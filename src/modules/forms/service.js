/**
 * Official letter formats (النماذج) — the service.
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The institute writes its letters on formats it designed in Word. An
 * administrator uploads such a .docx, the server discovers its #placeholders#,
 * the administrator labels them in Arabic and says who may use the format, and
 * from then on a user fills a short form and gets a filed PDF letter.
 *
 * A placeholder is written #الاسم# — a hash, the name, a hash — because # is on
 * the Arabic keyboard (Shift+3) and does not mirror inside Arabic text. The
 * older {{الاسم}} form is still accepted, and both may appear in one file;
 * docx.js carries the whole rule and the reasoning behind it.
 *
 * ─── The built-ins, and their Arabic names ──────────────────────────────────
 *
 * #date#, #date_iso#, #date_ar# and #author# are the server's to fill, and
 * #التاريخ# and #المنشئ# are the same two values under the names an Arabic
 * letterhead writes. All of them are hidden from the fill form, DELETED from
 * whatever a client submits, and merged here — so no user can issue a letter
 * dated last year over somebody else's name, in either language.
 *
 * ─── One rule shapes everything here ────────────────────────────────────────
 *
 * A generated letter is an ordinary document. It is filed through
 * `createDocument` like any upload, so the folder's permission check, the
 * extension and size policy, duplicate detection, hashing, the write ordering
 * and the extraction/rendition/classification queues all apply exactly once.
 * There is deliberately no second filing path: a second path is a second place
 * for the permission check to be missing (the same argument client/src/scanToPdf
 * makes about scanning). `form_letters` records only the provenance — which
 * format, which values, by whom.
 *
 * ─── Where a letter may be filed is the format's decision ───────────────────
 *
 * An official format belongs to particular places — the outgoing-letters folder
 * of each department entitled to write on it. So a format carries a list of
 * assigned folders, and while that list is non-empty it is a RULE: the fill
 * screen offers only those of them the person may upload into, and `generate`
 * refuses every other destination. An empty list means «anywhere this person may
 * upload», which is what every format did before the list existed, so nothing
 * already configured changed meaning.
 *
 * A format assigned only to folders a person cannot upload into is not usable by
 * them at all, and is left out of their list and their count rather than offered
 * and then refused at the last step.
 *
 * ─── Why the work is ordered the way it is ──────────────────────────────────
 *
 * Everything that can be refused without spending anything is refused first:
 * the switch, access, the field values, the destination folder's UPLOAD bit.
 * Only then is a LibreOffice slot taken and a conversion started. Finding out
 * after a forty-second conversion that the type needed a reference number, or
 * that the person cannot file into the chosen folder, wastes the conversion and
 * the person's minute — and conversion is the one expensive thing in the whole
 * feature.
 *
 * ─── The conversion slot ────────────────────────────────────────────────────
 *
 * LibreOffice is a desktop office suite being asked to behave like a service.
 * Each run is a fresh profile and a whole CPU, and four at once on the
 * institute's server means four requests that all time out instead of two that
 * succeed. So conversions queue behind an in-process semaphore of
 * `config.forms.maxConcurrent`, and a caller who cannot get a slot within a
 * second is told `busy` rather than left holding a connection open. The
 * semaphore is per process on purpose: there is one Node process, and a
 * database-backed lock would add a failure mode (a stale lock nobody can clear)
 * to protect against a deployment that does not exist.
 *
 * ─── Lifecycle state is advisory ────────────────────────────────────────────
 *
 * `documents.lifecycle_state` is advisory everywhere in this system — nothing
 * enforces it on a write — and this module deliberately follows that
 * precedent: generating a letter into a folder does not consult it.
 *
 * ─── Deviation from the design, on the record ───────────────────────────────
 *
 * A template is created INACTIVE. Activation is what enforces the publishing
 * rules (every field labelled, every required field of the type mapped), and a
 * format that went live the instant its file finished uploading would never
 * meet them.
 */

import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { storage } from '../../storage/index.js';
import { getSetting } from '../settings/service.js';
import { PERM, permissionBits, has } from '../tree/service.js';
import { sanitizeTitle } from '../../storage/paths.js';
import {
  BUILT_IN_PLACEHOLDERS,
  isBuiltIn,
  builtInValues,
  inspectTemplate,
  looksLikeDocx,
  mergeDocx,
} from './docx.js';

const log = moduleLogger('forms');

/** Where template blobs live under the storage root. */
const TEMPLATE_NAMESPACE = 'templates';

/** `value_text` is nvarchar(1000); a longer mapped value cannot be stored. */
const MAPPED_TEXT_LIMIT = 1000;

/** Custom field types a placeholder may be mapped to. */
const MAPPABLE_TYPES = Object.freeze(['text', 'number', 'date']);

/** The stored switch. Off means every route answers "disabled" and no row is written. */
export async function isEnabled() {
  return Boolean(await getSetting('forms.enabled'));
}

// ── The conversion slot ──────────────────────────────────────────────────

let activeConversions = 0;
const slotQueue = [];

/** Takes a conversion slot, or gives up. See the header on why this is per process. */
async function acquireSlot(waitMs = 1000) {
  if (activeConversions < config.forms.maxConcurrent) {
    activeConversions += 1;
    return true;
  }

  return new Promise((resolve) => {
    const waiter = { settled: false, timer: null, grant: null };
    waiter.grant = (granted) => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      resolve(granted);
    };
    waiter.timer = setTimeout(() => {
      const index = slotQueue.indexOf(waiter);
      if (index >= 0) slotQueue.splice(index, 1);
      waiter.grant(false);
    }, waitMs);
    // A pending wait must not hold the process open at shutdown.
    waiter.timer.unref?.();
    slotQueue.push(waiter);
  });
}

/** Hands the slot to the next waiter, or gives it back to the pool. */
function releaseSlot() {
  const next = slotQueue.shift();
  if (next) {
    next.grant(true);
    return;
  }
  activeConversions = Math.max(0, activeConversions - 1);
}

// ── Status ───────────────────────────────────────────────────────────────

/**
 * What the working surface needs before it draws anything: the switch, how many
 * formats this person may use, and whether LibreOffice is actually there.
 *
 * `ready` is separate from `enabled` because the honest answer on a host with no
 * LibreOffice is "the formats exist but nothing can be produced today" — a
 * button that fails after forty seconds is worse than a sentence naming the
 * administrator.
 */
export async function formsStatus({ userId, isSuperAdmin = false }) {
  if (!(await isEnabled())) return { enabled: false };

  const [templates, tools] = await Promise.all([usableCount({ userId, isSuperAdmin }), libreOfficePresent()]);
  return { enabled: true, templates, ready: tools };
}

/** The admin readiness line: the switch and the tool. */
export async function toolStatus() {
  return { enabled: await isEnabled(), libreOffice: await libreOfficePresent() };
}

async function libreOfficePresent() {
  try {
    const { detectTools } = await import('../renditions/service.js');
    const tools = await detectTools();
    return Boolean(tools.libreoffice?.available);
  } catch (error) {
    log.warn({ err: error }, 'could not probe LibreOffice');
    return false;
  }
}

/**
 * How many formats this person may actually fill.
 *
 * It counts the list rather than counting rows, because "may fill" now depends
 * on the folders a format is assigned to: a format whose every assigned folder
 * is one this person cannot upload into is not usable by them. A COUNT that did
 * not know that rule would promise a number the picker then contradicts.
 */
async function usableCount({ userId, isSuperAdmin }) {
  return (await listTemplatesFor({ userId, isSuperAdmin })).length;
}

// ── The assigned folders ─────────────────────────────────────────────────

/**
 * The folders a format's letters may be filed into — a RULE, not a suggestion.
 *
 * Empty means "anywhere this person may upload", which is what every format
 * carried before the list existed. Non-empty means only these, and the fill
 * screen is given only the ones the person may upload into.
 *
 * The raw ids are read without touching permissions or the tree: `generate`
 * refuses a destination that is not on the list before it reads a single
 * permission bit, so a format that is not filed here costs nothing to refuse.
 */
async function assignedFolderIds(templateId, executor = db) {
  const result = await sql`
    SELECT folder_id FROM dbo.form_template_folders WHERE template_id = ${templateId}
  `.execute(executor);
  return new Set(result.rows.map((row) => String(row.folder_id)));
}

/**
 * For each of these formats: everything assigned to it, and the subset this
 * person may actually file into.
 *
 * One query for the whole page rather than one per folder: `fn_effective_
 * permission` is exactly what `permissionBits` wraps, and CROSS APPLY calls it
 * once per assigned folder inside the server instead of once per round trip.
 * A deleted folder stays in `assigned` — so it cannot silently widen the rule
 * back to "any folder" — but it is never offered.
 */
async function foldersByTemplate(templateIds, { userId, isSuperAdmin }) {
  const byTemplate = new Map();
  if (templateIds.length === 0) return byTemplate;

  const result = await sql`
    SELECT tf.template_id, tf.folder_id, fo.name,
           -- Usable means the person can both see the folder in the tree the
           -- picker draws from (BROWSE) and file into it (UPLOAD). An
           -- upload-only grant would list a template with no folder to choose.
           CASE WHEN fo.is_deleted = 0
                  AND (${isSuperAdmin ? 1 : 0} = 1
                       OR (p.perm_bits & ${PERM.UPLOAD | PERM.BROWSE}) = ${PERM.UPLOAD | PERM.BROWSE})
                THEN 1 ELSE 0 END AS usable
      FROM dbo.form_template_folders tf
      JOIN dbo.folders fo ON fo.folder_id = tf.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, tf.folder_id) p
     WHERE tf.template_id IN (${sql.join(templateIds.map((value) => sql`${value}`))})
     ORDER BY fo.name
  `.execute(db);

  for (const row of result.rows) {
    const key = Number(row.template_id);
    const entry = byTemplate.get(key) ?? { assigned: 0, usable: [] };
    entry.assigned += 1;
    if (Number(row.usable) === 1) {
      entry.usable.push({ folderId: String(row.folder_id), name: row.name });
    }
    byTemplate.set(key, entry);
  }
  return byTemplate;
}

// ── The working surface ──────────────────────────────────────────────────

/** The formats this person may fill, for the picker. */
export async function listTemplatesFor({ userId, isSuperAdmin = false }) {
  const result = await sql`
    SELECT t.template_id, t.name, t.description, t.type_id,
           ty.name AS type_name
      FROM dbo.form_templates t
      LEFT JOIN dbo.document_types ty ON ty.type_id = t.type_id
     WHERE t.is_active = 1
       AND (${isSuperAdmin ? 1 : 0} = 1 OR EXISTS (
             SELECT 1 FROM dbo.form_template_access a
              WHERE a.template_id = t.template_id
                AND a.principal_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
           ))
     ORDER BY t.name
  `.execute(db);

  const folders = await foldersByTemplate(
    result.rows.map((row) => Number(row.template_id)),
    { userId, isSuperAdmin },
  );

  const out = [];
  for (const row of result.rows) {
    const entry = folders.get(Number(row.template_id));

    // Assigned to folders and none of them is one this person may file into:
    // the format is not usable by them at all, so it is not offered. Left in
    // the list it would be a format whose every destination the fill screen has
    // to refuse — an entry that exists only to fail.
    if (entry && entry.usable.length === 0) continue;

    out.push({
      templateId: String(row.template_id),
      name: row.name,
      description: row.description,
      typeId: row.type_id === null ? null : Number(row.type_id),
      typeName: row.type_name ?? null,
      folders: entry ? entry.usable : [],
    });
  }
  return out;
}

/**
 * Resolves a format AND the caller's access to it in ONE query.
 *
 * "No such format" and "no access to that format" both answer `not_found`, so
 * the id of a format a person may not use is never confirmed to them —
 * the same rule the folder tree follows. `template_inactive` is reserved for a
 * caller who does hold access, because for them it is real information.
 */
async function resolveForCaller({ templateId, userId, isSuperAdmin }) {
  const result = await sql`
    SELECT t.template_id, t.name, t.description, t.storage_path, t.original_filename,
           t.sha256, t.bytes, t.type_id, t.approval_template_id,
           t.is_active, ty.name AS type_name,
           CASE WHEN ${isSuperAdmin ? 1 : 0} = 1 OR EXISTS (
                  SELECT 1 FROM dbo.form_template_access a
                   WHERE a.template_id = t.template_id
                     AND a.principal_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
                ) THEN 1 ELSE 0 END AS has_access
      FROM dbo.form_templates t
      LEFT JOIN dbo.document_types ty ON ty.type_id = t.type_id
     WHERE t.template_id = ${templateId}
  `.execute(db);

  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (Number(row.has_access) !== 1) return { ok: false, reason: 'not_found' };
  return { ok: true, row };
}

/** The fill form: every field a person must answer, with its rules. */
export async function getTemplateFor({ templateId, userId, isSuperAdmin = false }) {
  if (!(await isEnabled())) return { ok: false, reason: 'forms_disabled' };

  const found = await resolveForCaller({ templateId, userId, isSuperAdmin });
  if (!found.ok) return found;
  if (Number(found.row.is_active) !== 1) return { ok: false, reason: 'template_inactive' };

  const folders = (await foldersByTemplate([Number(templateId)], { userId, isSuperAdmin })).get(
    Number(templateId),
  );

  // Assigned to folders, none of them usable by this person: the same answer the
  // picker gives by leaving the format out. An empty `folders` means «anywhere
  // you may upload», so returning the form with an empty list would offer every
  // folder they hold UPLOAD on and then refuse each one at «إنشاء الكتاب».
  if (folders && folders.usable.length === 0) return { ok: false, reason: 'not_found' };

  const fields = await templateFields(templateId);
  return {
    ok: true,
    template: {
      ...describeTemplate(found.row, folders ? folders.usable : []),
      fields: fields.filter((field) => !field.builtIn),
    },
  };
}

function describeTemplate(row, folders = []) {
  return {
    templateId: String(row.template_id),
    name: row.name,
    description: row.description,
    typeId: row.type_id === null ? null : Number(row.type_id),
    typeName: row.type_name ?? null,
    approvalTemplateId: row.approval_template_id === null ? null : Number(row.approval_template_id),
    folders,
    isActive: Number(row.is_active) === 1,
    originalFilename: row.original_filename,
    bytes: row.bytes === undefined ? undefined : Number(row.bytes),
    sha256: row.sha256,
  };
}

/**
 * One format's fields, in the order discovery found them.
 *
 * `maxLength` is what the control should enforce: a mapped text value has to fit
 * `document_field_values.value_text` (nvarchar(1000)), an unmapped one only the
 * merge limit. Sending the number keeps the client and the server saying the
 * same thing instead of each carrying its own copy of the rule.
 *
 * `required` is DERIVED, not just read: a placeholder mapped to a field the type
 * itself demands is required whether or not the administrator ticked «إلزامي».
 * Otherwise the control carries no asterisk, the person leaves it blank, and the
 * refusal comes from the metadata layer naming the custom field's own name — a
 * label that appears nowhere on the form they are looking at.
 */
async function templateFields(templateId, executor = db) {
  const result = await sql`
    SELECT f.placeholder, f.label, f.is_multiline, f.is_required, f.is_built_in,
           f.field_id, f.sort_order, d.data_type, d.name AS field_name, d.type_id AS field_type_id,
           d.is_required AS field_is_required, d.is_active AS field_is_active
      FROM dbo.form_template_fields f
      LEFT JOIN dbo.custom_field_defs d ON d.field_id = f.field_id
     WHERE f.template_id = ${templateId}
     ORDER BY f.sort_order, f.placeholder
  `.execute(executor);

  return result.rows.map((row) => ({
    placeholder: row.placeholder,
    label: row.label,
    multiline: Number(row.is_multiline) === 1,
    required:
      Number(row.is_required) === 1 ||
      (row.field_id !== null &&
        Number(row.field_is_required) === 1 &&
        Number(row.field_is_active) === 1),
    builtIn: Number(row.is_built_in) === 1,
    fieldId: row.field_id === null ? null : Number(row.field_id),
    fieldName: row.field_name ?? null,
    fieldTypeId: row.field_type_id === null || row.field_type_id === undefined ? null : Number(row.field_type_id),
    dataType: row.data_type ?? null,
    maxLength: row.field_id !== null && row.data_type === 'text' ? MAPPED_TEXT_LIMIT : config.forms.maxValueChars,
    sortOrder: Number(row.sort_order),
  }));
}

// ── Generation ───────────────────────────────────────────────────────────

/**
 * Fills a format, converts it and files the letter.
 *
 * The order is load-bearing; see the header. Returns the new document so the
 * client can open it, plus whatever the optional approval start reported — an
 * approval that would not start must not lose the letter that already exists.
 */
export async function generate({
  userId,
  displayName = null,
  isSuperAdmin = false,
  templateId,
  folderId,
  title,
  values,
}) {
  if (!(await isEnabled())) return { ok: false, reason: 'forms_disabled' };

  const found = await resolveForCaller({ templateId, userId, isSuperAdmin });
  if (!found.ok) return found;
  const template = found.row;
  if (Number(template.is_active) !== 1) return { ok: false, reason: 'template_inactive' };

  // The assigned folders, first of everything: while the list is non-empty the
  // format's letters belong in one of those places and nowhere else. Refused
  // here, before a permission bit is read or a value is validated, because this
  // is the cheapest refusal in the function and the destination is the one thing
  // the person chose that the format itself can veto.
  const assigned = await assignedFolderIds(templateId);
  if (assigned.size > 0 && !assigned.has(String(folderId))) {
    return { ok: false, reason: 'folder_not_allowed' };
  }

  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle || cleanTitle.length > 500) return { ok: false, reason: 'invalid_title' };

  const fields = await templateFields(templateId);
  const typeId = template.type_id === null ? null : Number(template.type_id);

  // The built-in keys are DELETED from what the caller sent, not merely
  // ignored: the date and the author of an official letter are the server's to
  // state, and a client that posts author='the minister' must not be able to
  // reach the renderer with it.
  const submitted = { ...(values && typeof values === 'object' ? values : {}) };
  for (const key of BUILT_IN_PLACEHOLDERS) delete submitted[key];

  const known = new Set(fields.filter((field) => !field.builtIn).map((field) => field.placeholder));
  for (const key of Object.keys(submitted)) {
    if (!known.has(key)) return { ok: false, reason: 'unknown_placeholder', detail: { placeholder: key } };
  }

  const merged = { ...builtInValues({ displayName, now: new Date() }) };
  const mappedValues = [];

  for (const field of fields) {
    if (field.builtIn) continue;

    const raw = submitted[field.placeholder];
    const text = raw === null || raw === undefined ? '' : String(raw);

    if (field.required && text.trim() === '') {
      return { ok: false, reason: 'missing_value', detail: fieldDetail(field) };
    }
    if (text.length > config.forms.maxValueChars) {
      return { ok: false, reason: 'value_too_long', detail: { ...fieldDetail(field), limit: config.forms.maxValueChars } };
    }

    merged[field.placeholder] = text;

    if (field.fieldId === null || text.trim() === '') continue;

    // Checked here, before any I/O: the mapped column is narrower than the
    // merge limit, and a date or a number that the metadata layer would refuse
    // must not cost a conversion first.
    if (field.dataType === 'text' && text.length > MAPPED_TEXT_LIMIT) {
      return { ok: false, reason: 'value_too_long', detail: { ...fieldDetail(field), limit: MAPPED_TEXT_LIMIT } };
    }
    if (field.dataType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
      return { ok: false, reason: 'invalid_value', detail: fieldDetail(field) };
    }
    if (field.dataType === 'number' && !Number.isFinite(Number(text.trim()))) {
      return { ok: false, reason: 'invalid_value', detail: fieldDetail(field) };
    }

    mappedValues.push({ fieldId: field.fieldId, value: text.trim() });
  }

  const { prepareFieldValues } = await import('../metadata/service.js');
  const validated = await prepareFieldValues(mappedValues);
  if (!validated.ok) return { ok: false, reason: validated.reason, detail: validated.detail };

  // The folder's UPLOAD bit is createDocument's to enforce and it is not
  // duplicated here — but it is READ here, cheaply, so that no conversion runs
  // for a folder the person could never have filed into.
  const bits = await permissionBits(userId, folderId);
  if (!has(bits, PERM.UPLOAD)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  // The type's own required fields, up front. createDocument checks this too,
  // but it checks it AFTER the conversion has already happened.
  //
  // On exactly the same footing as an upload: createDocument fills the blanks
  // from the folder's defaults BEFORE it checks, so a default that satisfies a
  // required field has to satisfy it here too — otherwise a letter is refused
  // where dragging the same file into the same folder succeeds. Read after the
  // UPLOAD bit so no folder's defaults are read for someone who could not file
  // into it, and still before any conversion.
  const { applyDefaults } = await import('../metadata/defaults.js');
  const withDefaults = await applyDefaults({ folderId, fields: mappedValues });
  const missing = await missingRequiredFieldNames(typeId, withDefaults);
  if (missing.length > 0) return { ok: false, reason: 'required_field', detail: missing.join('، ') };

  if (!(await acquireSlot(1000))) return { ok: false, reason: 'busy' };

  let pdf;
  let workDir = null;
  try {
    const blob = await readTemplateBytes(template);
    if (!blob.ok) return blob;

    const filled = await mergeDocx(blob.buffer, merged);
    if (!filled.ok) return filled;

    // convertToPdf takes a PATH, and the path must be short and ASCII:
    // LibreOffice dies without a message once its profile path crosses the
    // Windows limit, and stored paths here carry Arabic titles.
    workDir = await mkdtemp(path.join(tmpdir(), 'dms-letter-'));
    const docxPath = path.join(workDir, 'letter.docx');
    await writeFile(docxPath, filled.buffer);

    const { convertToPdf } = await import('../renditions/service.js');
    let produced;
    try {
      produced = await convertToPdf(docxPath, { timeoutMs: config.forms.timeoutMs });
    } catch (error) {
      log.error({ err: error, templateId: String(templateId) }, 'letter conversion failed');
      return { ok: false, reason: 'conversion_failed' };
    }
    if (produced === null) return { ok: false, reason: 'libreoffice_missing' };

    try {
      pdf = await readFile(produced);
    } finally {
      // The produced PDF lives in a temp directory of convertToPdf's own making.
      await rm(path.dirname(produced), { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    releaseSlot();
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  const { createDocument } = await import('../documents/service.js');
  const created = await createDocument({
    userId,
    folderId,
    title: cleanTitle,
    stream: Readable.from(pdf),
    // The extension is what buildRelativePath and the allow-list read.
    filename: `${sanitizeTitle(cleanTitle, 80)}.pdf`,
    mimeType: 'application/pdf',
    typeId,
    fields: mappedValues.length > 0 ? mappedValues : null,
  });
  if (!created.ok) return created;

  // Provenance. A failure here must not lose a letter that exists and is
  // already visible in its folder, so it is logged rather than thrown.
  try {
    await sql`
      INSERT INTO dbo.form_letters (document_id, template_id, values_json, created_by)
      VALUES (${created.documentId}, ${templateId}, ${JSON.stringify(merged)}, ${userId})
    `.execute(db);
  } catch (error) {
    log.error({ err: error, documentId: created.documentId }, 'could not record letter provenance');
  }

  // The approval starts AFTER the document exists and outside its transaction:
  // an approval template whose approvers cannot read the folder would otherwise
  // roll back a letter that is perfectly valid.
  let approval = null;
  if (template.approval_template_id !== null) {
    const { requestApproval } = await import('../workflow/service.js');
    const started = await requestApproval({
      userId,
      documentId: created.documentId,
      templateId: Number(template.approval_template_id),
    });
    approval = started.ok
      ? { ok: true, requestId: String(started.requestId) }
      : { ok: false, reason: started.reason };
  }

  log.info(
    { templateId: String(templateId), documentId: created.documentId, folderId: String(folderId) },
    'letter generated',
  );

  return {
    ok: true,
    documentId: created.documentId,
    version: created.version,
    templateName: template.name,
    ...(created.duplicateOf ? { duplicateOf: created.duplicateOf } : {}),
    approval,
  };
}

function fieldDetail(field) {
  return { placeholder: field.placeholder, label: field.label || field.placeholder };
}

/**
 * Names the required fields of this type that nothing maps to.
 *
 * The same rule createDocument applies, called here BEFORE the conversion so a
 * person is refused in a moment rather than after a minute. Imported lazily,
 * like every cross-module call, to keep the module graph acyclic.
 */
async function missingRequiredFieldNames(typeId, provided) {
  const { missingRequiredFields } = await import('../documents/service.js');
  return missingRequiredFields(typeId, provided);
}

// ── The template blob ────────────────────────────────────────────────────

/**
 * Reads a template's bytes and proves they are the bytes that were uploaded.
 *
 * A mismatch is not a corrupt-file curiosity: it means the file on disk is not
 * the format the administrator approved, and merging unknown bytes would put an
 * unknown document on the institute's letterhead. Both absence and mismatch
 * answer `template_missing`, which the route reports as 503 — the format is
 * fine, the installation is not.
 */
async function readTemplateBytes(row) {
  try {
    const chunks = [];
    for await (const chunk of storage.createReadStream(row.storage_path)) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual !== row.sha256) {
      log.error({ storagePath: row.storage_path, expected: row.sha256, actual }, 'template bytes changed on disk');
      return { ok: false, reason: 'template_missing', detail: 'ملف النموذج لا يطابق البصمة المسجّلة' };
    }
    return { ok: true, buffer };
  } catch (error) {
    log.error({ err: error, storagePath: row.storage_path }, 'template file could not be read');
    return { ok: false, reason: 'template_missing', detail: 'ملف النموذج غير موجود' };
  }
}

/** The .docx itself, for an administrator who wants to edit and re-upload it. */
export async function readTemplateFile(templateId) {
  const result = await sql`
    SELECT template_id, storage_path, original_filename, sha256, bytes
      FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  const blob = await readTemplateBytes(row);
  if (!blob.ok) return blob;
  return { ok: true, buffer: blob.buffer, filename: row.original_filename };
}

// ── Administration ───────────────────────────────────────────────────────

/**
 * The assigned folders of every format, each with the path an administrator
 * recognises it by.
 *
 * The path is built from `mpath` — the materialized path every folder carries —
 * rather than by walking parents one row at a time: two queries answer for the
 * whole page. A deleted folder is still listed, because an administrator looking
 * at an assignment that no longer leads anywhere needs to see it to remove it.
 */
async function adminFoldersByTemplate() {
  const rows = await sql`
    SELECT tf.template_id, tf.folder_id, fo.name, fo.mpath, fo.is_deleted
      FROM dbo.form_template_folders tf
      JOIN dbo.folders fo ON fo.folder_id = tf.folder_id
     ORDER BY fo.name
  `.execute(db);

  if (rows.rows.length === 0) return new Map();

  const chains = rows.rows.map((row) => String(row.mpath ?? '').split('/').filter(Boolean));
  const involved = [...new Set(chains.flat())];
  const names = await sql`
    SELECT folder_id, name FROM dbo.folders
     WHERE folder_id IN (${sql.join(involved.map((value) => sql`${value}`))})
  `.execute(db);
  const nameById = new Map(names.rows.map((row) => [String(row.folder_id), row.name]));

  const byTemplate = new Map();
  for (const [index, row] of rows.rows.entries()) {
    const key = Number(row.template_id);
    const list = byTemplate.get(key) ?? [];
    const chain = chains[index].map((id) => nameById.get(id)).filter(Boolean);
    list.push({
      folderId: String(row.folder_id),
      name: row.name,
      path: chain.length > 0 ? chain.join(' / ') : row.name,
      // A deleted folder stays assigned (so a deletion never widens a format
      // to «any folder») but nobody can file into it; the screen says so.
      isDeleted: row.is_deleted === true || Number(row.is_deleted) === 1,
    });
    byTemplate.set(key, list);
  }
  return byTemplate;
}

/** Every format, with its fields, its folders and its access list, for the admin tab. */
export async function listTemplatesAdmin() {
  const templates = await sql`
    SELECT t.template_id, t.name, t.description, t.storage_path, t.original_filename,
           t.sha256, t.bytes, t.type_id, t.approval_template_id,
           t.is_active, t.created_at, t.updated_at,
           ty.name AS type_name, ap.name AS approval_template_name
      FROM dbo.form_templates t
      LEFT JOIN dbo.document_types ty ON ty.type_id = t.type_id
      LEFT JOIN dbo.approval_templates ap ON ap.template_id = t.approval_template_id
     ORDER BY t.name
  `.execute(db);

  if (templates.rows.length === 0) return [];

  const access = await sql`
    SELECT a.template_id, a.principal_id, p.display_name, p.principal_type
      FROM dbo.form_template_access a
      JOIN dbo.principals p ON p.principal_id = a.principal_id
     ORDER BY p.display_name
  `.execute(db);

  const byTemplate = new Map();
  for (const row of access.rows) {
    const list = byTemplate.get(Number(row.template_id)) ?? [];
    list.push({
      principalId: String(row.principal_id),
      displayName: row.display_name,
      kind: row.principal_type,
    });
    byTemplate.set(Number(row.template_id), list);
  }

  const foldersByTemplateId = await adminFoldersByTemplate();

  const out = [];
  for (const row of templates.rows) {
    const fields = await templateFields(row.template_id);
    out.push({
      ...describeTemplate(row, foldersByTemplateId.get(Number(row.template_id)) ?? []),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      approvalTemplateName: row.approval_template_name ?? null,
      fields,
      access: byTemplate.get(Number(row.template_id)) ?? [],
      unlabelled: fields.filter((field) => !field.builtIn && String(field.label ?? '').trim() === '').length,
      // What the admin tab warns about: the type demands these and no
      // placeholder carries them, so the format cannot be activated.
      unmappedRequired: await unmappedRequiredNames(
        row.type_id === null ? null : Number(row.type_id),
        fields,
      ),
    });
  }
  return out;
}

async function unmappedRequiredNames(typeId, fields) {
  return missingRequiredFieldNames(
    typeId,
    fields.filter((field) => field.fieldId !== null).map((field) => ({ fieldId: field.fieldId, value: 'x' })),
  );
}

/** Verifies a referenced row exists. Ids arrive from a form, not from us. */
async function exists(table, column, value) {
  const result = await sql`
    SELECT COUNT(*) AS n FROM ${sql.table(`dbo.${table}`)} WHERE ${sql.ref(column)} = ${value}
  `.execute(db);
  return Number(result.rows[0].n) > 0;
}

async function checkReferences({ typeId, approvalTemplateId }) {
  if (typeId !== null && typeId !== undefined && !(await exists('document_types', 'type_id', typeId))) {
    return { ok: false, reason: 'not_found', detail: 'نوع الوثيقة غير موجود' };
  }
  if (
    approvalTemplateId !== null &&
    approvalTemplateId !== undefined &&
    !(await exists('approval_templates', 'template_id', approvalTemplateId))
  ) {
    return { ok: false, reason: 'not_found', detail: 'قالب الموافقة غير موجود' };
  }
  return { ok: true };
}

/**
 * Cleans a list of folder ids and proves every one of them is a live folder.
 *
 * Duplicates collapse — the table's key would refuse the second row anyway, and
 * an administrator who picked the same folder twice meant it once. A deleted
 * folder is refused rather than stored: an assignment nobody can file into is a
 * format that cannot be used, and the administrator is here now to pick another.
 *
 * No permission check: which folders a format belongs to is the institute's
 * decision, not this administrator's own upload rights. Whether a particular
 * person may file there is decided when they file.
 */
async function cleanFolderIds(folderIds) {
  const ids = [...new Set((Array.isArray(folderIds) ? folderIds : []).map((id) => String(id).trim()))];
  for (const id of ids) {
    if (!/^[0-9]{1,19}$/.test(id)) return { ok: false, reason: 'invalid_value', detail: id };
    const live = await sql`
      SELECT COUNT(*) AS n FROM dbo.folders WHERE folder_id = ${id} AND is_deleted = 0
    `.execute(db);
    if (Number(live.rows[0].n) === 0) {
      return { ok: false, reason: 'not_found', detail: `المجلد غير موجود: ${id}` };
    }
  }
  return { ok: true, ids };
}

/**
 * Registers a new format from an uploaded .docx.
 *
 * Created inactive: activation is where the publishing rules live, and a format
 * that went live the moment its file finished uploading would never meet them.
 */
export async function createTemplate({
  userId,
  name,
  description = null,
  typeId = null,
  approvalTemplateId = null,
  folderIds = null,
  filename,
  buffer,
}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > 200) {
    return { ok: false, reason: 'invalid_value', detail: 'اسم النموذج مطلوب (٢٠٠ حرف كحد أقصى)' };
  }

  const shape = looksLikeDocx(buffer, filename);
  if (!shape.ok) return shape;

  const references = await checkReferences({ typeId, approvalTemplateId });
  if (!references.ok) return references;

  const folders = await cleanFolderIds(folderIds);
  if (!folders.ok) return folders;

  const inspected = await inspectTemplate(buffer);
  if (!inspected.ok) return inspected;

  const relativePath = `${TEMPLATE_NAMESPACE}/${randomUUID()}.docx`;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  let stored;
  try {
    stored = await storage.putBuffer(buffer, relativePath);
  } catch (error) {
    log.error({ err: error }, 'could not store a template');
    return { ok: false, reason: 'storage_failed' };
  }

  let templateId;
  try {
    templateId = await db.transaction().execute(async (trx) => {
      const inserted = await sql`
        INSERT INTO dbo.form_templates
          (name, description, storage_path, original_filename, sha256, bytes,
           type_id, approval_template_id, is_active, created_by)
        OUTPUT INSERTED.template_id AS tid
        VALUES (${cleanName}, ${description ?? null}, ${stored.relativePath},
                ${String(filename).slice(0, 255)}, ${sha256}, ${stored.bytes},
                ${typeId}, ${approvalTemplateId}, 0, ${userId})
      `.execute(trx);

      const id = Number(inserted.rows[0].tid);
      await insertFields(trx, id, inspected.tags, new Map());
      await insertFolders(trx, id, folders.ids);
      return id;
    });
  } catch (error) {
    await storage.remove(stored.relativePath).catch(() => {});
    log.error({ err: error }, 'could not register a template');
    return { ok: false, reason: 'storage_failed' };
  }

  const template = await adminTemplate(templateId);
  return { ok: true, template };
}

/**
 * Writes the field rows discovered in a file.
 *
 * `keep` carries the rows that survive a file replacement, so a label an
 * administrator typed in Arabic is not lost because the Word file was edited.
 * A new field's label defaults to its own placeholder — which is exactly right
 * when the placeholder is already Arabic, and visibly wrong when it is not,
 * which is the point.
 */
async function insertFields(trx, templateId, tags, keep) {
  let order = 0;
  for (const tag of tags) {
    const previous = keep.get(tag);
    const builtIn = isBuiltIn(tag);
    await sql`
      INSERT INTO dbo.form_template_fields
        (template_id, placeholder, label, is_multiline, is_required, is_built_in, field_id, sort_order)
      VALUES (${templateId}, ${tag}, ${previous?.label ?? tag},
              ${previous?.is_multiline ?? 0}, ${previous?.is_required ?? 0},
              ${builtIn ? 1 : 0}, ${previous?.field_id ?? null}, ${order})
    `.execute(trx);
    order += 1;
  }
}

/** Writes the folder assignments. The caller has already cleaned the ids. */
async function insertFolders(trx, templateId, folderIds) {
  for (const folderId of folderIds) {
    await sql`
      INSERT INTO dbo.form_template_folders (template_id, folder_id)
      VALUES (${templateId}, ${folderId})
    `.execute(trx);
  }
}

async function adminTemplate(templateId) {
  const all = await listTemplatesAdmin();
  return all.find((template) => template.templateId === String(templateId)) ?? null;
}

/**
 * Changes a format's description, its bindings or its published state.
 *
 * Two rules are enforced here rather than at generation time, because a format
 * is published once and filled a thousand times: every field a person will see
 * must carry a label, and every required field of the chosen type must be
 * reachable from some placeholder. Refusing at activation puts the problem in
 * front of the one person who can fix it.
 */
export async function updateTemplate({
  templateId,
  name,
  description,
  typeId,
  approvalTemplateId,
  isActive,
}) {
  const current = await sql`
    SELECT template_id, type_id, is_active FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  const row = current.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  const nextName = name === undefined ? undefined : String(name ?? '').trim();
  if (nextName !== undefined && (!nextName || nextName.length > 200)) {
    return { ok: false, reason: 'invalid_value', detail: 'اسم النموذج مطلوب (٢٠٠ حرف كحد أقصى)' };
  }

  const references = await checkReferences({
    typeId: typeId === undefined ? null : typeId,
    approvalTemplateId: approvalTemplateId === undefined ? null : approvalTemplateId,
  });
  if (!references.ok) return references;

  const nextTypeId = typeId === undefined ? (row.type_id === null ? null : Number(row.type_id)) : typeId;
  const typeChanged = typeId !== undefined && Number(typeId ?? -1) !== Number(row.type_id ?? -1);

  // A mapping to a field belonging to the OLD type is meaningless once the type
  // changes, and silently leaving it would file a value under a field the new
  // type does not have. Cleared, and named in the answer so the administrator
  // learns which placeholders lost their mapping.
  let clearedMappings = [];
  if (typeChanged) {
    const invalid = await sql`
      SELECT f.placeholder
        FROM dbo.form_template_fields f
        JOIN dbo.custom_field_defs d ON d.field_id = f.field_id
       WHERE f.template_id = ${templateId}
         AND d.type_id IS NOT NULL
         AND (${nextTypeId} IS NULL OR d.type_id <> ${nextTypeId})
    `.execute(db);
    clearedMappings = invalid.rows.map((entry) => entry.placeholder);
  }

  // The publishing rules are about what is LIVE, not about the moment the switch
  // is flipped. Changing the type of an already-active format clears the
  // mappings to the old type's fields above, so checking only on activation left
  // the format published and unfillable: it kept appearing on /forms and every
  // «إنشاء الكتاب» came back «الحقل … إلزامي» with no control to fill. So the
  // rules run whenever the format will still be live afterwards and its type
  // moved. The administrator can still deactivate, change the type, remap the
  // fields and publish again.
  const willBeActive = isActive === undefined ? Number(row.is_active) === 1 : isActive === true;
  const activating = willBeActive && (isActive === true || typeChanged);
  if (activating) {
    const fields = await templateFields(templateId);
    const effective = fields.map((field) =>
      clearedMappings.includes(field.placeholder) ? { ...field, fieldId: null } : field,
    );

    const unlabelled = effective
      .filter((field) => !field.builtIn && String(field.label ?? '').trim() === '')
      .map((field) => field.placeholder);
    if (unlabelled.length > 0) {
      return { ok: false, reason: 'fields_unlabelled', detail: unlabelled.join('، ') };
    }

    const missing = await unmappedRequiredNames(nextTypeId, effective);
    if (missing.length > 0) {
      return { ok: false, reason: 'type_requires_fields', detail: missing.join('، ') };
    }
  }

  await db.transaction().execute(async (trx) => {
    if (clearedMappings.length > 0) {
      await sql`
        UPDATE f SET field_id = NULL
          FROM dbo.form_template_fields f
          JOIN dbo.custom_field_defs d ON d.field_id = f.field_id
         WHERE f.template_id = ${templateId}
           AND d.type_id IS NOT NULL
           AND (${nextTypeId} IS NULL OR d.type_id <> ${nextTypeId})
      `.execute(trx);
    }

    await sql`
      UPDATE dbo.form_templates
         SET name = COALESCE(${nextName ?? null}, name),
             description = CASE WHEN ${description === undefined ? 1 : 0} = 1 THEN description ELSE ${description ?? null} END,
             type_id = CASE WHEN ${typeId === undefined ? 1 : 0} = 1 THEN type_id ELSE ${typeId ?? null} END,
             approval_template_id = CASE WHEN ${approvalTemplateId === undefined ? 1 : 0} = 1
                                        THEN approval_template_id ELSE ${approvalTemplateId ?? null} END,
             is_active = CASE WHEN ${isActive === undefined ? 1 : 0} = 1 THEN is_active ELSE ${isActive ? 1 : 0} END,
             updated_at = SYSUTCDATETIME()
       WHERE template_id = ${templateId}
    `.execute(trx);
  });

  const template = await adminTemplate(templateId);
  return { ok: true, template, ...(clearedMappings.length > 0 ? { clearedMappings } : {}) };
}

/**
 * Replaces the Word file behind a format, keeping what survives.
 *
 * The diff is returned rather than applied silently: a placeholder that
 * disappeared took an Arabic label and possibly a field mapping with it, and the
 * administrator is the only one who can tell whether that was the intention.
 *
 * A replacement that costs a live format the only placeholder carrying one of
 * its type's required fields takes the format OFFLINE, and says so. The
 * publishing rules are the same ones activation enforces; letting this path walk
 * past them left the format published and unfillable, and the people filling it
 * met «الحقل … إلزامي» for a field that no longer had a control. Deactivated,
 * they meet «هذا النموذج معطّل حالياً» instead, and re-publishing goes back
 * through updateTemplate's rules.
 */
export async function replaceTemplateFile({ templateId, filename, buffer }) {
  const current = await sql`
    SELECT template_id, storage_path, type_id, is_active
      FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  const row = current.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  const shape = looksLikeDocx(buffer, filename);
  if (!shape.ok) return shape;

  const inspected = await inspectTemplate(buffer);
  if (!inspected.ok) return inspected;

  const existing = await sql`
    SELECT placeholder, label, is_multiline, is_required, field_id
      FROM dbo.form_template_fields WHERE template_id = ${templateId}
  `.execute(db);
  const keep = new Map(existing.rows.map((field) => [field.placeholder, field]));

  const added = inspected.tags.filter((tag) => !keep.has(tag));
  const kept = inspected.tags.filter((tag) => keep.has(tag));
  const removed = [...keep.keys()].filter((placeholder) => !inspected.tags.includes(placeholder));

  // What the format's fields will be once the rows are rewritten below: a
  // surviving placeholder keeps its mapping, a newly discovered one has none.
  // Only a live format is judged — an inactive one is already behind the
  // activation rules.
  const effective = inspected.tags.map((tag) => {
    const previous = keep.get(tag);
    return {
      placeholder: tag,
      fieldId:
        previous && previous.field_id !== null && previous.field_id !== undefined
          ? Number(previous.field_id)
          : null,
    };
  });
  const deactivated =
    Number(row.is_active) === 1
      ? await unmappedRequiredNames(row.type_id === null ? null : Number(row.type_id), effective)
      : [];

  const relativePath = `${TEMPLATE_NAMESPACE}/${randomUUID()}.docx`;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  let stored;
  try {
    stored = await storage.putBuffer(buffer, relativePath);
  } catch (error) {
    log.error({ err: error }, 'could not store a replacement template');
    return { ok: false, reason: 'storage_failed' };
  }

  try {
    await db.transaction().execute(async (trx) => {
      await sql`DELETE FROM dbo.form_template_fields WHERE template_id = ${templateId}`.execute(trx);
      await insertFields(trx, Number(templateId), inspected.tags, keep);
      await sql`
        UPDATE dbo.form_templates
           SET storage_path = ${stored.relativePath}, original_filename = ${String(filename).slice(0, 255)},
               sha256 = ${sha256}, bytes = ${stored.bytes},
               is_active = CASE WHEN ${deactivated.length > 0 ? 1 : 0} = 1 THEN 0 ELSE is_active END,
               updated_at = SYSUTCDATETIME()
         WHERE template_id = ${templateId}
      `.execute(trx);
    });
  } catch (error) {
    await storage.remove(stored.relativePath).catch(() => {});
    log.error({ err: error }, 'could not replace a template file');
    return { ok: false, reason: 'storage_failed' };
  }

  // The old blob goes only after the rows committed. An unreferenced file is
  // harmless; a row pointing at nothing is a format that cannot be used.
  await storage.remove(row.storage_path).catch(() => {});

  const template = await adminTemplate(templateId);
  return {
    ok: true,
    template,
    diff: { added, removed, kept },
    ...(deactivated.length > 0 ? { deactivated } : {}),
  };
}

/** Who may fill this format. Groups expand through fn_expand_principals. */
export async function setTemplateAccess({ templateId, principalIds }) {
  const current = await sql`
    SELECT template_id FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  if (!current.rows[0]) return { ok: false, reason: 'not_found' };

  const ids = [...new Set((Array.isArray(principalIds) ? principalIds : []).map((id) => String(id).trim()))];
  for (const id of ids) {
    if (!/^[0-9]{1,19}$/.test(id)) return { ok: false, reason: 'invalid_value', detail: id };
    if (!(await exists('principals', 'principal_id', id))) {
      return { ok: false, reason: 'not_found', detail: id };
    }
  }

  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM dbo.form_template_access WHERE template_id = ${templateId}`.execute(trx);
    for (const id of ids) {
      await sql`
        INSERT INTO dbo.form_template_access (template_id, principal_id) VALUES (${templateId}, ${id})
      `.execute(trx);
    }
  });

  const template = await adminTemplate(templateId);
  return { ok: true, template };
}

/**
 * Where this format's letters may be filed.
 *
 * An empty list is meaningful and allowed: it restores «any folder the person may
 * upload into», which is what every format did before assignment existed. So
 * this is a replace, not a merge — the administrator is looking at the whole list
 * in the dialog, and the set they submit is the set that holds afterwards.
 *
 * Replaced in ONE transaction: a delete that committed without its insert would
 * leave the format open to every folder, which is the failure that matters here.
 */
export async function setTemplateFolders({ templateId, folderIds }) {
  const current = await sql`
    SELECT template_id FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  if (!current.rows[0]) return { ok: false, reason: 'not_found' };

  const folders = await cleanFolderIds(folderIds);
  if (!folders.ok) return folders;

  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM dbo.form_template_folders WHERE template_id = ${templateId}`.execute(trx);
    await insertFolders(trx, templateId, folders.ids);
  });

  const template = await adminTemplate(templateId);
  return { ok: true, template };
}

/**
 * Labels the placeholders, and says which of them are also metadata.
 *
 * Only text, number and date fields may be mapped, and only fields that belong
 * to the format's own type or to no type at all. A choice or a user field cannot
 * be mapped because a letter's placeholder is free text: there is nothing to
 * match a typed sentence against a picklist with, and guessing would file
 * documents under the wrong choice silently.
 *
 * An entry naming a built-in placeholder is ignored rather than refused: the
 * form does not offer those, and a client that echoes the whole field list back
 * should not be punished for it.
 */
export async function setTemplateFields({ templateId, fields }) {
  const current = await sql`
    SELECT template_id, type_id FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  const row = current.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  const typeId = row.type_id === null ? null : Number(row.type_id);

  const rows = await sql`
    SELECT placeholder, is_built_in FROM dbo.form_template_fields WHERE template_id = ${templateId}
  `.execute(db);
  const present = new Map(rows.rows.map((field) => [field.placeholder, Number(field.is_built_in) === 1]));

  const { listFields } = await import('../metadata/service.js');
  const definitions = new Map((await listFields({ includeInactive: true })).map((field) => [field.fieldId, field]));

  const updates = [];
  for (const entry of Array.isArray(fields) ? fields : []) {
    const placeholder = String(entry?.placeholder ?? '');
    if (!present.has(placeholder)) {
      return { ok: false, reason: 'unknown_placeholder', detail: { placeholder } };
    }
    if (present.get(placeholder)) continue;

    const label = String(entry?.label ?? '');
    if (label.length > 200) {
      return { ok: false, reason: 'value_too_long', detail: { placeholder, label: label.slice(0, 40) } };
    }

    let fieldId = null;
    if (entry?.fieldId !== null && entry?.fieldId !== undefined && entry.fieldId !== '') {
      fieldId = Number(entry.fieldId);
      const definition = definitions.get(fieldId);
      if (!definition) return { ok: false, reason: 'field_unmappable', detail: { placeholder } };
      if (!MAPPABLE_TYPES.includes(definition.dataType)) {
        return {
          ok: false,
          reason: 'field_unmappable',
          detail: { placeholder, field: definition.name, dataType: definition.dataType },
        };
      }
      if (definition.typeId !== null && definition.typeId !== typeId) {
        return {
          ok: false,
          reason: 'field_not_in_type',
          detail: { placeholder, field: definition.name },
        };
      }
    }

    updates.push({
      placeholder,
      label,
      multiline: entry?.multiline ? 1 : 0,
      required: entry?.required ? 1 : 0,
      fieldId,
      sortOrder: Number.isInteger(Number(entry?.sortOrder)) ? Number(entry.sortOrder) : 0,
    });
  }

  // One field may not be mapped to the same metadata field twice: the second
  // write would overwrite the first and the letter would carry only one.
  //
  // Its own reason code, and both offending placeholders named as a STRING: this
  // used to borrow `field_unmappable` — the data-type refusal — so the
  // administrator was told the field could not be mapped at all, about a field
  // the very select had offered, with no clue which two rows collided.
  const seen = new Map();
  for (const entry of updates) {
    if (entry.fieldId === null) continue;
    if (seen.has(entry.fieldId)) {
      return {
        ok: false,
        reason: 'field_mapped_twice',
        detail: `${seen.get(entry.fieldId)} + ${entry.placeholder}`,
      };
    }
    seen.set(entry.fieldId, entry.placeholder);
  }

  await db.transaction().execute(async (trx) => {
    for (const entry of updates) {
      await sql`
        UPDATE dbo.form_template_fields
           SET label = ${entry.label}, is_multiline = ${entry.multiline},
               is_required = ${entry.required}, field_id = ${entry.fieldId},
               sort_order = ${entry.sortOrder}
         WHERE template_id = ${templateId} AND placeholder = ${entry.placeholder}
      `.execute(trx);
    }
  });

  const template = await adminTemplate(templateId);
  return { ok: true, template };
}

/**
 * A sample-filled PDF, for checking that LibreOffice reproduces the format.
 *
 * Creates nothing. Every field is filled with its own Arabic label, so the
 * administrator sees which box on the page each label lands in — the question
 * they actually have. It takes a conversion slot like a real letter, because it
 * costs exactly as much.
 */
export async function previewTemplate({ templateId, displayName = null }) {
  const current = await sql`
    SELECT template_id, name, storage_path, sha256 FROM dbo.form_templates WHERE template_id = ${templateId}
  `.execute(db);
  const row = current.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  const fields = await templateFields(templateId);
  const values = { ...builtInValues({ displayName, now: new Date() }) };
  for (const field of fields) {
    if (field.builtIn) continue;
    values[field.placeholder] = String(field.label ?? '').trim() || field.placeholder;
  }

  if (!(await acquireSlot(1000))) return { ok: false, reason: 'busy' };

  let workDir = null;
  try {
    const blob = await readTemplateBytes(row);
    if (!blob.ok) return blob;

    const filled = await mergeDocx(blob.buffer, values);
    if (!filled.ok) return filled;

    workDir = await mkdtemp(path.join(tmpdir(), 'dms-preview-'));
    const docxPath = path.join(workDir, 'preview.docx');
    await writeFile(docxPath, filled.buffer);

    const { convertToPdf } = await import('../renditions/service.js');
    let produced;
    try {
      produced = await convertToPdf(docxPath, { timeoutMs: config.forms.timeoutMs });
    } catch (error) {
      log.error({ err: error, templateId: String(templateId) }, 'template preview failed');
      return { ok: false, reason: 'conversion_failed' };
    }
    if (produced === null) return { ok: false, reason: 'libreoffice_missing' };

    try {
      return { ok: true, pdf: await readFile(produced), name: row.name };
    } finally {
      await rm(path.dirname(produced), { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    releaseSlot();
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
