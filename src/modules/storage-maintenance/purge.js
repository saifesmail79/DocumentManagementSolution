/**
 * Storage maintenance.
 *
 * Two jobs that nothing else does, and whose absence is invisible until the
 * disk fills:
 *
 *   1. Purge the blobs of documents that have been soft-deleted longer than the
 *      grace period.
 *   2. Remove staging and temp files left by uploads that failed or were
 *      abandoned mid-stream.
 *
 * ─── Order matters, in the opposite direction to writing ────────────────────
 *
 * Writing goes file-then-row, so a crash leaves an unreferenced file rather than
 * a row pointing at nothing. Deleting must go row-then-file for the same reason:
 * remove the database row first, and a crash leaves an unreferenced file, which
 * this sweep collects on its next pass. Deleting the file first would leave a
 * row pointing at bytes that are gone — the exact corruption the write ordering
 * exists to prevent.
 *
 * ─── The grace period is the undo ───────────────────────────────────────────
 *
 * "Someone deleted the wrong contract" is a routine support call. Until the
 * grace period expires, a soft-deleted document is fully recoverable because its
 * bytes are still on disk. After it expires they are gone for good, which is why
 * the default is generous and why every purge is recorded.
 */

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { record, ACTION } from '../audit/service.js';
import { writeAllManifests } from './manifest.js';

const log = moduleLogger('purge');

/** The grace period the administrator set; the environment value if unreachable. */
async function effectiveGraceDays() {
  try {
    const { getSetting } = await import('../settings/service.js');
    return await getSetting('storage.purge_grace_days');
  } catch {
    return config.storage.purgeGraceDays;
  }
}

/**
 * Removes the blobs of documents soft-deleted before the grace period.
 *
 * @param {{graceDays?: number, max?: number, dryRun?: boolean}} options
 */
export async function purgeDeletedDocuments({
  graceDays,
  max = 500,
  dryRun = false,
} = {}) {
  // Resolved at run time, not in the signature: a default parameter is bound to
  // the frozen boot config, which is how the setting spent months accepting
  // values that no sweep ever read.
  if (graceDays === undefined) graceDays = await effectiveGraceDays();
  // Both file axes are purged.
  //
  // Enumerating only dbo.document_versions would leave every constituent file
  // of every deleted multi-file document on disk forever: the document row is
  // tombstoned, nothing references the blobs, and the orphan sweep only looks
  // at .tmp and .staging — so the bytes would never be reclaimed and would
  // never be reported as reclaimable either. That is the quietest possible
  // storage leak, which is why the union is here rather than in a second pass.
  const candidates = await sql`
    SELECT TOP (${max})
           c.document_id, c.version_number, c.file_id, c.source,
           c.storage_path, c.sha256, c.file_size_bytes,
           d.title, d.folder_id, d.deleted_at
      FROM (
            SELECT document_id, version_number, CAST(NULL AS bigint) AS file_id,
                   CAST('version' AS varchar(10)) AS source,
                   storage_path, sha256, file_size_bytes
              FROM dbo.document_versions
             UNION ALL
            SELECT document_id, 0 AS version_number, file_id,
                   CAST('file' AS varchar(10)) AS source,
                   storage_path, sha256, file_size_bytes
              FROM dbo.document_files
           ) c
      JOIN dbo.documents d ON d.document_id = c.document_id
     WHERE d.is_deleted = 1
       AND d.deleted_at < DATEADD(day, ${-Math.abs(graceDays)}, SYSUTCDATETIME())
     ORDER BY d.deleted_at
  `.execute(db);

  if (candidates.rows.length === 0) return { purged: 0, bytes: 0, failed: 0, dryRun };

  let purged = 0;
  let bytes = 0;
  let failed = 0;

  for (const row of candidates.rows) {
    if (dryRun) {
      purged += 1;
      bytes += Number(row.file_size_bytes);
      continue;
    }

    try {
      // Row first. A crash here leaves an unreferenced file, which the orphan
      // sweep collects; the reverse would leave a row pointing at nothing.
      await db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO dbo.purged_blobs (document_id, version_number, storage_path, sha256, bytes)
          VALUES (${row.document_id}, ${row.version_number}, ${row.storage_path},
                  ${row.sha256}, ${row.file_size_bytes})
        `.execute(trx);

        if (row.source === 'file') {
          await sql`
            DELETE FROM dbo.document_files WHERE file_id = ${row.file_id}
          `.execute(trx);
        } else {
          await sql`
            DELETE FROM dbo.document_versions
             WHERE document_id = ${row.document_id} AND version_number = ${row.version_number}
          `.execute(trx);
        }

        // The document row stays as a tombstone: "this existed and was deleted"
        // is worth keeping, and the audit trail references it.
        await sql`
          UPDATE dbo.documents SET current_version = 0 WHERE document_id = ${row.document_id}
        `.execute(trx);
      });

      await storage.remove(row.storage_path);

      purged += 1;
      bytes += Number(row.file_size_bytes);

      await record({
        action: ACTION.BLOB_PURGED,
        targetType: 'document',
        targetId: row.document_id,
        folderId: row.folder_id,
        detail:
          row.source === 'file'
            ? `a file of "${row.title}" purged after ${graceDays} days`
            : `v${row.version_number} of "${row.title}" purged after ${graceDays} days`,
      });
    } catch (error) {
      failed += 1;
      log.error(
        { err: error, documentId: String(row.document_id), version: row.version_number },
        'could not purge a blob',
      );
    }
  }

  if (purged > 0 || failed > 0) {
    log.info({ purged, bytes, failed, graceDays }, 'purge sweep complete');
  }

  return { purged, bytes, failed, dryRun };
}

/**
 * Why a sweep found nothing, in the terms the recycle bin uses.
 *
 * "purged: 0" is not an answer. It is the same number whether the bin is empty,
 * everything is still inside its grace period, or the content is already gone —
 * three situations calling for three different actions, and an operator staring
 * at a zero cannot tell which one they are in. So the sweep reports what is in
 * the bin alongside what it took.
 */
export async function recycleBinState({ graceDays } = {}) {
  if (graceDays === undefined) graceDays = await effectiveGraceDays();
  const rows = await sql`
    SELECT
      SUM(CASE WHEN content.blobs > 0
                AND d.deleted_at < DATEADD(day, ${-Math.abs(graceDays)}, SYSUTCDATETIME())
               THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN content.blobs > 0
                AND d.deleted_at >= DATEADD(day, ${-Math.abs(graceDays)}, SYSUTCDATETIME())
               THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN content.blobs = 0 THEN 1 ELSE 0 END) AS tombstones,
      MIN(CASE WHEN content.blobs > 0
                AND d.deleted_at >= DATEADD(day, ${-Math.abs(graceDays)}, SYSUTCDATETIME())
               THEN d.deleted_at END) AS oldest_waiting
      FROM dbo.documents d
     CROSS APPLY (
       SELECT (SELECT COUNT(*) FROM dbo.document_versions v WHERE v.document_id = d.document_id)
            + (SELECT COUNT(*) FROM dbo.document_files f WHERE f.document_id = d.document_id)
              AS blobs
     ) AS content
     WHERE d.is_deleted = 1
  `.execute(db);

  const row = rows.rows[0] ?? {};
  const oldest = row.oldest_waiting ?? null;

  return {
    graceDays,
    eligible: Number(row.eligible ?? 0),
    waiting: Number(row.waiting ?? 0),
    // Kept for the audit trail and unrestorable: nothing will ever collect them,
    // and they no longer hold a folder open.
    tombstones: Number(row.tombstones ?? 0),
    nextEligibleAt: oldest
      ? new Date(new Date(oldest).getTime() + Math.abs(graceDays) * 86_400_000).toISOString()
      : null,
  };
}

/**
 * Removes abandoned staging and temp files.
 *
 * A refused or interrupted upload can leave a .part file behind. Individually
 * tiny, collectively a slow leak on the document volume — and the one directory
 * nobody thinks to look in.
 */
export async function purgeOrphanedUploads({ olderThanHours = 24 } = {}) {
  const olderThanMs = Math.abs(olderThanHours) * 3_600_000;

  const temp = await storage.cleanupTemp({ olderThanMs }).catch((error) => {
    log.warn({ err: error }, 'temp cleanup failed');
    return 0;
  });

  const staging = await cleanupStaging(olderThanMs);

  if (temp > 0 || staging > 0) log.info({ temp, staging }, 'orphaned upload files removed');
  return { temp: Number(temp) || 0, staging };
}

/**
 * The staging directory is written by the document module, not the driver, so
 * the driver's own temp cleanup does not cover it.
 */
async function cleanupStaging(olderThanMs) {
  const { readdir, stat, unlink } = await import('node:fs/promises');
  const path = await import('node:path');

  const directory = path.join(config.storage.root, '.staging');
  let removed = 0;

  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    // Never created because nothing has failed yet. Not a problem.
    return 0;
  }

  const cutoff = Date.now() - olderThanMs;

  for (const entry of entries) {
    const full = path.join(directory, entry);
    try {
      const info = await stat(full);
      // mtime, not ctime: an upload still streaming has a recent mtime and must
      // not be deleted out from under itself.
      if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(full);
        removed += 1;
      }
    } catch {
      /* raced with another sweep or the upload itself; skip */
    }
  }

  return removed;
}

/**
 * Rows whose file is missing from disk.
 *
 * This is the check that would have caught the corruption the write ordering
 * exists to prevent, so it is worth being able to run on demand rather than
 * only believing the ordering is right.
 */
export async function findMissingBlobs({ max = 1000 } = {}) {
  // Constituent files are covered too: the write ordering that guarantees a
  // committed row has its file is the same for both axes, so the check that
  // verifies it has to look at both or it only half-verifies the invariant.
  const rows = await sql`
    SELECT TOP (${max}) c.document_id, c.version_number, c.storage_path, d.title
      FROM (
            SELECT document_id, version_number, storage_path FROM dbo.document_versions
             UNION ALL
            SELECT document_id, 0 AS version_number, storage_path FROM dbo.document_files
           ) c
      JOIN dbo.documents d ON d.document_id = c.document_id
     ORDER BY c.document_id
  `.execute(db);

  const missing = [];
  for (const row of rows.rows) {
    if (!(await storage.exists(row.storage_path))) {
      missing.push({
        documentId: String(row.document_id),
        versionNumber: Number(row.version_number),
        storagePath: row.storage_path,
        title: row.title,
      });
    }
  }

  if (missing.length > 0) {
    log.error({ count: missing.length }, 'documents reference files that are not on disk');
  }

  return { checked: rows.rows.length, missing };
}

/**
 * Starts the maintenance timer.
 *
 * Runs far less often than the extraction worker: nothing here is
 * time-sensitive, and a sweep that runs constantly is a sweep competing with
 * real work for the same disk.
 */
export function startMaintenance() {
  if (!config.storage.purgeEnabled) {
    log.info('storage maintenance disabled (STORAGE_PURGE_ENABLED=false)');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await purgeDeletedDocuments();
      await purgeOrphanedUploads();

      // Regenerated after the purge so a manifest never lists a file the sweep
      // has just removed.
      if (config.storage.manifestsEnabled) await writeAllManifests();

      // The periodic jobs the other modules own. Grouped here rather than each
      // starting its own timer: four timers doing small amounts of work on the
      // same disk and database is worse than one pass that does all of it.
      const [{ notifyExpiring }, { escalateOverdue }, { purgeStaleSessions }, { purgeUnusedTags }, integration] =
        await Promise.all([
          import('../documents/state.js'),
          import('../workflow/service.js'),
          import('../uploads/resumable.js'),
          import('../tags/service.js'),
          import('../integration/service.js'),
        ]);

      await notifyExpiring();
      await escalateOverdue();
      await purgeStaleSessions();
      await purgeUnusedTags();
      await integration.deliverPending();

      const { purgeResetTokens } = await import('../auth/reset.js');
      await purgeResetTokens();
    } catch (error) {
      log.error({ err: error }, 'maintenance sweep failed');
    } finally {
      if (!stopped) timer = setTimeout(tick, config.storage.purgeIntervalMs);
    }
  };

  log.info({ intervalMs: config.storage.purgeIntervalMs }, 'storage maintenance started');
  // Deliberately not immediate: startup already has enough to do, and nothing
  // here needs to happen in the first minute of uptime.
  timer = setTimeout(tick, config.storage.purgeIntervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
