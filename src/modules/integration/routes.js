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
import {
  getRendition,
  getRenditionJob,
  renditionStatus,
  enqueueRendition,
  QUEUE,
} from '../renditions/service.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  createWebhook,
  listWebhooks,
  deleteWebhook,
  updateWebhook,
  setWebhookActive,
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
  // The document exists and is readable; it just cannot be expressed as one
  // versioned file. 409, not 404 — 404 would send the caller looking for a
  // document that is right there.
  multi_file_document: 409,
  invalid_state: 400,
  invalid_date: 400,
  invalid_size: 400,
  invalid_name: 400,
  invalid_expiry: 400,
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

    /*
     * `?fileId=` addresses one constituent of a multi-file document.
     *
     * Such a document has no version row at all — migration 0012 keeps
     * `current_version = 0` on purpose — so `getVersionForRead` cannot be the
     * gate here. The per-file read check is, and it answers the same question
     * about the same folder's permissions.
     */
    const fileId = request.query?.fileId ? parseId(request.query.fileId) : null;

    let versionNumber;
    if (fileId !== null) {
      const { getConstituentForRead } = await import('../documents/service.js');
      const file = await getConstituentForRead({ userId: request.user.userId, documentId, fileId });
      if (!file.ok) return reply.code(file.reason === 'forbidden' ? 403 : 404).send({ error: file.reason });
      // Version 0 is the multi-file document's key, matching what the worker and
      // the thumbnail path already use.
      versionNumber = 0;
    } else {
      const { getVersionForRead } = await import('../documents/service.js');
      const version = await getVersionForRead({
        userId: request.user.userId,
        documentId,
        version: request.query?.version ? Number(request.query.version) : undefined,
      });
      if (!version) return reply.code(404).send({ error: 'not_found' });
      versionNumber = version.versionNumber;
    }

    const rendition = await getRendition({ documentId, versionNumber, kind, fileId });

    if (!rendition) {
      const job = await getRenditionJob({ documentId, versionNumber, kind, fileId });

      /*
       * A missing rendition is three different situations, and answering all
       * three with 202 was wrong in two of them.
       *
       * The worker records SKIPPED for a file type it has no renderer for and
       * FAILED once the attempts are spent, and both are terminal — `claim`
       * only ever picks up PENDING and RETRYABLE. But `enqueueRendition` resets
       * whatever it matches back to PENDING, so re-queueing on every miss turned
       * both terminal states into an endless render-fail-render loop, and the
       * caller was told "queued" each time with nothing ever arriving. Saying so
       * plainly lets the viewer offer a download instead of spinning.
       */
      if (job?.status === QUEUE.SKIPPED) {
        return reply.code(415).send({ error: 'rendition_unsupported' });
      }
      if (job?.status === QUEUE.FAILED) {
        return reply.code(422).send({ error: 'rendition_failed', reason: job.lastError });
      }

      // Queued rather than 404'd for good: a missing rendition usually means the
      // worker has not reached it, and asking is a reasonable trigger. Only when
      // nothing is already in flight — resetting a RUNNING job would hand the
      // same file to a second worker.
      if (!job || job.status === QUEUE.DONE) {
        await enqueueRendition(db, documentId, versionNumber, kind, fileId).catch(() => {});
      }

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
      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.API_KEY_ISSUED,
        targetType: 'api_key',
        targetId: result.keyId,
        // The key itself is a secret. Log only what it is called and whose account
        // it acts as — enough to answer "what created that integration" without
        // making the audit trail a source of working credentials.
        detail: `name: ${request.body?.name ?? ''}, actsAs: ${parseId(request.body?.userId)}`,
        request,
      });

      return reply.code(201).send(result);
    });

    admin.delete('/api-keys/:keyId', async (request, reply) => {
      const keyId = parseId(request.params.keyId);
      const result = await revokeApiKey({ keyId });
      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.API_KEY_REVOKED,
        targetType: 'api_key',
        targetId: keyId,
        request,
      });

      return result;
    });

    admin.get('/webhooks', async () => ({ webhooks: await listWebhooks(), events: WEBHOOK_EVENTS }));

    admin.post('/webhooks', async (request, reply) => {
      const result = await createWebhook({
        name: request.body?.name,
        url: request.body?.url,
        events: request.body?.events,
        createdBy: request.user.userId,
      });
      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.WEBHOOK_CHANGED,
        targetType: 'webhook',
        targetId: result.webhookId,
        detail: `created ${request.body?.name ?? ''}`,
        request,
      });

      return reply.code(201).send(result);
    });

    admin.patch('/webhooks/:webhookId', async (request, reply) => {
      const webhookId = parseId(request.params.webhookId);
      const result = await updateWebhook({
        webhookId,
        name: request.body?.name,
        url: request.body?.url,
        events: request.body?.events,
      });
      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.WEBHOOK_CHANGED,
        targetType: 'webhook',
        targetId: webhookId,
        detail: 'updated',
        request,
      });

      return result;
    });

    admin.post('/webhooks/:webhookId/active', async (request, reply) => {
      const webhookId = parseId(request.params.webhookId);
      // Treat any body that is not explicitly false as an activation — a missing
      // field from a form that forgot the value should not silently pause a hook.
      const active = request.body?.active !== false;
      const result = await setWebhookActive({ webhookId, active });
      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.WEBHOOK_CHANGED,
        targetType: 'webhook',
        targetId: webhookId,
        detail: active ? 'resumed' : 'paused',
        request,
      });

      return result;
    });

    admin.delete('/webhooks/:webhookId', async (request, reply) => {
      const webhookId = parseId(request.params.webhookId);
      const result = await deleteWebhook({ webhookId });
      if (!result.ok) return send(reply, result);

      await record({
        actor: request.user,
        action: ACTION.WEBHOOK_CHANGED,
        targetType: 'webhook',
        targetId: webhookId,
        detail: 'deleted',
        request,
      });

      return result;
    });

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
