/**
 * Metadata routes.
 *
 * Definitions (types, fields, labels) are administered centrally and gated on
 * super-admin. Values on a document are gated on EDIT_META for its folder,
 * checked inside the service — the same delegation split as folder permissions.
 *
 * Reading the definitions is open to any signed-in user, because the document
 * form needs them to render and they reveal nothing but vocabulary.
 */

import {
  listTypes,
  createType,
  setTypeActive,
  listFields,
  createField,
  setFieldActive,
  listLabels,
  createLabel,
  updateDocumentMetadata,
} from './service.js';
import { listDefaults, setDefaults } from './defaults.js';
import { record, ACTION } from '../audit/service.js';

const parseFolderId = (value) => {
  const text = String(value ?? '').trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
};

const STATUS = {
  invalid_name: 400,
  invalid_rank: 400,
  invalid_colour: 400,
  invalid_data_type: 400,
  invalid_title: 400,
  invalid_value: 400,
  required_field: 400,
  unknown_field: 400,
  choices_required: 400,
  name_taken: 409,
  unsupported_field_type: 400,
  rank_taken: 409,
  forbidden: 403,
  not_found: 404,
};

const send = (reply, result) =>
  result.ok
    ? result
    : reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason, detail: result.detail });

export async function metadataRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // Readable by anyone signed in: the document form cannot render without them.
  app.get('/types', async (request) => ({
    types: await listTypes({ includeInactive: request.query?.inactive === 'true' }),
  }));

  app.get('/fields', async (request) => ({
    fields: await listFields({
      typeId: request.query?.typeId ? Number(request.query.typeId) : null,
      includeInactive: request.query?.inactive === 'true',
    }),
  }));

  app.get('/labels', async () => ({ labels: await listLabels() }));



  // Definitions are system-wide vocabulary, so changing them is super-admin.
  app.register(async (admin) => {
    admin.addHook('preHandler', admin.requireSuperAdmin);

    admin.post('/types', async (request, reply) => {
      const result = await createType(request.body ?? {});
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    admin.post('/types/:typeId/active', async (request, reply) =>
      send(
        reply,
        await setTypeActive({
          typeId: Number(request.params.typeId),
          active: request.body?.active !== false,
        }),
      ),
    );

    admin.post('/fields', async (request, reply) => {
      const result = await createField(request.body ?? {});
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    admin.post('/fields/:fieldId/active', async (request, reply) =>
      send(
        reply,
        await setFieldActive({
          fieldId: Number(request.params.fieldId),
          active: request.body?.active !== false,
        }),
      ),
    );

    admin.post('/labels', async (request, reply) => {
      const result = await createLabel(request.body ?? {});
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });
  });
}

/** Registered under /api/documents so it sits with the rest of the document API. */
export async function documentMetadataRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  app.patch('/:documentId/metadata', async (request, reply) => {
    const documentId = String(request.params.documentId).trim();
    if (!/^[0-9]{1,19}$/.test(documentId)) {
      return reply.code(400).send({ error: 'invalid_document_id' });
    }

    const result = await updateDocumentMetadata({
      userId: request.user.userId,
      documentId,
      ...(request.body ?? {}),
    });

    if (!result.ok) return send(reply, result);

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_METADATA_CHANGED,
      targetType: 'document',
      targetId: documentId,
      request,
    });

    return { ok: true };
  });
}

/**
 * Folder defaults, mounted under /api/folders.
 *
 * They are metadata definitions, but they are addressed by folder and that is
 * where a caller looks for them — a URL under /api/metadata would be a filing
 * decision imposed on the API's users.
 */
export async function folderDefaultsRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/:folderId/defaults', async (request, reply) =>
    send(
      reply,
      await listDefaults({ userId: request.user.userId, folderId: parseFolderId(request.params.folderId) }),
    ),
  );

  app.put('/:folderId/defaults', async (request, reply) =>
    send(
      reply,
      await setDefaults({
        userId: request.user.userId,
        folderId: parseFolderId(request.params.folderId),
        defaults: request.body?.defaults,
      }),
    ),
  );
}
