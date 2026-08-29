/**
 * Document upload, versioning and content access.
 *
 * ─── Write ordering ─────────────────────────────────────────────────────────
 *
 * The invariant: a committed document row always has a durable file behind it.
 * An unreferenced file is harmless — the sweep removes it. A row pointing at a
 * file that is not there is silent corruption that only surfaces when someone
 * tries to open a document, possibly months later.
 *
 * So the order is:
 *
 *   1. stream the upload to a staging path, fsync, rename            (slow, no transaction)
 *   2. BEGIN — insert the document and version rows
 *   3. promote the staged file to its final path                     (rename, microseconds)
 *   4. COMMIT
 *
 * The final path contains the document id, which does not exist until step 2 —
 * hence staging. Doing the streaming inside the transaction instead would hold
 * it open for as long as a 200MB transfer over SMB takes.
 */

import { randomUUID } from 'node:crypto';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { buildRelativePath } from '../../storage/paths.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, permissionBits, has } from '../tree/service.js';

const log = moduleLogger('documents');

/** Staging lives under the storage root so the promote is a same-volume rename. */
const STAGING_DIR = '.staging';

/**
 * Streams an upload to durable staging.
 * Returns what is needed to finish the write, or a failure reason.
 */
async function stageUpload(stream) {
  const stagedPath = `${STAGING_DIR}/${randomUUID()}.part`;
  try {
    const stored = await storage.put(stream, {
      relativePath: stagedPath,
      maxBytes: config.storage.maxUploadBytes,
    });
    return { ok: true, staged: stored };
  } catch (error) {
    if (error.code === 'upload_too_large') return { ok: false, reason: 'too_large' };
    if (error.code === 'empty_upload') return { ok: false, reason: 'empty_file' };
    log.error({ err: error }, 'staging an upload failed');
    return { ok: false, reason: 'storage_failed' };
  }
}

/** Removes a staged file after a failure. Best effort — an orphan is swept later. */
async function discardStaged(staged) {
  if (staged) await storage.remove(staged.relativePath).catch(() => {});
}

/**
 * Creates a document and its first version.
 *
 * @param {object} args
 * @param {bigint|string} args.userId
 * @param {string} args.folderId
 * @param {string} args.title
 * @param {import('node:stream').Readable} args.stream
 * @param {string} [args.filename] used only to derive the extension
 * @param {string} [args.mimeType]
 * @param {number|null} [args.typeId]
 */
export async function createDocument({
  userId,
  folderId,
  title,
  stream,
  filename,
  mimeType,
  typeId = null,
}) {
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) return { ok: false, reason: 'invalid_title' };
  if (cleanTitle.length > 500) return { ok: false, reason: 'invalid_title' };

  // Permission is checked before a byte is written, so a user with no rights
  // cannot fill the disk. It is checked again implicitly by the folder FK.
  const bits = await permissionBits(userId, folderId);
  if (!has(bits, PERM.UPLOAD)) {
    // The stream must still be drained, or the client sees a stalled connection
    // rather than the error response.
    stream.resume();
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const staging = await stageUpload(stream);
  if (!staging.ok) return staging;

  try {
    const result = await db.transaction().execute(async (trx) => {
      const inserted = await sql`
        INSERT INTO dbo.documents (folder_id, type_id, title, current_version, created_by)
        OUTPUT INSERTED.document_id AS did, INSERTED.created_at AS created_at
        VALUES (${folderId}, ${typeId}, ${cleanTitle}, 1, ${userId})
      `.execute(trx);

      const documentId = inserted.rows[0].did;
      const createdAt = inserted.rows[0].created_at;

      const relativePath = buildRelativePath({
        documentId,
        version: 1,
        title: cleanTitle,
        originalFilename: filename,
        createdAt,
        maxTitleLength: config.storage.maxTitleLength,
      });

      await sql`
        INSERT INTO dbo.document_versions
          (document_id, version_number, storage_path, original_filename,
           file_size_bytes, sha256, mime_type, uploaded_by)
        VALUES (${documentId}, 1, ${relativePath}, ${filename ?? null},
                ${staging.staged.bytes}, ${staging.staged.sha256},
                ${mimeType || 'application/octet-stream'}, ${userId})
      `.execute(trx);

      // Inside the transaction and after the rows: if this throws, the insert
      // rolls back and nothing references a file that was never put in place.
      await storage.promote(staging.staged.relativePath, relativePath);

      return { documentId, relativePath, createdAt };
    });

    log.info(
      { documentId: String(result.documentId), folderId: String(folderId), bytes: staging.staged.bytes },
      'document created',
    );

    return {
      ok: true,
      documentId: String(result.documentId),
      version: 1,
      sha256: staging.staged.sha256,
      bytes: staging.staged.bytes,
    };
  } catch (error) {
    await discardStaged(staging.staged);
    log.error({ err: error, folderId: String(folderId) }, 'document creation failed');
    return { ok: false, reason: 'storage_failed' };
  }
}

/**
 * Adds a new version to an existing document.
 *
 * Versions are immutable: this never overwrites the previous file. The old
 * version stays readable, which is the point of versioning and also what makes
 * "restore the previous one" a metadata change rather than a recovery job.
 */
export async function addVersion({ userId, documentId, stream, filename, mimeType, comment }) {
  const found = await sql`
    SELECT d.document_id, d.folder_id, d.title, d.current_version, d.created_at
      FROM dbo.documents d
     WHERE d.document_id = ${documentId} AND d.is_deleted = 0
  `.execute(db);

  const document = found.rows[0];
  if (!document) {
    stream.resume();
    return { ok: false, reason: 'not_found' };
  }

  const bits = await permissionBits(userId, document.folder_id);
  if (!has(bits, PERM.UPLOAD)) {
    stream.resume();
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const staging = await stageUpload(stream);
  if (!staging.ok) return staging;

  try {
    const nextVersion = Number(document.current_version) + 1;

    const relativePath = buildRelativePath({
      documentId: document.document_id,
      version: nextVersion,
      title: document.title,
      originalFilename: filename,
      createdAt: document.created_at,
      maxTitleLength: config.storage.maxTitleLength,
    });

    await db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO dbo.document_versions
          (document_id, version_number, storage_path, original_filename,
           file_size_bytes, sha256, mime_type, comment, uploaded_by)
        VALUES (${document.document_id}, ${nextVersion}, ${relativePath}, ${filename ?? null},
                ${staging.staged.bytes}, ${staging.staged.sha256},
                ${mimeType || 'application/octet-stream'}, ${comment ?? null}, ${userId})
      `.execute(trx);

      // current_version moves in the same transaction as the version row, which
      // is what keeps the denormalised pointer from ever being wrong.
      //
      // The WHERE guards against two concurrent uploads both computing the same
      // next version: the second finds current_version already advanced, updates
      // nothing, and the PK on (document_id, version_number) has already rejected
      // its insert anyway.
      const updated = await sql`
        UPDATE dbo.documents
           SET current_version = ${nextVersion},
               updated_at = SYSUTCDATETIME(),
               updated_by = ${userId}
         WHERE document_id = ${document.document_id}
           AND current_version = ${document.current_version}
      `.execute(trx);

      if (Number(updated.numAffectedRows ?? 0) !== 1) {
        throw new Error('concurrent version conflict');
      }

      await storage.promote(staging.staged.relativePath, relativePath);
    });

    log.info({ documentId: String(documentId), version: nextVersion }, 'version added');
    return { ok: true, documentId: String(documentId), version: nextVersion, sha256: staging.staged.sha256 };
  } catch (error) {
    await discardStaged(staging.staged);
    if (String(error.message).includes('concurrent version conflict')) {
      return { ok: false, reason: 'conflict' };
    }
    log.error({ err: error, documentId: String(documentId) }, 'adding a version failed');
    return { ok: false, reason: 'storage_failed' };
  }
}

/**
 * Resolves a document version for reading, enforcing READ.
 *
 * This is the gate on the bytes. The listing's `canRead` flag is a rendering
 * hint and is never consulted here — a client that ignores it still gets 404.
 *
 * @param {object} args
 * @param {number} [args.version] defaults to the current version
 */
export async function getVersionForRead({ userId, documentId, version }) {
  const result = await sql`
    SELECT v.version_number, v.storage_path, v.file_size_bytes, v.sha256,
           v.mime_type, v.original_filename,
           d.title, d.folder_id,
           p.perm_bits
      FROM dbo.documents d
      JOIN dbo.document_versions v
        ON v.document_id = d.document_id
       AND v.version_number = COALESCE(${version ?? null}, d.current_version)
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE d.document_id = ${documentId}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.READ}) <> 0
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  return {
    versionNumber: Number(row.version_number),
    storagePath: row.storage_path,
    bytes: Number(row.file_size_bytes),
    sha256: row.sha256,
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    title: row.title,
  };
}

/** Document metadata and its version history, gated on BROWSE. */
export async function getDocument({ userId, documentId }) {
  const result = await sql`
    SELECT d.document_id, d.folder_id, d.title, d.type_id, d.sensitivity_label_id,
           d.current_version, d.created_at, d.updated_at,
           t.name AS type_name, s.name AS sensitivity_name,
           p.perm_bits
      FROM dbo.documents d
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_types     t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels s ON s.label_id = d.sensitivity_label_id
     WHERE d.document_id = ${documentId}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  const canRead = (Number(row.perm_bits) & PERM.READ) !== 0;

  // Version history is content-adjacent: it reveals how often a document changed
  // and who touched it. Browse-only sees that versions exist, not their detail.
  const versions = canRead
    ? (
        await sql`
          SELECT v.version_number, v.file_size_bytes, v.mime_type, v.uploaded_at,
                 v.comment, pr.display_name AS uploaded_by
            FROM dbo.document_versions v
            JOIN dbo.principals pr ON pr.principal_id = v.uploaded_by
           WHERE v.document_id = ${documentId}
           ORDER BY v.version_number DESC
        `.execute(db)
      ).rows.map((v) => ({
        version: Number(v.version_number),
        bytes: Number(v.file_size_bytes),
        mimeType: v.mime_type,
        uploadedAt: v.uploaded_at,
        uploadedBy: v.uploaded_by,
        comment: v.comment,
      }))
    : [];

  return {
    documentId: String(row.document_id),
    folderId: String(row.folder_id),
    title: row.title,
    typeId: row.type_id,
    typeName: row.type_name,
    sensitivity: row.sensitivity_name,
    currentVersion: Number(row.current_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canRead,
    versions,
  };
}

/**
 * Soft-deletes a document. The file stays on disk until the purge grace period
 * expires — a delete that immediately destroys bytes has no undo, and "someone
 * deleted the wrong contract" is a routine support call.
 */
export async function deleteDocument({ userId, documentId }) {
  const found = await sql`
    SELECT folder_id FROM dbo.documents WHERE document_id = ${documentId} AND is_deleted = 0
  `.execute(db);

  const document = found.rows[0];
  if (!document) return { ok: false, reason: 'not_found' };

  const bits = await permissionBits(userId, document.folder_id);
  if (!has(bits, PERM.DELETE)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  await sql`
    UPDATE dbo.documents
       SET is_deleted = 1, deleted_at = SYSUTCDATETIME(), deleted_by = ${userId}
     WHERE document_id = ${documentId}
  `.execute(db);

  log.info({ documentId: String(documentId) }, 'document soft-deleted');
  return { ok: true };
}
