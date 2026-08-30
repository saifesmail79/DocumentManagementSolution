/**
 * Tags — flat, cross-cutting labels.
 *
 * Separate from the admin-defined type and field system on purpose: a tag is
 * created by whoever needs it, in the moment, and its whole value is that it
 * spans departments. "Everything about project X" has no other retrieval path
 * when the documents live in six different branches of the tree.
 */

import { db, sql } from '../../db/index.js';
import { normalizeArabic } from '../../lib/arabic.js';
import { PERM, has } from '../tree/service.js';
import { documentPermission } from '../collaboration/service.js';

/** Tags in use, with counts, for autocomplete and a tag cloud. */
export async function listTags({ search = null, limit = 100 } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const pattern = search
    ? `%${normalizeArabic(String(search)).replace(/[[\]%_]/g, (c) => `[${c}]`)}%`
    : null;

  const result = await sql`
    SELECT TOP (${pageSize})
           t.tag_id, t.name,
           (SELECT COUNT(*) FROM dbo.document_tags dt
              JOIN dbo.documents d ON d.document_id = dt.document_id
             WHERE dt.tag_id = t.tag_id AND d.is_deleted = 0) AS usage_count
      FROM dbo.tags t
     WHERE (${pattern} IS NULL OR t.name LIKE ${pattern})
     ORDER BY usage_count DESC, t.name
  `.execute(db);

  return result.rows.map((row) => ({
    tagId: Number(row.tag_id),
    name: row.name,
    count: Number(row.usage_count),
  }));
}

/**
 * Sets the complete tag set on a document, creating any tag that is new.
 *
 * Requires EDIT_META: a tag changes how a document is found, which is a
 * metadata change like any other.
 */
export async function tagDocument({ userId, documentId, tags }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.EDIT_META)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const names = [
    ...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean)),
  ]
    .filter((name) => name.length <= 100)
    .slice(0, 50);

  await db.transaction().execute(async (trx) => {
    // Replaced wholesale: the caller sends the complete set it wants, which is
    // how a tag editor behaves, and diffing only adds ways to disagree.
    await sql`DELETE FROM dbo.document_tags WHERE document_id = ${documentId}`.execute(trx);

    for (const name of names) {
      // MERGE rather than select-then-insert: two people tagging at the same
      // moment would otherwise race on the unique name.
      await sql`
        MERGE dbo.tags WITH (HOLDLOCK) AS target
        USING (SELECT ${name} AS name) AS source ON target.name = source.name
        WHEN NOT MATCHED THEN INSERT (name) VALUES (source.name);
      `.execute(trx);

      const tag = await sql`SELECT tag_id AS tid FROM dbo.tags WHERE name = ${name}`.execute(trx);

      await sql`
        INSERT INTO dbo.document_tags (document_id, tag_id) VALUES (${documentId}, ${tag.rows[0].tid})
      `.execute(trx);
    }
  });

  return { ok: true, tags: names };
}

export async function documentTags({ documentId }) {
  const result = await sql`
    SELECT t.tag_id, t.name
      FROM dbo.document_tags dt JOIN dbo.tags t ON t.tag_id = dt.tag_id
     WHERE dt.document_id = ${documentId}
     ORDER BY t.name
  `.execute(db);

  return result.rows.map((row) => ({ tagId: Number(row.tag_id), name: row.name }));
}

/** Documents carrying a tag, permission-filtered. */
export async function documentsWithTag({ userId, tagName, limit = 50 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const result = await sql`
    SELECT TOP (${pageSize})
           d.document_id, d.title, d.folder_id, f.name AS folder_name,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read
      FROM dbo.document_tags dt
      JOIN dbo.tags t ON t.tag_id = dt.tag_id
      JOIN dbo.documents d ON d.document_id = dt.document_id
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE t.name = ${tagName}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
     ORDER BY d.updated_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    title: row.title,
    folderId: String(row.folder_id),
    folderName: row.folder_name,
    canRead: Number(row.can_read) === 1,
  }));
}

/**
 * Removes tags no document uses any more.
 *
 * Run by the maintenance sweep. Without it the autocomplete list slowly fills
 * with labels from documents that were deleted years ago.
 */
export async function purgeUnusedTags() {
  const result = await sql`
    DELETE FROM dbo.tags
     WHERE NOT EXISTS (SELECT 1 FROM dbo.document_tags dt WHERE dt.tag_id = tags.tag_id)
  `.execute(db);

  return { removed: Number(result.numAffectedRows ?? 0) };
}
