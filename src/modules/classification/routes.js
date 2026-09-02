/**
 * Recognition pilot routes.
 *
 * Two scopes, mounted separately in app.js:
 *
 *   • Per document, for anyone who can read the document: what the pilot
 *     thinks this page is, and what it read from the header.
 *   • Administration, super-admin only: the switch's state, the tools, the
 *     queue, the training set, the measurements, and the rebuild action.
 *
 * Every route answers "disabled" rather than working while the stored switch
 * is off, so a production install with the pilot dormant has nothing to hide
 * and nothing to compute.
 */

import {
  documentClassification,
  requestClassification,
  classificationStatus,
  classificationMetrics,
  isEnabled,
  rebuild,
} from './service.js';
import { record, ACTION } from '../audit/service.js';

const STATUS = { not_found: 404, classification_disabled: 409 };

function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

/** Mounted under /api. */
export async function classificationRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/documents/:documentId/classification', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const result = await documentClassification({ userId: request.user.userId, documentId });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  app.post('/documents/:documentId/classification/run', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const result = await requestClassification({ userId: request.user.userId, documentId });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });
}

/** Mounted under /api/admin/classification. */
export async function classificationAdminRoutes(app) {
  app.addHook('preHandler', app.requireAuth);
  app.addHook('preHandler', app.requireSuperAdmin);

  app.get('/status', async () => classificationStatus());

  app.get('/metrics', async (_request, reply) => {
    if (!(await isEnabled())) return reply.code(409).send({ error: 'classification_disabled' });
    return classificationMetrics();
  });

  /**
   * Queues documents for fingerprinting: those without a current fingerprint,
   * or every live document with `all`.
   */
  app.post('/rebuild', async (request, reply) => {
    if (!(await isEnabled())) return reply.code(409).send({ error: 'classification_disabled' });

    const all = request.body?.all === true;
    const result = await rebuild({ all });

    await record({
      actor: request.user,
      action: ACTION.SETTING_CHANGED,
      targetType: 'classification',
      targetId: all ? 'rebuild-all' : 'rebuild',
      detail: `queued ${result.queued} document(s) for fingerprinting`,
      request,
    });

    return result;
  });
}
