/**
 * Integration routes: bulk operations, document state, resumable upload,
 * renditions, API keys, webhooks, share links and reporting.
 *
 * ─── The share route is the only unauthenticated one ────────────────────────
 *
 * /api/share/:token serves document content to whoever holds the URL. It is
 * mounted outside the authenticated tree deliberately and enforces every bound
 * itself — expiry, revocation, password, download cap.
 */

import contentDisposition from 'content-disposition';

import { storage } from '../../storage/index.js';
import { bulkMove, bulkUpdateMetadata, bulkDelete, buildZip } from '../documents/bulk.js';
import {
  checkOut,
  checkIn,
  setLifecycle,
  setExpiry,
  setLegalHold,
  restoreVersion,
} from '../documents/state.js';
import { createSession, sessionStatus, appendChunk, completeSession, abortSession } from '../uploads/resumable.js';
import { getRendition, renditionStatus, enqueueRendition } from '../renditions/service.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  createWebhook,
  listWebhooks,
  deleteWebhook,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  resolveShare,
  countShareDownload,
  WEBHOOK_EVENTS,
} from './service.js';
import { overview, uploadTrend, storageByFolder, topContributors, distribution, exportMetadataCsv } from '../reporting/service.js';
import { record, ACTION } from '../audit/service.js';
import { db } from '../../db/index.js';

const STATUS = {
  not_found: 404,
  forbidden: 403,
  legal_hold: 409,
  locked: 409,
  conflict: 409,
  not_your_lock: 403,
  already_current: 409,
  version_not_found: 404,
  invalid_state: 400,
  invalid_date: 400,
  invalid_size: 400,
  invalid_name: 400,
  invalid_url: 400,
  no_events: 400,
  unknown_user: 404,
  too_large: 413,
  no_documents: 400,
  nothing_readable: 403,
  offset_mismatch: 409,
  already_completed: 409,
  incomplete: 400,
  download_limit_reached: 410,
  password_required: 401,
  invalid_password: 401,
  invalid_token: 404,
};

const send = (reply, result) =>
  result.ok ? result : reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason, ...result });

const parseId = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
};

export async function integrationRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // ── Bulk operations ────────────────────────────────────────────────────

  app.post('/bulk/move', async (request, reply) =>
    send(
      reply,
      await bulkMove({
        userId: request.user.userId,
        documentIds: request.body?.documentIds,
        targetFolderId: parseId(request.body?.targetFolderId),
      }),
    ),
  );

  app.post('/bulk/metadata', async (request, reply) =>
    send(
      reply,
      await bulkUpdateMetadata({
        userId: request.user.userId,
        documentIds: request.body?.documentIds,
        typeId: request.body?.typeId,
        labelId: request.body?.labelId,
        fields: request.body?.fields,
      }),
    ),
  );

  app.post('/bulk/delete', async (request, reply) =>
    send(reply, await bulkDelete({ userId: request.user.userId, documentIds: request.body?.documentIds })),
  );

  /** Streams a ZIP. Not buffered — a selection of scans is hundreds of megabytes. */
  app.post('/bulk/download', async (request, reply) => {
    const result = await buildZip({ userId: request.user.userId, documentIds: request.body?.documentIds });
    if (!result.ok) return send(reply, result);

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', contentDisposition('documents.zip', { type: 'attachment' }));
    return reply.send(result.stream);
  });

  // ── Document state ─────────────────────────────────────────────────────

  app.post('/documents/:documentId/checkout', async (request, reply) =>
    send(reply, await checkOut({ userId: request.user.userId, documentId: parseId(request.params.documentId) })),
  );

  app.post('/documents/:documentId/checkin', async (request, reply) =>
    send(
      reply,
      await checkIn({
        userId: request.user.userId,
        documentId: parseId(request.params.documentId),
        isSuperAdmin: request.user.isSuperAdmin,
      }),
    ),
  );

  app.post('/documents/:documentId/lifecycle', async (request, reply) =>
    send(
      reply,
      await setLifecycle({
        userId: request.user.userId,
        documentId: parseId(request.params.documentId),
        state: request.body?.state,
      }),
    ),
  );

  app.post('/documents/:documentId/expiry', async (request, reply) =>
    send(
      reply,
      await setExpiry({
        userId: request.user.userId,
        documentId: parseId(request.params.documentId),
        expiresAt: request.body?.expiresAt ?? null,
      }),
    ),
  );

  /** Legal hold overrides deletion for everyone, so only a super admin sets it. */
  app.post(
    '/documents/:documentId/legal-hold',
    { preHandler: app.requireSuperAdmin },
    async (request, reply) => {
      const documentId = parseId(request.params.documentId);
      const result = await setLegalHold({
        userId: request.user.userId,
        documentId,
        hold: request.body?.hold === true,
        reason: request.body?.reason,
      });

      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.LEGAL_HOLD_CHANGED,
        targetType: 'document',
        targetId: documentId,
        detail: request.body?.hold ? `placed: ${request.body?.reason ?? ''}` : 'lifted',
        request,
      });

      return result;
    },
  );

  app.post('/documents/:documentId/versions/:versionNumber/restore', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    const result = await restoreVersion({
      userId: request.user.userId,
      documentId,
      versionNumber: Number(request.params.versionNumber),
      comment: request.body?.comment,
    });

    if (!result.ok) return send(reply, result);

    await record({
      actor: request.user,
      action: ACTION.VERSION_RESTORED,
      targetType: 'document',
      targetId: documentId,
      detail: `v${request.params.versionNumber} → v${result.version}`,
      request,
    });

    return result;
  });

  // ── Resumable upload ───────────────────────────────────────────────────

  app.post('/uploads', async (request, reply) => {
    const result = await createSession({
      userId: request.user.userId,
      folderId: parseId(request.body?.folderId),
      filename: request.body?.filename,
      totalBytes: request.body?.totalBytes,
      mimeType: request.body?.mimeType,
      title: request.body?.title,
      typeId: request.body?.typeId,
      fields: request.body?.fields,
    });
    return result.ok ? reply.code(201).send(result) : send(reply, result);
  });

  app.get('/uploads/:sessionId', async (request, reply) =>
    send(reply, await sessionStatus({ userId: request.user.userId, sessionId: String(request.params.sessionId) })),
  );

  /**
   * Appends a chunk. The body is the raw bytes, not multipart: a chunk is not a
   * form, and multipart framing would add parsing for no benefit.
   */
  app.patch('/uploads/:sessionId', async (request, reply) => {
    const offset = Number(request.headers['x-upload-offset'] ?? request.query?.offset ?? 0);
    const result = await appendChunk({
      userId: request.user.userId,
      sessionId: String(request.params.sessionId),
      offset,
      // The octet-stream parser passes the stream through as the body; raw is
      // the fallback if some other content type reached here.
      stream: request.body ?? request.raw,
    });
    return send(reply, result);
  });

  app.post('/uploads/:sessionId/complete', async (request, reply) =>
    send(reply, await completeSession({ userId: request.user.userId, sessionId: String(request.params.sessionId) })),
  );

  app.delete('/uploads/:sessionId', async (request, reply) =>
    send(reply, await abortSession({ userId: request.user.userId, sessionId: String(request.params.sessionId) })),
  );

  // ── Renditions ─────────────────────────────────────────────────────────

  /**
   * Serves a thumbnail or rendered preview.
   *
   * Gated on READ through the same query the content route uses — a thumbnail
   * of a document is a low-resolution copy of it, not metadata.
   */
  app.get('/documents/:documentId/rendition/:kind', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    const kind = String(request.params.kind);
    if (!['thumbnail', 'preview'].includes(kind)) return reply.code(400).send({ error: 'invalid_kind' });

    const { getVersionForRead } = await import('../documents/service.js');
    const version = await getVersionForRead({
      userId: request.user.userId,
      documentId,
      version: request.query?.version ? Number(request.query.version) : undefined,
    });
    if (!version) return reply.code(404).send({ error: 'not_found' });

    const rendition = await getRendition({ documentId, versionNumber: version.versionNumber, kind });

    if (!rendition) {
      // Queued rather than 404'd for good: a missing rendition usually means the
      // worker has not reached it, and asking is a reasonable trigger.
      await enqueueRendition(db, documentId, version.versionNumber, kind).catch(() => {});
      return reply.code(202).send({ status: 'queued' });
    }

    reply.header('Content-Type', rendition.mimeType);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(storage.createReadStream(rendition.storagePath));
  });

  // ── Share links ────────────────────────────────────────────────────────

  app.get('/documents/:documentId/shares', async (request, reply) =>
    send(reply, await listShareLinks({ userId: request.user.userId, documentId: parseId(request.params.documentId) })),
  );

  app.post('/documents/:documentId/shares', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    const result = await createShareLink({
      userId: request.user.userId,
      documentId,
      versionNumber: request.body?.versionNumber ?? null,
      expiresInHours: request.body?.expiresInHours,
      password: request.body?.password,
      maxDownloads: request.body?.maxDownloads,
    });

    if (!result.ok) return send(reply, result);

    await record({
      actor: request.user,
      action: ACTION.SHARE_LINK_CREATED,
      targetType: 'document',
      targetId: documentId,
      detail: `expires ${result.expiresAt}`,
      request,
    });

    return reply.code(201).send(result);
  });

  app.delete('/shares/:shareId', async (request, reply) =>
    send(reply, await revokeShareLink({ userId: request.user.userId, shareId: parseId(request.params.shareId) })),
  );

  // ── Administration: keys, webhooks, reporting ──────────────────────────

  app.register(async (admin) => {
    admin.addHook('preHandler', admin.requireSuperAdmin);

    admin.get('/api-keys', async () => ({ keys: await listApiKeys() }));

    admin.post('/api-keys', async (request, reply) => {
      const result = await createApiKey({
        name: request.body?.name,
        userId: parseId(request.body?.userId),
        createdBy: request.user.userId,
        expiresAt: request.body?.expiresAt,
      });
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    admin.delete('/api-keys/:keyId', async (request, reply) =>
      send(reply, await revokeApiKey({ keyId: parseId(request.params.keyId) })),
    );

    admin.get('/webhooks', async () => ({ webhooks: await listWebhooks(), events: WEBHOOK_EVENTS }));

    admin.post('/webhooks', async (request, reply) => {
      const result = await createWebhook({
        name: request.body?.name,
        url: request.body?.url,
        events: request.body?.events,
        createdBy: request.user.userId,
      });
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    admin.delete('/webhooks/:webhookId', async (request, reply) =>
      send(reply, await deleteWebhook({ webhookId: parseId(request.params.webhookId) })),
    );

    admin.get('/reports/overview', async () => overview());
    admin.get('/reports/trend', async (request) => ({ trend: await uploadTrend({ days: request.query?.days }) }));
    admin.get('/reports/storage', async () => ({ folders: await storageByFolder() }));
    admin.get('/reports/contributors', async (request) => ({
      contributors: await topContributors({ days: request.query?.days }),
    }));
    admin.get('/reports/distribution', async () => distribution());
    admin.get('/renditions/status', async () => renditionStatus());
  });

  /** CSV export is permission-filtered, so it needs no admin gate. */
  app.get('/export/metadata.csv', async (request, reply) => {
    const result = await exportMetadataCsv({
      userId: request.user.userId,
      folderId: parseId(request.query?.folderId),
    });

    if (!result.ok) return send(reply, result);

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', contentDisposition('documents.csv', { type: 'attachment' }));
    return reply.send(result.csv);
  });
}

/**
 * The public share route.
 *
 * Registered separately, outside the authenticated tree — it is the one place
 * document bytes leave without a session.
 */
export async function shareRoutes(app) {
  app.get('/:token', async (request, reply) => {
    const resolved = await resolveShare({
      token: String(request.params.token),
      password: request.query?.password ?? null,
    });

    if (!resolved.ok) {
      const status = STATUS[resolved.reason] ?? 404;
      return reply.code(status).send({ error: resolved.reason });
    }

    await countShareDownload({ shareId: resolved.shareId });

    reply.header(
      'Content-Disposition',
      contentDisposition(resolved.originalFilename || resolved.title, { type: 'inline' }),
    );
    reply.header('Content-Type', resolved.mimeType || 'application/octet-stream');
    reply.header('Content-Length', resolved.bytes);
    // A shared link must not be cached by a proxy and handed to the next person
    // who asks for the same URL after it expires.
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');

    return reply.send(storage.createReadStream(resolved.storagePath));
  });
}
