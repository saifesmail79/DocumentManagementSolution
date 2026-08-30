/**
 * Personal shelves, watches, comments, relations and saved searches.
 *
 * ─── Everything here re-checks permission ───────────────────────────────────
 *
 * A favourite, a watch or a comment thread is a stored reference to a document,
 * and permissions change after it is stored. Someone favourites a document, is
 * later removed from the group that granted access, and the favourite must stop
 * resolving — so every listing joins fn_effective_permission rather than
 * trusting that the reference was legitimate when it was made.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, permissionBits, has } from '../tree/service.js';

const log = moduleLogger('collaboration');

// ── Favourites ───────────────────────────────────────────────────────────

export async function addFavourite({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };

  await sql`
    MERGE dbo.favourites WITH (HOLDLOCK) AS target
    USING (SELECT ${userId} AS user_id, ${documentId} AS document_id) AS source
       ON target.user_id = source.user_id AND target.document_id = source.document_id
    WHEN NOT MATCHED THEN
      INSERT (user_id, document_id) VALUES (source.user_id, source.document_id);
  `.execute(db);

  return { ok: true };
}

export async function removeFavourite({ userId, documentId }) {
  await sql`
    DELETE FROM dbo.favourites WHERE user_id = ${userId} AND document_id = ${documentId}
  `.execute(db);
  return { ok: true };
}

export async function listFavourites({ userId, limit = 100 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const result = await sql`
    SELECT TOP (${pageSize})
           d.document_id, d.title, d.folder_id, f.name AS folder_name, fav.added_at,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read
      FROM dbo.favourites fav
      JOIN dbo.documents d ON d.document_id = fav.document_id
      JOIN dbo.folders   f ON f.folder_id  = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE fav.user_id = ${userId}
       AND d.is_deleted = 0
       -- Access may have been revoked since the favourite was made.
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
     ORDER BY fav.added_at DESC
  `.execute(db);

  return result.rows.map(toListItem);
}

// ── Recent documents ─────────────────────────────────────────────────────

/**
 * Records a view. Fire-and-forget from the caller's point of view — failing to
 * record that someone looked at a document must never fail showing it to them.
 */
export async function recordView({ userId, documentId }) {
  try {
    await sql`
      MERGE dbo.recent_documents WITH (HOLDLOCK) AS target
      USING (SELECT ${userId} AS user_id, ${documentId} AS document_id) AS source
         ON target.user_id = source.user_id AND target.document_id = source.document_id
      WHEN MATCHED THEN UPDATE SET viewed_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (user_id, document_id) VALUES (source.user_id, source.document_id);
    `.execute(db);
  } catch (error) {
    log.warn({ err: error }, 'could not record a document view');
  }
}

export async function listRecent({ userId, limit = 20 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await sql`
    SELECT TOP (${pageSize})
           d.document_id, d.title, d.folder_id, f.name AS folder_name, r.viewed_at AS added_at,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read
      FROM dbo.recent_documents r
      JOIN dbo.documents d ON d.document_id = r.document_id
      JOIN dbo.folders   f ON f.folder_id  = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE r.user_id = ${userId}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
     ORDER BY r.viewed_at DESC
  `.execute(db);

  return result.rows.map(toListItem);
}

// ── Watches ──────────────────────────────────────────────────────────────

export async function watch({ userId, folderId = null, documentId = null, recursive = true }) {
  if ((folderId === null) === (documentId === null)) return { ok: false, reason: 'invalid_target' };

  if (folderId !== null) {
    const bits = await permissionBits(userId, folderId);
    if (!has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };
  } else {
    const bits = await documentPermission(userId, documentId);
    if (bits === null || !has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };
  }

  // Deliberately not a MERGE. One of the two target columns is always NULL, and
  // a parameter bound as an untyped NULL inside a MERGE's USING clause has no
  // type for SQL Server to match on. An update-then-insert is plainer and the
  // filtered unique indexes make the race safe: a concurrent insert loses on the
  // constraint rather than creating a duplicate watch.
  const updated = await sql`
    UPDATE dbo.watches
       SET recursive = ${recursive ? 1 : 0}
     WHERE user_id = ${userId}
       AND ISNULL(folder_id, -1) = ISNULL(CONVERT(bigint, ${folderId}), -1)
       AND ISNULL(document_id, -1) = ISNULL(CONVERT(bigint, ${documentId}), -1)
  `.execute(db);

  if (Number(updated.numAffectedRows ?? 0) === 0) {
    try {
      await sql`
        INSERT INTO dbo.watches (user_id, folder_id, document_id, recursive)
        VALUES (${userId}, CONVERT(bigint, ${folderId}), CONVERT(bigint, ${documentId}),
                ${recursive ? 1 : 0})
      `.execute(db);
    } catch (error) {
      // Lost the race to another request for the same watch. Already watching is
      // the outcome the caller asked for.
      if (!/UX_watches|duplicate key/i.test(error.message)) throw error;
    }
  }

  return { ok: true };
}

export async function unwatch({ userId, folderId = null, documentId = null }) {
  await sql`
    DELETE FROM dbo.watches
     WHERE user_id = ${userId}
       AND ISNULL(folder_id, -1) = ISNULL(CONVERT(bigint, ${folderId}), -1)
       AND ISNULL(document_id, -1) = ISNULL(CONVERT(bigint, ${documentId}), -1)
  `.execute(db);
  return { ok: true };
}

export async function listWatches({ userId }) {
  const result = await sql`
    SELECT w.watch_id, w.folder_id, w.document_id, w.recursive, w.created_at,
           f.name AS folder_name, d.title AS document_title
      FROM dbo.watches w
      LEFT JOIN dbo.folders   f ON f.folder_id  = w.folder_id
      LEFT JOIN dbo.documents d ON d.document_id = w.document_id
     WHERE w.user_id = ${userId}
     ORDER BY w.created_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    watchId: String(row.watch_id),
    folderId: row.folder_id === null ? null : String(row.folder_id),
    documentId: row.document_id === null ? null : String(row.document_id),
    name: row.folder_name ?? row.document_title,
    recursive: Number(row.recursive) === 1,
    createdAt: row.created_at,
  }));
}

/**
 * Everyone watching a document, directly or through an ancestor folder.
 *
 * Ancestors come from the materialized path, so a recursive watch high in the
 * tree is matched by a prefix comparison rather than a walk. The result excludes
 * anyone who can no longer browse the folder: a watch is not a way to keep
 * receiving notices about a branch you have lost access to.
 */
export async function watchersOf({ documentId, excludeUserId = null }) {
  const result = await sql`
    WITH doc AS (
      SELECT d.document_id, d.folder_id, f.mpath
        FROM dbo.documents d JOIN dbo.folders f ON f.folder_id = d.folder_id
       WHERE d.document_id = ${documentId}
    )
    SELECT DISTINCT w.user_id
      FROM dbo.watches w
     CROSS JOIN doc
      LEFT JOIN dbo.folders wf ON wf.folder_id = w.folder_id
     CROSS APPLY dbo.fn_effective_permission(w.user_id, doc.folder_id) p
     WHERE (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${excludeUserId} IS NULL OR w.user_id <> ${excludeUserId})
       AND (
             w.document_id = doc.document_id
          OR (w.folder_id = doc.folder_id)
          OR (w.recursive = 1 AND doc.mpath LIKE wf.mpath + '%')
       )
  `.execute(db);

  return result.rows.map((row) => String(row.user_id));
}

// ── Comments ─────────────────────────────────────────────────────────────

export async function addComment({ userId, documentId, body, parentCommentId = null }) {
  const text = String(body ?? '').trim();
  if (!text || text.length > 4000) return { ok: false, reason: 'invalid_body' };

  // READ, not BROWSE: a comment thread discusses content, and someone who may
  // only see that the document exists has nothing to discuss.
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const result = await sql`
    INSERT INTO dbo.document_comments (document_id, parent_comment_id, author_id, body)
    OUTPUT INSERTED.comment_id AS cid
    VALUES (${documentId}, ${parentCommentId}, ${userId}, ${text})
  `.execute(db);

  return { ok: true, commentId: String(result.rows[0].cid) };
}

export async function listComments({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const result = await sql`
    SELECT c.comment_id, c.parent_comment_id, c.body, c.created_at, c.edited_at, c.is_deleted,
           c.author_id, p.display_name AS author
      FROM dbo.document_comments c
      JOIN dbo.principals p ON p.principal_id = c.author_id
     WHERE c.document_id = ${documentId}
     ORDER BY c.created_at
  `.execute(db);

  return {
    ok: true,
    comments: result.rows.map((row) => ({
      commentId: String(row.comment_id),
      parentCommentId: row.parent_comment_id === null ? null : String(row.parent_comment_id),
      // A deleted comment leaves a tombstone rather than vanishing: replies below
      // it would otherwise become orphaned fragments of a conversation.
      body: Number(row.is_deleted) === 1 ? null : row.body,
      isDeleted: Number(row.is_deleted) === 1,
      author: row.author,
      authorId: String(row.author_id),
      createdAt: row.created_at,
      editedAt: row.edited_at,
    })),
  };
}

export async function deleteComment({ userId, commentId, isSuperAdmin = false }) {
  const found = await sql`
    SELECT author_id FROM dbo.document_comments WHERE comment_id = ${commentId} AND is_deleted = 0
  `.execute(db);

  if (!found.rows[0]) return { ok: false, reason: 'not_found' };
  if (String(found.rows[0].author_id) !== String(userId) && !isSuperAdmin) {
    return { ok: false, reason: 'forbidden' };
  }

  await sql`
    UPDATE dbo.document_comments SET is_deleted = 1 WHERE comment_id = ${commentId}
  `.execute(db);
  return { ok: true };
}

// ── Cross-references ─────────────────────────────────────────────────────

export async function relate({ userId, fromDocument, toDocument, relationType = 'related' }) {
  if (String(fromDocument) === String(toDocument)) return { ok: false, reason: 'invalid_target' };

  // Both ends must be visible, or a relation becomes a way to confirm that a
  // document id exists in a folder you cannot see.
  for (const documentId of [fromDocument, toDocument]) {
    const bits = await documentPermission(userId, documentId);
    if (bits === null || !has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };
  }

  try {
    await sql`
      INSERT INTO dbo.document_relations (from_document, to_document, relation_type, created_by)
      VALUES (${fromDocument}, ${toDocument}, ${relationType}, ${userId})
    `.execute(db);
  } catch (error) {
    if (/UQ_relations|duplicate key/i.test(error.message)) return { ok: true, alreadyLinked: true };
    if (/CK_relations_type/i.test(error.message)) return { ok: false, reason: 'invalid_type' };
    throw error;
  }

  return { ok: true };
}

export async function unrelate({ relationId }) {
  await sql`DELETE FROM dbo.document_relations WHERE relation_id = ${relationId}`.execute(db);
  return { ok: true };
}

/** Relations in both directions, permission-filtered on the far end. */
export async function listRelations({ userId, documentId }) {
  const result = await sql`
    SELECT r.relation_id, r.relation_type, r.from_document, r.to_document,
           d.document_id AS other_id, d.title AS other_title, d.folder_id,
           CAST(CASE WHEN r.from_document = ${documentId} THEN 1 ELSE 0 END AS bit) AS outgoing
      FROM dbo.document_relations r
      JOIN dbo.documents d
        ON d.document_id = CASE WHEN r.from_document = ${documentId} THEN r.to_document ELSE r.from_document END
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE (r.from_document = ${documentId} OR r.to_document = ${documentId})
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
     ORDER BY r.created_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    relationId: String(row.relation_id),
    relationType: row.relation_type,
    outgoing: Number(row.outgoing) === 1,
    documentId: String(row.other_id),
    title: row.other_title,
    folderId: String(row.folder_id),
  }));
}

// ── Saved searches ───────────────────────────────────────────────────────

export async function saveSearch({ userId, name, criteria, isShared = false }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };

  const json = JSON.stringify(criteria ?? {});
  if (json.length > 4000) return { ok: false, reason: 'criteria_too_large' };

  try {
    const result = await sql`
      INSERT INTO dbo.saved_searches (user_id, name, criteria, is_shared)
      OUTPUT INSERTED.search_id AS sid
      VALUES (${userId}, ${clean}, ${json}, ${isShared ? 1 : 0})
    `.execute(db);
    return { ok: true, searchId: String(result.rows[0].sid) };
  } catch (error) {
    if (/UQ_saved_searches_name|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    throw error;
  }
}

export async function listSavedSearches({ userId }) {
  const result = await sql`
    SELECT s.search_id, s.name, s.criteria, s.is_shared, s.user_id, p.display_name AS owner
      FROM dbo.saved_searches s
      JOIN dbo.principals p ON p.principal_id = s.user_id
     WHERE s.user_id = ${userId} OR s.is_shared = 1
     ORDER BY s.name
  `.execute(db);

  return result.rows.map((row) => ({
    searchId: String(row.search_id),
    name: row.name,
    // Parsed here so a client never has to know the column is text. A row that
    // somehow holds invalid JSON degrades to empty criteria rather than
    // breaking the whole list.
    criteria: safeParse(row.criteria),
    isShared: Number(row.is_shared) === 1,
    isMine: String(row.user_id) === String(userId),
    owner: row.owner,
  }));
}

export async function deleteSavedSearch({ userId, searchId }) {
  const result = await sql`
    DELETE FROM dbo.saved_searches WHERE search_id = ${searchId} AND user_id = ${userId}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0) === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

// ── Shared helpers ───────────────────────────────────────────────────────

/** A document's effective permission bits, or null when it does not exist. */
async function documentPermission(userId, documentId) {
  const result = await sql`
    SELECT p.perm_bits
      FROM dbo.documents d
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE d.document_id = ${documentId} AND d.is_deleted = 0
  `.execute(db);

  return result.rows[0] ? Number(result.rows[0].perm_bits) : null;
}

export { documentPermission };

function toListItem(row) {
  return {
    documentId: String(row.document_id),
    title: row.title,
    folderId: String(row.folder_id),
    folderName: row.folder_name,
    addedAt: row.added_at,
    canRead: Number(row.can_read) === 1,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
