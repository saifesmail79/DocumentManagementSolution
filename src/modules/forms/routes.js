/**
 * Letter format routes (النماذج).
 *
 * Two scopes, mounted separately in app.js, the same split the mail room uses:
 *
 *   • /api/forms        — the working surface: status, the formats this person
 *     may fill, and generation.
 *   • /api/admin/forms  — super-admin configuration of the formats themselves.
 *
 * Every route except the two `/status` routes answers 409 `forms_disabled`
 * while the stored switch is off, so an install that has not adopted letter
 * formats carries the code inert. The status routes answer regardless, because
 * that is how the client knows whether to render anything at all.
 *
 * ─── What lives here and not in the service ─────────────────────────────────
 *
 * The audit trail and the event fan-out. `record` needs the request (its actor,
 * its IP, its user agent) and the house convention is that the route writes the
 * trail, not the service — so the same service call from a future script cannot
 * forge a user's name into the log.
 *
 * ─── Multipart ──────────────────────────────────────────────────────────────
 *
 * Scalar fields must arrive BEFORE the file part: the stream is read in order,
 * and a field sent after the file is unreachable while that file is still being
 * consumed. The upload is counted as it is read and refused at
 * `config.forms.maxTemplateBytes`, and a refused stream is still drained — a
 * client that is not drained sees a stalled connection rather than the error.
 */

import contentDisposition from 'content-disposition';

import { config } from '../../config/index.js';
import {
  isEnabled,
  formsStatus,
  toolStatus,
  listTemplatesFor,
  getTemplateFor,
  generate,
  listTemplatesAdmin,
  createTemplate,
  updateTemplate,
  replaceTemplateFile,
  setTemplateAccess,
  setTemplateFolders,
  setTemplateFields,
  readTemplateFile,
  previewTemplate,
} from './service.js';
import { record, ACTION } from '../audit/service.js';
import { announceDocumentEvent } from '../documents/events.js';

/**
 * Refusal reason to HTTP code.
 *
 * Its own map rather than an extension of the documents module's: a feature that
 * borrows another's table of codes ends up either constrained by it or quietly
 * changing it for everyone.
 *
 * 503 for `libreoffice_missing`, `template_missing` and `busy` says the same
 * thing three ways — the request was fine, the installation could not serve it
 * right now — which is exactly what a person should be told to report to the
 * administrator rather than retype.
 */
const STATUS = {
  forms_disabled: 409,
  template_inactive: 409,
  duplicate: 409,
  conflict: 409,
  not_found: 404,
  forbidden: 403,
  // The destination is not one of the folders this format is filed into. 403
  // rather than 400: the request is well formed and the folder is real, it is
  // the format that does not go there.
  folder_not_allowed: 403,
  invalid_title: 400,
  missing_value: 400,
  value_too_long: 400,
  unknown_placeholder: 400,
  invalid_value: 400,
  required_field: 400,
  template_invalid: 400,
  field_unmappable: 400,
  field_mapped_twice: 400,
  field_not_in_type: 400,
  fields_unlabelled: 400,
  type_requires_fields: 400,
  no_file: 400,
  unknown_field: 400,
  libreoffice_missing: 503,
  template_missing: 503,
  busy: 503,
  storage_failed: 500,
  conversion_failed: 502,
  blocked_extension: 415,
  too_large: 413,
};

function refuse(reply, result) {
  return reply.code(STATUS[result.reason] ?? 400).send({ ...result, error: result.reason });
}

/** Template ids are int; document and folder ids are bigint and stay strings. */
function parseTemplateId(value) {
  const text = String(value ?? '').trim();
  return /^[0-9]{1,9}$/.test(text) ? Number(text) : null;
}

function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

/**
 * The folders a format is assigned to, from a JSON body: `{ folderIds: [...] }`.
 *
 * An absent list is an empty list — the caller said «any folder». A list holding
 * anything that is not an id is refused whole rather than filtered, because
 * silently dropping one entry would assign the format to fewer places than the
 * administrator chose and the dialog would still show what they picked.
 */
function parseFolderIds(value) {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value)) return { ok: false };
  const ids = value.map((entry) => parseId(entry));
  if (ids.some((id) => id === null)) return { ok: false };
  return { ok: true, ids };
}

/**
 * The same list as a multipart scalar part, which is text and not an array: the
 * create form sends it as JSON in one part, before the file. Absent means «any
 * folder»; malformed is refused rather than read as absent.
 */
function parseFolderIdsField(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, ids: [] };
  try {
    return parseFolderIds(JSON.parse(String(value)));
  } catch {
    return { ok: false };
  }
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

async function requireEnabled(_request, reply) {
  if (!(await isEnabled())) {
    return reply.code(409).send({ error: 'forms_disabled' });
  }
}

/**
 * Reads a template upload: the scalar fields, then the file, counting bytes.
 *
 * The stream is consumed with event handlers rather than `for await`, because
 * returning out of a for-await loop calls the iterator's return() and closes the
 * multipart stream — the client is then left waiting on a request nobody is
 * reading. An over-size upload is drained to its end and reported as `too_large`.
 */
async function readTemplateUpload(request) {
  const parts = request.parts();
  const fields = {};
  let file = null;

  for (;;) {
    const { value: part, done } = await parts.next();
    if (done) break;
    if (part.type === 'file') {
      file = part;
      break;
    }
    fields[part.fieldname] = part.value;
  }

  if (!file) return { ok: false, reason: 'no_file' };

  const limit = config.forms.maxTemplateBytes;
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let refused = false;
    file.file.on('data', (chunk) => {
      if (refused) return;
      bytes += chunk.length;
      if (bytes > limit) {
        refused = true;
        chunks.length = 0;
        file.file.resume();
        return;
      }
      chunks.push(chunk);
    });
    file.file.on('end', () => resolve(refused ? null : Buffer.concat(chunks)));
    file.file.on('error', reject);
  });

  if (buffer === null) return { ok: false, reason: 'too_large', detail: `الحد ${limit} بايت` };
  return { ok: true, fields, filename: file.filename, buffer };
}

/** Mounted under /api/forms. */
export async function formsRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  /** The one route that answers while the switch is off. */
  app.get('/status', async (request) =>
    formsStatus({ userId: request.user.userId, isSuperAdmin: request.user.isSuperAdmin }),
  );

  app.get('/templates', { preHandler: requireEnabled }, async (request) => ({
    templates: await listTemplatesFor({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    }),
  }));

  app.get('/templates/:templateId', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const result = await getTemplateFor({
      templateId,
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    });
    if (!result.ok) return refuse(reply, result);
    return { template: result.template };
  });

  /**
   * Produces one letter.
   *
   * `bodyLimit` is the module's own rather than the instance's: the instance's
   * limit is sized for file uploads, and this body is a handful of text values.
   */
  app.post(
    '/generate',
    { preHandler: requireEnabled, bodyLimit: config.forms.bodyLimitBytes },
    async (request, reply) => {
      const templateId = parseTemplateId(request.body?.templateId);
      if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });
      const folderId = parseId(request.body?.folderId);
      if (folderId === null) return reply.code(400).send({ error: 'invalid_folder_id' });

      const title = String(request.body?.title ?? '').trim();

      const result = await generate({
        userId: request.user.userId,
        displayName: request.user.displayName,
        isSuperAdmin: request.user.isSuperAdmin,
        templateId,
        folderId,
        title,
        values: request.body?.values,
      });
      if (!result.ok) return refuse(reply, result);

      // The letter is a document first: the documents trail must show it, or a
      // folder's history would have a document nobody filed.
      await record({
        actor: request.user,
        action: ACTION.DOCUMENT_CREATED,
        targetType: 'document',
        targetId: result.documentId,
        folderId,
        detail: title,
        request,
      });

      await record({
        actor: request.user,
        action: ACTION.FORM_LETTER_CREATED,
        targetType: 'document',
        targetId: result.documentId,
        folderId,
        detail:
          `template ${result.templateName}` +
          (result.approval && result.approval.ok === false ? ` — approval: ${result.approval.reason}` : ''),
        request,
      });

      if (result.approval?.ok) {
        await record({
          actor: request.user,
          action: ACTION.APPROVAL_REQUESTED,
          targetType: 'document',
          targetId: result.documentId,
          folderId,
          detail: `request ${result.approval.requestId}`,
          request,
        });
      }

      await announceDocumentEvent({
        event: 'document.created',
        actor: request.user,
        documentId: result.documentId,
        folderId,
        title,
      });

      return reply.code(201).send({
        documentId: result.documentId,
        version: result.version,
        ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
        approval: result.approval,
      });
    },
  );
}

/** Mounted under /api/admin/forms. */
export async function formsAdminRoutes(app) {
  app.addHook('preHandler', app.requireAuth);
  app.addHook('preHandler', app.requireSuperAdmin);

  app.get('/status', async () => toolStatus());

  app.get('/templates', { preHandler: requireEnabled }, async () => ({
    templates: await listTemplatesAdmin(),
  }));

  app.post('/templates', { preHandler: requireEnabled }, async (request, reply) => {
    const upload = await readTemplateUpload(request);
    if (!upload.ok) return refuse(reply, upload);

    const folderIds = parseFolderIdsField(upload.fields.folderIds);
    if (!folderIds.ok) {
      return refuse(reply, { reason: 'invalid_value', detail: 'قائمة المجلدات غير صالحة' });
    }

    const result = await createTemplate({
      userId: request.user.userId,
      name: upload.fields.name,
      description: upload.fields.description ?? null,
      typeId: toNullableInt(upload.fields.typeId),
      approvalTemplateId: toNullableInt(upload.fields.approvalTemplateId),
      folderIds: folderIds.ids,
      filename: upload.filename,
      buffer: upload.buffer,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.FORM_TEMPLATE_CREATED,
      targetType: 'form_template',
      targetId: result.template.templateId,
      detail: `${result.template.name} (${result.template.fields.length} حقل)`,
      request,
    });

    return reply.code(201).send({ template: result.template });
  });

  app.patch('/templates/:templateId', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const body = request.body ?? {};
    const result = await updateTemplate({
      templateId,
      name: body.name,
      description: body.description,
      typeId: body.typeId === undefined ? undefined : toNullableInt(body.typeId),
      approvalTemplateId:
        body.approvalTemplateId === undefined ? undefined : toNullableInt(body.approvalTemplateId),
      isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.FORM_TEMPLATE_UPDATED,
      targetType: 'form_template',
      targetId: String(templateId),
      detail:
        `${result.template.name}` +
        (body.isActive === undefined ? '' : body.isActive ? ' — مُفعّل' : ' — مُعطّل') +
        (result.clearedMappings ? ` — أُلغي ربط: ${result.clearedMappings.join('، ')}` : ''),
      request,
    });

    return {
      template: result.template,
      ...(result.clearedMappings ? { clearedMappings: result.clearedMappings } : {}),
    };
  });

  app.put('/templates/:templateId/file', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const upload = await readTemplateUpload(request);
    if (!upload.ok) return refuse(reply, upload);

    const result = await replaceTemplateFile({
      templateId,
      filename: upload.filename,
      buffer: upload.buffer,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.FORM_TEMPLATE_FILE_REPLACED,
      targetType: 'form_template',
      targetId: String(templateId),
      detail:
        `${upload.filename} — أُضيف ${result.diff.added.length}، ` +
        `حُذف ${result.diff.removed.length}، بقي ${result.diff.kept.length}` +
        // A replacement that cost the format a required mapping took it offline;
        // that is the part of this line an administrator will come looking for.
        (result.deactivated ? ` — عُطّل النموذج: ${result.deactivated.join('، ')}` : ''),
      request,
    });

    return {
      template: result.template,
      diff: result.diff,
      ...(result.deactivated ? { deactivated: result.deactivated } : {}),
    };
  });

  app.put('/templates/:templateId/access', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const result = await setTemplateAccess({
      templateId,
      principalIds: request.body?.principalIds,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.FORM_TEMPLATE_ACCESS_CHANGED,
      targetType: 'form_template',
      targetId: String(templateId),
      detail: result.template.access.map((entry) => entry.displayName).join('، ') || 'لا أحد',
      request,
    });

    return { template: result.template };
  });

  /**
   * The folders this format's letters may be filed into.
   *
   * Its own route rather than a field on PATCH: it is a set replaced whole, it
   * has its own audit action, and the dialog saves it only when it changed.
   */
  app.put('/templates/:templateId/folders', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const folderIds = parseFolderIds(request.body?.folderIds);
    if (!folderIds.ok) {
      return refuse(reply, { reason: 'invalid_value', detail: 'قائمة المجلدات غير صالحة' });
    }

    const result = await setTemplateFolders({ templateId, folderIds: folderIds.ids });
    if (!result.ok) return refuse(reply, result);

    const folders = result.template.folders;
    await record({
      actor: request.user,
      action: ACTION.FORM_TEMPLATE_FOLDERS_CHANGED,
      targetType: 'form_template',
      targetId: String(templateId),
      detail:
        folders.length === 0
          ? 'أي مجلد'
          : `${folders.length} مجلد: ${folders.map((folder) => folder.name).join('، ')}`,
      request,
    });

    return { template: result.template };
  });

  app.put('/templates/:templateId/fields', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const result = await setTemplateFields({ templateId, fields: request.body?.fields });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.FORM_TEMPLATE_FIELDS_CHANGED,
      targetType: 'form_template',
      targetId: String(templateId),
      detail: `${result.template.fields.length} حقل، بلا عنوان ${result.template.unlabelled}`,
      request,
    });

    return { template: result.template };
  });

  app.get('/templates/:templateId/file', { preHandler: requireEnabled }, async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const result = await readTemplateFile(templateId);
    if (!result.ok) return refuse(reply, result);

    reply.header(
      'Content-Disposition',
      contentDisposition(result.filename || 'template.docx', { type: 'attachment' }),
    );
    reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(result.buffer);
  });

  /**
   * A sample-filled PDF. Registered on both verbs on purpose: the design calls
   * it a POST because it creates a temporary artefact and costs a conversion,
   * while the scaffolded client helper is `adminPreviewUrl`, which a browser can
   * only open as a GET. Both reach the same handler, which writes nothing.
   */
  const preview = async (request, reply) => {
    const templateId = parseTemplateId(request.params.templateId);
    if (templateId === null) return reply.code(400).send({ error: 'invalid_template_id' });

    const result = await previewTemplate({ templateId, displayName: request.user.displayName });
    if (!result.ok) return refuse(reply, result);

    reply.header('Content-Disposition', contentDisposition(`${result.name}.pdf`, { type: 'inline' }));
    reply.type('application/pdf');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(result.pdf);
  };

  app.post('/templates/:templateId/preview', { preHandler: requireEnabled }, preview);
  app.get('/templates/:templateId/preview', { preHandler: requireEnabled }, preview);
}
