/**
 * Facets and result snippets.
 *
 * ─── Facets are counted over the same predicate as the results ──────────────
 *
 * A facet count that does not match what clicking it returns is worse than no
 * facet — the user clicks "Contracts (12)" and gets nine. So the counts run the
 * same permission and scope predicate the search does, only grouped.
 *
 * ─── Snippets are built from the normalised text ────────────────────────────
 *
 * The stored content is normalised (tashkeel stripped, alef forms unified), so
 * a snippet cut from it is not byte-identical to the document. That is the
 * honest trade: showing where the match is beats showing nothing, and the
 * alternative — keeping a second, unnormalised copy of every document's text —
 * doubles the largest column in the database.
 */

import { db, sql } from '../../db/index.js';
import { normalizeArabic } from '../../lib/arabic.js';
import { PERM } from '../tree/service.js';

/** Counts by type, sensitivity, lifecycle state and folder for a given query. */
export async function facetsFor({ userId, query = null, folderId = null }) {
  const normalized = query ? normalizeArabic(String(query)) : null;
  const likePattern = normalized ? `%${escapeLike(normalized)}%` : null;

  let mpathPrefix = null;
  if (folderId != null) {
    const scope = await sql`
      SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
    `.execute(db);
    if (!scope.rows[0]) return { types: [], sensitivities: [], states: [], folders: [] };
    mpathPrefix = `${scope.rows[0].mpath}%`;
  }

  const rows = await sql`
    SELECT t.name AS type_name, s.name AS sensitivity_name, d.lifecycle_state,
           f.folder_id, f.name AS folder_name, COUNT(*) AS total
      FROM dbo.documents d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_types     t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels s ON s.label_id = d.sensitivity_label_id
     WHERE d.is_deleted = 0
       AND f.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${mpathPrefix} IS NULL OR f.mpath LIKE ${mpathPrefix})
       AND (${likePattern} IS NULL OR d.title_normalized LIKE ${likePattern})
     GROUP BY t.name, s.name, d.lifecycle_state, f.folder_id, f.name
  `.execute(db);

  // Rolled up here rather than by four separate GROUP BY queries: one pass over
  // a few hundred grouped rows is cheaper than four more scans of the
  // permission function.
  const tally = (key, fallback) => {
    const counts = new Map();
    for (const row of rows.rows) {
      const name = row[key] ?? fallback;
      counts.set(name, (counts.get(name) ?? 0) + Number(row.total));
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  };

  const folders = new Map();
  for (const row of rows.rows) {
    const key = String(row.folder_id);
    const entry = folders.get(key) ?? { folderId: key, name: row.folder_name, count: 0 };
    entry.count += Number(row.total);
    folders.set(key, entry);
  }

  return {
    types: tally('type_name', 'بدون نوع'),
    sensitivities: tally('sensitivity_name', 'غير محددة'),
    states: tally('lifecycle_state', 'active'),
    folders: [...folders.values()].sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

/**
 * Builds an excerpt around the first match, for each document given.
 *
 * Done here rather than in SQL because SQL Server has no excerpt function —
 * CONTAINSTABLE returns a rank, not surrounding text — and shipping whole
 * content columns to the client to cut there would send megabytes per result.
 */
export async function snippetsFor({ userId, documentIds, query, radius = 90 }) {
  const ids = [...new Set((documentIds ?? []).map(String))].filter((id) => /^[0-9]{1,19}$/.test(id));
  if (ids.length === 0 || !query) return {};

  const terms = normalizeArabic(String(query))
    .split(' ')
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  if (terms.length === 0) return {};

  const rows = await sql`
    SELECT d.document_id, d.content_normalized
      FROM dbo.documents d
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
     WHERE d.document_id IN (${sql.join(ids.map((id) => sql`${id}`))})
       AND d.content_normalized IS NOT NULL
       -- READ, not BROWSE. A snippet is content, and a browse-only user is
       -- entitled to the title and nothing more.
       AND (p.perm_bits & ${PERM.READ}) <> 0
  `.execute(db);

  const snippets = {};

  for (const row of rows.rows) {
    const text = String(row.content_normalized);
    const lower = text.toLowerCase();

    let at = -1;
    let matched = null;
    for (const term of terms) {
      const index = lower.indexOf(term.toLowerCase());
      if (index >= 0 && (at === -1 || index < at)) {
        at = index;
        matched = term;
      }
    }

    if (at === -1) continue;

    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + matched.length + radius);
    const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();

    // The terms are returned alongside the text rather than the text being
    // marked up here: the client decides how to highlight, and nothing from a
    // document is ever handed over as markup.
    snippets[String(row.document_id)] = {
      text: `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`,
      terms,
    };
  }

  return snippets;
}

function escapeLike(value) {
  return String(value).replace(/[[\]%_]/g, (c) => `[${c}]`);
}
