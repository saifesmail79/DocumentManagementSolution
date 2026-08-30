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
import { getSetting } from '../settings/service.js';

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
 * How long a job may sit in RUNNING before another worker may take it.
 *
 * Generous, because it must exceed the slowest legitimate job — a large scanned
 * PDF through OCR — or two workers would process the same document at once.
 */
const STALE_CLAIM_MS = 30 * 60 * 1000;

/**
 * Atomically claims one job.
 *
 * READPAST makes a second worker skip a row another has locked rather than wait
 * for it, which is what lets several run at once without a coordinator.
 *
 * ─── Why RUNNING is reclaimable ─────────────────────────────────────────────
 *
 * A worker that dies mid-job — the process killed, the machine restarted —
 * leaves its row in RUNNING. Nothing ever moves it out again, so the document
 * stays unsearchable permanently, with no error recorded anywhere and no sign of
 * a problem beyond a queue row nobody reads. That had already happened once in
 * production here.
 *
 * A RUNNING row older than STALE_CLAIM_MS is therefore treated as abandoned.
 * `attempts` still increments, so a job that reliably kills its worker exhausts
 * its retries and stops rather than looping forever.
 */
async function claimJob(maxAttempts) {
  const result = await sql`
    UPDATE TOP (1) q
       SET status = ${QUEUE.RUNNING},
           started_at = SYSUTCDATETIME(),
           attempts = q.attempts + 1
      OUTPUT INSERTED.queue_id, INSERTED.document_id, INSERTED.version_number, INSERTED.attempts
      FROM dbo.extraction_queue AS q WITH (READPAST, UPDLOCK, ROWLOCK)
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
    // The administration panel's OCR switch is read here, per document, rather
    // than at startup: an operator turning OCR on expects the next scan to be
    // recognised, not to have to restart the server. getSetting caches for ten
    // seconds and falls back to the environment, so this costs nothing per job.
    const ocrEnabled = await getSetting('ocr.enabled');

    if (await ocrAvailable({ enabled: ocrEnabled })) {
      const recognised = await attemptOcr(absolutePath, {
        filename: version.original_filename ?? path.basename(version.storage_path),
        mimeType: version.mime_type,
        enabled: ocrEnabled,
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
      //
      // `detail` is kept, not dropped. The reason alone is a category, and the
      // categories are wide: `ocr_failed` covered both a crashed engine and
      // Tesseract being unable to open an Arabic path, and only the message it
      // printed distinguished them. That message existed, was caught, and was
      // thrown away one line before it would have been useful — leaving a
      // diagnostics screen that said an image was unreadable when what had
      // actually happened was that the engine never opened it.
      await markDocument(documentId, DOC_EXTRACTION.UNSUPPORTED);
      await finishJob(
        queueId,
        QUEUE.SKIPPED,
        [`${result.outcome}; ${recognised.reason}`, recognised.detail].filter(Boolean).join(': '),
      );
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
  // Deliberately not gated here on the stored setting. The environment switch
  // decides whether this process runs a worker at all; the stored setting
  // decides whether it does any work on a given tick, so an operator toggling it
  // sees an effect without a restart.
  if (!config.extraction.enabled) {
    log.info('extraction worker disabled (EXTRACTION_ENABLED=false)');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      // Returning still runs the finally below, which schedules the next tick —
      // so a paused worker keeps checking and resumes on its own when the
      // setting comes back on.
      if (!(await getSetting('extraction.enabled'))) return;

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

/**
 * How old a claim must be before an explicit reindex will take it back.
 *
 * Far shorter than STALE_CLAIM_MS, because this is not the background loop
 * guessing whether a worker died — it is an administrator saying so. A minute is
 * enough to avoid interrupting a job that genuinely started moments ago.
 */
const STALE_RECLAIM_ON_REQUEST_MS = 60 * 1000;

/**
 * Puts every unsearchable document back on the queue.
 *
 * ─── Why this has to exist ──────────────────────────────────────────────────
 *
 * A job that exhausts its attempts is finished for good, and a job skipped as
 * unindexable is never revisited. Both are correct while the cause is the
 * document. Neither is correct when the cause was the server — a missing OCR
 * engine, a broken library call, a tool installed the day after the upload.
 *
 * Without this the only remedy is to delete and re-upload every affected file,
 * which loses its version history and its metadata. Two real cases here: Office
 * documents that failed on a library rename, and scans skipped because OCRmyPDF
 * was not yet configured.
 *
 * Attempts reset to zero, so a document that genuinely cannot be read simply
 * fails again and stops. Documents already extracted are left alone.
 *
 * @returns {Promise<{requeued: number}>}
 */
export async function requeueUnsearchable() {
  const result = await sql`
    UPDATE q
       SET status = ${QUEUE.PENDING},
           attempts = 0,
           last_error = NULL,
           started_at = NULL,
           finished_at = NULL
      FROM dbo.extraction_queue AS q
      JOIN dbo.documents AS d ON d.document_id = q.document_id
     WHERE d.deleted_at IS NULL
       AND q.version_number = d.current_version
       AND (
             q.status IN (${QUEUE.FAILED}, ${QUEUE.SKIPPED})
             -- A row abandoned by a worker that died mid-job. Without this an
             -- administrator clicking "reindex" sees nothing happen to exactly
             -- the documents most obviously stuck, and waits out STALE_CLAIM_MS
             -- with no indication why. A restart during a reindex produces this
             -- immediately, which is how it was found.
             OR (
                  q.status = ${QUEUE.RUNNING}
                  AND q.started_at IS NOT NULL
                  AND DATEDIFF(second, q.started_at, SYSUTCDATETIME()) > ${Math.floor(STALE_RECLAIM_ON_REQUEST_MS / 1000)}
                )
           )
  `.execute(db);

  const requeued = Number(result.numAffectedRows ?? 0);
  log.info({ requeued }, 'unsearchable documents requeued');
  return { requeued };
}

/**
 * The documents that are not searchable, with the reason for each.
 *
 * A count on a dashboard says something is wrong; this says which documents and
 * why, which is the difference between knowing there is a problem and being able
 * to act on it. RETRYABLE rows that have used up their attempts are included —
 * they are finished in every sense but the one the status column records.
 *
 * `last_error` is only meaningful on a row that did not succeed: a completed OCR
 * job stores its engine there ("ocr:ocrmypdf"), which would read as a failure.
 * Only failing statuses are selected, so that cannot leak into this list.
 */
export async function listUnsearchable({ limit = 50 } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const result = await sql`
    SELECT TOP (${pageSize})
           q.document_id, q.version_number, q.status, q.attempts, q.last_error, q.finished_at,
           d.title, d.folder_id, d.extraction_status,
           v.original_filename, v.mime_type,
           f.name AS folder_name
      FROM dbo.extraction_queue q
      JOIN dbo.documents d ON d.document_id = q.document_id
      LEFT JOIN dbo.folders f ON f.folder_id = d.folder_id
      LEFT JOIN dbo.document_versions v
        ON v.document_id = q.document_id AND v.version_number = q.version_number
     WHERE d.is_deleted = 0
       AND (
             q.status IN (${QUEUE.FAILED}, ${QUEUE.SKIPPED})
             OR (q.status = ${QUEUE.RETRYABLE} AND q.attempts >= ${config.extraction.maxAttempts})
           )
     ORDER BY q.finished_at DESC, q.queue_id DESC
  `.execute(db);

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    version: Number(row.version_number),
    title: row.title,
    folderId: String(row.folder_id),
    folderName: row.folder_name,
    filename: row.original_filename,
    mimeType: row.mime_type,
    status: Number(row.status),
    attempts: Number(row.attempts),
    reason: row.last_error,
    finishedAt: row.finished_at,
  }));
}

/**
 * Whether the worker is actually doing anything, and if not, why.
 *
 * "Nothing is being indexed" has several causes that look identical from a
 * queue count: the environment switch is off, the stored setting is off, or the
 * worker is alive and simply has nothing to do. Only the last is healthy.
 */
export async function workerHealth() {
  const enabledInEnvironment = config.extraction.enabled;
  const enabledBySetting = await getSetting('extraction.enabled');

  const stuck = await sql`
    SELECT COUNT(*) AS n FROM dbo.extraction_queue
     WHERE status = ${QUEUE.RUNNING}
       AND started_at IS NOT NULL
       AND DATEDIFF(second, started_at, SYSUTCDATETIME()) > ${Math.floor(STALE_CLAIM_MS / 1000)}
  `.execute(db);

  const oldestWaiting = await sql`
    SELECT MIN(queued_at) AS oldest FROM dbo.extraction_queue
     WHERE status IN (${QUEUE.PENDING}, ${QUEUE.RETRYABLE})
  `.execute(db);

  return {
    enabledInEnvironment,
    enabledBySetting: Boolean(enabledBySetting),
    running: enabledInEnvironment && Boolean(enabledBySetting),
    stuckJobs: Number(stuck.rows[0].n),
    oldestWaitingSince: oldestWaiting.rows[0].oldest ?? null,
    pollMs: config.extraction.pollMs,
  };
}
