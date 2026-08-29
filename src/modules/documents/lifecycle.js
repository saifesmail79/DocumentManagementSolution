/**
 * Duplicate detection and the recycle bin.
 *
 * ─── Duplicates ─────────────────────────────────────────────────────────────
 *
 * Every version already carries a SHA-256, computed while the bytes stream past
 * on the way to disk, so detecting an identical file costs one indexed lookup
 * and no extra reading.
 *
 * The policy is a setting rather than a hardcoded rule because the right answer
 * differs per organisation. "warn" is the default: the same circular genuinely
 * does get filed in three departments, and blocking that is wrong, while saying
 * nothing means nobody ever notices the archive filling with the same PDF.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { getSetting } from '../settings/service.js';
import { PERM, permissionBits, has } from '../tree/service.js';

const log = moduleLogger('documents');

/**
 * Finds live documents whose content is byte-identical.
 *
 * Only ones the user may browse are returned — a duplicate warning naming a
 * document in a folder they cannot see would leak both its existence and its
 * title.
 */
export async function findDuplicates({ userId, sha256, excludeDocumentId = null }) {
  if (!sha256) return [];

  const result = await sql`
    SELECT TOP (10)
           d.document_id, d.title, d.folder_id, f.name AS folder_name,
           v.version_number, v.uploaded_at
      FROM dbo.document_versions v
      JOIN dbo.documents d ON d.document_id = v.document_id
      JOIN dbo.folders   f ON f.folder_id  = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE v.sha256 = ${sha256}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${excludeDocumentId} IS NULL OR d.document_id <> ${excludeDocumentId})
     ORDER BY v.uploaded_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    title: row.title,
    folderId: String(row.folder_id),
    folderName: row.folder_name,
    version: Number(row.version_number),
    uploadedAt: row.uploaded_at,
  }));
}

/** 'allow' | 'warn' | 'block' */
export async function duplicatePolicy() {
  return getSetting('upload.duplicate_policy');
}

// ── Recycle bin ──────────────────────────────────────────────────────────

/**
 * Documents the user deleted, or can see and restore.
 *
 * Scoped by DELETE on the containing folder rather than BROWSE: the bin is a
 * recovery tool for whoever is responsible for that folder, and listing every
 * deletion to everyone who can read the folder turns it into a record of what
 * colleagues have been throwing away.
 */
export async function listRecycleBin({ userId, folderId = null, limit = 100 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const result = await sql`
    SELECT TOP (${pageSize})
           d.document_id, d.title, d.folder_id, d.deleted_at, d.current_version,
           f.name AS folder_name,
           deleter.display_name AS deleted_by,
           CAST(CASE WHEN EXISTS (
                  SELECT 1 FROM dbo.document_versions v WHERE v.document_id = d.document_id
                ) THEN 1 ELSE 0 END AS bit) AS has_content
      FROM dbo.documents d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.principals deleter ON deleter.principal_id = d.deleted_by
     WHERE d.is_deleted = 1
       AND (p.perm_bits & ${PERM.DELETE}) <> 0
       AND (${folderId} IS NULL OR d.folder_id = ${folderId})
     ORDER BY d.deleted_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    title: row.title,
    folderId: String(row.folder_id),
    folderName: row.folder_name,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    currentVersion: Number(row.current_version),
    // After the purge sweep the row survives as a tombstone with no file. It is
    // listed so the deletion is still visible, but it cannot be restored.
    restorable: Number(row.has_content) === 1,
  }));
}

/** Puts a soft-deleted document back. */
export async function restoreDocument({ userId, documentId }) {
  const found = await sql`
    SELECT d.folder_id, d.title, d.is_deleted,
           (SELECT COUNT(*) FROM dbo.document_versions v WHERE v.document_id = d.document_id) AS versions
      FROM dbo.documents d
     WHERE d.document_id = ${documentId}
  `.execute(db);

  const document = found.rows[0];
  if (!document) return { ok: false, reason: 'not_found' };
  if (Number(document.is_deleted) !== 1) return { ok: false, reason: 'not_deleted' };

  const bits = await permissionBits(userId, document.folder_id);
  if (!has(bits, PERM.DELETE)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  // The purge has already reclaimed the bytes. Restoring the row would produce a
  // document that lists and then fails to open, which is worse than refusing.
  if (Number(document.versions) === 0) return { ok: false, reason: 'content_purged' };

  await sql`
    UPDATE dbo.documents
       SET is_deleted = 0,
           deleted_at = NULL,
           deleted_by = NULL,
           restored_at = SYSUTCDATETIME(),
           restored_by = ${userId},
           updated_at = SYSUTCDATETIME()
     WHERE document_id = ${documentId}
  `.execute(db);

  log.info({ documentId: String(documentId) }, 'document restored');
  return { ok: true, title: document.title, folderId: String(document.folder_id) };
}

/**
 * Deletes a document's content immediately, before the grace period.
 *
 * Kept separate from the ordinary delete and gated the same way, because this is
 * the one operation with no undo. The blobs go on the next sweep; the row is
 * marked so it cannot be restored in the meantime.
 */
export async function purgeNow({ userId, documentId }) {
  const found = await sql`
    SELECT folder_id, is_deleted FROM dbo.documents WHERE document_id = ${documentId}
  `.execute(db);

  const document = found.rows[0];
  if (!document) return { ok: false, reason: 'not_found' };
  if (Number(document.is_deleted) !== 1) return { ok: false, reason: 'not_deleted' };

  const bits = await permissionBits(userId, document.folder_id);
  if (!has(bits, PERM.DELETE)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  // Backdating deleted_at is what makes the existing sweep pick it up, rather
  // than adding a second deletion path with its own ordering to get wrong.
  await sql`
    UPDATE dbo.documents
       SET deleted_at = DATEADD(year, -1, SYSUTCDATETIME())
     WHERE document_id = ${documentId}
  `.execute(db);

  log.warn({ documentId: String(documentId) }, 'document marked for immediate purge');
  return { ok: true };
}
