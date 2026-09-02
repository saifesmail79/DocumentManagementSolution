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
  /*
   * The one public value.
   *
   * The organisation's name goes on the sign-in screen, which by definition is
   * read by people who have not signed in. It is the name on the building; the
   * sensitive values stay in the guarded scope below.
   *
   * The guarded routes live in their own child scope because a Fastify hook
   * belongs to the whole plugin, not to the routes declared after it —
   * registering this "before" the hook changes nothing, which is exactly the
   * mistake this layout replaces.
   */
  app.get('/branding', async () => {
    const { getSetting } = await import('./service.js');
    return { organisationName: await getSetting('organisation.name') };
  });

  app.register(guardedSettingsRoutes);
}

async function guardedSettingsRoutes(app) {
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

    // The whole refusal, not just its name: an out-of-range reply carries the
    // bounds, and dropping them here is what left the screen saying "out of
    // range" without ever saying what the range was.
    if (!result.ok) {
      const { ok, reason, ...detail } = result;
      return reply.code(STATUS[reason] ?? 400).send({ error: reason, ...detail });
    }

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
    // The whole refusal, not just its name: an out-of-range reply carries the
    // bounds, and dropping them here is what left the screen saying "out of
    // range" without ever saying what the range was.
    if (!result.ok) {
      const { ok, reason, ...detail } = result;
      return reply.code(STATUS[reason] ?? 400).send({ error: reason, ...detail });
    }

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
