/**
 * Document routes.
 *
 * Uploads arrive as multipart and are streamed straight to storage — never
 * buffered into memory. A 200MB scan batch held in a Buffer is 200MB of heap per
 * concurrent upload, which is how a file server falls over under exactly the load
 * it was bought for.
 */

import contentDisposition from 'content-disposition';
import rangeParser from 'range-parser';

import { storage } from '../../storage/index.js';
import {
  createDocument,
  addVersion,
  getVersionForRead,
  getDocument,
  deleteDocument,
} from './service.js';
import { record, ACTION } from '../audit/service.js';

/** Maps a service failure to a status code. not_found covers "exists but invisible". */
const STATUS = {
  invalid_title: 400,
  empty_file: 400,
  no_file: 400,
  too_large: 413,
  conflict: 409,
  forbidden: 403,
  not_found: 404,
  storage_failed: 500,
};

export async function documentRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Upload into a folder.
   *
   * The title comes from a form field when supplied and falls back to the
   * filename. Fields ordered after the file part are not readable while the
   * stream is being consumed, so the client must send them first — which is what
   * the error below tells them.
   */
  app.post('/folders/:folderId/documents', async (request, reply) => {
    const folderId = parseId(request.params.folderId);
    if (folderId === null) return reply.code(400).send({ error: 'invalid_folder_id' });

    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });

    const title = firstValue(part.fields?.title) ?? stripExtension(part.filename);
    const typeId = toNullableInt(firstValue(part.fields?.typeId));

    const result = await createDocument({
      userId: request.user.userId,
      folderId,
      title,
      stream: part.file,
      filename: part.filename,
      mimeType: part.mimetype,
      typeId,
    });

    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_CREATED,
      targetType: 'document',
      targetId: result.documentId,
      folderId,
      detail: title,
      request,
    });

    return reply.code(201).send(result);
  });

  /** Adds a version to an existing document. */
  app.post('/documents/:documentId/versions', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });

    const result = await addVersion({
      userId: request.user.userId,
      documentId,
      stream: part.file,
      filename: part.filename,
      mimeType: part.mimetype,
      comment: firstValue(part.fields?.comment),
    });

    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_VERSION_ADDED,
      targetType: 'document',
      targetId: documentId,
      detail: `v${result.version}`,
      request,
    });

    return reply.code(201).send(result);
  });

  /** Metadata and version history. Requires BROWSE; history requires READ. */
  app.get('/documents/:documentId', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const document = await getDocument({ userId: request.user.userId, documentId });
    if (!document) return reply.code(404).send({ error: 'not_found' });
    return document;
  });

  /**
   * Streams document content. Requires READ — checked in the query that resolves
   * the version, not here.
   *
   * Range support is not optional: PDF.js requests pages by byte range, and
   * without it every preview downloads the entire file first.
   */
  app.get('/documents/:documentId/content', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const version = toNullableInt(request.query.version);
    const found = await getVersionForRead({ userId: request.user.userId, documentId, version });
    if (!found) return reply.code(404).send({ error: 'not_found' });

    // Recorded before streaming: who read what is the question an audit of a
    // document system is actually asked.
    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_DOWNLOADED,
      targetType: 'document',
      targetId: documentId,
      detail: `v${found.versionNumber}`,
      request,
    });

    const filename = found.originalFilename || `${found.title}`;

    // contentDisposition emits both the ASCII fallback and RFC 5987 filename*,
    // which is what makes an Arabic filename survive the download dialog rather
    // than arriving as a row of question marks.
    reply.header('Content-Disposition', contentDisposition(filename, { type: 'inline' }));
    reply.header('Content-Type', found.mimeType || 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');
    // Content is immutable per version, so it can be cached hard. Private: a
    // shared proxy must never serve one user's document to another.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('X-Content-Type-Options', 'nosniff');

    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const ranges = rangeParser(found.bytes, rangeHeader, { combine: true });

      if (ranges === -1) {
        reply.header('Content-Range', `bytes */${found.bytes}`);
        return reply.code(416).send();
      }

      // A multi-range request needs a multipart/byteranges body; no viewer we
      // serve asks for one, so the whole file is a valid and simpler answer.
      if (ranges !== -2 && ranges.length === 1) {
        const { start, end } = ranges[0];
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${found.bytes}`);
        reply.header('Content-Length', end - start + 1);
        return reply.send(storage.createReadStream(found.storagePath, { start, end }));
      }
    }

    reply.header('Content-Length', found.bytes);
    return reply.send(storage.createReadStream(found.storagePath));
  });

  app.delete('/documents/:documentId', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const result = await deleteDocument({ userId: request.user.userId, documentId });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_DELETED,
      targetType: 'document',
      targetId: documentId,
      request,
    });

    return { ok: true };
  });
}

/** bigint ids stay strings — Number() loses precision past 2^53. */
function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

/** @fastify/multipart exposes a field as {value} or an array when repeated. */
function firstValue(field) {
  if (!field) return undefined;
  const entry = Array.isArray(field) ? field[0] : field;
  const value = entry?.value;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function toNullableInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function stripExtension(filename) {
  const name = String(filename ?? '').trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
