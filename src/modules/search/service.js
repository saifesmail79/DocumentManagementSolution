/**
 * Search.
 *
 * ─── Permission filtering is part of the query, not a step after it ─────────
 *
 * The full-text predicate and the permission predicate live in one statement, so
 * a document the user cannot browse is never a row that existed. This also fixes
 * ranking and paging: filtering after the fact gives "the top 50 matches, minus
 * the ones you cannot see", which is a short and arbitrary page rather than the
 * top 50 you can see.
 *
 * ─── Two kinds of search, one endpoint ──────────────────────────────────────
 *
 *   • Attributes — title, type, sensitivity, metadata field values. Always
 *     available, because it needs no full-text index and no extraction.
 *   • Content — the extracted text of the document, via CONTAINS.
 *
 * Content search degrades to attribute search when full-text is unavailable or
 * nothing has been extracted yet, rather than returning an error. A search box
 * that errors is worse than one that finds less.
 *
 * ─── Scoping ────────────────────────────────────────────────────────────────
 *
 * The requirement was that a user may search their own folders, or a subset they
 * choose, and that a document they may see but not read appears by title only.
 * folderId scopes to one subtree using the materialized path, which is a prefix
 * range scan rather than a recursive walk.
 */

import { db, sql } from '../../db/index.js';
import { normalizeArabic, buildContainsExpression } from '../../lib/arabic.js';
import { PERM } from '../tree/service.js';

/**
 * @param {object} args
 * @param {bigint|string} args.userId
 * @param {string} args.query           raw user input
 * @param {string} [args.folderId]      restrict to this folder and everything under it
 * @param {number} [args.typeId]
 * @param {boolean} [args.includeContent] search extracted text as well as titles
 * @param {number} [args.limit]
 * @param {number} [args.offset]
 */
export async function search({
  userId,
  query,
  folderId = null,
  typeId = null,
  includeContent = true,
  limit = 25,
  offset = 0,
}) {
  const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);

  const raw = String(query ?? '').trim();
  const normalized = normalizeArabic(raw);

  if (!normalized) return { results: [], total: 0, contentSearched: false };

  // The same normalisation is applied to the query as to the stored columns.
  // Normalising only one side makes recall worse than normalising neither.
  const likePattern = `%${escapeLike(normalized)}%`;

  // CONTAINS is only usable once the full-text index exists AND something has
  // been indexed; otherwise the clause is dropped and this stays a title search.
  const contains = includeContent ? buildContainsExpression(raw) : null;
  const useContent = contains !== null && (await contentSearchAvailable());

  // Resolve the subtree prefix once, so the row filter is a BIN2 prefix scan
  // against the materialized path rather than a recursive CTE per row.
  let mpathPrefix = null;
  if (folderId != null) {
    const scope = await sql`
      SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
    `.execute(db);
    // An unknown or invisible scope yields no results rather than silently
    // widening the search to everything.
    if (!scope.rows[0]) return { results: [], total: 0, contentSearched: useContent };
    mpathPrefix = `${scope.rows[0].mpath}%`;
  }

  const contentClause = useContent
    ? sql`OR CONTAINS(d.content_normalized, ${contains})`
    : sql``;

  const rows = await sql`
    SELECT d.document_id, d.title, d.folder_id, d.type_id, d.current_version,
           d.created_at, d.updated_at,
           f.name  AS folder_name,
           f.mpath AS folder_path,
           t.name  AS type_name,
           s.name  AS sensitivity_name,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read,
           COUNT(*) OVER () AS total_matches
      FROM dbo.documents d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_types     t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels s ON s.label_id = d.sensitivity_label_id
     WHERE d.is_deleted = 0
       AND f.is_deleted = 0
       -- BROWSE, not READ: a user may find a document by title without being
       -- able to open it. can_read above tells the UI which it is.
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${mpathPrefix} IS NULL OR f.mpath LIKE ${mpathPrefix})
       AND (${typeId} IS NULL OR d.type_id = ${typeId})
       AND (
             d.title_normalized LIKE ${likePattern}
             ${contentClause}
           )
     ORDER BY d.updated_at DESC, d.document_id DESC
     OFFSET ${skip} ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `.execute(db);

  return {
    results: rows.rows.map((row) => ({
      documentId: String(row.document_id),
      title: row.title,
      folderId: String(row.folder_id),
      folderName: row.folder_name,
      typeId: row.type_id,
      typeName: row.type_name,
      sensitivity: row.sensitivity_name,
      currentVersion: Number(row.current_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canRead: Number(row.can_read) === 1,
    })),
    total: Number(rows.rows[0]?.total_matches ?? 0),
    contentSearched: useContent,
  };
}

/**
 * Multi-criteria search: any combination of type, label, dates, tags and
 * metadata fields, with an optional text term.
 *
 * The blueprint calls this the mandatory one — "filtering by any combination of
 * indexed fields" — and combination is the operative word. Each field criterion
 * becomes an EXISTS against document_field_values, so criteria AND together
 * without multiplying rows, and each still lands on the typed column's index.
 *
 * @param {object} args
 * @param {Array<{fieldId:number, op?:string, value?:*, min?:*, max?:*}>} [args.fields]
 */
export async function advancedSearch({
  userId,
  query = null,
  folderId = null,
  typeId = null,
  labelId = null,
  createdFrom = null,
  createdTo = null,
  tags = null,
  fields = [],
  includeContent = true,
  limit = 25,
  offset = 0,
}) {
  const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);

  const raw = String(query ?? '').trim();
  const normalized = raw ? normalizeArabic(raw) : null;
  const likePattern = normalized ? `%${escapeLike(normalized)}%` : null;

  const contains = normalized && includeContent ? buildContainsExpression(raw) : null;
  const useContent = contains !== null && (await contentSearchAvailable());

  let mpathPrefix = null;
  if (folderId != null) {
    const scope = await sql`
      SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
    `.execute(db);
    if (!scope.rows[0]) return { results: [], total: 0, contentSearched: useContent };
    mpathPrefix = `${scope.rows[0].mpath}%`;
  }

  // Each criterion is its own EXISTS, so N criteria AND together rather than
  // producing N rows per document to be de-duplicated afterwards.
  const fieldClauses = (Array.isArray(fields) ? fields : [])
    .map((criterion) => buildFieldClause(criterion))
    .filter(Boolean);

  const fieldPredicate = fieldClauses.length
    ? sql`AND ${sql.join(fieldClauses, sql` AND `)}`
    : sql``;

  const tagList = Array.isArray(tags) ? tags.filter(Boolean) : [];
  const tagPredicate = tagList.length
    ? sql`AND EXISTS (
            SELECT 1 FROM dbo.document_tags dt
              JOIN dbo.tags tg ON tg.tag_id = dt.tag_id
             WHERE dt.document_id = d.document_id
               AND tg.name IN (${sql.join(tagList.map((t) => sql`${t}`))})
          )`
    : sql``;

  const textPredicate = likePattern
    ? useContent
      ? sql`AND (d.title_normalized LIKE ${likePattern} OR CONTAINS(d.content_normalized, ${contains}))`
      : sql`AND d.title_normalized LIKE ${likePattern}`
    : sql``;

  const rows = await sql`
    SELECT d.document_id, d.title, d.folder_id, d.type_id, d.current_version,
           d.created_at, d.updated_at,
           f.name AS folder_name,
           t.name AS type_name,
           s.name AS sensitivity_name,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read,
           COUNT(*) OVER () AS total_matches
      FROM dbo.documents d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_types     t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels s ON s.label_id = d.sensitivity_label_id
     WHERE d.is_deleted = 0
       AND f.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${mpathPrefix} IS NULL OR f.mpath LIKE ${mpathPrefix})
       AND (${typeId} IS NULL OR d.type_id = ${typeId})
       AND (${labelId} IS NULL OR d.sensitivity_label_id = ${labelId})
       AND (${createdFrom} IS NULL OR d.created_at >= CONVERT(datetime2(3), ${createdFrom}, 126))
       AND (${createdTo} IS NULL OR d.created_at <= CONVERT(datetime2(3), ${createdTo}, 126))
       ${textPredicate}
       ${fieldPredicate}
       ${tagPredicate}
     ORDER BY d.updated_at DESC, d.document_id DESC
     OFFSET ${skip} ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `.execute(db);

  return {
    results: rows.rows.map((row) => ({
      documentId: String(row.document_id),
      title: row.title,
      folderId: String(row.folder_id),
      folderName: row.folder_name,
      typeId: row.type_id,
      typeName: row.type_name,
      sensitivity: row.sensitivity_name,
      currentVersion: Number(row.current_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canRead: Number(row.can_read) === 1,
    })),
    total: Number(rows.rows[0]?.total_matches ?? 0),
    contentSearched: useContent,
    criteria: fieldClauses.length + tagList.length,
  };
}

/**
 * One field criterion as an EXISTS predicate.
 *
 * Returns null for anything malformed rather than throwing: a search form that
 * sends a stray empty row should narrow nothing, not fail.
 */
function buildFieldClause(criterion) {
  const fieldId = Number(criterion?.fieldId);
  if (!Number.isInteger(fieldId)) return null;

  const has = (key) => criterion[key] !== undefined && criterion[key] !== null && criterion[key] !== '';

  let predicate = null;

  if (has('value')) {
    const value = criterion.value;
    switch (criterion.op) {
      case 'number':
        predicate = sql`v.value_number = ${Number(value)}`;
        break;
      case 'bool':
        predicate = sql`v.value_bool = ${['true', '1', 'yes'].includes(String(value).toLowerCase()) ? 1 : 0}`;
        break;
      case 'choice':
        predicate = sql`v.value_choice_id = ${Number(value)}`;
        break;
      case 'user':
        predicate = sql`v.value_principal_id = ${String(value)}`;
        break;
      default:
        // Normalised on both sides, like every other Arabic comparison.
        predicate = sql`v.value_text LIKE ${`%${escapeLike(normalizeArabic(String(value)))}%`}`;
    }
  } else if (has('min') || has('max')) {
    const isDate = criterion.op === 'date';
    const min = has('min')
      ? isDate
        ? sql`v.value_date >= CONVERT(datetime2(3), ${new Date(criterion.min).toISOString()}, 126)`
        : sql`v.value_number >= ${Number(criterion.min)}`
      : null;
    const max = has('max')
      ? isDate
        ? sql`v.value_date <= CONVERT(datetime2(3), ${new Date(criterion.max).toISOString()}, 126)`
        : sql`v.value_number <= ${Number(criterion.max)}`
      : null;

    const parts = [min, max].filter(Boolean);
    if (parts.length === 0) return null;
    predicate = sql.join(parts, sql` AND `);
  } else {
    return null;
  }

  // multiselect values live in their own table, so that criterion is a second
  // EXISTS rather than a different column.
  if (criterion.op === 'multiselect') {
    return sql`EXISTS (
      SELECT 1 FROM dbo.document_field_selections ms
       WHERE ms.document_id = d.document_id
         AND ms.field_id = ${fieldId}
         AND ms.choice_id = ${Number(criterion.value)}
    )`;
  }

  return sql`EXISTS (
    SELECT 1 FROM dbo.document_field_values v
     WHERE v.document_id = d.document_id AND v.field_id = ${fieldId} AND ${predicate}
  )`;
}

/**
 * Searches by metadata field value.
 *
 * Typed columns mean each comparison uses the right semantics: a number range is
 * numeric, a date range is chronological. The whole reason 0002 avoided a single
 * nvarchar value column.
 */
export async function searchByField({ userId, fieldId, equals, min, max, limit = 25 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const definition = await sql`
    SELECT field_id, data_type FROM dbo.custom_field_defs WHERE field_id = ${fieldId}
  `.execute(db);

  const field = definition.rows[0];
  if (!field) return { results: [], total: 0 };

  const dataType = field.data_type;
  const textValue = equals != null && dataType === 'text' ? normalizeArabic(String(equals)) : null;
  const numberEquals = dataType === 'number' && equals != null ? Number(equals) : null;
  const numberMin = dataType === 'number' && min != null ? Number(min) : null;
  const numberMax = dataType === 'number' && max != null ? Number(max) : null;
  // Dates travel as ISO text and convert server-side: a bound JS Date binds as
  // `datetime` (3.33ms) and will not match a datetime2(3) value exactly.
  const dateMin = dataType === 'date' && min != null ? new Date(min).toISOString() : null;
  const dateMax = dataType === 'date' && max != null ? new Date(max).toISOString() : null;
  const boolValue = dataType === 'bool' && equals != null ? (isTruthy(equals) ? 1 : 0) : null;
  const choiceValue = dataType === 'choice' && equals != null ? Number(equals) : null;

  const rows = await sql`
    SELECT d.document_id, d.title, d.folder_id, f.name AS folder_name,
           CAST(CASE WHEN (p.perm_bits & ${PERM.READ}) <> 0 THEN 1 ELSE 0 END AS bit) AS can_read,
           COUNT(*) OVER () AS total_matches
      FROM dbo.document_field_values v
      JOIN dbo.documents d ON d.document_id = v.document_id
      JOIN dbo.folders   f ON f.folder_id  = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE v.field_id = ${fieldId}
       AND d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${textValue}   IS NULL OR v.value_text LIKE ${textValue === null ? null : `%${escapeLike(textValue)}%`})
       AND (${numberEquals} IS NULL OR v.value_number = ${numberEquals})
       AND (${numberMin}    IS NULL OR v.value_number >= ${numberMin})
       AND (${numberMax}    IS NULL OR v.value_number <= ${numberMax})
       AND (${dateMin}      IS NULL OR v.value_date >= CONVERT(datetime2(3), ${dateMin}, 126))
       AND (${dateMax}      IS NULL OR v.value_date <= CONVERT(datetime2(3), ${dateMax}, 126))
       AND (${boolValue}    IS NULL OR v.value_bool = ${boolValue})
       AND (${choiceValue}  IS NULL OR v.value_choice_id = ${choiceValue})
     ORDER BY d.updated_at DESC, d.document_id DESC
     OFFSET 0 ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `.execute(db);

  return {
    results: rows.rows.map((row) => ({
      documentId: String(row.document_id),
      title: row.title,
      folderId: String(row.folder_id),
      folderName: row.folder_name,
      canRead: Number(row.can_read) === 1,
    })),
    total: Number(rows.rows[0]?.total_matches ?? 0),
  };
}

/**
 * True when a full-text index exists on documents and holds at least one row.
 *
 * Cached for a minute: this is checked on every content search, and the answer
 * changes at most once per deployment. Querying an index that is not there is a
 * hard error, not an empty result, so the check cannot be skipped.
 */
let availability = { value: null, checkedAt: 0 };
const AVAILABILITY_TTL_MS = 60_000;

export async function contentSearchAvailable({ force = false } = {}) {
  const now = Date.now();
  if (!force && availability.value !== null && now - availability.checkedAt < AVAILABILITY_TTL_MS) {
    return availability.value;
  }

  try {
    const result = await sql`
      SELECT CASE
               WHEN CAST(SERVERPROPERTY('IsFullTextInstalled') AS int) = 1
                AND EXISTS (SELECT 1 FROM sys.fulltext_indexes
                             WHERE object_id = OBJECT_ID('dbo.documents'))
               THEN 1 ELSE 0
             END AS available
    `.execute(db);

    availability = { value: Number(result.rows[0]?.available) === 1, checkedAt: now };
  } catch {
    availability = { value: false, checkedAt: now };
  }

  return availability.value;
}

/** Test hook: forget the cached availability answer. */
export function resetSearchAvailability() {
  availability = { value: null, checkedAt: 0 };
}

/** LIKE treats these as wildcards; a user searching for "50%" means the character. */
function escapeLike(value) {
  return String(value).replace(/[[\]%_]/g, (c) => `[${c}]`);
}

function isTruthy(value) {
  return value === true || value === 1 || ['true', '1', 'yes'].includes(String(value).toLowerCase());
}
