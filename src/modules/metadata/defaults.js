/**
 * Metadata inheritance: default field values that hang off a folder.
 *
 * ─── Why this is a Tier 2 row and not a nicety ──────────────────────────────
 *
 * A filing clerk uploading into "Legal / Contracts / 2026" re-enters the same
 * department, project and year on every single document. That friction compounds
 * — people start leaving fields blank, and within weeks the metadata everyone
 * planned to search by is half empty.
 *
 * ─── Nearest ancestor wins ──────────────────────────────────────────────────
 *
 * Defaults inherit down the tree, and a folder closer to the document overrides
 * one further up. That is the same precedence people already understand from the
 * permission model, which is worth more than any argument for a different rule.
 *
 * ─── Defaults fill, they do not overwrite ───────────────────────────────────
 *
 * A value supplied at upload always wins. A default that silently replaced what
 * someone typed would be a bug that looks like the system ignoring them.
 */

import { db, sql } from '../../db/index.js';
import { PERM, permissionBits, has } from '../tree/service.js';

const VALUE_COLUMNS = Object.freeze({
  text: 'value_text',
  number: 'value_number',
  date: 'value_date',
  bool: 'value_bool',
  choice: 'value_choice_id',
});

/** The defaults set directly on one folder. */
export async function listDefaults({ userId, folderId }) {
  const bits = await permissionBits(userId, folderId);
  if (!has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };

  const result = await sql`
    SELECT d.field_id, d.value_text, d.value_number, d.value_date, d.value_bool,
           d.value_choice_id, d.inherit_down, f.name, f.data_type, c.label AS choice_label
      FROM dbo.folder_field_defaults d
      JOIN dbo.custom_field_defs f ON f.field_id = d.field_id
      LEFT JOIN dbo.custom_field_choices c ON c.choice_id = d.value_choice_id
     WHERE d.folder_id = ${folderId}
     ORDER BY f.sort_order, f.name
  `.execute(db);

  return {
    ok: true,
    defaults: result.rows.map((row) => ({
      fieldId: Number(row.field_id),
      name: row.name,
      dataType: row.data_type,
      value: readValue(row),
      choiceLabel: row.choice_label,
      inheritDown: Number(row.inherit_down) === 1,
    })),
  };
}

/**
 * Replaces the defaults on a folder.
 *
 * Requires EDIT_META on the folder: setting what every future document inherits
 * is a metadata decision about the branch.
 */
export async function setDefaults({ userId, folderId, defaults }) {
  const bits = await permissionBits(userId, folderId);
  if (!has(bits, PERM.EDIT_META)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const { prepareFieldValues } = await import('./service.js');
  const validation = await prepareFieldValues(
    (Array.isArray(defaults) ? defaults : []).map((entry) => ({
      fieldId: entry.fieldId,
      value: entry.value,
    })),
  );
  if (!validation.ok) return validation;

  // Multi-select and user-picker are not supported as defaults: the first needs
  // its own table and the second names a person, which is rarely the same for
  // every document in a folder. Rejected explicitly rather than silently
  // dropped.
  const unsupported = validation.prepared.find((entry) => !VALUE_COLUMNS[entry.dataType]);
  if (unsupported) return { ok: false, reason: 'unsupported_field_type', detail: unsupported.dataType };

  const inheritByField = new Map(
    (Array.isArray(defaults) ? defaults : []).map((entry) => [
      Number(entry.fieldId),
      entry.inheritDown !== false,
    ]),
  );

  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM dbo.folder_field_defaults WHERE folder_id = ${folderId}`.execute(trx);

    for (const entry of validation.prepared) {
      if (entry.value === null) continue;

      const column = VALUE_COLUMNS[entry.dataType];
      const value =
        entry.dataType === 'date'
          ? sql`CONVERT(datetime2(3), ${entry.value}, 126)`
          : sql`${entry.value}`;

      await sql`
        INSERT INTO dbo.folder_field_defaults (folder_id, field_id, ${sql.raw(column)}, inherit_down)
        VALUES (${folderId}, ${entry.fieldId}, ${value},
                ${inheritByField.get(entry.fieldId) === false ? 0 : 1})
      `.execute(trx);
    }
  });

  return { ok: true };
}

/**
 * The effective defaults for a folder: its own, plus anything inheriting down
 * from its ancestors, with the nearest winning.
 *
 * Ancestors come from the materialized path, so this is one indexed lookup per
 * level rather than a recursive walk.
 */
export async function effectiveDefaults({ folderId }) {
  const found = await sql`
    SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);
  if (!found.rows[0]) return [];

  const chain = String(found.rows[0].mpath).split('/').filter(Boolean);
  if (chain.length === 0) return [];

  const result = await sql`
    SELECT d.folder_id, d.field_id, d.value_text, d.value_number, d.value_date,
           d.value_bool, d.value_choice_id, d.inherit_down,
           -- cf, not f: the f alias is the folder, and only the field
           -- definition knows the data type.
           cf.data_type, f.depth
      FROM dbo.folder_field_defaults d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
      JOIN dbo.custom_field_defs cf ON cf.field_id = d.field_id
     WHERE d.folder_id IN (${sql.join(chain.map((value) => sql`${value}`))})
       AND cf.is_active = 1
       -- An ancestor's default only applies if it was marked to inherit; the
       -- folder's own defaults always apply.
       AND (d.folder_id = ${folderId} OR d.inherit_down = 1)
     ORDER BY f.depth
  `.execute(db);

  // Ordered by depth, so a later row — a nearer folder — overwrites an earlier.
  const byField = new Map();
  for (const row of result.rows) {
    byField.set(Number(row.field_id), {
      fieldId: Number(row.field_id),
      dataType: row.data_type,
      value: readValue(row),
    });
  }

  return [...byField.values()].filter((entry) => entry.value !== null);
}

/**
 * Merges folder defaults into the field values supplied with an upload.
 *
 * Supplied values win. A default only fills a gap.
 */
export async function applyDefaults({ folderId, fields }) {
  const defaults = await effectiveDefaults({ folderId });
  if (defaults.length === 0) return fields ?? null;

  const supplied = new Map(
    (Array.isArray(fields) ? fields : [])
      .filter((entry) => entry && entry.value !== null && entry.value !== undefined && entry.value !== '')
      .map((entry) => [Number(entry.fieldId), entry]),
  );

  const merged = [...(Array.isArray(fields) ? fields : [])];
  for (const entry of defaults) {
    if (!supplied.has(entry.fieldId)) {
      merged.push({ fieldId: entry.fieldId, value: entry.value });
    }
  }

  return merged;
}

function readValue(row) {
  switch (row.data_type) {
    case 'number':
      return row.value_number === null ? null : Number(row.value_number);
    case 'date':
      return row.value_date === null ? null : new Date(row.value_date).toISOString();
    case 'bool':
      return row.value_bool === null ? null : Number(row.value_bool) === 1;
    case 'choice':
      return row.value_choice_id === null ? null : Number(row.value_choice_id);
    default:
      return row.value_text;
  }
}
