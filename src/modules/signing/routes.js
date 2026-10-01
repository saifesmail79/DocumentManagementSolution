/**
 * Ink signing routes — /api/signing.
 *
 * ─── Why one scope and no admin scope ───────────────────────────────────────
 *
 * There is nothing to configure. A letter format has templates, access lists
 * and field labels; a signature has a switch, and the switch lives in
 * الإدارة ← الإعدادات like every other one. So this module mounts a single
 * plugin and `formsAdminRoutes` has no counterpart here.
 *
 * ─── What the routes do and do not do ───────────────────────────────────────
 *
 * Thin, as the house pattern requires: parse and whitelist the path
 * parameters, call the service, map its reason onto a status code, and write
 * the audit trail and the event fan-out AFTER a success. Every rule — who may
 * sign, whether the document is a single-file PDF or a single-page image,
 * whether it is frozen, where the ink lands — is in service.js, because the
 * rule must hold for any caller and a route is only one caller.
 *
 * The routes themselves do not know which kind of file they are serving. A page
 * image is a PNG whether it came from Ghostscript or from a scan, the sign body
 * is the same shape either way, and `describe` says `kind` so the client can
 * word its screen. That is why adding images changed one name in the map below
 * and nothing else in this file.
 *
 * `/status` answers while the switch is off; everything else answers 409
 * `signing_disabled`, so an install that has not adopted signing carries the
 * code inert and the client knows not to render the tab. "The switch" is two
 * settings read as one: `signing.enabled` AND `correspondence.enabled`, the
 * master switch of «الوارد والصادر» — see `switchState` in service.js. `/status`
 * carries `masterOff` so the client can name whichever of the two is off.
 *
 * ─── Two decisions worth naming ─────────────────────────────────────────────
 *
 *   • The sign route sets its own `bodyLimit`. The Fastify instance's limit is
 *     `config.storage.maxUploadBytes`, which is an upload allowance measured in
 *     gigabytes; a JSON body of base64 page overlays has no business being that
 *     large, and the refusal should arrive as bytes are read rather than after
 *     a gigabyte of base64 has been parsed into a string.
 *   • Page images are served `private, immutable` with a year's max-age. The
 *     URL names the version, and a version's bytes never change, so the answer
 *     is immutable by construction — the same reasoning as the content route's
 *     headers. `private` because it is document content.
 */

import { config } from '../../config/index.js';
import { record, ACTION } from '../audit/service.js';
import { announceDocumentEvent } from '../documents/events.js';
import { isEnabled, switchState, describe, pageGeometry, renderPage, sign } from './service.js';

/**
 * The module's own reason→status map, as documents/routes.js and
 * correspondence/routes.js each keep their own. `render_failed` is 502: the
 * request was sound and an external renderer did not deliver, which is the
 * distinction between "you asked wrongly" and "we could not answer".
 */
const STATUS = {
  signing_disabled: 409,
  multi_file_document: 409,
  conflict: 409,
  not_found: 404,
  forbidden: 403,
  legal_hold: 423,
  locked: 423,
  // One name for every shape of file this module does not sign: a Word
  // document, a spreadsheet, a multi-file document's constituent, a multi-page
  // TIFF. It was `not_pdf` while a PDF was the only thing that could be signed;
  // an image can be too now, so the name says what the rule is rather than what
  // one of its cases used to be. The status is unchanged.
  unsupported_format: 415,
  pdf_not_allowed: 415,
  blocked_extension: 415,
  unreadable_pdf: 422,
  // The image counterpart of `unreadable_pdf`: the bytes are the format they
  // claim to be as far as the name and the type say, and no decoder can open
  // them. Same status, because it is the same fact about the same thing.
  unreadable_image: 422,
  no_strokes: 400,
  invalid_image: 400,
  invalid_page: 400,
  too_large: 413,
  too_many_pages: 413,
  renderer_missing: 503,
  // Every render slot is taken. A temporary state of the host, not a fault in
  // the request, so 503 with the same name the forms converter uses.
  busy: 503,
  render_timeout: 504,
  render_failed: 502,
  storage_failed: 500,
};

/** Ids are bigint and stay strings; never Number(). */
function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

/** A 1-based page number, at most four digits — no PDF this system files has more. */
function parsePage(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  const page = Number(text);
  return page >= 1 ? page : null;
}

/** A version number, at most five digits; absent means the current version. */
function parseVersion(value) {
  if (value === undefined || value === null || value === '') return { ok: true, version: undefined };
  const text = String(value).trim();
  if (!/^[0-9]{1,5}$/.test(text)) return { ok: false };
  const version = Number(text);
  return version >= 1 ? { ok: true, version } : { ok: false };
}

function refuse(reply, result) {
  return reply.code(STATUS[result.reason] ?? 400).send({ ...result, error: result.reason });
}

async function requireEnabled(_request, reply) {
  if (!(await isEnabled())) {
    return reply.code(409).send({ error: 'signing_disabled' });
  }
}

/** Mounted under /api/signing. */
export async function signingRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // The one route that answers while disabled: the client asks it whether to
  // show the tab at all.
  app.get('/status', async () => {
    const state = await switchState();
    return {
      enabled: state.enabled,
      // Only when signing's own switch is on and the master switch of
      // «الوارد والصادر» is off, so a screen can name the switch that is off
      // instead of pointing at the one that is already on.
      ...(state.masterOff ? { masterOff: true } : {}),
      // Published so the panel refuses an over-large save before the person
      // draws the page that would exceed it, with the server's real numbers
      // rather than a copy that drifts when the configuration changes.
      maxPagesPerRequest: config.signing.maxPagesPerRequest,
      bodyLimitBytes: config.signing.bodyLimitBytes,
      dpi: config.signing.dpi,
    };
  });

  // Cheap by contract — the document page calls this for every document it
  // opens, whether or not anybody means to sign anything.
  app.get('/documents/:documentId', { preHandler: requireEnabled }, async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const result = await describe({ userId: request.user.userId, documentId });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  // Loads the PDF. Asked once, when the tab is opened.
  app.get('/documents/:documentId/pages', { preHandler: requireEnabled }, async (request, reply) => {
    const documentId = parseId(request.params.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    const version = parseVersion(request.query?.version);
    if (!version.ok) return reply.code(400).send({ error: 'invalid_page' });

    const result = await pageGeometry({
      userId: request.user.userId,
      documentId,
      version: version.version,
    });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  app.get(
    '/documents/:documentId/pages/:page',
    { preHandler: requireEnabled },
    async (request, reply) => {
      const documentId = parseId(request.params.documentId);
      if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

      const page = parsePage(request.params.page);
      if (page === null) return reply.code(400).send({ error: 'invalid_page' });

      const version = parseVersion(request.query?.version);
      if (!version.ok) return reply.code(400).send({ error: 'invalid_page' });

      const result = await renderPage({
        userId: request.user.userId,
        documentId,
        page,
        version: version.version,
      });
      if (!result.ok) return refuse(reply, result);

      reply.header('Content-Type', 'image/png');
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.send(result.png);
    },
  );

  app.post(
    '/documents/:documentId/sign',
    { preHandler: requireEnabled, bodyLimit: config.signing.bodyLimitBytes },
    async (request, reply) => {
      const documentId = parseId(request.params.documentId);
      if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

      const body = request.body ?? {};
      const result = await sign({
        userId: request.user.userId,
        documentId,
        version: body.version,
        note: body.note ?? null,
        pages: body.pages,
        // The Arabic display name goes into the version comment and the ledger,
        // never into the PDF's own text: the standard fonts cannot encode it.
        displayName: request.user.displayName || request.user.username || null,
      });
      if (!result.ok) return refuse(reply, result);

      /*
       * Two audit rows, because two different questions are asked of the trail.
       *
       * "What happened to this document?" is answered by the version row, and
       * every other path that adds a version records DOCUMENT_VERSION_ADDED —
       * a signature that did not would be a hole in that history. "Who has
       * signed anything?" is answered by DOCUMENT_SIGNED, which the ledger
       * table also answers but only for documents that still exist.
       */
      await record({
        actor: request.user,
        action: ACTION.DOCUMENT_VERSION_ADDED,
        targetType: 'document',
        targetId: documentId,
        folderId: result.folderId,
        detail: `v${result.version} توقيع`,
        request,
      });

      await record({
        actor: request.user,
        action: ACTION.DOCUMENT_SIGNED,
        targetType: 'document',
        targetId: documentId,
        folderId: result.folderId,
        detail:
          `v${result.version} pages [${result.pages.join(',')}]`
          + ` sha256 ${result.sha256} from ${result.fromSha256}`
          + (result.ledger ? '' : ' (ledger row failed)'),
        request,
      });

      // The existing event name, not a new one: watchers asked to hear about
      // this document, and a webhook subscriber registered for versions is
      // entitled to the one a signature creates.
      await announceDocumentEvent({
        event: 'document.version_added',
        actor: request.user,
        documentId,
        folderId: result.folderId,
        title: result.title,
      });

      return reply.code(201).send(result);
    },
  );
}
