/**
 * Filing tree queries.
 *
 * ─── The rule this file exists to hold ──────────────────────────────────────
 *
 * Permission filtering happens IN SQL, in the same query that fetches the rows.
 * Not afterwards in JavaScript, and never by returning everything plus a bitmask
 * and trusting the caller to check it.
 *
 * The difference matters for a reason that is easy to miss: a listing filtered
 * in JavaScript has already loaded the forbidden rows, so any bug in the filter,
 * any new caller, any `console.log`, any error serialiser that dumps the query
 * result, leaks them. A row that never leaves the database cannot leak. It also
 * makes pagination correct — "page 2 of what this user can see" is not something
 * you can compute after the fact from a page of mixed rows.
 *
 * ─── Browse versus Read ─────────────────────────────────────────────────────
 *
 * BROWSE means the folder and the titles inside it exist. READ means the content
 * can be opened. The requirement was explicit: a user may see that a document is
 * there without being able to open it.
 *
 * So a document row is returned when the user has BROWSE, and carries canRead so
 * the UI knows whether to offer the download. The content endpoint checks READ
 * itself and does not trust that flag — canRead is a hint for rendering, never
 * the thing that guards the bytes.
 */

import { db, sql } from '../../db/index.js';
import { filterPredicate, totalBytesExpression } from '../search/filters.js';
import { PERM } from '../../db/migrations/0001-identity-and-acl.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('tree');

// PERM is imported from the migration because that is where the bitmask is
// defined and frozen. A second copy in application code is a copy that can drift
// from the schema the database is actually enforcing.
export { PERM };

/**
 * Effective permission bits for one user on one folder.
 *
 * fn_effective_permission computes live from the ACL and returns 0 for a deleted
 * folder, an inactive user or a folder that does not exist — so callers get a
 * safe answer without a separate existence check.
 */
export async function permissionBits(userId, folderId) {
  const result = await sql`
    SELECT perm_bits FROM dbo.fn_effective_permission(${userId}, ${folderId})
  `.execute(db);
  return Number(result.rows[0]?.perm_bits ?? 0);
}

export const has = (bits, verb) => (bits & verb) !== 0;

/**
 * Returns the folder itself, or null when the user may not browse it.
 *
 * "Not permitted" and "does not exist" deliberately produce the same null. A
 * distinct 403 would confirm that a folder id is real, which is a slow directory
 * listing for anyone willing to iterate.
 */
export async function getFolder(userId, folderId) {
  const result = await sql`
    SELECT f.folder_id, f.parent_id, f.name, f.mpath, f.depth,
           f.inherits_acl, f.created_at, f.updated_at,
           p.perm_bits
      FROM dbo.folders f
     CROSS APPLY dbo.fn_effective_permission(${userId}, f.folder_id) p
     WHERE f.folder_id = ${folderId}
       AND f.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  return {
    folderId: row.folder_id,
    parentId: row.parent_id,
    name: row.name,
    depth: row.depth,
    inheritsAcl: Number(row.inherits_acl) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: describeBits(Number(row.perm_bits)),
  };
}

/**
 * Subfolders of `parentId` that the user may browse. Pass null for the roots.
 *
 * A folder the user cannot browse is simply absent — not greyed out, not a
 * placeholder. The tree a user sees is the tree they have.
 */
/**
 * Every folder the user may browse, as a flat list for the client to nest.
 *
 * One query rather than a request per expanded node: a filing tree is browsed by
 * clicking around it, and a round trip per expand makes that feel broken. At a
 * few thousand folders the whole visible tree is a handful of kilobytes.
 *
 * ─── Orphans are real and must not be dropped ───────────────────────────────
 *
 * A folder can be visible while its parent is not: breaking inheritance and
 * granting on the child produces exactly that, and it is a normal way to share
 * one subfolder out of a private branch. Such a folder's parent_id points at
 * something absent from this result, so the caller must treat any folder whose
 * parent is not in the set as a root. Filtering them out instead would hide
 * folders the user has been deliberately granted.
 *
 * Ordered by mpath, which is depth-first: a parent always precedes its
 * descendants, so a single pass can build the tree.
 */
export async function listTree(userId, { limit = 5000 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 5000, 1), 20_000);

  const result = await sql`
    SELECT TOP (${cap + 1})
           f.folder_id, f.parent_id, f.name, f.depth, f.inherits_acl,
           p.perm_bits,
           ISNULL(counts.document_count, 0) AS document_count
      FROM dbo.folders f
     CROSS APPLY dbo.fn_effective_permission(${userId}, f.folder_id) p
      LEFT JOIN (
            SELECT folder_id, COUNT(*) AS document_count
              FROM dbo.documents
             WHERE is_deleted = 0
             GROUP BY folder_id
           ) counts ON counts.folder_id = f.folder_id
     WHERE f.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
     ORDER BY f.mpath
  `.execute(db);

  // One row over the cap means there are more. Reporting it beats silently
  // returning a truncated tree that looks complete.
  const truncated = result.rows.length > cap;
  const rows = truncated ? result.rows.slice(0, cap) : result.rows;

  return {
    folders: rows.map((row) => ({
      folderId: String(row.folder_id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      name: row.name,
      depth: Number(row.depth),
      inheritsAcl: Number(row.inherits_acl) === 1,
      documentCount: Number(row.document_count),
      permissions: describeBits(Number(row.perm_bits)),
    })),
    truncated,
  };
}

/**
 * The chain of ancestors from the root down to `folderId`, for a breadcrumb.
 *
 * Walks the materialized path rather than recursing: mpath already holds the
 * ancestor ids in order, so this is one indexed lookup per level with no
 * recursive CTE.
 *
 * An ancestor the user cannot browse is returned as a placeholder with a null
 * name rather than omitted, so the breadcrumb still shows the true depth instead
 * of implying the folder sits closer to the root than it does.
 */
export async function getAncestors(userId, folderId) {
  const found = await sql`
    SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);

  if (!found.rows[0]) return [];

  // '/3/17/42/' -> ['3','17','42']
  const ids = String(found.rows[0].mpath).split('/').filter(Boolean);
  if (ids.length === 0) return [];

  const result = await sql`
    SELECT f.folder_id, f.name, f.depth, p.perm_bits
      FROM dbo.folders f
     CROSS APPLY dbo.fn_effective_permission(${userId}, f.folder_id) p
     WHERE f.folder_id IN (${sql.join(ids.map((value) => sql`${value}`))})
       AND f.is_deleted = 0
  `.execute(db);

  const byId = new Map(result.rows.map((row) => [String(row.folder_id), row]));

  return ids.map((ancestorId) => {
    const row = byId.get(ancestorId);
    const visible = row ? (Number(row.perm_bits) & PERM.BROWSE) !== 0 : false;
    return {
      folderId: ancestorId,
      name: visible ? row.name : null,
      visible,
    };
  });
}

export async function listSubfolders(userId, parentId) {
  const result = await sql`
    SELECT f.folder_id, f.name, f.depth, f.inherits_acl, f.created_at, p.perm_bits,
           (SELECT COUNT(*) FROM dbo.documents d
             WHERE d.folder_id = f.folder_id AND d.is_deleted = 0) AS document_count
      FROM dbo.folders f
     CROSS APPLY dbo.fn_effective_permission(${userId}, f.folder_id) p
     WHERE f.is_deleted = 0
       AND (${parentId ?? null} IS NULL AND f.parent_id IS NULL
            OR f.parent_id = ${parentId ?? null})
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
     ORDER BY f.name
  `.execute(db);

  return result.rows.map((row) => ({
    folderId: row.folder_id,
    name: row.name,
    depth: row.depth,
    documentCount: Number(row.document_count),
    permissions: describeBits(Number(row.perm_bits)),
  }));
}

/**
 * Documents directly inside one folder, newest first.
 *
 * Keyset pagination rather than OFFSET/FETCH: OFFSET makes the server read and
 * discard every skipped row, so page 500 costs 500 pages of work. The cursor is
 * (created_at, document_id) because created_at alone is not unique and a tie at
 * a page boundary would drop or repeat a row.
 *
 * The cursor timestamp is sent as an ISO STRING and converted in SQL, never as a
 * JS Date. tedious binds a Date as SQL Server's `datetime`, whose resolution is
 * 3.33ms — so a value read from a datetime2(3) column and sent straight back does
 * not compare equal to itself. That silently disabled the `created_at = cursor`
 * tie-break branch, and documents sharing a millisecond were served twice. Style
 * 126 is ISO 8601 and parses exactly.
 */
export async function listDocuments(userId, folderId, { limit = 50, cursor, filters = null } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const cursorIso = cursor?.createdAt ? new Date(cursor.createdAt).toISOString() : null;
  const cursorId = cursor?.documentId ?? null;

  // Filters narrow, they never reorder: the keyset cursor is (created_at,
  // document_id) and stays that way, so a filtered listing pages exactly as an
  // unfiltered one does and an outstanding cursor remains valid.
  const narrowing = filters ? filterPredicate(filters) : sql``;

  const result = await sql`
    SELECT TOP (${pageSize + 1})
           d.document_id, d.title, d.type_id, d.sensitivity_label_id,
           d.current_version, d.created_at, d.updated_at,
           t.name AS type_name,
           s.name AS sensitivity_name,
           v.mime_type, v.original_filename,
           -- Total size across whichever axis holds the files, so a multi-file
           -- document reports what it actually occupies rather than NULL.
           ${totalBytesExpression} AS file_size_bytes,
           (SELECT COUNT(*) FROM dbo.document_files df
             WHERE df.document_id = d.document_id) AS file_count,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read
      FROM dbo.documents d
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_types      t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels  s ON s.label_id = d.sensitivity_label_id
      -- The current version, for the row preview: it decides whether the browser
      -- can draw the file itself or has to ask for a rendition. LEFT because a
      -- document row can exist before its first version does — and because a
      -- multi-file document never has one.
      LEFT JOIN dbo.document_versions   v ON v.document_id = d.document_id
                                         AND v.version_number = d.current_version
     WHERE d.folder_id = ${folderId}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${cursorIso} IS NULL
            OR d.created_at < CONVERT(datetime2(3), ${cursorIso}, 126)
            OR (d.created_at = CONVERT(datetime2(3), ${cursorIso}, 126)
                AND d.document_id < CONVERT(bigint, ${cursorId})))
       ${narrowing}
     ORDER BY d.created_at DESC, d.document_id DESC
  `.execute(db);

  // One row over the page size tells us another page exists without a COUNT.
  const hasMore = result.rows.length > pageSize;
  const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
  const last = rows[rows.length - 1];

  return {
    documents: rows.map((row) => {
      // A hint for the UI. The content route checks READ for itself.
      const canRead = Number(row.can_read) === 1;

      return {
        documentId: row.document_id,
        title: row.title,
        typeId: row.type_id,
        typeName: row.type_name,
        sensitivity: row.sensitivity_name,
        currentVersion: Number(row.current_version),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canRead,
        // Withheld from a browse-only user on purpose. The requirement is that
        // such a user learns a document exists and nothing more, and a filename
        // is frequently the most revealing thing about a document — "استقالة
        // 2026.pdf" discloses the content the permission was meant to withhold.
        mimeType: canRead ? row.mime_type : null,
        originalFilename: canRead ? row.original_filename : null,
        bytes: canRead && row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
        // Stated rather than left for the client to infer from a null mimeType,
        // which is also what an unreadable row looks like. Not gated on READ:
        // that a document is made of several files is structure, not content,
        // and the row has to render an icon either way.
        multiFile: Number(row.file_count) > 0,
        fileCount: Number(row.file_count),
      };
    }),
    nextCursor: hasMore && last ? { createdAt: last.created_at, documentId: String(last.document_id) } : null,
  };
}

/**
 * Creates a folder.
 *
 * mpath is written in the same transaction as the row, using the id the insert
 * just produced. It cannot be computed beforehand because it contains that id,
 * and leaving it provisional even briefly would let a concurrent permission
 * query walk a path that points nowhere.
 */
export async function createFolder(userId, { parentId, name }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'invalid_name' };
  if (trimmed.length > 400) return { ok: false, reason: 'invalid_name' };

  let parent = null;
  if (parentId != null) {
    const found = await sql`
      SELECT folder_id, mpath, depth FROM dbo.folders
       WHERE folder_id = ${parentId} AND is_deleted = 0
    `.execute(db);
    parent = found.rows[0] ?? null;
    if (!parent) return { ok: false, reason: 'not_found' };

    // Creating inside a folder is adding content to it, which is UPLOAD.
    const bits = await permissionBits(userId, parentId);
    if (!has(bits, PERM.UPLOAD)) return { ok: false, reason: 'forbidden' };

    if (Number(parent.depth) >= 32) return { ok: false, reason: 'too_deep' };
  }

  const folderId = await db.transaction().execute(async (trx) => {
    const inserted = await sql`
      INSERT INTO dbo.folders (parent_id, name, mpath, depth, created_by)
      OUTPUT INSERTED.folder_id AS fid
      VALUES (${parentId ?? null}, ${trimmed}, '/pending/', ${parent ? Number(parent.depth) + 1 : 0}, ${userId})
    `.execute(trx);

    const fid = inserted.rows[0].fid;
    const mpath = `${parent ? parent.mpath : '/'}${fid}/`;
    await sql`UPDATE dbo.folders SET mpath = ${mpath} WHERE folder_id = ${fid}`.execute(trx);
    return fid;
  });

  return { ok: true, folderId };
}

/**
 * Deletes a folder, but only one that holds nothing.
 *
 * ─── Why emptiness is required rather than cascaded ─────────────────────────
 *
 * A recursive delete of a filing tree is the single most destructive action this
 * system could offer, and it is the one an accidental click can least afford. A
 * folder that still holds documents or subfolders is refused, with a count of
 * what is in the way, so the operator empties it deliberately and can see what
 * they are emptying.
 *
 * ─── What counts as content ─────────────────────────────────────────────────
 *
 * A soft-deleted document still belongs to this folder and is still restorable
 * to it, so it counts. Removing the folder from under it would strand the
 * restore with nowhere to put the document back. Only a folder with no live
 * subfolders and no documents at all — deleted or not — can go.
 *
 * The delete itself is soft, like a document's, so the row and its audit trail
 * survive and the tree can be put back.
 */
export async function deleteFolder(userId, folderId) {
  const found = await sql`
    SELECT folder_id, name, parent_id FROM dbo.folders
     WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);

  const folder = found.rows[0];
  if (!folder) return { ok: false, reason: 'not_found' };

  // Deleting a folder is a delete, so it takes the delete verb on that folder.
  // Absence rather than refusal for someone who cannot even see it.
  const bits = await permissionBits(userId, folderId);
  if (!has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.DELETE)) return { ok: false, reason: 'forbidden' };

  /*
   * Live and binned documents counted separately — and a tombstone is neither.
   *
   * A binned document blocks because it is still restorable to this folder, and
   * it gets its own number because the folder listing shows live documents only:
   * a folder reading "0 وثيقة" refused for holding one is a flat
   * contradiction unless the refusal says where that one is.
   *
   * But once the purge has taken its content, restoring it is impossible
   * forever — `restore` refuses with `content_purged`, and no sweep will ever
   * remove the row, because the tombstone is deliberately kept for the audit
   * trail. Counting it here made such a folder permanently undeletable: the
   * refusal named a document, the recycle bin offered nothing to do with it, and
   * running the cleanup again found nothing left to purge. A closed loop with no
   * exit anywhere in the product.
   *
   * So emptiness asks whether anything can still come back, not whether a row
   * exists. A tombstone keeps its folder_id — the folder is soft-deleted too, so
   * the audit trail still resolves the name it refers to.
   */
  const counts = await sql`
    SELECT
      (SELECT COUNT(*) FROM dbo.folders f
        WHERE f.parent_id = ${folderId} AND f.is_deleted = 0) AS subfolders,
      (SELECT COUNT(*) FROM dbo.documents d
        WHERE d.folder_id = ${folderId} AND d.is_deleted = 0) AS documents,
      (SELECT COUNT(*) FROM dbo.documents d
        WHERE d.folder_id = ${folderId} AND d.is_deleted = 1
          AND (EXISTS (SELECT 1 FROM dbo.document_versions v
                        WHERE v.document_id = d.document_id)
            OR EXISTS (SELECT 1 FROM dbo.document_files df
                        WHERE df.document_id = d.document_id))) AS binned
  `.execute(db);

  const subfolders = Number(counts.rows[0].subfolders);
  const documents = Number(counts.rows[0].documents);
  const binned = Number(counts.rows[0].binned);

  if (subfolders > 0 || documents > 0 || binned > 0) {
    return { ok: false, reason: 'not_empty', subfolders, documents, binned };
  }

  await sql`
    UPDATE dbo.folders
       SET is_deleted = 1, deleted_at = SYSUTCDATETIME()
     WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);

  log.info({ folderId: String(folderId), userId: String(userId) }, 'folder deleted');
  return { ok: true, name: folder.name, parentId: folder.parent_id };
}

/** Turns a bitmask into the shape the UI wants, so no client re-implements the masks. */
export function describeBits(bits) {
  return {
    browse: has(bits, PERM.BROWSE),
    read: has(bits, PERM.READ),
    upload: has(bits, PERM.UPLOAD),
    editMeta: has(bits, PERM.EDIT_META),
    delete: has(bits, PERM.DELETE),
    managePerms: has(bits, PERM.MANAGE_PERMS),
  };
}
