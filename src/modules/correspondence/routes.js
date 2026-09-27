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
  isRegistrar,
  DIRECTIONS,
  LETTER_STATUSES,
} from './service.js';
import { record, ACTION } from '../audit/service.js';

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
};

function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

function refuse(reply, result) {
  return reply.code(STATUS[result.reason] ?? 400).send({ ...result, error: result.reason });
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

    const { direction, year, status, q } = request.query;
    if (direction && !DIRECTIONS.includes(direction)) {
      return reply.code(400).send({ error: 'invalid_direction' });
    }
    if (status && !LETTER_STATUSES.includes(status)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    return {
      letters: await listLetters({
        direction: direction || null,
        year: year || null,
        status: status || null,
        q: q || null,
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

    const result = await getLetter({ letterId });
    if (!result.ok) return refuse(reply, result);
    return result;
  });

  app.get(
    '/documents/:documentId/letter',
    { preHandler: requireEnabled },
    async (request, reply) => {
      const documentId = parseId(request.params.documentId);
      if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

      const result = await letterForDocument({ userId: request.user.userId, documentId });
      if (!result.ok) return refuse(reply, result);
      return result;
    },
  );

  app.post('/register', { preHandler: requireEnabled }, async (request, reply) => {
    const body = request.body ?? {};
    const documentId = parseId(body.documentId);
    if (documentId === null) return reply.code(400).send({ error: 'invalid_document_id' });

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
