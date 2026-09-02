/**
 * Session lifecycle.
 *
 * The token handed to the browser is 256 bits of CSPRNG output. Only its
 * SHA-256 is stored, so the database never holds anything that can be replayed —
 * see migration 0003 for why that matters more than usual here.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('auth');

const TOKEN_BYTES = 32;

/** Hex SHA-256 of the raw token. Fast by design — this runs on every request. */
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Issues a session and returns the raw token — the only moment it exists in
 * readable form.
 *
 * @param {object} args
 * @param {bigint|number|string} args.userId
 * @param {string} [args.ipAddress]
 * @param {string} [args.userAgent]
 */
/**
 * The session lifetime an administrator has actually set.
 *
 * Read here rather than from `config`, which is frozen at boot: the setting
 * existed, accepted values, displayed them back — and every session was still
 * cut to the environment's length. Existing sessions keep the expiry they were
 * written with; the change applies from the next sign-in or renewal, which is
 * also the only behaviour that does not involve editing rows under live users.
 */
async function sessionTtlHours() {
  try {
    const { getSetting } = await import('../settings/service.js');
    return await getSetting('auth.session_ttl_hours');
  } catch {
    return config.auth.sessionTtlHours;
  }
}

export async function createSession({ userId, ipAddress, userAgent }) {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + (await sessionTtlHours()) * 3_600_000);

  await sql`
    INSERT INTO dbo.user_sessions (token_hash, user_id, expires_at, ip_address, user_agent)
    VALUES (${tokenHash}, ${userId}, ${expiresAt}, ${ipAddress ?? null}, ${userAgent?.slice(0, 400) ?? null})
  `.execute(db);

  return { token, expiresAt };
}

/**
 * Resolves a raw token to the user behind it, or null.
 *
 * Every check that decides "is this session usable" happens in SQL, in one
 * round trip, including the ones that are not about the session itself:
 *
 *   • the session is unexpired and not revoked
 *   • the user still exists and is_active
 *   • the principal is active
 *
 * Deactivating a user must end their access immediately. Doing that check here
 * rather than at each call site is the same principle as putting the is_deleted
 * check inside fn_effective_permission — a caller cannot forget what it never
 * had to remember.
 */
export async function resolveSession(token) {
  if (typeof token !== 'string' || token.length < 16) return null;

  const result = await sql`
    SELECT s.session_id, s.user_id, s.expires_at, s.created_at,
           u.username, u.is_super_admin, u.must_change_password,
           p.display_name
      FROM dbo.user_sessions s
      JOIN dbo.users      u ON u.user_id = s.user_id
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE s.token_hash = ${hashToken(token)}
       AND s.revoked_at IS NULL
       AND s.expires_at > SYSUTCDATETIME()
       AND p.is_active = 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    isSuperAdmin: Number(row.is_super_admin) === 1,
    mustChangePassword: Number(row.must_change_password) === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * Slides the expiry forward on an in-use session, bounded by the absolute
 * lifetime measured from creation.
 *
 * Returns the new expiry, or null when nothing was written. The write is skipped
 * unless the session is over halfway through its window, so an active user does
 * not generate an UPDATE per request.
 */
export async function touchSession(session) {
  const now = Date.now();
  const expiresAt = new Date(session.expiresAt).getTime();
  const ttlMs = (await sessionTtlHours()) * 3_600_000;

  if (expiresAt - now > ttlMs / 2) return null;

  const absoluteCeiling = new Date(session.createdAt).getTime() + config.auth.absoluteTtlHours * 3_600_000;
  const next = new Date(Math.min(now + ttlMs, absoluteCeiling));

  // Never move an expiry backwards: past the absolute ceiling the computed value
  // is older than what is stored, and writing it would cut the session short.
  if (next.getTime() <= expiresAt) return null;

  await sql`
    UPDATE dbo.user_sessions
       SET expires_at = ${next}, last_seen_at = SYSUTCDATETIME()
     WHERE session_id = ${session.sessionId} AND revoked_at IS NULL
  `.execute(db);

  return next;
}

/** Ends one session. Idempotent — logging out twice is not an error. */
export async function revokeSession(sessionId) {
  await sql`
    UPDATE dbo.user_sessions
       SET revoked_at = SYSUTCDATETIME()
     WHERE session_id = ${sessionId} AND revoked_at IS NULL
  `.execute(db);
}

/**
 * Ends every live session for a user.
 *
 * Called on password change and on deactivation. A password change that leaves
 * old sessions running does not actually lock anyone out, which is the entire
 * reason the user changed it.
 */
export async function revokeAllSessions(userId, { except } = {}) {
  const result = await sql`
    UPDATE dbo.user_sessions
       SET revoked_at = SYSUTCDATETIME()
     WHERE user_id = ${userId}
       AND revoked_at IS NULL
       AND (${except ?? null} IS NULL OR session_id <> ${except ?? null})
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
}

/**
 * Deletes sessions that expired more than `graceDays` ago.
 *
 * Expired rows are kept for a while on purpose: "when did this person last sign
 * in, and from where" is an audit question, and deleting the row the moment it
 * expires destroys the answer.
 */
export async function purgeExpiredSessions({ graceDays = 30 } = {}) {
  const result = await sql`
    DELETE FROM dbo.user_sessions
     WHERE expires_at < DATEADD(day, ${-graceDays}, SYSUTCDATETIME())
  `.execute(db);

  const removed = Number(result.numAffectedRows ?? 0);
  if (removed > 0) log.info({ removed }, 'purged expired sessions');
  return removed;
}

/**
 * Constant-time comparison for the rare case where two secrets are compared in
 * JavaScript rather than by the database.
 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
