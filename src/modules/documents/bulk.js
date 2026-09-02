/**
 * Bulk operations: move, metadata edit, delete and ZIP download.
 *
 * ─── Permission is checked per document, never per batch ────────────────────
 *
 * A bulk action over fifty documents is fifty permission decisions. Checking
 * the first one and applying the rest is the obvious shortcut and the obvious
 * bug: a selection made from a search result can span folders with entirely
 * different grants.
 *
 * ─── Partial success is reported, not hidden ────────────────────────────────
 *
 * These return per-document outcomes rather than one boolean. A user who moved
 * fifty documents and is told "done" while nine were silently skipped has been
 * misled about where their documents are.
 */

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { normalizeArabic } from '../../lib/arabic.js';
import { PERM, permissionBits, has } from '../tree/service.js';

const log = moduleLogger('documents');

/** Caps a batch. A selection of ten thousand is a mistake, not an intention. */
const MAX_BATCH = 500;

function normaliseIds(documentIds) {
  return [...new Set((Array.isArray(documentIds) ? documentIds : []).map(String))]
    .filter((id) => /^[0-9]{1,19}$/.test(id))
    .slice(0, MAX_BATCH);
}

/**
 * Loads the documents in a batch with the caller's permission bits attached, so
 * the per-document decisions are one query rather than N.
 */
async function loadBatch(userId, ids) {
  if (ids.length === 0) return [];

  const result = await sql`
    SELECT d.document_id, d.title, d.folder_id, d.legal_hold, d.locked_by, d.current_version,
           p.perm_bits
      FROM dbo.documents d
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE d.is_deleted = 0
       -- Filtered here rather than reported as "forbidden" below: a document the
       -- caller cannot browse must be indistinguishable from one that does not
       -- exist, or a bulk action becomes a way to probe for document ids.
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND d.document_id IN (${sql.join(ids.map((id) => sql`${id}`))})
  `.execute(db);

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    title: row.title,
    folderId: String(row.folder_id),
    legalHold: Number(row.legal_hold) === 1,
    lockedBy: row.locked_by === null ? null : String(row.locked_by),
    currentVersion: Number(row.current_version),
    bits: Number(row.perm_bits),
  }));
}

/**
 * Moves documents to another folder.
 *
 * Requires DELETE on the source (it leaves) and UPLOAD on the destination (it
 * arrives) — the same two rights the equivalent manual operations would need.
 * Nothing on disk moves: the storage layout is keyed on upload date precisely so
 * that a move stays a single column update.
 */
export async function bulkMove({ userId, documentIds, targetFolderId }) {
  const ids = normaliseIds(documentIds);
  if (ids.length === 0) return { ok: false, reason: 'no_documents' };

  const targetBits = await permissionBits(userId, targetFolderId);
  if (!has(targetBits, PERM.UPLOAD)) {
    return { ok: false, reason: has(targetBits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const batch = await loadBatch(userId, ids);
  const results = [];

  for (const document of batch) {
    if (!has(document.bits, PERM.DELETE)) {
      results.push({ documentId: document.documentId, ok: false, reason: 'forbidden' });
      continue;
    }
    if (document.legalHold) {
      results.push({ documentId: document.documentId, ok: false, reason: 'legal_hold' });
      continue;
    }
    if (document.folderId === String(targetFolderId)) {
      results.push({ documentId: document.documentId, ok: true, skipped: 'already_there' });
      continue;
    }

    await sql`
      UPDATE dbo.documents
         SET folder_id = ${targetFolderId}, updated_at = SYSUTCDATETIME(), updated_by = ${userId}
       WHERE document_id = ${document.documentId}
    `.execute(db);

    results.push({ documentId: document.documentId, ok: true });
  }

  // Ids that resolved to nothing were invisible or deleted — reported so the
  // count the user sees matches the selection they made.
  for (const id of ids) {
    if (!batch.some((d) => d.documentId === id)) {
      results.push({ documentId: id, ok: false, reason: 'not_found' });
    }
  }

  log.info({ moved: results.filter((r) => r.ok).length, target: String(targetFolderId) }, 'bulk move');
  return summarise(results);
}

/** Applies the same type, label or field values to every document in a batch. */
export async function bulkUpdateMetadata({ userId, documentIds, typeId, labelId, fields }) {
  const ids = normaliseIds(documentIds);
  if (ids.length === 0) return { ok: false, reason: 'no_documents' };

  const { prepareFieldValues, writeFieldValues } = await import('../metadata/service.js');

  const validated = await prepareFieldValues(fields);
  if (!validated.ok) return validated;

  const batch = await loadBatch(userId, ids);
  const results = [];

  for (const document of batch) {
    if (!has(document.bits, PERM.EDIT_META)) {
      results.push({ documentId: document.documentId, ok: false, reason: 'forbidden' });
      continue;
    }

    await db.transaction().execute(async (trx) => {
      if (typeId !== undefined || labelId !== undefined) {
        await sql`
          UPDATE dbo.documents
             SET type_id = ${typeId === undefined ? sql`type_id` : typeId},
                 sensitivity_label_id = ${labelId === undefined ? sql`sensitivity_label_id` : labelId},
                 updated_at = SYSUTCDATETIME(),
                 updated_by = ${userId}
           WHERE document_id = ${document.documentId}
        `.execute(trx);
      }

      if (validated.prepared.length > 0) {
        await writeFieldValues(trx, document.documentId, validated.prepared);
      }
    });

    results.push({ documentId: document.documentId, ok: true });
  }

  return summarise(results);
}

export async function bulkDelete({ userId, documentIds }) {
  const ids = normaliseIds(documentIds);
  if (ids.length === 0) return { ok: false, reason: 'no_documents' };

  const batch = await loadBatch(userId, ids);
  const results = [];

  for (const document of batch) {
    if (!has(document.bits, PERM.DELETE)) {
      results.push({ documentId: document.documentId, ok: false, reason: 'forbidden' });
      continue;
    }
    // Legal hold outranks the Delete permission, including for an administrator.
    // That is the whole point of a hold.
    if (document.legalHold) {
      results.push({ documentId: document.documentId, ok: false, reason: 'legal_hold' });
      continue;
    }

    await sql`
      UPDATE dbo.documents
         SET is_deleted = 1, deleted_at = SYSUTCDATETIME(), deleted_by = ${userId}
       WHERE document_id = ${document.documentId}
    `.execute(db);

    results.push({ documentId: document.documentId, ok: true });
  }

  return summarise(results);
}

/**
 * Streams a ZIP of the selected documents.
 *
 * Streamed rather than assembled in memory: a selection of fifty scans is
 * hundreds of megabytes, and buffering it is how a file server runs out of heap
 * serving exactly the request it exists for.
 *
 * Requires READ per document — a browse-only document is omitted rather than
 * included empty, and the manifest inside the archive says which and why.
 */
export async function buildZip({ userId, documentIds, reply }) {
  const ids = normaliseIds(documentIds);
  if (ids.length === 0) return { ok: false, reason: 'no_documents' };

  const batch = await loadBatch(userId, ids);
  const readable = batch.filter((document) => has(document.bits, PERM.READ));

  if (readable.length === 0) return { ok: false, reason: 'nothing_readable' };

  // Both file axes.
  //
  // Matching only on version_number = current_version silently drops every
  // multi-file document: those have no version row at all. The user would
  // select ten documents, receive eight files, and find nothing in the archive
  // or the manifest to say what happened to the other two.
  const readableIds = sql.join(readable.map((d) => sql`${d.documentId}`));
  const versions = await sql`
    SELECT c.document_id, c.storage_path, c.original_filename, c.sort_order, d.title
      FROM (
            SELECT v.document_id, v.storage_path, v.original_filename,
                   CAST(NULL AS int) AS sort_order, v.version_number
              FROM dbo.document_versions v
             UNION ALL
            SELECT df.document_id, df.storage_path, df.original_filename,
                   df.sort_order, NULL AS version_number
              FROM dbo.document_files df
           ) c
      JOIN dbo.documents d ON d.document_id = c.document_id
     WHERE (c.version_number IS NULL OR c.version_number = d.current_version)
       AND c.document_id IN (${readableIds})
     ORDER BY c.document_id, c.sort_order
  `.execute(db);

  const { default: archiver } = await import('archiver');
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('warning', (error) => log.warn({ err: error }, 'zip warning'));
  archive.on('error', (error) => log.error({ err: error }, 'zip failed'));

  const used = new Map();
  for (const row of versions.rows) {
    // Two documents can legitimately share a title. Suffixing keeps both rather
    // than letting the second overwrite the first inside the archive.
    const base = row.original_filename || `${row.title}`;

    // A multi-file document becomes a directory inside the archive, named after
    // the document and holding its files in reading order. Flattening them
    // alongside everything else would scatter one document's pages through the
    // archive with nothing to say they belong together.
    const entry =
      row.sort_order === null
        ? base
        : `${row.title}/${String(row.sort_order + 1).padStart(2, '0')}-${base}`;

    const count = (used.get(entry) ?? 0) + 1;
    used.set(entry, count);
    const name = count === 1 ? entry : `${count}_${entry}`;

    archive.append(storage.createReadStream(row.storage_path), { name });
  }

  const omitted = batch.filter((document) => !has(document.bits, PERM.READ));
  if (omitted.length > 0) {
    archive.append(
      [
        'لم تُدرج الوثائق التالية لعدم توفر صلاحية القراءة:',
        ...omitted.map((document) => `- ${document.title}`),
        '',
      ].join('\n'),
      { name: 'ملاحظة.txt' },
    );
  }

  archive.finalize();

  return { ok: true, stream: archive, count: versions.rows.length, omitted: omitted.length };
}

function summarise(results) {
  const succeeded = results.filter((r) => r.ok).length;
  return {
    ok: true,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export { normaliseIds, MAX_BATCH };
