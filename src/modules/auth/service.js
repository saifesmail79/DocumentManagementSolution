/**
 * Login, lockout and password change.
 *
 * Two properties this file exists to hold:
 *
 *   • A failed login tells the caller nothing about WHY. Wrong username, wrong
 *     password and deactivated account return one identical answer, and an
 *     unknown username still pays the full argon2 verification cost against a
 *     dummy hash — otherwise a fast rejection reveals which usernames exist, and
 *     an attacker enumerates the staff list before trying a single password.
 *
 *   • Lockout is temporary and per-account. A permanent lock is a denial of
 *     service that an attacker can trigger deliberately against a real user.
 */

import { randomBytes } from 'node:crypto';

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { hashPassword, verifyPassword, validatePassword, needsRehash } from './passwords.js';
import { createSession, revokeAllSessions } from './sessions.js';

const log = moduleLogger('auth');

/**
 * An argon2id hash of a random value nobody knows, used to spend the same CPU on
 * an unknown username as on a real one.
 *
 * Computed at first use rather than written as a literal: verifyPassword()
 * swallows a malformed hash and returns false immediately, so a hand-written
 * constant that argon2 cannot parse would return in microseconds and reinstate
 * exactly the timing difference this exists to remove. Deriving it from the real
 * hasher means it can never drift from the real parameters either.
 */
let dummyHashPromise;
function getDummyHash() {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}

/** Spends a full verification against the dummy hash and always fails. */
async function burnVerification(password) {
  return verifyPassword(await getDummyHash(), typeof password === 'string' ? password : 'x');
}

/** The single answer every failed login gives. */
const FAILED = Object.freeze({ ok: false, reason: 'invalid_credentials' });

/**
 * Authenticates a user and issues a session.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {string} args.password
 * @param {string} [args.ipAddress]
 * @param {string} [args.userAgent]
 */
export async function login({ username, password, ipAddress, userAgent }) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    await burnVerification(password);
    return FAILED;
  }

  const found = await sql`
    SELECT u.user_id, u.username, u.password_hash, u.is_super_admin, u.must_change_password,
           u.failed_login_count, u.locked_until, p.is_active, p.display_name
      FROM dbo.users u
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE u.username = ${username}
  `.execute(db);

  const user = found.rows[0];

  // Unknown username: still pay for a verification, then give the same answer.
  if (!user) {
    await burnVerification(password);
    log.warn({ username, ipAddress }, 'login failed: unknown username');
    return FAILED;
  }

  // A deactivated account must not be distinguishable from a wrong password, or
  // "who has left the organisation" becomes a public query.
  if (Number(user.is_active) !== 1) {
    await burnVerification(password);
    log.warn({ username, ipAddress }, 'login failed: account inactive');
    return FAILED;
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await burnVerification(password);
    log.warn({ username, ipAddress, lockedUntil: user.locked_until }, 'login failed: account locked');
    // Locked IS surfaced, unlike the cases above. The user needs to know why
    // waiting will help, and an attacker who triggered it already knows.
    return { ok: false, reason: 'account_locked', lockedUntil: user.locked_until };
  }

  const passwordOk = await verifyPassword(user.password_hash, password);

  if (!passwordOk) {
    await recordFailedAttempt(user);
    log.warn({ username, ipAddress }, 'login failed: wrong password');
    return FAILED;
  }

  // Success. Clear the counter, note the login, and upgrade the hash if the cost
  // parameters have moved on since it was written.
  await sql`
    UPDATE dbo.users
       SET failed_login_count = 0,
           locked_until = NULL,
           last_login_at = SYSUTCDATETIME()
     WHERE user_id = ${user.user_id}
  `.execute(db);

  if (needsRehash(user.password_hash)) {
    const upgraded = await hashPassword(password);
    await sql`UPDATE dbo.users SET password_hash = ${upgraded} WHERE user_id = ${user.user_id}`.execute(db);
    log.info({ username }, 'password hash upgraded to current parameters');
  }

  const session = await createSession({ userId: user.user_id, ipAddress, userAgent });
  log.info({ username, ipAddress }, 'login succeeded');

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name,
      isSuperAdmin: Number(user.is_super_admin) === 1,
      mustChangePassword: Number(user.must_change_password) === 1,
    },
  };
}

/** Increments the failure counter and locks the account once it crosses the threshold. */
async function recordFailedAttempt(user) {
  const next = Number(user.failed_login_count) + 1;
  const shouldLock = next >= config.auth.maxFailedLogins;

  // Computing locked_until in SQL keeps it on the database clock, which is the
  // same clock the expiry comparison uses. Mixing app and server time here is how
  // a lockout ends early on a host whose clock has drifted.
  await sql`
    UPDATE dbo.users
       SET failed_login_count = ${next},
           locked_until = ${shouldLock ? sql`DATEADD(minute, ${config.auth.lockoutMinutes}, SYSUTCDATETIME())` : sql`NULL`}
     WHERE user_id = ${user.user_id}
  `.execute(db);

  if (shouldLock) {
    log.warn(
      { username: user.username, attempts: next, minutes: config.auth.lockoutMinutes },
      'account locked after repeated failures',
    );
  }
}

/**
 * Changes a user's own password.
 *
 * Every other session is revoked. The one making the change is kept, so the user
 * is not signed out of the tab they are looking at — but a stolen session
 * elsewhere dies here, which is usually the reason for the change.
 */
export async function changePassword({ userId, currentPassword, newPassword, keepSessionId }) {
  const found = await sql`
    SELECT u.user_id, u.username, u.password_hash
      FROM dbo.users u WHERE u.user_id = ${userId}
  `.execute(db);

  const user = found.rows[0];
  if (!user) return { ok: false, reason: 'not_found' };

  if (!(await verifyPassword(user.password_hash, currentPassword))) {
    log.warn({ username: user.username }, 'password change rejected: current password wrong');
    return { ok: false, reason: 'invalid_credentials' };
  }

  const policy = validatePassword(newPassword, { username: user.username });
  if (!policy.ok) return { ok: false, reason: 'weak_password', problems: policy.problems };

  if (await verifyPassword(user.password_hash, newPassword)) {
    return { ok: false, reason: 'weak_password', problems: ['New password must differ from the current one.'] };
  }

  await sql`
    UPDATE dbo.users
       SET password_hash = ${await hashPassword(newPassword)},
           password_changed_at = SYSUTCDATETIME(),
           must_change_password = 0,
           failed_login_count = 0,
           locked_until = NULL
     WHERE user_id = ${userId}
  `.execute(db);

  const revoked = await revokeAllSessions(userId, { except: keepSessionId });
  log.info({ username: user.username, revoked }, 'password changed');

  return { ok: true, revokedSessions: revoked };
}
