/**
 * Configuration panel routes.
 *
 * Super-admin only. Reading is gated too, unlike the metadata vocabulary: the
 * values include lockout thresholds and password policy, which tell an attacker
 * exactly how much room they have.
 */

import { listSettings, setSetting, clearSetting } from './service.js';
import { record, ACTION } from '../audit/service.js';

const STATUS = { unknown_setting: 404, invalid_value: 400, out_of_range: 400 };

export async function settingsRoutes(app) {
  app.addHook('preHandler', app.requireAuth);
  app.addHook('preHandler', app.requireSuperAdmin);

  app.get('/', async () => ({ settings: await listSettings() }));

  app.put('/:key', async (request, reply) => {
    const key = String(request.params.key);
    const result = await setSetting({
      key,
      value: request.body?.value,
      actorId: request.user.userId,
    });

    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    // Changing a lockout threshold or a password minimum is a security-relevant
    // act, so it belongs in the trail with the value it was set to.
    await record({
      actor: request.user,
      action: ACTION.SETTING_CHANGED,
      targetType: 'setting',
      targetId: key,
      detail: String(request.body?.value ?? ''),
      request,
    });

    return { ok: true };
  });

  /** Drops the stored override so the environment value applies again. */
  app.delete('/:key', async (request, reply) => {
    const key = String(request.params.key);
    const result = await clearSetting({ key });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason });

    await record({
      actor: request.user,
      action: ACTION.SETTING_CHANGED,
      targetType: 'setting',
      targetId: key,
      detail: 'reverted to the environment default',
      request,
    });

    return { ok: true };
  });
}
