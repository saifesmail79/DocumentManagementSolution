/**
 * Routes for personal shelves, watches, comments, relations, saved searches,
 * tags, notifications and approvals.
 *
 * Grouped in one file because they share a shape: small, per-user, and all
 * gated by the same document-level permission check inside their services.
 */

import {
  addFavourite,
  removeFavourite,
  listFavourites,
  listRecent,
  watch,
  unwatch,
  listWatches,
  addComment,
  listComments,
  deleteComment,
  relate,
  unrelate,
  listRelations,
  saveSearch,
  listSavedSearches,
  deleteSavedSearch,
} from './service.js';
import { listInbox, unreadCount, markRead } from '../notifications/service.js';
import { listTags, tagDocument, documentTags, documentsWithTag } from '../tags/service.js';
import {
  requestApproval,
  decide,
  cancelRequest,
  myPendingApprovals,
  documentApprovals,
  listTemplates,
  createTemplate,
  updateTemplate,
  setTemplateActive,
  deleteTemplate,
} from '../workflow/service.js';
import { listPreferences, setPreference } from '../preferences/service.js';
import { record, ACTION } from '../audit/service.js';

const STATUS = {
  unknown_preference: 404,
  invalid_value: 400,
  duplicate_entry: 400,
  too_many_entries: 400,
  not_found: 404,
  forbidden: 403,
  invalid_body: 400,
  invalid_target: 400,
  invalid_name: 400,
  invalid_type: 400,
  invalid_decision: 400,
  name_taken: 409,
  already_pending: 409,
  already_decided: 409,
  not_pending: 409,
  not_your_step: 403,
  no_template: 400,
  steps_required: 400,
  unknown_approver: 400,
  template_in_use: 409,
  criteria_too_large: 400,
};

const send = (reply, result) =>
  result.ok ? result : reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason, ...result });

const parseId = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
};

export async function collaborationRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // ── Interface preferences ──────────────────────────────────────────────

  /*
   * Deliberately not audited.
   *
   * The audit trail exists to answer who did what to which document. The order
   * somebody likes their tiles in is not that, and writing a row every time a
   * tile is dragged would bury the entries that matter under the ones that do
   * not.
   */
  app.get('/preferences', async (request) => ({
    preferences: await listPreferences(request.user.userId),
  }));

  app.put('/preferences/:key', async (request, reply) =>
    send(
      reply,
      await setPreference({
        userId: request.user.userId,
        key: String(request.params.key),
        value: request.body?.value,
      }),
    ));

  // ── Favourites and recents ─────────────────────────────────────────────

  app.get('/favourites', async (request) => ({
    documents: await listFavourites({ userId: request.user.userId, limit: request.query?.limit }),
  }));

  app.put('/favourites/:documentId', async (request, reply) =>
    send(reply, await addFavourite({ userId: request.user.userId, documentId: parseId(request.params.documentId) })),
  );

  app.delete('/favourites/:documentId', async (request, reply) =>
    send(reply, await removeFavourite({ userId: request.user.userId, documentId: parseId(request.params.documentId) })),
  );

  app.get('/recent', async (request) => ({
    documents: await listRecent({ userId: request.user.userId, limit: request.query?.limit }),
  }));

  // ── Watches ────────────────────────────────────────────────────────────

  app.get('/watches', async (request) => ({ watches: await listWatches({ userId: request.user.userId }) }));

  app.post('/watches', async (request, reply) =>
    send(
      reply,
      await watch({
        userId: request.user.userId,
        folderId: parseId(request.body?.folderId),
        documentId: parseId(request.body?.documentId),
        recursive: request.body?.recursive !== false,
      }),
    ),
  );

  app.delete('/watches', async (request, reply) =>
    send(
      reply,
      await unwatch({
        userId: request.user.userId,
        folderId: parseId(request.query?.folderId),
        documentId: parseId(request.query?.documentId),
      }),
    ),
  );

  // ── Notifications ──────────────────────────────────────────────────────

  app.get('/notifications', async (request) => ({
    notifications: await listInbox({
      userId: request.user.userId,
      unreadOnly: request.query?.unread === 'true',
      limit: request.query?.limit,
    }),
    unread: await unreadCount({ userId: request.user.userId }),
  }));

  app.post('/notifications/read', async (request) =>
    markRead({ userId: request.user.userId, notificationId: parseId(request.body?.notificationId) }),
  );

  // ── Comments ───────────────────────────────────────────────────────────

  app.get('/documents/:documentId/comments', async (request, reply) =>
    send(reply, await listComments({ userId: request.user.userId, documentId: parseId(request.params.documentId) })),
  );

  app.post('/documents/:documentId/comments', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    const result = await addComment({
      userId: request.user.userId,
      documentId,
      body: request.body?.body,
      parentCommentId: parseId(request.body?.parentCommentId),
    });

    if (!result.ok) return send(reply, result);

    // Everyone watching the document hears about it, except the author — being
    // notified of your own comment is noise that trains people to ignore the
    // inbox.
    const { watchersOf } = await import('./service.js');
    const { notifyMany, KIND } = await import('../notifications/service.js');
    const watchers = await watchersOf({ documentId, excludeUserId: request.user.userId });

    if (watchers.length > 0) {
      await notifyMany({
        userIds: watchers,
        kind: KIND.COMMENT_ADDED,
        title: `تعليق جديد من ${request.user.displayName || request.user.username}`,
        body: String(request.body?.body).slice(0, 200),
        documentId,
      });
    }

    return reply.code(201).send(result);
  });

  app.delete('/comments/:commentId', async (request, reply) =>
    send(
      reply,
      await deleteComment({
        userId: request.user.userId,
        commentId: parseId(request.params.commentId),
        isSuperAdmin: request.user.isSuperAdmin,
      }),
    ),
  );

  // ── Relations ──────────────────────────────────────────────────────────

  app.get('/documents/:documentId/relations', async (request) => ({
    relations: await listRelations({
      userId: request.user.userId,
      documentId: parseId(request.params.documentId),
    }),
  }));

  app.post('/documents/:documentId/relations', async (request, reply) =>
    send(
      reply,
      await relate({
        userId: request.user.userId,
        fromDocument: parseId(request.params.documentId),
        toDocument: parseId(request.body?.toDocument),
        relationType: request.body?.relationType ?? 'related',
      }),
    ),
  );

  app.delete('/relations/:relationId', async (request, reply) =>
    send(reply, await unrelate({ relationId: parseId(request.params.relationId) })),
  );

  // ── Tags ───────────────────────────────────────────────────────────────

  app.get('/tags', async (request) => ({
    tags: await listTags({ search: request.query?.q, limit: request.query?.limit }),
  }));

  app.get('/tags/:name/documents', async (request) => ({
    documents: await documentsWithTag({
      userId: request.user.userId,
      tagName: String(request.params.name),
      limit: request.query?.limit,
    }),
  }));

  app.get('/documents/:documentId/tags', async (request) => ({
    tags: await documentTags({ documentId: parseId(request.params.documentId) }),
  }));

  app.put('/documents/:documentId/tags', async (request, reply) =>
    send(
      reply,
      await tagDocument({
        userId: request.user.userId,
        documentId: parseId(request.params.documentId),
        tags: request.body?.tags,
      }),
    ),
  );

  // ── Saved searches ─────────────────────────────────────────────────────

  app.get('/saved-searches', async (request) => ({
    searches: await listSavedSearches({ userId: request.user.userId }),
  }));

  app.post('/saved-searches', async (request, reply) => {
    const result = await saveSearch({
      userId: request.user.userId,
      name: request.body?.name,
      criteria: request.body?.criteria,
      isShared: request.body?.isShared === true,
    });
    return result.ok ? reply.code(201).send(result) : send(reply, result);
  });

  app.delete('/saved-searches/:searchId', async (request, reply) =>
    send(reply, await deleteSavedSearch({ userId: request.user.userId, searchId: parseId(request.params.searchId) })),
  );

  // ── Approvals ──────────────────────────────────────────────────────────

  app.get('/approvals/pending', async (request) => ({
    requests: await myPendingApprovals({ userId: request.user.userId }),
  }));

  app.get('/documents/:documentId/approvals', async (request, reply) =>
    send(reply, await documentApprovals({ userId: request.user.userId, documentId: parseId(request.params.documentId) })),
  );

  app.post('/documents/:documentId/approvals', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    const result = await requestApproval({
      userId: request.user.userId,
      documentId,
      templateId: request.body?.templateId,
      note: request.body?.note,
    });

    if (!result.ok) return send(reply, result);

    await record({
      actor: request.user,
      action: ACTION.APPROVAL_REQUESTED,
      targetType: 'document',
      targetId: documentId,
      request,
    });

    return reply.code(201).send(result);
  });

  app.post('/approvals/:requestId/decision', async (request, reply) => {
    const requestId = parseId(request.params.requestId);
    const result = await decide({
      userId: request.user.userId,
      requestId,
      decision: request.body?.decision,
      note: request.body?.note,
    });

    if (!result.ok) return send(reply, result);

    await record({
      actor: request.user,
      action: ACTION.APPROVAL_DECIDED,
      targetType: 'approval',
      targetId: requestId,
      detail: request.body?.decision,
      request,
    });

    return result;
  });

  app.post('/approvals/:requestId/cancel', async (request, reply) =>
    send(
      reply,
      await cancelRequest({
        userId: request.user.userId,
        requestId: parseId(request.params.requestId),
        isSuperAdmin: request.user.isSuperAdmin,
      }),
    ),
  );

  // Templates are system-wide vocabulary, like document types.
  app.register(async (admin) => {
    admin.addHook('preHandler', admin.requireSuperAdmin);

    admin.get('/approval-templates', async () => ({ templates: await listTemplates() }));

    admin.post('/approval-templates', async (request, reply) => {
      const result = await createTemplate(request.body ?? {});
      if (!result.ok) return send(reply, result);
      await record({
        actor: request.user,
        action: ACTION.APPROVAL_TEMPLATE_CHANGED,
        targetType: 'approval_template',
        targetId: String(result.templateId),
        detail: `created ${request.body?.name ?? ''}`,
        request,
      });
      return reply.code(201).send(result);
    });

    admin.patch('/approval-templates/:templateId', async (request, reply) => {
      // Number('abc') === NaN and would reach SQL — use parseId which validates
      // the format first, then convert the validated string.
      const rawId = parseId(request.params.templateId);
      if (rawId === null) return send(reply, { ok: false, reason: 'not_found' });
      const templateId = Number(rawId);
      const { name, typeId, steps } = request.body ?? {};
      const result = await updateTemplate({ templateId, name, typeId, steps });
      if (!result.ok) return send(reply, result);
      await record({
        actor: request.user,
        action: ACTION.APPROVAL_TEMPLATE_CHANGED,
        targetType: 'approval_template',
        targetId: String(templateId),
        detail: 'updated',
        request,
      });
      return result;
    });

    admin.post('/approval-templates/:templateId/active', async (request, reply) => {
      const rawId = parseId(request.params.templateId);
      if (rawId === null) return send(reply, { ok: false, reason: 'not_found' });
      const templateId = Number(rawId);
      // Same reading as every other activate route: only an explicit false pauses.
      const active = request.body?.active !== false;
      const result = await setTemplateActive({ templateId, active });
      if (!result.ok) return send(reply, result);
      await record({
        actor: request.user,
        action: ACTION.APPROVAL_TEMPLATE_CHANGED,
        targetType: 'approval_template',
        targetId: String(templateId),
        detail: active ? 'activated' : 'deactivated',
        request,
      });
      return result;
    });

    admin.delete('/approval-templates/:templateId', async (request, reply) => {
      const rawId = parseId(request.params.templateId);
      if (rawId === null) return send(reply, { ok: false, reason: 'not_found' });
      const templateId = Number(rawId);
      const result = await deleteTemplate({ templateId });
      if (!result.ok) return send(reply, result);
      await record({
        actor: request.user,
        action: ACTION.APPROVAL_TEMPLATE_CHANGED,
        targetType: 'approval_template',
        targetId: String(templateId),
        detail: 'deleted',
        request,
      });
      return result;
    });
  });
}
