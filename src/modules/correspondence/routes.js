/**
 * Correspondence routes.
 *
 * Two scopes, mounted separately in app.js, the same split as the pilot:
 *
 *   • /api/correspondence — the working surface: status, the personal queue,
 *     the register, registration and routing. Registrar-only actions enforce
 *     themselves in the service, because "registrar" is a setting-backed
 *     role, not a route prefix.
 *   • /api/admin/correspondence — super-admin configuration: units and
 *     counters. (Not /api/admin/mail — that already means SMTP diagnostics.)
 *
 * Every route answers "disabled" while the stored switch is off, so an
 * install that has not adopted the mail room carries the code inert.
 */

import {
  isEnabled,
  mailStatus,
  unregisteredIntake,
  listUnits,
  createUnit,
  updateUnit,
  setUnitActive,
  getCounters,
  setCounter,
  registerLetter,
  listLetters,
  getLetter,
  letterForDocument,
  myQueue,
  followUp,
  receiveTransfer,
  closeTransfer,
  cancelTransfer,
  addTransfers,
  annulLetter,
  setOutgoingStatus,
  addLetterVersion,
  recordMovement,
  isRegistrar,
  DIRECTIONS,
  LETTER_STATUSES,
} from './service.js';
import { record, ACTION } from '../audit/service.js';
import { announceDocumentEvent } from '../documents/events.js';

const STATUS = {
  not_found: 404,
  not_registrar: 403,
  correspondence_disabled: 409,
  already_registered: 409,
  already_routed_to_unit: 409,
  unit_has_open_transfers: 409,
  name_taken: 409,
  below_issued: 409,
  not_pending: 409,
  not_open: 409,
  annulled: 409,
  reason_too_short: 400,
  // The paper trail. not_allowed is the register's own refusal — neither the
  // mail room nor a department holding the letter — and is deliberately
  // distinct from the core's `forbidden`, which means no UPLOAD on the folder.
  not_allowed: 403,
  invalid_action: 400,
  invalid_kind: 400,
  person_required: 400,
  invalid_reply_to: 400,
  // The letter exists and could be replied to, but this clerk cannot reach it.
  // A separate reason from invalid_reply_to because the screen must say «لا
  // تملك صلاحية الوصول إلى هذا الكتاب» rather than send her back to re-pick a
  // letter the picker legitimately offered.
  reply_to_forbidden: 403,
  // The core addVersion's own reasons, mapped exactly as the ordinary version
  // route maps them (src/modules/documents/routes.js). A rescan refused for
  // legal hold must answer 423 here too, or the client has to learn two
  // vocabularies for one upload.
  forbidden: 403,
  legal_hold: 423,
  locked: 423,
  blocked_extension: 415,
  empty_file: 400,
  no_file: 400,
  too_large: 413,
  too_many_files: 413,
  multi_file_document: 409,
  conflict: 409,
  storage_failed: 500,
};

function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

function refuse(reply, result) {
  return reply.code(STATUS[result.reason] ?? 400).send({ ...result, error: result.reason });
}

/** @fastify/multipart exposes a field as {value} or an array when repeated. */
function firstValue(field) {
  if (!field) return undefined;
  const entry = Array.isArray(field) ? field[0] : field;
  const value = entry?.value;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function requireEnabled(_request, reply) {
  if (!(await isEnabled())) {
    return reply.code(409).send({ error: 'correspondence_disabled' });
  }
}

/** Mounted under /api/correspondence. */
export async function correspondenceRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // Status is the one route that answers while disabled: the client asks it
  // whether to show anything at all.
  app.get('/status', async (request) =>
    mailStatus({ userId: request.user.userId, isSuperAdmin: request.user.isSuperAdmin }));

  app.get('/queue', { preHandler: requireEnabled }, async (request, reply) => {
    const scope = request.query?.scope ?? 'open';
    if (!['open', 'all'].includes(scope)) return reply.code(400).send({ error: 'invalid_scope' });
    return {
      transfers: await myQueue({
        userId: request.user.userId,
        scope,
        q: request.query?.q || null,
      }),
    };
  });

  // Scanned into the intake branch but not yet in the book — the تسجيل كتاب
  // screen's work list, so nothing skips registration.
  app.get('/intake', { preHandler: requireEnabled }, async (request, reply) => {
    const registrar = await isRegistrar({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    });
    if (!registrar) return reply.code(403).send({ error: 'not_registrar' });
    return unregisteredIntake();
  });

  app.get('/followup', { preHandler: requireEnabled }, async (request, reply) => {
    const registrar = await isRegistrar({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    });
    if (!registrar) return reply.code(403).send({ error: 'not_registrar' });
    return { transfers: await followUp() };
  });

  app.get('/letters', { preHandler: requireEnabled }, async (request, reply) => {
    const registrar = await isRegistrar({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    });
    if (!registrar) return reply.code(403).send({ error: 'not_registrar' });

    const { direction, year, status, q, location } = request.query;
    if (direction && !DIRECTIONS.includes(direction)) {
      return reply.code(400).send({ error: 'invalid_direction' });
    }
    if (status && !LETTER_STATUSES.includes(status)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    // 'out' is the only filter the paper's whereabouts can usefully be asked
    // for; a typo must refuse rather than quietly widen to the whole book.
    if (location && location !== 'out') {
      return reply.code(400).send({ error: 'invalid_location' });
    }
    return {
      letters: await listLetters({
        direction: direction || null,
        year: year || null,
        status: status || null,
        q: q || null,
        location: location || null,
      }),
    };
  });

  app.get('/letters/:letterId', { preHandler: requireEnabled }, async (request, reply) => {
    const letterId = parseId(request.params.letterId);
    if (letterId === null) return reply.code(400).send({ error: 'invalid_letter_id' });

    const registrar = await isRegistrar({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    });
    if (!registrar) return reply.code(403).send({ error: 'not_registrar' });

    const result = await getLetter({
      letterId,
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
    });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  app.get(
    '/documents/:documentId/letter',
    { preHandler: requireEnabled },
    async (request, reply) => {
      const documentId = parseId(request.params.documentId);
      if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

      const result = await letterForDocument({
        userId: request.user.userId,
        isSuperAdmin: request.user.isSuperAdmin,
        documentId,
      });
      if (!result.ok) return refuse(reply, result);
      return result;
    },
  );

  app.post('/register', { preHandler: requireEnabled }, async (request, reply) => {
    const body = request.body ?? {};
    const documentId = parseId(body.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

    // A malformed reply target is a reply target the clerk meant to set, so it
    // refuses by name instead of being dropped into an unlinked registration.
    const replyToLetterId = parseId(body.replyToLetterId);
    if (body.replyToLetterId && replyToLetterId === null) {
      return reply.code(400).send({ error: 'invalid_reply_to' });
    }

    const result = await registerLetter({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      documentId,
      direction: body.direction,
      subject: body.subject,
      externalParty: body.externalParty,
      externalRef: body.externalRef,
      externalDate: body.externalDate,
      unitId: parseId(body.unitId),
      transfers: body.transfers,
      // «رد على الوارد …» — the letter this outgoing one answers, stored as a
      // core document relation so the link survives the area being switched off.
      replyToLetterId,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_REGISTERED,
      targetType: 'correspondence',
      targetId: result.letterId,
      detail: `${body.direction === 'out' ? 'صادر' : 'وارد'} ${result.reference} — document ${documentId}`,
      request,
    });
    return result;
  });

  app.post('/letters/:letterId/transfers', { preHandler: requireEnabled }, async (request, reply) => {
    const letterId = parseId(request.params.letterId);
    if (letterId === null) return reply.code(400).send({ error: 'invalid_letter_id' });

    const result = await addTransfers({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      letterId,
      transfers: request.body?.transfers,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_ROUTED,
      targetType: 'correspondence',
      targetId: letterId,
      detail: `forwarded to ${request.body.transfers.length} unit(s)`,
      request,
    });
    return result;
  });

  /**
   * A returned, re-annotated or rescanned paper, filed as a NEW VERSION of the
   * letter's own document and named by what was done on it.
   *
   * Multipart, one file part named "file". The text fields — action, personName,
   * note, returned — must be sent BEFORE the file part: @fastify/multipart
   * cannot read a field that arrives after the stream the handler is consuming,
   * exactly as in the ordinary upload route.
   */
  app.post('/letters/:letterId/versions', { preHandler: requireEnabled }, async (request, reply) => {
    const letterId = parseId(request.params.letterId);
    if (letterId === null) return reply.code(400).send({ error: 'invalid_letter_id' });

    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });

    const result = await addLetterVersion({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      letterId,
      stream: part.file,
      filename: part.filename,
      mimeType: part.mimetype,
      action: firstValue(part.fields?.action),
      personName: firstValue(part.fields?.personName),
      note: firstValue(part.fields?.note),
      // The paper came back in the same gesture that brought its new scan.
      returned: firstValue(part.fields?.returned) === 'true',
    });
    if (!result.ok) return refuse(reply, result);

    /*
     * Two audit rows and the core event, because two different questions are
     * asked of this one act — the same split the signing route documents.
     *
     * «ما جرى على هذه الوثيقة؟» is answered by the version row, and EVERY other
     * path that adds a version records DOCUMENT_VERSION_ADDED against the
     * document and its folder. A paper-trail scan that did not would be a hole
     * in that history, invisible to the document's own audit view and to the
     * folder-scoped one. «ما جرى على هذا الكتاب؟» is answered by
     * MAIL_PAPER_VERSION, which names the act on the paper and stays beside it.
     */
    await record({
      actor: request.user,
      action: ACTION.DOCUMENT_VERSION_ADDED,
      targetType: 'document',
      targetId: result.documentId,
      folderId: result.folderId,
      detail: `v${result.version} ${result.action}`,
      request,
    });

    await record({
      actor: request.user,
      action: ACTION.MAIL_PAPER_VERSION,
      targetType: 'correspondence',
      targetId: letterId,
      detail: `${result.reference} v${result.version} — ${result.action}`
        + (result.personName ? ` (${result.personName})` : '')
        + (result.trail ? '' : ' (trail row failed)')
        + (result.movementFailed ? ' (return not recorded)' : ''),
      request,
    });

    // The existing event name, not a new one: somebody watching this letter
    // asked to hear about the document, and a webhook subscriber registered for
    // versions is entitled to the one a returned paper creates.
    await announceDocumentEvent({
      event: 'document.version_added',
      actor: request.user,
      documentId: result.documentId,
      folderId: result.folderId,
      title: `إصدار ${result.version}`,
    });

    return reply.code(201).send(result);
  });

  /** «سُلّمت الورقة إلى …» / «عادت الورقة من …» — where the paper went. */
  app.post('/letters/:letterId/movements', { preHandler: requireEnabled }, async (request, reply) => {
    const letterId = parseId(request.params.letterId);
    if (letterId === null) return reply.code(400).send({ error: 'invalid_letter_id' });

    const result = await recordMovement({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      letterId,
      kind: request.body?.kind,
      personName: request.body?.personName,
      note: request.body?.note,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_PAPER_MOVED,
      targetType: 'correspondence',
      targetId: letterId,
      detail: `${result.reference} ${result.movement.kind} — ${result.movement.personName}`,
      request,
    });
    return reply.code(201).send(result);
  });

  app.post('/letters/:letterId/annul', { preHandler: requireEnabled }, async (request, reply) => {
    const letterId = parseId(request.params.letterId);
    if (letterId === null) return reply.code(400).send({ error: 'invalid_letter_id' });

    const result = await annulLetter({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      letterId,
      reason: request.body?.reason,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_ANNULLED,
      targetType: 'correspondence',
      targetId: letterId,
      detail: String(request.body?.reason ?? '').slice(0, 400),
      request,
    });
    return result;
  });

  app.post('/letters/:letterId/status', { preHandler: requireEnabled }, async (request, reply) => {
    const letterId = parseId(request.params.letterId);
    if (letterId === null) return reply.code(400).send({ error: 'invalid_letter_id' });

    const result = await setOutgoingStatus({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      letterId,
      status: request.body?.status,
    });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  app.post('/transfers/:transferId/receive', { preHandler: requireEnabled }, async (request, reply) => {
    const transferId = parseId(request.params.transferId);
    if (transferId === null) return reply.code(400).send({ error: 'invalid_transfer_id' });

    const result = await receiveTransfer({ userId: request.user.userId, transferId });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  app.post('/transfers/:transferId/close', { preHandler: requireEnabled }, async (request, reply) => {
    const transferId = parseId(request.params.transferId);
    if (transferId === null) return reply.code(400).send({ error: 'invalid_transfer_id' });

    const result = await closeTransfer({
      userId: request.user.userId,
      transferId,
      note: request.body?.note,
    });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  app.post('/transfers/:transferId/cancel', { preHandler: requireEnabled }, async (request, reply) => {
    const transferId = parseId(request.params.transferId);
    if (transferId === null) return reply.code(400).send({ error: 'invalid_transfer_id' });

    const result = await cancelTransfer({
      userId: request.user.userId,
      isSuperAdmin: request.user.isSuperAdmin,
      transferId,
      reason: request.body?.reason,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_ROUTED,
      targetType: 'correspondence',
      targetId: result.letterId,
      detail: `transfer ${transferId} withdrawn: ${String(request.body?.reason ?? '').slice(0, 300)}`,
      request,
    });
    return result;
  });
}

/** Mounted under /api/admin/correspondence. */
export async function correspondenceAdminRoutes(app) {
  app.addHook('preHandler', app.requireAuth);
  app.addHook('preHandler', app.requireSuperAdmin);

  app.get('/units', async (request) => ({
    units: await listUnits({ includeInactive: request.query?.all === 'true' }),
  }));

  app.post('/units', { preHandler: requireEnabled }, async (request, reply) => {
    const body = request.body ?? {};
    const groupId = parseId(body.groupId);
    if (groupId === null) return reply.code(400).send({ error: 'invalid_group_id' });

    const result = await createUnit({
      name: body.name,
      groupId,
      archiveFolderId: parseId(body.archiveFolderId),
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_UNIT_CHANGED,
      targetType: 'correspondence_unit',
      targetId: result.unitId,
      detail: `created "${String(body.name).trim()}"`,
      request,
    });
    return result;
  });

  app.patch('/units/:unitId', { preHandler: requireEnabled }, async (request, reply) => {
    const unitId = parseId(request.params.unitId);
    const groupId = parseId(request.body?.groupId);
    if (unitId === null) return reply.code(400).send({ error: 'invalid_unit_id' });
    if (groupId === null) return reply.code(400).send({ error: 'invalid_group_id' });

    const result = await updateUnit({
      unitId,
      name: request.body?.name,
      groupId,
      archiveFolderId: parseId(request.body?.archiveFolderId),
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_UNIT_CHANGED,
      targetType: 'correspondence_unit',
      targetId: unitId,
      detail: `updated "${String(request.body?.name ?? '').trim()}"`,
      request,
    });
    return result;
  });

  app.post('/units/:unitId/active', { preHandler: requireEnabled }, async (request, reply) => {
    const unitId = parseId(request.params.unitId);
    if (unitId === null) return reply.code(400).send({ error: 'invalid_unit_id' });

    const result = await setUnitActive({ unitId, active: request.body?.active === true });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_UNIT_CHANGED,
      targetType: 'correspondence_unit',
      targetId: unitId,
      detail: request.body?.active === true ? 'activated' : 'deactivated',
      request,
    });
    return result;
  });

  app.get('/counters', async (request) => getCounters({ year: request.query?.year }));

  app.put('/counters', { preHandler: requireEnabled }, async (request, reply) => {
    const body = request.body ?? {};
    const result = await setCounter({
      direction: body.direction,
      year: body.year,
      nextNumber: body.nextNumber,
    });
    if (!result.ok) return refuse(reply, result);

    await record({
      actor: request.user,
      action: ACTION.MAIL_COUNTER_SET,
      targetType: 'correspondence_counter',
      targetId: `${body.direction}/${body.year}`,
      detail: `next number set to ${body.nextNumber}`,
      request,
    });
    return result;
  });
}
