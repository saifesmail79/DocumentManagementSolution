/**
 * Document types, custom fields and sensitivity labels.
 *
 * All three are data, not code. The scope decision was "all sectors, not
 * government-specific", which means the type list, the field set and even the
 * sensitivity vocabulary differ per deployment — so none of them can be an enum
 * without a migration per customer.
 *
 * Definitions are administered centrally; values are edited per document by
 * anyone holding EDIT_META on the folder.
 */

import { db, sql } from '../../db/index.js';
import { normalizeArabic } from '../../lib/arabic.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, permissionBits, has } from '../tree/service.js';

const log = moduleLogger('metadata');

const DATA_TYPES = new Set(['text', 'number', 'date', 'bool', 'choice', 'multiselect', 'user']);

/**
 * Which column holds each data type's value.
 *
 * These names are interpolated as identifiers rather than parameters, so the map
 * is fixed and internal — a data type reaching here has already been checked
 * against DATA_TYPES, and no user input ever selects a column name.
 */
const VALUE_COLUMNS = Object.freeze({
  text: 'value_text',
  number: 'value_number',
  date: 'value_date',
  bool: 'value_bool',
  choice: 'value_choice_id',
  user: 'value_principal_id',
});

const ALL_VALUE_COLUMNS = Object.freeze(Object.values(VALUE_COLUMNS));

// ── Definitions ──────────────────────────────────────────────────────────

export async function listTypes({ includeInactive = false } = {}) {
  const result = await sql`
    SELECT t.type_id, t.name, t.description, t.is_active, t.sort_order,
           (SELECT COUNT(*) FROM dbo.custom_field_defs f
             WHERE f.type_id = t.type_id AND f.is_active = 1) AS field_count
      FROM dbo.document_types t
     WHERE (${includeInactive ? 1 : 0} = 1 OR t.is_active = 1)
     ORDER BY t.sort_order, t.name
  `.execute(db);

  return result.rows.map((row) => ({
    typeId: Number(row.type_id),
    name: row.name,
    description: row.description,
    isActive: Number(row.is_active) === 1,
    sortOrder: Number(row.sort_order),
    fieldCount: Number(row.field_count),
  }));
}

export async function createType({ name, description, sortOrder = 0 }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };

  const existing = await sql`SELECT type_id FROM dbo.document_types WHERE name = ${clean}`.execute(db);
  if (existing.rows.length > 0) return { ok: false, reason: 'name_taken' };

  const result = await sql`
    INSERT INTO dbo.document_types (name, description, sort_order)
    OUTPUT INSERTED.type_id AS tid
    VALUES (${clean}, ${description?.trim() || null}, ${Number(sortOrder) || 0})
  `.execute(db);

  return { ok: true, typeId: Number(result.rows[0].tid) };
}

/**
 * Deactivates rather than deletes.
 *
 * Documents reference their type, so removing one would either orphan them or
 * cascade the classification away. Deactivating hides it from the picker while
 * leaving existing documents intact and still correctly labelled.
 */
export async function setTypeActive({ typeId, active }) {
  const result = await sql`
    UPDATE dbo.document_types SET is_active = ${active ? 1 : 0} WHERE type_id = ${typeId}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0) === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * Field definitions, optionally scoped to one type.
 *
 * A field with type_id NULL applies to every document type — the common case for
 * things like Reference Number or Department.
 */
export async function listFields({ typeId = null, includeInactive = false } = {}) {
  const result = await sql`
    SELECT f.field_id, f.type_id, f.name, f.data_type, f.is_required,
           f.is_searchable, f.sort_order, f.is_active, t.name AS type_name
      FROM dbo.custom_field_defs f
      LEFT JOIN dbo.document_types t ON t.type_id = f.type_id
     WHERE (${includeInactive ? 1 : 0} = 1 OR f.is_active = 1)
       -- NULL typeId means "all fields"; a value means global fields plus that
       -- type's own, which is exactly the set a form for that type needs.
       AND (${typeId} IS NULL OR f.type_id IS NULL OR f.type_id = ${typeId})
     ORDER BY f.sort_order, f.name
  `.execute(db);

  const fields = result.rows.map((row) => ({
    fieldId: Number(row.field_id),
    typeId: row.type_id === null ? null : Number(row.type_id),
    typeName: row.type_name,
    name: row.name,
    dataType: row.data_type,
    isRequired: Number(row.is_required) === 1,
    isSearchable: Number(row.is_searchable) === 1,
    sortOrder: Number(row.sort_order),
    isActive: Number(row.is_active) === 1,
    choices: [],
  }));

  const choiceFields = fields.filter((field) => ['choice', 'multiselect'].includes(field.dataType));
  if (choiceFields.length > 0) {
    const choices = await sql`
      SELECT choice_id, field_id, label, sort_order
        FROM dbo.custom_field_choices
       WHERE is_active = 1
         AND field_id IN (${sql.join(choiceFields.map((f) => sql`${f.fieldId}`))})
       ORDER BY sort_order, label
    `.execute(db);

    const byField = new Map();
    for (const row of choices.rows) {
      const list = byField.get(Number(row.field_id)) ?? [];
      list.push({ choiceId: Number(row.choice_id), label: row.label });
      byField.set(Number(row.field_id), list);
    }
    for (const field of choiceFields) field.choices = byField.get(field.fieldId) ?? [];
  }

  return fields;
}

export async function createField({
  name,
  dataType,
  typeId = null,
  isRequired = false,
  isSearchable = true,
  sortOrder = 0,
  choices = [],
}) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };
  if (!DATA_TYPES.has(dataType)) return { ok: false, reason: 'invalid_data_type' };
  if (['choice', 'multiselect'].includes(dataType) && choices.filter((c) => String(c).trim()).length === 0) {
    return { ok: false, reason: 'choices_required' };
  }

  try {
    const fieldId = await db.transaction().execute(async (trx) => {
      const inserted = await sql`
        INSERT INTO dbo.custom_field_defs
          (type_id, name, data_type, is_required, is_searchable, sort_order)
        OUTPUT INSERTED.field_id AS fid
        VALUES (${typeId}, ${clean}, ${dataType}, ${isRequired ? 1 : 0},
                ${isSearchable ? 1 : 0}, ${Number(sortOrder) || 0})
      `.execute(trx);

      const id = inserted.rows[0].fid;

      let order = 0;
      for (const label of choices.map((c) => String(c).trim()).filter(Boolean)) {
        await sql`
          INSERT INTO dbo.custom_field_choices (field_id, label, sort_order)
          VALUES (${id}, ${label}, ${order})
        `.execute(trx);
        order += 1;
      }

      return id;
    });

    return { ok: true, fieldId: Number(fieldId) };
  } catch (error) {
    // The filtered unique indexes enforce one name per type, and one per global
    // scope. Reporting the conflict beats surfacing an index name.
    if (/UX_custom_field_defs|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    throw error;
  }
}

export async function setFieldActive({ fieldId, active }) {
  const result = await sql`
    UPDATE dbo.custom_field_defs SET is_active = ${active ? 1 : 0} WHERE field_id = ${fieldId}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0) === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

// ── Sensitivity labels ───────────────────────────────────────────────────

export async function listLabels() {
  const result = await sql`
    SELECT label_id, name, severity_rank, colour, is_active
      FROM dbo.sensitivity_labels WHERE is_active = 1 ORDER BY severity_rank
  `.execute(db);

  return result.rows.map((row) => ({
    labelId: Number(row.label_id),
    name: row.name,
    severityRank: Number(row.severity_rank),
    colour: row.colour,
  }));
}

export async function createLabel({ name, severityRank, colour }) {
  const clean = String(name ?? '').trim();
  const rank = Number(severityRank);

  if (!clean || clean.length > 100) return { ok: false, reason: 'invalid_name' };
  if (!Number.isInteger(rank)) return { ok: false, reason: 'invalid_rank' };
  if (colour && !/^#[0-9A-Fa-f]{6}$/.test(colour)) return { ok: false, reason: 'invalid_colour' };

  try {
    const result = await sql`
      INSERT INTO dbo.sensitivity_labels (name, severity_rank, colour)
      OUTPUT INSERTED.label_id AS lid
      VALUES (${clean}, ${rank}, ${colour || null})
    `.execute(db);
    return { ok: true, labelId: Number(result.rows[0].lid) };
  } catch (error) {
    if (/UQ_sensitivity_labels|duplicate key/i.test(error.message)) {
      // Both the name and the rank are unique — the rank because "at or above
      // Confidential" is meaningless if two labels claim the same level.
      return { ok: false, reason: /rank/i.test(error.message) ? 'rank_taken' : 'name_taken' };
    }
    throw error;
  }
}

// ── Values on a document ─────────────────────────────────────────────────

/** The field values currently set on one document. */
export async function getDocumentFields(documentId) {
  const result = await sql`
    SELECT v.field_id, v.value_text, v.value_number, v.value_date, v.value_bool,
           v.value_choice_id, v.value_principal_id, f.name, f.data_type,
           c.label AS choice_label, pr.display_name AS principal_name
      FROM dbo.document_field_values v
      JOIN dbo.custom_field_defs f ON f.field_id = v.field_id
      LEFT JOIN dbo.custom_field_choices c ON c.choice_id = v.value_choice_id
      LEFT JOIN dbo.principals pr ON pr.principal_id = v.value_principal_id
     WHERE v.document_id = ${documentId}
     ORDER BY f.sort_order, f.name
  `.execute(db);

  const single = result.rows.map((row) => ({
    fieldId: Number(row.field_id),
    name: row.name,
    dataType: row.data_type,
    value: readValue(row),
    // Resolved for display: an id means nothing on screen, and a client should
    // not have to look up every choice and principal itself.
    choiceLabel: row.choice_label ?? row.principal_name ?? null,
  }));

  // Multi-select values live in their own table, so they are collected
  // separately and folded in as arrays.
  const selections = await sql`
    SELECT s.field_id, s.choice_id, f.name, c.label
      FROM dbo.document_field_selections s
      JOIN dbo.custom_field_defs f ON f.field_id = s.field_id
      JOIN dbo.custom_field_choices c ON c.choice_id = s.choice_id
     WHERE s.document_id = ${documentId}
     ORDER BY f.sort_order, c.sort_order
  `.execute(db);

  const grouped = new Map();
  for (const row of selections.rows) {
    const key = Number(row.field_id);
    const entry = grouped.get(key) ?? {
      fieldId: key,
      name: row.name,
      dataType: 'multiselect',
      value: [],
      choiceLabel: [],
    };
    entry.value.push(Number(row.choice_id));
    entry.choiceLabel.push(row.label);
    grouped.set(key, entry);
  }

  return [...single, ...grouped.values()];
}

function readValue(row) {
  switch (row.data_type) {
    case 'number':
      return row.value_number === null ? null : Number(row.value_number);
    case 'date':
      return row.value_date;
    case 'bool':
      return row.value_bool === null ? null : Number(row.value_bool) === 1;
    case 'choice':
      return row.value_choice_id === null ? null : Number(row.value_choice_id);
    case 'user':
      return row.value_principal_id === null ? null : String(row.value_principal_id);
    default:
      return row.value_text;
  }
}

/**
 * Updates a document's metadata: title, type, sensitivity and field values.
 *
 * Requires EDIT_META on the folder. The whole update is one transaction — a
 * half-applied metadata change is worse than none, because nobody can tell which
 * half landed.
 *
 * The title's normalised copy is rewritten alongside it. Writing one without the
 * other makes the document unfindable by its own new title, which is the kind of
 * bug that surfaces weeks later as "search is broken".
 */
export async function updateDocumentMetadata({ userId, documentId, title, typeId, labelId, fields }) {
  const found = await sql`
    SELECT folder_id, title FROM dbo.documents WHERE document_id = ${documentId} AND is_deleted = 0
  `.execute(db);

  const document = found.rows[0];
  if (!document) return { ok: false, reason: 'not_found' };

  const bits = await permissionBits(userId, document.folder_id);
  if (!has(bits, PERM.EDIT_META)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const newTitle = title === undefined ? null : String(title).trim();
  if (newTitle !== null && (!newTitle || newTitle.length > 500)) {
    return { ok: false, reason: 'invalid_title' };
  }

  // Validated before the transaction opens: a half-applied metadata change is
  // worse than none, because nobody can tell which half landed.
  const validation = await prepareFieldValues(fields);
  if (!validation.ok) return validation;
  const prepared = validation.prepared;

  await db.transaction().execute(async (trx) => {
    if (newTitle !== null || typeId !== undefined || labelId !== undefined) {
      await sql`
        UPDATE dbo.documents
           SET title = COALESCE(${newTitle}, title),
               title_normalized = COALESCE(${newTitle === null ? null : normalizeArabic(newTitle)}, title_normalized),
               type_id = ${typeId === undefined ? sql`type_id` : typeId},
               sensitivity_label_id = ${labelId === undefined ? sql`sensitivity_label_id` : labelId},
               updated_at = SYSUTCDATETIME(),
               updated_by = ${userId}
         WHERE document_id = ${documentId}
      `.execute(trx);
    }

    await writeFieldValues(trx, documentId, prepared);
  });

  log.info({ documentId: String(documentId), fields: prepared.length }, 'document metadata updated');
  return { ok: true };
}


/**
 * Validates a set of field values without writing anything.
 *
 * Separated from the write so both the upload path and the metadata editor can
 * check first: upload has to reject a missing required field before it streams
 * the file, and the editor has to reject before it opens a transaction.
 *
 * @returns {{ok: true, prepared: Array} | {ok: false, reason: string, detail?: string}}
 */
export async function prepareFieldValues(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return { ok: true, prepared: [] };

  const definitions = new Map((await listFields({ includeInactive: true })).map((f) => [f.fieldId, f]));
  const prepared = [];

  for (const entry of fields) {
    const definition = definitions.get(Number(entry.fieldId));
    if (!definition) return { ok: false, reason: 'unknown_field', detail: String(entry.fieldId) };

    const value = coerce(definition.dataType, entry.value);
    if (value === undefined) return { ok: false, reason: 'invalid_value', detail: definition.name };

    if (definition.isRequired && (value === null || (Array.isArray(value) && value.length === 0))) {
      return { ok: false, reason: 'required_field', detail: definition.name };
    }

    prepared.push({ fieldId: definition.fieldId, dataType: definition.dataType, value });
  }

  return { ok: true, prepared };
}

/**
 * Writes prepared values inside the caller's transaction.
 *
 * Takes the transaction rather than opening one so a document and its metadata
 * commit together — a document that exists without the metadata its type
 * requires is exactly what the required-field rule is meant to prevent.
 */
export async function writeFieldValues(trx, documentId, prepared) {
    for (const entry of prepared) {
      if (entry.dataType === 'multiselect') {
        // Replaced wholesale rather than diffed: the set is small, and a
        // delete-then-insert inside this transaction is atomic anyway.
        await sql`
          DELETE FROM dbo.document_field_selections
           WHERE document_id = ${documentId} AND field_id = ${entry.fieldId}
        `.execute(trx);

        for (const choiceId of entry.value ?? []) {
          await sql`
            INSERT INTO dbo.document_field_selections (document_id, field_id, choice_id)
            VALUES (${documentId}, ${entry.fieldId}, ${choiceId})
          `.execute(trx);
        }
        continue;
      }

      if (entry.value === null) {
        await sql`
          DELETE FROM dbo.document_field_values
           WHERE document_id = ${documentId} AND field_id = ${entry.fieldId}
        `.execute(trx);
        continue;
      }

      const column = VALUE_COLUMNS[entry.dataType];

      // Only the OTHER columns are cleared. Listing all five and then assigning
      // the target would set one column twice in the same SET clause, which SQL
      // Server rejects outright ("a column cannot be assigned more than one
      // value in the same clause").
      const cleared = sql.join(
        ALL_VALUE_COLUMNS.filter((name) => name !== column).map((name) => sql`${sql.raw(name)} = NULL`),
        sql`, `,
      );

      // A date arrives as ISO text and is converted here, never bound as a JS
      // Date: tedious binds one as SQL Server `datetime`, whose 3.33ms
      // resolution silently rounds the value away from the datetime2(3) column.
      const value =
        entry.dataType === 'date'
          ? sql`CONVERT(datetime2(3), ${entry.value}, 126)`
          : sql`${entry.value}`;

      // Clearing the others matters because CK_document_field_values_one_value
      // requires exactly one populated column: rewriting a value must not leave
      // the previous column behind.
      await sql`
        MERGE dbo.document_field_values WITH (HOLDLOCK) AS target
        USING (SELECT ${documentId} AS document_id, ${entry.fieldId} AS field_id) AS source
           ON target.document_id = source.document_id AND target.field_id = source.field_id
        WHEN MATCHED THEN
          UPDATE SET ${cleared},
                     ${sql.raw(column)} = ${value},
                     updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (document_id, field_id, ${sql.raw(column)})
          VALUES (source.document_id, source.field_id, ${value});
      `.execute(trx);
    }
}

/**
 * Converts an incoming value to what its column expects.
 * Returns null for "clear it", undefined for "this is not valid".
 */
function coerce(dataType, raw) {
  if (raw === null || raw === undefined || raw === '') return dataType === 'multiselect' ? [] : null;

  switch (dataType) {
    case 'number': {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'date': {
      const value = new Date(raw);
      // Sent as ISO text and converted server-side: a bound JS Date binds as
      // `datetime` (3.33ms) and will not compare equal to a datetime2(3) value.
      return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw ? 1 : 0;
      if (['true', '1', 'yes'].includes(String(raw).toLowerCase())) return 1;
      if (['false', '0', 'no'].includes(String(raw).toLowerCase())) return 0;
      return undefined;
    case 'choice': {
      const value = Number(raw);
      return Number.isInteger(value) ? value : undefined;
    }
    case 'user': {
      // A bigint principal id stays a string: Number() loses precision past 2^53.
      const value = String(raw).trim();
      return /^[0-9]{1,19}$/.test(value) ? value : undefined;
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : [raw];
      const ids = list.map((item) => Number(item));
      return ids.every((value) => Number.isInteger(value)) ? ids : undefined;
    }
    default: {
      const value = String(raw);
      return value.length > 1000 ? undefined : value;
    }
  }
}
