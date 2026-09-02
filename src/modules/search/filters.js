/**
 * Document parameter filters — the predicates shared by every listing.
 *
 * ─── Why this is one module and not two ─────────────────────────────────────
 *
 * Documents can be narrowed in two places: the folder listing in Browse, and
 * the Search page's parameter mode. They page differently — Browse walks a
 * keyset cursor, search uses OFFSET — but the QUESTIONS are identical: filed by
 * whom, of what type, carrying which label, changed between when and when.
 *
 * Written twice, the two copies drift. That drift is close to undetectable from
 * the outside: both screens return plausible documents, and only someone who
 * filters the same folder from both places and counts notices they disagree. So
 * the predicates live here once and each caller composes them into its own
 * query, keeping its own paging.
 *
 * ─── The two rules every predicate here obeys ───────────────────────────────
 *
 * 1. Dates cross as ISO TEXT and are converted in SQL with style 126. tedious
 *    binds a JS Date as `datetime`, whose resolution is 3.33ms — a value read
 *    from a datetime2(3) column and sent straight back does not compare equal to
 *    itself. A range filter built that way silently drops boundary rows.
 *
 * 2. Nothing joins. Every predicate is a correlated EXISTS or scalar subquery
 *    against the `d` alias. A JOIN to document_versions on current_version looks
 *    tempting for size and type, but a multi-file document has current_version 0
 *    and no version row: the join matches nothing and the document vanishes from
 *    the result before the WHERE clause is ever evaluated — filtered out by a
 *    filter it should have matched, with no error anywhere.
 */

import { sql } from 'kysely';

/** Sort keys a caller may ask for, mapped to the column that orders them. */
export const SORT_COLUMNS = Object.freeze({
  created: 'created_at',
  updated: 'updated_at',
  title: 'title',
  size: 'size',
});

/**
 * Total bytes of a document, whichever axis holds its files.
 *
 * SUM over constituent files for a multi-file document, the current version's
 * size otherwise. "Documents over 10MB" means the whole document, not whichever
 * part of it happens to be biggest.
 */
const TOTAL_BYTES = sql`
  COALESCE(
    (SELECT SUM(df.file_size_bytes) FROM dbo.document_files df
      WHERE df.document_id = d.document_id),
    (SELECT dv.file_size_bytes FROM dbo.document_versions dv
      WHERE dv.document_id = d.document_id AND dv.version_number = d.current_version)
  )
`;

/** The expression a caller should select to report a document's size. */
export const totalBytesExpression = TOTAL_BYTES;

/**
 * Normalises a raw filter object from a query string or JSON body.
 *
 * Anything malformed becomes null rather than throwing: a filter bar that sends
 * an empty date because the user cleared the field should narrow nothing, not
 * return a 500. The one exception is a date that cannot be parsed at all, which
 * is reported so the caller can answer 400 instead of silently ignoring it —
 * a filter that quietly does nothing is worse than one that says it is wrong.
 */
export function normaliseFilters(raw = {}) {
  const problems = [];

  const date = (value, name) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      problems.push(name);
      return null;
    }
    return parsed.toISOString();
  };

  const int = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  };

  const bigint = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    return /^[0-9]{1,19}$/.test(text) ? text : null;
  };

  const list = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const items = (Array.isArray(value) ? value : String(value).split(','))
      .map((entry) => String(entry).trim())
      .filter(Boolean);
    return items.length > 0 ? items : null;
  };

  const filters = {
    typeId: int(raw.typeId),
    labelId: int(raw.labelId),
    createdBy: bigint(raw.createdBy),
    createdFrom: date(raw.createdFrom, 'createdFrom'),
    createdTo: date(raw.createdTo, 'createdTo'),
    updatedFrom: date(raw.updatedFrom, 'updatedFrom'),
    updatedTo: date(raw.updatedTo, 'updatedTo'),
    tags: list(raw.tags),
    mimeTypes: list(raw.mimeTypes),
    extensions: list(raw.extensions)?.map((entry) => entry.replace(/^\./, '').toLowerCase()) ?? null,
    minBytes: bigint(raw.minBytes),
    maxBytes: bigint(raw.maxBytes),
    // Tri-state on purpose: null means "either", which is not the same question
    // as "only multi-file" or "only ordinary".
    multiFile: raw.multiFile === undefined || raw.multiFile === null || raw.multiFile === ''
      ? null
      : raw.multiFile === true || raw.multiFile === 'true' || raw.multiFile === '1',
  };

  return { filters, problems };
}

/** True when nothing at all was asked for, so a caller can skip the work. */
export function isEmptyFilterSet(filters) {
  return Object.values(filters ?? {}).every((value) =>
    value === null || (Array.isArray(value) && value.length === 0),
  );
}

/**
 * The filters as one SQL fragment, ready to drop into a WHERE clause where the
 * documents table is aliased `d`.
 *
 * Returns an empty fragment when nothing is filtered, so callers can always
 * interpolate it unconditionally.
 */
export function filterPredicate(filters = {}) {
  const clauses = [];

  if (filters.typeId !== null && filters.typeId !== undefined) {
    clauses.push(sql`d.type_id = ${filters.typeId}`);
  }

  if (filters.labelId !== null && filters.labelId !== undefined) {
    clauses.push(sql`d.sensitivity_label_id = ${filters.labelId}`);
  }

  if (filters.createdBy) {
    clauses.push(sql`d.created_by = ${filters.createdBy}`);
  }

  // Every date bound goes through CONVERT with style 126. See the header.
  if (filters.createdFrom) {
    clauses.push(sql`d.created_at >= CONVERT(datetime2(3), ${filters.createdFrom}, 126)`);
  }
  if (filters.createdTo) {
    clauses.push(sql`d.created_at <= CONVERT(datetime2(3), ${filters.createdTo}, 126)`);
  }
  if (filters.updatedFrom) {
    clauses.push(sql`d.updated_at >= CONVERT(datetime2(3), ${filters.updatedFrom}, 126)`);
  }
  if (filters.updatedTo) {
    clauses.push(sql`d.updated_at <= CONVERT(datetime2(3), ${filters.updatedTo}, 126)`);
  }

  // Tags match by exact stored name. The filter UI offers the names the tag
  // endpoint returns rather than free text, because tags are stored without
  // Arabic normalisation: a typed "مُراجعة" would not match a stored "مراجعة",
  // and Arabic_CI_AI does not fold tashkeel.
  if (filters.tags?.length) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM dbo.document_tags dt
        JOIN dbo.tags tg ON tg.tag_id = dt.tag_id
       WHERE dt.document_id = d.document_id
         AND tg.name IN (${sql.join(filters.tags.map((tag) => sql`${tag}`))})
    )`);
  }

  // "Documents containing a file of this type" — both axes, because a
  // multi-file document of PDFs is a PDF document to anyone filtering for one.
  if (filters.mimeTypes?.length) {
    const values = sql.join(filters.mimeTypes.map((mime) => sql`${mime}`));
    clauses.push(sql`(
      EXISTS (SELECT 1 FROM dbo.document_versions dv
               WHERE dv.document_id = d.document_id
                 AND dv.version_number = d.current_version
                 AND dv.mime_type IN (${values}))
      OR EXISTS (SELECT 1 FROM dbo.document_files df
                  WHERE df.document_id = d.document_id
                    AND df.mime_type IN (${values}))
    )`);
  }

  // Extension rather than MIME, because "show me the spreadsheets" is a
  // question people ask in terms of .xlsx, and a browser's reported MIME for an
  // Office file is unreliable enough that filtering on it alone misses rows.
  if (filters.extensions?.length) {
    clauses.push(extensionClause(filters.extensions));
  }

  if (filters.minBytes) {
    clauses.push(sql`${TOTAL_BYTES} >= CONVERT(bigint, ${filters.minBytes})`);
  }
  if (filters.maxBytes) {
    clauses.push(sql`${TOTAL_BYTES} <= CONVERT(bigint, ${filters.maxBytes})`);
  }

  if (filters.multiFile !== null && filters.multiFile !== undefined) {
    const exists = sql`EXISTS (SELECT 1 FROM dbo.document_files df WHERE df.document_id = d.document_id)`;
    clauses.push(filters.multiFile ? exists : sql`NOT ${exists}`);
  }

  return clauses.length > 0 ? sql`AND ${sql.join(clauses, sql` AND `)}` : sql``;
}

/**
 * Extension matching, as an OR of LIKE patterns.
 *
 * Separate from the main builder because SQL Server has no `LIKE ANY`, so each
 * extension needs its own comparison rather than an IN list.
 */
function extensionClause(extensions) {
  const perExtension = extensions.map(
    (ext) => sql`(
      EXISTS (SELECT 1 FROM dbo.document_versions dv
               WHERE dv.document_id = d.document_id
                 AND dv.version_number = d.current_version
                 AND dv.original_filename LIKE ${`%.${ext}`})
      OR EXISTS (SELECT 1 FROM dbo.document_files df
                  WHERE df.document_id = d.document_id
                    AND df.original_filename LIKE ${`%.${ext}`})
    )`,
  );

  return sql`(${sql.join(perExtension, sql` OR `)})`;
}
