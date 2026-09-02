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
import { config } from '../../config/index.js';
import {
  createDocument,
  createMultiFileDocument,
  addVersion,
  getVersionForRead,
  getConstituentForRead,
  getMultiFileForRead,
  isMultiFileDocument,
  getDocument,
  deleteDocument,
} from './service.js';
import { record, ACTION } from '../audit/service.js';
import { announceDocumentEvent } from './events.js';
import { qrPng, stampPdf } from './qr.js';
import { listRecycleBin, restoreDocument, purgeNow, findDuplicates } from './lifecycle.js';

/** Maps a service failure to a status code. not_found covers "exists but invisible". */
const STATUS = {
  invalid_title: 400,
  required_field: 400,
  duplicate: 409,
  not_deleted: 409,
  content_purged: 410,
  // 415: the request is well-formed and the file kind itself is the objection.
  blocked_extension: 415,
  empty_file: 400,
  no_file: 400,
  too_many_files: 413,
  too_large: 413,
  // A multi-file document has no single blob, so an endpoint that must hand one
  // over refuses rather than picking a file the caller did not ask for.
  multi_file_document: 409,
  not_multi_file: 409,
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
    // Metadata travels as one JSON form part rather than a field per value:
    // multipart fields must precede the file to be readable, and one part is
    // far easier for a client to order correctly than a dozen.
    const fields = parseJsonField(firstValue(part.fields?.fields));

    const result = await createDocument({
      userId: request.user.userId,
      folderId,
      title,
      stream: part.file,
      filename: part.filename,
      mimeType: part.mimetype,
      typeId,
      fields,
    });

    if (!result.ok) {
      return reply.code(STATUS[result.reason] ?? 400).send({
        error: result.reason,
        detail: result.detail,
        duplicates: result.duplicates,
        // A blocked extension names what would have been accepted; a refusal
        // that keeps the list to itself just schedules the next refusal.
        allowed: result.allowed,
        extension: result.extension,
      });
    }

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_CREATED,
      targetType: 'document',
      targetId: result.documentId,
      folderId,
      detail: title,
      request,
    });

    await announceDocumentEvent({
      event: 'document.created',
      actor: request.user,
      documentId: result.documentId,
      folderId,
      title,
    });

    return reply.code(201).send(result);
  });

  /**
   * Files a batch of documents chosen in one action.
   *
   * ─── Why one endpoint with a mode, and not two ──────────────────────────
   *
   * Selecting several files and being asked "separate documents, or one entry?"
   * is a single user action with two outcomes. Both outcomes need the same
   * permission check, the same destination folder, the same duplicate policy and
   * the same audit trail, so splitting them into two endpoints would duplicate
   * all of that and let the two copies drift.
   *
   *   mode=separate  each file becomes its own document      (the default)
   *   mode=single    all files become one document's files   (dbo.document_files)
   *
   * `separate` is the default because it is the outcome that loses nothing if
   * the client forgot to send the field: N documents can be merged by hand,
   * whereas one document wrongly holding five unrelated files has to be taken
   * apart.
   *
   * Field parts must precede the file parts, exactly as on the single upload —
   * the multipart stream is read in order and a field after a file is
   * unreachable while that file is still being consumed.
   */
  app.post('/folders/:folderId/documents/batch', async (request, reply) => {
    const folderId = parseId(request.params.folderId);
    if (folderId === null) return reply.code(400).send({ error: 'invalid_folder_id' });

    const parts = request.parts();
    const fields = {};
    let firstFile = null;

    // Read fields up to the first file part.
    //
    // Stepped with next() rather than `for await ... break`, because breaking
    // out of a for-await loop calls the iterator's return() — which closes the
    // multipart stream. Every file after the first would then be silently
    // dropped and the batch would arrive as one document, with no error
    // anywhere to explain where the rest went.
    for (;;) {
      const { value: part, done } = await parts.next();
      if (done) break;
      if (part.type === 'file') {
        firstFile = part;
        break;
      }
      fields[part.fieldname] = part.value;
    }

    if (!firstFile) return reply.code(400).send({ error: 'no_file' });

    const mode = fields.mode === 'single' ? 'single' : 'separate';
    const typeId = toNullableInt(fields.typeId);
    const metadataFields = parseJsonField(fields.fields);

    /**
     * The first file, then the rest — one pass, nothing buffered.
     *
     * Stepped with next() for the same reason as above: a consumer that stops
     * early must not close the underlying multipart stream out from under the
     * drain that follows.
     */
    async function* incoming() {
      yield { stream: firstFile.file, filename: firstFile.filename, mimeType: firstFile.mimetype };
      for (;;) {
        const { value: part, done } = await parts.next();
        if (done) return;
        if (part.type === 'file') {
          yield { stream: part.file, filename: part.filename, mimeType: part.mimetype };
        }
      }
    }

    try {
      // ── One entry ───────────────────────────────────────────────────────
      if (mode === 'single') {
        const title = String(fields.title ?? '').trim() || stripExtension(firstFile.filename);

        const result = await createMultiFileDocument({
          userId: request.user.userId,
          folderId,
          title,
          files: incoming(),
          typeId,
          fields: metadataFields,
        });

        if (!result.ok) {
          return reply.code(STATUS[result.reason] ?? 400).send({
            error: result.reason,
            detail: result.detail,
            duplicates: result.duplicates,
          });
        }

        await record({
          actor: request.user,
          action: ACTION.DOCUMENT_CREATED,
          targetType: 'document',
          targetId: result.documentId,
          folderId,
          detail: result.multiFile ? `${title} (${result.fileCount} ملفات)` : title,
          request,
        });

        await announceDocumentEvent({
          event: 'document.created',
          actor: request.user,
          documentId: result.documentId,
          folderId,
          title,
        });

        return reply.code(201).send({ mode, created: [result], failed: [] });
      }

      // ── Separate documents ──────────────────────────────────────────────
      //
      // One file's failure must not abandon the rest: the user picked twenty
      // scans and one of them being a duplicate is not a reason to refuse the
      // other nineteen. Each outcome is reported against its filename so the
      // client can say exactly which ones did not land.
      const created = [];
      const failed = [];

      for await (const file of incoming()) {
        if (created.length + failed.length >= config.storage.maxFilesPerUpload) {
          file.stream.resume();
          failed.push({ filename: file.filename, reason: 'too_many_files' });
          continue;
        }

        const title = stripExtension(file.filename);

        const result = await createDocument({
          userId: request.user.userId,
          folderId,
          title,
          stream: file.stream,
          filename: file.filename,
          mimeType: file.mimeType,
          typeId,
          fields: metadataFields,
        });

        if (!result.ok) {
          failed.push({ filename: file.filename, reason: result.reason, detail: result.detail });
          continue;
        }

        created.push({ ...result, filename: file.filename, title });

        await record({
          actor: request.user,
          action: ACTION.DOCUMENT_CREATED,
          targetType: 'document',
          targetId: result.documentId,
          folderId,
          detail: title,
          request,
        });

        await announceDocumentEvent({
          event: 'document.created',
          actor: request.user,
          documentId: result.documentId,
          folderId,
          title,
        });
      }

      // 201 when anything landed, even partially: the response body carries the
      // per-file outcome, and a 4xx would tell the client nothing was filed.
      return reply.code(created.length > 0 ? 201 : 400).send({ mode, created, failed });
    } catch (error) {
      // @fastify/multipart refuses the request outright once its own file limit
      // is passed, and that error would otherwise surface as an unexplained 500
      // on an upload the user can see is simply too big a batch.
      if (error?.code === 'FST_FILES_LIMIT') {
        return reply.code(413).send({
          error: 'too_many_files',
          detail: String(config.storage.maxFilesPerUpload),
        });
      }
      throw error;
    }
  });

  /** The constituent files of a multi-file document, in reading order. */
  app.get('/documents/:documentId/files', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const found = await getMultiFileForRead({ userId: request.user.userId, documentId });
    if (!found.ok) {
      if (found.reason === 'not_multi_file') return { files: [] };
      return reply.code(STATUS[found.reason] ?? 404).send({ error: found.reason });
    }

    return {
      files: found.files.map(({ storagePath, ...rest }) => rest),
    };
  });

  /**
   * Streams one constituent file.
   *
   * Range support matters here for the same reason it does on the version
   * route: the preview pane points an iframe at this URL, and PDF.js fetches
   * pages by byte range.
   */
  app.get('/documents/:documentId/files/:fileId/content', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const fileId = parseId(request.params.fileId);
    if (fileId === null) return reply.code(400).send({ error: 'invalid_file_id' });

    const found = await getConstituentForRead({ userId: request.user.userId, documentId, fileId });
    if (!found.ok) return reply.code(STATUS[found.reason] ?? 404).send({ error: found.reason });

    const { recordView } = await import('../collaboration/service.js');
    recordView({ userId: request.user.userId, documentId }).catch(() => {});

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_DOWNLOADED,
      targetType: 'document',
      targetId: documentId,
      detail: `ملف ${found.sortOrder + 1}`,
      request,
    });

    return sendBlob(request, reply, {
      storagePath: found.storagePath,
      bytes: found.bytes,
      mimeType: found.mimeType,
      filename: found.filename || found.title,
    });
  });

  /**
   * Every constituent file as one zip.
   *
   * A multi-file document has no single blob to hand over, so "download this
   * document" has to mean all of it. Streamed through archiver rather than
   * built in memory: five 40MB scans is 200MB of heap per concurrent download
   * otherwise, which is the same mistake the streaming upload path avoids.
   */
  app.get('/documents/:documentId/files.zip', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const found = await getMultiFileForRead({ userId: request.user.userId, documentId });
    if (!found.ok) {
      const status = found.reason === 'not_multi_file' ? 409 : (STATUS[found.reason] ?? 404);
      return reply.code(status).send({ error: found.reason });
    }

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_DOWNLOADED,
      targetType: 'document',
      targetId: documentId,
      detail: `${found.files.length} ملفات (zip)`,
      request,
    });

    const { default: archiver } = await import('archiver');
    const archive = archiver('zip', { zlib: { level: 0 } });

    reply.header('Content-Disposition', contentDisposition(`${found.title}.zip`, { type: 'attachment' }));
    reply.header('Content-Type', 'application/zip');
    reply.header('X-Content-Type-Options', 'nosniff');
    // No Content-Length: the archive is streamed, so its size is not known
    // until it has been produced.

    // Names are prefixed with the reading position so the order survives
    // extraction — a zip has no ordering of its own, and two scans of the same
    // page would otherwise collide on filename.
    const used = new Set();
    for (const file of found.files) {
      const base = file.filename || `${found.title}-${file.sortOrder + 1}`;
      let name = `${String(file.sortOrder + 1).padStart(2, '0')}-${base}`;
      let suffix = 1;
      while (used.has(name)) name = `${String(file.sortOrder + 1).padStart(2, '0')}-${suffix++}-${base}`;
      used.add(name);

      archive.append(storage.createReadStream(file.storagePath), { name });
    }

    archive.finalize().catch((error) => archive.destroy(error));
    return reply.send(archive);
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

    await announceDocumentEvent({
      event: 'document.version_added',
      actor: request.user,
      documentId,
      title: `إصدار ${result.version}`,
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

    if (!found) {
      // A multi-file document has no version row, so the lookup above misses in
      // exactly the same way it does for a document that is not there. Saying
      // 404 would be a lie the client cannot recover from, so the distinct case
      // is named and the caller is pointed at the endpoint that can serve it.
      if (await isMultiFileDocument(documentId)) {
        return reply.code(409).send({
          error: 'multi_file_document',
          filesUrl: `/api/documents/${documentId}/files`,
          zipUrl: `/api/documents/${documentId}/files.zip`,
        });
      }
      return reply.code(404).send({ error: 'not_found' });
    }

    // "Recently viewed" is the cheapest answer to "I can never find my documents
    // again", which research named the most common reason people abandon a DMS.
    const { recordView } = await import('../collaboration/service.js');
    recordView({ userId: request.user.userId, documentId }).catch(() => {});

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

    /**
     * ?stamp=qr overlays a QR code linking back to this document.
     *
     * Buffered rather than streamed, because stamping needs the whole file —
     * and the range branch below is skipped for the same reason. That is the
     * right trade for a print copy, which is a deliberate one-off action, and
     * the wrong one for ordinary viewing, which is why it is opt-in.
     */
    if (request.query?.stamp === 'qr' && (found.mimeType || '').includes('pdf')) {
      const chunks = [];
      for await (const chunk of storage.createReadStream(found.storagePath)) chunks.push(chunk);

      const stamped = await stampPdf(Buffer.concat(chunks), {
        documentId,
        title: found.title,
      });

      if (stamped) {
        reply.header('Content-Length', stamped.length);
        return reply.send(stamped);
      }
      // Stamping failed; fall through and serve the file unchanged.
    }

    return streamRange(request, reply, { storagePath: found.storagePath, bytes: found.bytes });
  });

  /**
   * Whether this content is already filed, asked before uploading.
   *
   * Lets a client hash locally and check first, so a 200MB duplicate is never
   * transferred at all.
   */
  app.get('/documents/duplicates/:sha256', async (request, reply) => {
    const sha256 = String(request.params.sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) return reply.code(400).send({ error: 'invalid_hash' });

    // folderId is optional: a client that has already chosen a destination gets
    // the same answer the upload itself would give, and one that has not gets
    // every copy it may see.
    const folderId = request.query?.folderId ? parseId(request.query.folderId) : null;

    return {
      duplicates: await findDuplicates({ userId: request.user.userId, sha256, folderId }),
      scope: folderId ? 'folder' : 'all',
    };
  });

  /** The recycle bin: what has been deleted and can still be brought back. */
  app.get('/recycle-bin', async (request) => ({
    documents: await listRecycleBin({
      userId: request.user.userId,
      folderId: parseId(request.query?.folderId),
      limit: request.query?.limit,
    }),
  }));

  app.post('/documents/:documentId/restore', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const result = await restoreDocument({ userId: request.user.userId, documentId });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_RESTORED,
      targetType: 'document',
      targetId: documentId,
      folderId: result.folderId,
      detail: result.title,
      request,
    });

    return { ok: true };
  });

  /** Destroys the content now rather than waiting out the grace period. */
  app.post('/documents/:documentId/purge', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const result = await purgeNow({ userId: request.user.userId, documentId });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_PURGE_REQUESTED,
      targetType: 'document',
      targetId: documentId,
      request,
    });

    return { ok: true };
  });

  /**
   * A QR code linking back to this document, for printing onto a copy.
   *
   * Requires READ, like the content itself: the code is a pointer to the
   * document, and handing one out to someone who may only see the title lets
   * them pass a link to it around.
   */
  app.get('/documents/:documentId/qr', async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const found = await getVersionForRead({ userId: request.user.userId, documentId });
    if (!found) return reply.code(404).send({ error: 'not_found' });

    reply.header('Content-Type', 'image/png');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(await qrPng(documentId, { size: request.query?.size }));
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

    await announceDocumentEvent({
      event: 'document.deleted',
      actor: request.user,
      documentId,
      notifyWatchers: false,
    });

    return { ok: true };
  });
}

/** bigint ids stay strings — Number() loses precision past 2^53. */
/**
 * Serves a blob, honouring a single Range request.
 *
 * Shared by the version route and the constituent-file route so the two cannot
 * drift: a preview pane that works for one-file documents and silently fails to
 * seek on multi-file ones would be a hard bug to attribute, and the only
 * difference between the two cases is which row supplied the path.
 *
 * The caller sets Content-Type, Content-Disposition and caching — those depend
 * on what is being served, whereas ranging depends only on the blob.
 */
function streamRange(request, reply, { storagePath, bytes }) {
  const rangeHeader = request.headers.range;

  if (rangeHeader) {
    const ranges = rangeParser(bytes, rangeHeader, { combine: true });

    if (ranges === -1) {
      reply.header('Content-Range', `bytes */${bytes}`);
      return reply.code(416).send();
    }

    // A multi-range request needs a multipart/byteranges body; no viewer we
    // serve asks for one, so the whole file is a valid and simpler answer.
    if (ranges !== -2 && ranges.length === 1) {
      const { start, end } = ranges[0];
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${bytes}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(storage.createReadStream(storagePath, { start, end }));
    }
  }

  reply.header('Content-Length', bytes);
  return reply.send(storage.createReadStream(storagePath));
}

/** Serves one constituent file with the headers a preview pane needs. */
function sendBlob(request, reply, { storagePath, bytes, mimeType, filename }) {
  // Both the ASCII fallback and RFC 5987 filename*, which is what makes an
  // Arabic filename survive the download dialog rather than arriving as a row
  // of question marks.
  reply.header('Content-Disposition', contentDisposition(filename, { type: 'inline' }));
  reply.header('Content-Type', mimeType || 'application/octet-stream');
  reply.header('Accept-Ranges', 'bytes');
  // A constituent file is immutable once filed, exactly as a version is.
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  reply.header('X-Content-Type-Options', 'nosniff');

  return streamRange(request, reply, { storagePath, bytes });
}

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

/** The metadata part, when the client sent one. A malformed value is ignored. */
function parseJsonField(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripExtension(filename) {
  const name = String(filename ?? '').trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
