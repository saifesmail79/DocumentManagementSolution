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

/**
 * Removes the blobs of documents soft-deleted before the grace period.
 *
 * @param {{graceDays?: number, max?: number, dryRun?: boolean}} options
 */
export async function purgeDeletedDocuments({
  graceDays = config.storage.purgeGraceDays,
  max = 500,
  dryRun = false,
} = {}) {
  const candidates = await sql`
    SELECT TOP (${max})
           v.document_id, v.version_number, v.storage_path, v.sha256, v.file_size_bytes,
           d.title, d.folder_id, d.deleted_at
      FROM dbo.document_versions v
      JOIN dbo.documents d ON d.document_id = v.document_id
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

        await sql`
          DELETE FROM dbo.document_versions
           WHERE document_id = ${row.document_id} AND version_number = ${row.version_number}
        `.execute(trx);

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
        detail: `v${row.version_number} of "${row.title}" purged after ${graceDays} days`,
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
  const rows = await sql`
    SELECT TOP (${max}) v.document_id, v.version_number, v.storage_path, d.title
      FROM dbo.document_versions v
      JOIN dbo.documents d ON d.document_id = v.document_id
     ORDER BY v.document_id
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
