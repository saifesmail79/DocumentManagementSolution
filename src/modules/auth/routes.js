/**
 * Authentication wiring and routes.
 *
 * registerAuth() is called with the ROOT Fastify instance rather than through
 * app.register(). Fastify encapsulates decorators added inside a registered
 * plugin, so `requireAuth` defined that way would be invisible to sibling route
 * modules — the usual fix is the fastify-plugin package, and calling it directly
 * achieves the same thing without another dependency.
 */

import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { login, changePassword } from './service.js';
import { resolveSession, touchSession, revokeSession, revokeAllSessions } from './sessions.js';
import { requestReset, checkResetToken, completeReset } from './reset.js';
import { record, ACTION } from '../audit/service.js';

const log = moduleLogger('auth');

/** Cookie options shared by the set and clear paths — they must match or the clear silently fails. */
function cookieOptions() {
  return {
    httpOnly: true, //   not readable from JavaScript, so XSS cannot exfiltrate the session
    secure: config.auth.cookieSecure,
    sameSite: 'lax', // blocks cross-site POSTs while keeping ordinary navigation working
    path: '/',
  };
}

export function registerAuth(app) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  /**
   * Resolves the session on every request, including anonymous ones.
   *
   * This is a hook rather than a per-route preHandler so that a route added later
   * cannot accidentally see a stale or absent `request.user`. Authentication is
   * ambient; authorisation is explicit.
   */
  app.addHook('onRequest', async (request) => {
    const token = request.cookies?.[config.auth.cookieName];
    if (!token) return;

    const session = await resolveSession(token);
    if (!session) return;

    request.user = session;
    request.sessionId = session.sessionId;

    // Sliding expiry. Fire-and-forget: a failed expiry extension must not fail
    // the request the user actually asked for.
    touchSession(session).catch((error) => log.warn({ err: error }, 'could not extend session'));
  });

  /**
   * Rejects unauthenticated requests. Use as a preHandler:
   *   app.get('/x', { preHandler: app.requireAuth }, handler)
   */
  app.decorate('requireAuth', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'authentication_required' });
    }

    // A user under must_change_password can do exactly two things: read their own
    // identity and change the password. Anything else is refused, so an admin
    // handing out a temporary password does not hand out a working account.
    const exempt = request.routeOptions?.config?.allowPasswordChangeOnly === true;
    if (request.user.mustChangePassword && !exempt) {
      return reply.code(403).send({ error: 'password_change_required' });
    }
  });

  /** Rejects anyone who is not a super admin. Layered after requireAuth. */
  app.decorate('requireSuperAdmin', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'authentication_required' });
    if (!request.user.isSuperAdmin) return reply.code(403).send({ error: 'forbidden' });
  });

  app.register(authRoutes, { prefix: '/api/auth' });
}

async function authRoutes(app) {
  app.post('/login', async (request, reply) => {
    const { username, password } = request.body ?? {};

    const result = await login({
      username,
      password,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (!result.ok) {
      // 423 Locked is distinguishable on purpose; every other failure is one
      // indistinguishable 401. See service.js.
      // Recorded without an actor id: the account may not exist, and inventing a
      // link to one would be a lie in the trail.
      await record({
        action: ACTION.LOGIN_FAILED,
        targetType: 'username',
        targetId: typeof username === 'string' ? username.slice(0, 64) : null,
        detail: result.reason,
        request,
      });

      const status = result.reason === 'account_locked' ? 423 : 401;
      return reply.code(status).send({
        error: result.reason,
        ...(result.lockedUntil ? { lockedUntil: result.lockedUntil } : {}),
      });
    }

    reply.setCookie(config.auth.cookieName, result.token, {
      ...cookieOptions(),
      expires: result.expiresAt,
    });

    await record({
      actor: { userId: result.user.userId, username: result.user.username },
      action: ACTION.LOGIN_SUCCEEDED,
      request,
    });

    return { user: result.user, expiresAt: result.expiresAt };
  });

  app.post('/logout', async (request, reply) => {
    if (request.sessionId) await revokeSession(request.sessionId);
    if (request.user) await record({ actor: request.user, action: ACTION.LOGOUT, request });
    reply.clearCookie(config.auth.cookieName, cookieOptions());
    return { ok: true };
  });

  app.get(
    '/me',
    { preHandler: app.requireAuth, config: { allowPasswordChangeOnly: true } },
    async (request) => ({
      user: {
        userId: request.user.userId,
        username: request.user.username,
        displayName: request.user.displayName,
        isSuperAdmin: request.user.isSuperAdmin,
        mustChangePassword: request.user.mustChangePassword,
      },
      expiresAt: request.user.expiresAt,
    }),
  );

  app.post(
    '/change-password',
    { preHandler: app.requireAuth, config: { allowPasswordChangeOnly: true } },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body ?? {};

      const result = await changePassword({
        userId: request.user.userId,
        currentPassword,
        newPassword,
        keepSessionId: request.sessionId,
      });

      if (!result.ok) {
        const status = result.reason === 'weak_password' ? 400 : 401;
        return reply.code(status).send({ error: result.reason, problems: result.problems });
      }

      await record({ actor: request.user, action: ACTION.PASSWORD_CHANGED, request });
      return { ok: true, revokedSessions: result.revokedSessions };
    },
  );

  /**
   * Self-service reset. These three are the only unauthenticated routes besides
   * login -- the whole point is that the user cannot sign in.
   */
  app.post('/reset/request', async (request) => {
    const { username } = request.body ?? {};
    await requestReset({ username, ipAddress: request.ip });
    await record({
      action: ACTION.PASSWORD_RESET_REQUESTED,
      targetType: 'username',
      targetId: typeof username === 'string' ? username.slice(0, 64) : null,
      request,
    });
    // Always the same answer, whether or not the account exists.
    return { ok: true };
  });

  app.get('/reset/check', async (request, reply) => {
    const result = await checkResetToken(request.query?.token);
    return result.ok ? { ok: true, username: result.username } : reply.code(400).send({ error: result.reason });
  });

  app.post('/reset/complete', async (request, reply) => {
    const { token, newPassword } = request.body ?? {};
    const result = await completeReset({ token, newPassword });

    if (!result.ok) {
      const status = result.reason === 'weak_password' ? 400 : 400;
      return reply.code(status).send({ error: result.reason, problems: result.problems });
    }

    await record({ action: ACTION.PASSWORD_RESET_COMPLETED, request });
    return { ok: true };
  });

  /** Signs the user out everywhere, including the current session. */
  app.post('/logout-all', { preHandler: app.requireAuth }, async (request, reply) => {
    const revoked = await revokeAllSessions(request.user.userId);
    reply.clearCookie(config.auth.cookieName, cookieOptions());
    return { ok: true, revokedSessions: revoked };
  });
}
