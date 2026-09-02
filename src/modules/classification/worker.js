/**
 * The fingerprinting worker.
 *
 * Drains classification_queue: for each document, rasterises page one, reads
 * its words, computes the fingerprints and the header fields, and stores the
 * lot in classification_pages. The same shape as the extraction worker —
 * claim under READPAST, bounded attempts, reasons kept — because that shape
 * has already had its failure modes found in production here.
 *
 * ─── Always polling, gated per tick ─────────────────────────────────────────
 *
 * Unlike the extraction worker, the loop is not switched off by an
 * environment variable. The pilot has to be switchable from the administration
 * screen without a restart, on a machine where nobody edits .env: so the loop
 * is always alive, and each tick asks the stored setting whether to do
 * anything. Off, it costs one cached read every poll.
 */

import path from 'node:path';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { QUEUE, STALE_CLAIM_MS, isEnabled } from './service.js';
import { pageKind, classificationTools, fingerprintPage } from './page.js';

const log = moduleLogger('classification');

async function claimJob(maxAttempts) {
  const result = await sql`
    UPDATE TOP (1) q
       SET status = ${QUEUE.RUNNING},
           started_at = SYSUTCDATETIME(),
           attempts = q.attempts + 1
      OUTPUT INSERTED.queue_id, INSERTED.document_id, INSERTED.attempts
      FROM dbo.classification_queue AS q WITH (READPAST, UPDLOCK, ROWLOCK)
     WHERE (
             q.status IN (${QUEUE.PENDING}, ${QUEUE.RETRYABLE})
             OR (
               q.status = ${QUEUE.RUNNING}
               AND q.started_at IS NOT NULL
               AND DATEDIFF(second, q.started_at, SYSUTCDATETIME()) > ${Math.floor(STALE_CLAIM_MS / 1000)}
             )
           )
       AND q.attempts < ${maxAttempts}
  `.execute(db);

  return result.rows[0] ?? null;
}

async function finishJob(queueId, status, error) {
  await sql`
    UPDATE dbo.classification_queue
       SET status = ${status},
           finished_at = SYSUTCDATETIME(),
           last_error = ${error ? String(error).slice(0, 2000) : null}
     WHERE queue_id = ${queueId}
  `.execute(db);
}

/**
 * The file that stands for a document's first page.
 *
 * The current version's file for an ordinary document; the first constituent,
 * in filing order, for a document made of several files.
 */
async function primaryBlob(documentId, currentVersion) {
  if (Number(currentVersion) >= 1) {
    const version = await sql`
      SELECT storage_path, mime_type, original_filename, NULL AS file_id
        FROM dbo.document_versions
       WHERE document_id = ${documentId} AND version_number = ${currentVersion}
    `.execute(db);
    if (version.rows[0]) return version.rows[0];
  }

  const file = await sql`
    SELECT TOP (1) storage_path, mime_type, original_filename, file_id
      FROM dbo.document_files
     WHERE document_id = ${documentId}
     ORDER BY sort_order ASC
  `.execute(db);
  return file.rows[0] ?? null;
}

/**
 * Runs one job. Exported so tests drive it directly.
 *
 * @returns {Promise<{claimed: boolean, outcome?: string, documentId?: string}>}
 */
export async function processOne({ maxAttempts = config.classification.maxAttempts } = {}) {
  const job = await claimJob(maxAttempts);
  if (!job) return { claimed: false };

  const { queue_id: queueId, document_id: documentId } = job;
  const id = String(documentId);

  try {
    const found = await sql`
      SELECT current_version, is_deleted FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    const document = found.rows[0];

    if (!document || Number(document.is_deleted) === 1) {
      await finishJob(queueId, QUEUE.SKIPPED, 'document no longer exists');
      return { claimed: true, outcome: 'missing', documentId: id };
    }

    const blob = await primaryBlob(documentId, document.current_version);
    if (!blob) {
      await finishJob(queueId, QUEUE.SKIPPED, 'document has no file');
      return { claimed: true, outcome: 'missing', documentId: id };
    }

    const filename = blob.original_filename ?? path.basename(blob.storage_path);
    const kind = pageKind(filename, blob.mime_type);
    if (!kind) {
      // An Office file or a text file has no page to look at. Not a failure:
      // the pilot is about scans, and this is recorded as exactly that.
      await finishJob(queueId, QUEUE.SKIPPED, `not a scanned page: ${filename}`);
      return { claimed: true, outcome: 'not_classifiable', documentId: id };
    }

    const tools = await classificationTools();
    if (!tools.tesseract.available) throw new Error('Tesseract is not installed');
    if (kind === 'pdf' && !tools.ghostscript.available) throw new Error('Ghostscript is not installed');

    const result = await fingerprintPage(storage.absolute(blob.storage_path), { kind });

    await sql`
      MERGE dbo.classification_pages WITH (HOLDLOCK) AS target
      USING (SELECT ${documentId} AS document_id) AS source
         ON target.document_id = source.document_id
      WHEN MATCHED THEN
        UPDATE SET version_number = ${Number(document.current_version)},
                   file_id = ${blob.file_id ?? null},
                   page_width = ${result.page.width},
                   page_height = ${result.page.height},
                   ocr_psm = ${String(result.psm)},
                   word_count = ${result.words.length},
                   char_count = ${result.chars},
                   features = ${JSON.stringify(result.features)},
                   words = ${JSON.stringify(result.words)},
                   extracted = ${JSON.stringify(result.extracted)},
                   computed_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (document_id, version_number, file_id, page_width, page_height, ocr_psm,
                word_count, char_count, features, words, extracted)
        VALUES (source.document_id, ${Number(document.current_version)}, ${blob.file_id ?? null},
                ${result.page.width}, ${result.page.height}, ${String(result.psm)},
                ${result.words.length}, ${result.chars}, ${JSON.stringify(result.features)},
                ${JSON.stringify(result.words)}, ${JSON.stringify(result.extracted)});
    `.execute(db);

    // A page Tesseract could not read still has a layout fingerprint and is
    // still DONE; the note says why its text side is empty.
    await finishJob(queueId, QUEUE.DONE, result.chars < config.ocr.minCharacters ? 'no text recognised' : null);

    log.info({ documentId: id, words: result.words.length, chars: result.chars, psm: result.psm }, 'document fingerprinted');
    return { claimed: true, outcome: 'done', documentId: id };
  } catch (error) {
    const attempts = Number(job.attempts);
    const exhausted = attempts >= maxAttempts;

    await finishJob(queueId, exhausted ? QUEUE.FAILED : QUEUE.RETRYABLE, error.message);

    log[exhausted ? 'error' : 'warn'](
      { err: error, documentId: id, attempts, exhausted },
      exhausted ? 'fingerprinting failed permanently' : 'fingerprinting failed, will retry',
    );

    return { claimed: true, outcome: 'error', documentId: id };
  }
}

/** Drains the queue until it is empty. Returns how many jobs ran. */
export async function drainQueue({ max = 1000 } = {}) {
  let processed = 0;
  while (processed < max) {
    const result = await processOne();
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
}

/**
 * Starts the polling loop.
 *
 * @returns {{stop: () => void}}
 */
export function startClassificationWorker() {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      // Returning still runs the finally below, so a paused worker keeps
      // checking and resumes on its own when the setting comes back on.
      if (!(await isEnabled())) return;

      const processed = await drainQueue({ max: config.classification.batchSize });
      if (processed > 0) log.info({ processed }, 'classification batch complete');
    } catch (error) {
      log.error({ err: error }, 'classification loop error');
    } finally {
      if (!stopped) timer = setTimeout(tick, config.classification.pollMs);
    }
  };

  log.info({ pollMs: config.classification.pollMs }, 'classification worker started (idle until enabled)');
  timer = setTimeout(tick, config.classification.pollMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
