/**
 * The extraction worker.
 *
 * Drains extraction_queue, pulls each version's text, normalises it and writes
 * it to documents.content_normalized — which is what the full-text index is
 * built over. Until this runs, content search has nothing to search.
 *
 * ─── Claiming ───────────────────────────────────────────────────────────────
 *
 * A row is claimed with a single UPDATE ... OUTPUT under READPAST, so two
 * workers never take the same job: the second skips the locked row instead of
 * blocking on it. This is the reason the queue can be a plain table — the
 * database already provides the one primitive a queue needs.
 *
 * ─── Failure ────────────────────────────────────────────────────────────────
 *
 * Attempts are counted and bounded. A document that cannot be parsed is not
 * retried forever: after maxAttempts it is marked permanently failed with the
 * reason kept, so it shows up on a diagnostics screen instead of consuming a
 * worker slot every poll. This is the concern raised early on — that a failed
 * background job would silently break search — and the answer is that the
 * failure is recorded and visible, not swallowed.
 */

import path from 'node:path';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { config } from '../../config/index.js';
import { normalizeArabic } from '../../lib/arabic.js';
import { moduleLogger } from '../../lib/logger.js';
import { extractText, OUTCOME } from './extractors.js';
import { attemptOcr, ocrAvailable } from './ocr.js';

const log = moduleLogger('extraction');

/** extraction_queue.status */
export const QUEUE = Object.freeze({
  PENDING: 0,
  RUNNING: 1,
  DONE: 2,
  RETRYABLE: 3,
  FAILED: 4,
  SKIPPED: 5,
});

/**
 * documents.extraction_status
 *
 * OCR_EXTRACTED is kept distinct from EXTRACTED on purpose: text lifted from a
 * document's own text layer is exact, and text recognised from a photograph of a
 * page is roughly 85-93% right on clean Arabic print. Both are fine for finding
 * a document; only one would be honest to show as its contents. Nothing returns
 * either column to a client, and this flag is how an operator can tell which
 * documents are searchable only approximately.
 */
export const DOC_EXTRACTION = Object.freeze({
  PENDING: 0,
  EXTRACTED: 1,
  UNSUPPORTED: 2,
  FAILED: 3,
  OCR_EXTRACTED: 4,
});

/**
 * Atomically claims one job.
 *
 * READPAST makes a second worker skip a row another has locked rather than wait
 * for it, which is what lets several run at once without a coordinator.
 */
async function claimJob(maxAttempts) {
  const result = await sql`
    UPDATE TOP (1) q
       SET status = ${QUEUE.RUNNING},
           started_at = SYSUTCDATETIME(),
           attempts = q.attempts + 1
      OUTPUT INSERTED.queue_id, INSERTED.document_id, INSERTED.version_number, INSERTED.attempts
      FROM dbo.extraction_queue AS q WITH (READPAST, UPDLOCK, ROWLOCK)
     WHERE q.status IN (${QUEUE.PENDING}, ${QUEUE.RETRYABLE})
       AND q.attempts < ${maxAttempts}
  `.execute(db);

  return result.rows[0] ?? null;
}

async function finishJob(queueId, status, error) {
  await sql`
    UPDATE dbo.extraction_queue
       SET status = ${status},
           finished_at = SYSUTCDATETIME(),
           last_error = ${error ? String(error).slice(0, 2000) : null}
     WHERE queue_id = ${queueId}
  `.execute(db);
}

/**
 * Runs one job.
 *
 * Exported so tests can drive extraction deterministically instead of waiting on
 * a polling loop.
 *
 * @returns {Promise<{claimed: boolean, outcome?: string, documentId?: string}>}
 */
export async function processOne({ maxAttempts = config.extraction.maxAttempts } = {}) {
  const job = await claimJob(maxAttempts);
  if (!job) return { claimed: false };

  const { queue_id: queueId, document_id: documentId, version_number: versionNumber } = job;

  try {
    const found = await sql`
      SELECT v.storage_path, v.mime_type, v.original_filename, v.file_size_bytes
        FROM dbo.document_versions v
       WHERE v.document_id = ${documentId} AND v.version_number = ${versionNumber}
    `.execute(db);

    const version = found.rows[0];
    if (!version) {
      // The document was hard-deleted between enqueue and now. Nothing to do,
      // and retrying will not bring it back.
      await finishJob(queueId, QUEUE.SKIPPED, 'version no longer exists');
      return { claimed: true, outcome: 'missing', documentId: String(documentId) };
    }

    if (Number(version.file_size_bytes) > config.extraction.maxBytes) {
      await markDocument(documentId, DOC_EXTRACTION.UNSUPPORTED);
      await finishJob(queueId, QUEUE.SKIPPED, `file larger than the extraction limit`);
      return { claimed: true, outcome: 'too_large', documentId: String(documentId) };
    }

    const absolutePath = storage.absolute(version.storage_path);

    const result = await extractText(absolutePath, {
      filename: version.original_filename ?? path.basename(version.storage_path),
      mimeType: version.mime_type,
      maxChars: config.extraction.maxChars,
    });

    if (result.outcome === OUTCOME.EXTRACTED) {
      // Normalised on the way in, exactly as the title is. The full-text index
      // is built over the normalised column, so text stored raw here would be
      // unfindable by a normalised query.
      await sql`
        UPDATE dbo.documents
           SET content_normalized = ${normalizeArabic(result.text)},
               extraction_status = ${DOC_EXTRACTION.EXTRACTED},
               extracted_at = SYSUTCDATETIME()
         WHERE document_id = ${documentId}
      `.execute(db);

      await finishJob(queueId, QUEUE.DONE, null);
      log.info(
        { documentId: String(documentId), version: versionNumber, characters: result.text.length },
        'text extracted',
      );
      return { claimed: true, outcome: OUTCOME.EXTRACTED, documentId: String(documentId) };
    }

    // No text layer. This is the scan case, and the point at which OCR is the
    // only way the document becomes searchable.
    if (await ocrAvailable()) {
      const recognised = await attemptOcr(absolutePath, {
        filename: version.original_filename ?? path.basename(version.storage_path),
        mimeType: version.mime_type,
      }).catch((error) => ({ ok: false, reason: 'ocr_failed', detail: error.message }));

      if (recognised.ok) {
        await sql`
          UPDATE dbo.documents
             SET content_normalized = ${normalizeArabic(recognised.text)},
                 extraction_status = ${DOC_EXTRACTION.OCR_EXTRACTED},
                 extracted_at = SYSUTCDATETIME()
           WHERE document_id = ${documentId}
        `.execute(db);

        await finishJob(queueId, QUEUE.DONE, `ocr:${recognised.engine}`);
        log.info(
          { documentId: String(documentId), engine: recognised.engine, characters: recognised.text.length },
          'text recovered by OCR',
        );
        return { claimed: true, outcome: 'ocr', documentId: String(documentId) };
      }

      // OCR was available and did not help. Recorded with its reason so the
      // difference between "no OCR installed" and "OCR found nothing" is
      // visible, rather than both looking like an unreadable document.
      await markDocument(documentId, DOC_EXTRACTION.UNSUPPORTED);
      await finishJob(queueId, QUEUE.SKIPPED, `${result.outcome}; ${recognised.reason}`);
      return { claimed: true, outcome: recognised.reason, documentId: String(documentId) };
    }

    // no_text_layer and unsupported are both "there is nothing to index", not
    // failures. Recording which is which is what makes the OCR work list.
    await markDocument(documentId, DOC_EXTRACTION.UNSUPPORTED);
    await finishJob(queueId, QUEUE.SKIPPED, `${result.outcome}: ${result.detail ?? ''}`.trim());

    log.info(
      { documentId: String(documentId), outcome: result.outcome, detail: result.detail },
      'nothing to index for this document',
    );
    return { claimed: true, outcome: result.outcome, documentId: String(documentId) };
  } catch (error) {
    const attempts = Number(job.attempts);
    const exhausted = attempts >= maxAttempts;

    if (exhausted) await markDocument(documentId, DOC_EXTRACTION.FAILED);
    await finishJob(queueId, exhausted ? QUEUE.FAILED : QUEUE.RETRYABLE, error.message);

    log[exhausted ? 'error' : 'warn'](
      { err: error, documentId: String(documentId), attempts, exhausted },
      exhausted ? 'extraction failed permanently' : 'extraction failed, will retry',
    );

    return { claimed: true, outcome: 'error', documentId: String(documentId) };
  }
}

async function markDocument(documentId, status) {
  await sql`
    UPDATE dbo.documents
       SET extraction_status = ${status}, extracted_at = SYSUTCDATETIME()
     WHERE document_id = ${documentId}
  `.execute(db);
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
 * Polling rather than a notification: the queue is low-volume, the latency that
 * matters is "searchable within a minute of upload", and a poll has no extra
 * moving parts to keep alive on a Windows server.
 *
 * @returns {{stop: () => void}}
 */
export function startExtractionWorker() {
  if (!config.extraction.enabled) {
    log.info('extraction worker disabled (EXTRACTION_ENABLED=false)');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const processed = await drainQueue({ max: config.extraction.batchSize });
      if (processed > 0) log.info({ processed }, 'extraction batch complete');
    } catch (error) {
      // The loop must survive anything: a database blip must not end extraction
      // for the life of the process.
      log.error({ err: error }, 'extraction loop error');
    } finally {
      if (!stopped) timer = setTimeout(tick, config.extraction.pollMs);
    }
  };

  log.info({ pollMs: config.extraction.pollMs }, 'extraction worker started');
  timer = setTimeout(tick, config.extraction.pollMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * How many documents are searchable, and how.
 *
 * "unindexed" is the OCR work list: documents stored and browsable whose
 * contents nothing can search.
 */
export async function extractionStats() {
  const result = await sql`
    SELECT extraction_status, COUNT(*) AS total
      FROM dbo.documents WHERE is_deleted = 0 GROUP BY extraction_status
  `.execute(db);

  const stats = { pending: 0, extracted: 0, unindexed: 0, failed: 0, ocr: 0 };
  const names = { 0: 'pending', 1: 'extracted', 2: 'unindexed', 3: 'failed', 4: 'ocr' };

  for (const row of result.rows) {
    const name = names[Number(row.extraction_status)];
    if (name) stats[name] = Number(row.total);
  }
  return stats;
}

/** Counts by queue status, for a diagnostics screen. */
export async function queueStats() {
  const result = await sql`
    SELECT status, COUNT(*) AS total FROM dbo.extraction_queue GROUP BY status
  `.execute(db);

  const stats = { pending: 0, running: 0, done: 0, retryable: 0, failed: 0, skipped: 0 };
  const names = ['pending', 'running', 'done', 'retryable', 'failed', 'skipped'];

  for (const row of result.rows) {
    const name = names[Number(row.status)];
    if (name) stats[name] = Number(row.total);
  }
  return stats;
}
