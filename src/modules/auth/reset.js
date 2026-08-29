/**
 * Self-service password reset.
 *
 * ─── Delivery is deliberately not implemented here ──────────────────────────
 *
 * There is no SMTP configuration on this deployment yet, and a reset flow that
 * silently drops its emails is worse than none: users would believe a link is
 * coming and administrators would believe the feature works.
 *
 * So the token mechanism is complete and tested, and delivery is a pluggable
 * transport. Out of the box the transport is `log`, which writes the link to the
 * application log — usable for a small on-prem install where an administrator
 * can read it, and honest about what it is. Configure a real transport before
 * telling users the feature exists; `resetLinkDelivery` in config is the seam.
 *
 * ─── Enumeration ────────────────────────────────────────────────────────────
 *
 * requestReset() returns the same answer whether or not the account exists. A
 * reset form that says "no such user" is a free membership check against the
 * organisation, and it is the same reasoning that makes login failures
 * indistinguishable.
 */

import { randomBytes, createHash } from 'node:crypto';

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { hashPassword, validatePassword } from './passwords.js';
import { revokeAllSessions } from './sessions.js';

const log = moduleLogger('auth');

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Issues a reset token if the username exists.
 *
 * Always resolves the same way. The caller cannot tell the difference, and must
 * not try to.
 */
export async function requestReset({ username, ipAddress }) {
  const found = await sql`
    SELECT u.user_id, u.username, p.is_active
      FROM dbo.users u
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE u.username = ${String(username ?? '').trim()}
  `.execute(db);

  const user = found.rows[0];

  // Deactivated accounts get no token either — but the answer is still the same.
  if (!user || Number(user.is_active) !== 1) {
    log.info({ username, ipAddress }, 'password reset requested for an unknown or inactive account');
    return { ok: true };
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.resetTokenMinutes * 60_000);

  await db.transaction().execute(async (trx) => {
    // Outstanding tokens are invalidated: requesting a new link must retire the
    // old one, or a leaked earlier email stays usable.
    await sql`
      UPDATE dbo.password_reset_tokens
         SET used_at = SYSUTCDATETIME()
       WHERE user_id = ${user.user_id} AND used_at IS NULL
    `.execute(trx);

    await sql`
      INSERT INTO dbo.password_reset_tokens (token_hash, user_id, expires_at, requested_ip)
      VALUES (${hashToken(token)}, ${user.user_id}, ${expiresAt}, ${ipAddress ?? null})
    `.execute(trx);
  });

  await deliver({ username: user.username, token, expiresAt });

  return { ok: true };
}

/**
 * Hands the reset link to the configured transport.
 *
 * The token appears in the log under the `log` transport — which is the point of
 * that mode, and the reason it must not be used once real email exists.
 */
async function deliver({ username, token, expiresAt }) {
  const link = `${config.auth.resetLinkBase}/reset?token=${encodeURIComponent(token)}`;

  if (config.auth.resetDelivery === 'log') {
    log.warn(
      { username, link, expiresAt },
      'password reset link generated - delivery transport is "log", so this link is only ' +
        'visible here. Configure a real transport before offering reset to users.',
    );
    return;
  }

  // No other transport is wired yet. Failing loudly beats pretending to send.
  log.error(
    { transport: config.auth.resetDelivery, username },
    'no delivery transport is implemented for this setting; the reset link was not sent',
  );
}

/** Checks a token without consuming it, so the form can be shown or refused. */
export async function checkResetToken(token) {
  if (typeof token !== 'string' || token.length < 16) return { ok: false, reason: 'invalid_token' };

  const found = await sql`
    SELECT t.token_id, t.user_id, u.username
      FROM dbo.password_reset_tokens t
      JOIN dbo.users u ON u.user_id = t.user_id
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE t.token_hash = ${hashToken(token)}
       AND t.used_at IS NULL
       AND t.expires_at > SYSUTCDATETIME()
       AND p.is_active = 1
  `.execute(db);

  const row = found.rows[0];
  return row
    ? { ok: true, userId: String(row.user_id), username: row.username }
    : { ok: false, reason: 'invalid_token' };
}

/**
 * Redeems a token and sets the new password.
 *
 * The token is marked used in the same transaction as the password change, so a
 * link cannot be replayed — including by two requests arriving at once.
 */
export async function completeReset({ token, newPassword }) {
  const check = await checkResetToken(token);
  if (!check.ok) return check;

  const policy = validatePassword(newPassword, { username: check.username });
  if (!policy.ok) return { ok: false, reason: 'weak_password', problems: policy.problems };

  const hash = await hashPassword(newPassword);

  const consumed = await db.transaction().execute(async (trx) => {
    // The WHERE clause is the guard: a second concurrent redemption updates zero
    // rows and is rejected, rather than both succeeding.
    const result = await sql`
      UPDATE dbo.password_reset_tokens
         SET used_at = SYSUTCDATETIME()
       WHERE token_hash = ${hashToken(token)} AND used_at IS NULL
    `.execute(trx);

    if (Number(result.numAffectedRows ?? 0) !== 1) return false;

    await sql`
      UPDATE dbo.users
         SET password_hash = ${hash},
             password_changed_at = SYSUTCDATETIME(),
             must_change_password = 0,
             failed_login_count = 0,
             locked_until = NULL
       WHERE user_id = ${check.userId}
    `.execute(trx);

    return true;
  });

  if (!consumed) return { ok: false, reason: 'invalid_token' };

  // Whoever prompted the reset may be the reason the account was compromised.
  const revoked = await revokeAllSessions(check.userId);

  log.info({ username: check.username, revoked }, 'password reset completed');
  return { ok: true, revokedSessions: revoked };
}

/** Removes spent and expired tokens. Called by the maintenance sweep. */
export async function purgeResetTokens({ graceDays = 7 } = {}) {
  const result = await sql`
    DELETE FROM dbo.password_reset_tokens
     WHERE expires_at < DATEADD(day, ${-Math.abs(graceDays)}, SYSUTCDATETIME())
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
}
