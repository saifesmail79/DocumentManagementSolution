/**
 * Integration tests for authentication.
 *
 * Run with `npm run test:db`. These go through the real Fastify instance via
 * app.inject(), so the cookie handling, hooks and status codes are the ones a
 * browser will actually meet — not a reimplementation of them.
 *
 * The cases here are the security properties, not the happy path. A login form
 * that works is easy; one that does not leak which usernames exist, and where
 * revocation takes effect on the next request, is the part worth testing.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

let db;
let sql;
let app;
let auth;
let sessions;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

/** Creates a user directly, bypassing the CLI. */
async function makeUser(username, { password = PASSWORD, active = true, superAdmin = false } = {}) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(password);

  const principal = await sql`
    INSERT INTO dbo.principals (principal_type, display_name, is_active)
    OUTPUT INSERTED.principal_id AS pid
    VALUES ('user', ${username}, ${active ? 1 : 0})
  `.execute(db);
  const pid = principal.rows[0].pid;

  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0})
  `.execute(db);

  id[username] = pid;
  return pid;
}

/** Logs in over HTTP and returns { status, body, cookie }. */
async function loginVia(username, password = PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });

  const setCookie = response.cookies.find((c) => c.name === 'dms_session');
  return {
    status: response.statusCode,
    body: response.json(),
    cookie: setCookie ? `dms_session=${setCookie.value}` : null,
    rawCookie: setCookie,
  };
}

const withCookie = (cookie) => ({ cookie });

describe('authentication', { skip: CONFIGURED ? false : target.reason }, () => {
  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    await sql`DELETE FROM dbo.user_sessions`.execute(db);

    auth = await import('../src/modules/auth/service.js');
    sessions = await import('../src/modules/auth/sessions.js');

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('salim');
    await makeUser('dormant', { active: false });
    await makeUser('boss', { superAdmin: true });
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
  });

  // ── The property the design is built around ────────────────────────────

  test('a wrong password, an unknown user and a disabled account are indistinguishable', async () => {
    const wrongPassword = await loginVia('salim', 'not-the-password');
    const unknownUser = await loginVia('nobody-here', 'not-the-password');
    const disabled = await loginVia('dormant');

    for (const [label, result] of [
      ['wrong password', wrongPassword],
      ['unknown user', unknownUser],
      ['disabled account', disabled],
    ]) {
      assert.equal(result.status, 401, `${label} should be 401`);
      assert.deepEqual(result.body, { error: 'invalid_credentials' }, `${label} leaked detail`);
      assert.equal(result.cookie, null, `${label} must not set a session`);
    }
  });

  test('the session token is never stored in readable form', async () => {
    const { cookie, rawCookie } = await loginVia('salim');
    assert.ok(cookie, 'login should set a cookie');

    // A database backup goes to a NAS and to tape. If the token were stored as
    // handed out, anyone reading a backup could resume a live session.
    const stored = await sql`
      SELECT token_hash FROM dbo.user_sessions WHERE revoked_at IS NULL
    `.execute(db);

    for (const row of stored.rows) {
      assert.notEqual(row.token_hash, rawCookie.value, 'raw token found in the database');
      assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'token_hash should be a hex SHA-256');
    }
  });

  test('the session cookie is httpOnly and same-site', async () => {
    const { rawCookie } = await loginVia('salim');
    assert.equal(rawCookie.httpOnly, true, 'XSS must not be able to read the session');
    assert.equal(String(rawCookie.sameSite).toLowerCase(), 'lax');
    assert.equal(rawCookie.path, '/');
  });

  // ── Session lifecycle ──────────────────────────────────────────────────

  test('a valid session identifies the user, and logout ends it', async () => {
    const { cookie } = await loginVia('salim');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withCookie(cookie) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.username, 'salim');
    assert.equal(me.json().user.isSuperAdmin, false);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: withCookie(cookie) });
    assert.equal(out.statusCode, 200);

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withCookie(cookie) });
    assert.equal(after.statusCode, 401, 'a revoked session must stop working immediately');
  });

  test('no session means 401, not a crash', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(me.statusCode, 401);
    assert.deepEqual(me.json(), { error: 'authentication_required' });
  });

  test('a garbage cookie is rejected without error', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: withCookie('dms_session=not-a-real-token'),
    });
    assert.equal(me.statusCode, 401);
  });

  /**
   * The reason sessions are server-side rather than JWT. Deactivating someone
   * must take effect on their next request, not when a token happens to expire.
   */
  test('deactivating a user kills their live session on the next request', async () => {
    await makeUser('temp');
    const { cookie } = await loginVia('temp');

    const before = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withCookie(cookie) });
    assert.equal(before.statusCode, 200);

    await sql`UPDATE dbo.principals SET is_active = 0 WHERE principal_id = ${id.temp}`.execute(db);

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withCookie(cookie) });
    assert.equal(after.statusCode, 401, 'the session must die with the account');
  });

  test('an expired session does not resolve', async () => {
    await makeUser('expiring');
    const { cookie } = await loginVia('expiring');

    // created_at moves too: CK_user_sessions_expiry requires expires_at to be
    // after created_at, so backdating only the expiry is refused by the schema —
    // which is the constraint doing its job, not a test problem to work around.
    await sql`
      UPDATE dbo.user_sessions
         SET created_at = DATEADD(hour, -3, SYSUTCDATETIME()),
             expires_at = DATEADD(hour, -1, SYSUTCDATETIME())
       WHERE user_id = ${id.expiring} AND revoked_at IS NULL
    `.execute(db);

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withCookie(cookie) });
    assert.equal(after.statusCode, 401);
  });

  // ── Lockout ────────────────────────────────────────────────────────────

  test('repeated failures lock the account, and the lock is announced', async () => {
    await makeUser('bruteforced');

    // The threshold is configurable; read it rather than assuming 5.
    const { config } = await import('../src/config/index.js');
    const limit = config.auth.maxFailedLogins;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const result = await loginVia('bruteforced', 'wrong');
      assert.equal(result.status, 401, `attempt ${attempt} should still read as a bad password`);
    }

    // Locked is deliberately NOT hidden: the user needs to know that waiting
    // helps, and whoever triggered it already knows the account exists.
    const locked = await loginVia('bruteforced', 'wrong');
    assert.equal(locked.status, 423);
    assert.equal(locked.body.error, 'account_locked');
    assert.ok(locked.body.lockedUntil, 'the client needs to know when to retry');

    // Even the correct password is refused while locked.
    const correct = await loginVia('bruteforced');
    assert.equal(correct.status, 423, 'the lock must hold against the real password too');
  });

  test('a successful login clears the failure counter', async () => {
    await makeUser('clumsy');
    await loginVia('clumsy', 'wrong');
    await loginVia('clumsy', 'wrong');

    const ok = await loginVia('clumsy');
    assert.equal(ok.status, 200);

    const row = await sql`SELECT failed_login_count FROM dbo.users WHERE user_id = ${id.clumsy}`.execute(db);
    assert.equal(Number(row.rows[0].failed_login_count), 0);
  });

  // ── Password change ────────────────────────────────────────────────────

  test('changing the password revokes other sessions but keeps the current one', async () => {
    await makeUser('rotator');
    const phone = await loginVia('rotator');
    const laptop = await loginVia('rotator');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: withCookie(laptop.cookie),
      payload: { currentPassword: PASSWORD, newPassword: 'a-completely-different-secret' },
    });

    assert.equal(changed.statusCode, 200);
    assert.ok(changed.json().revokedSessions >= 1, 'the other session should have been revoked');

    const stillHere = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: withCookie(laptop.cookie),
    });
    assert.equal(stillHere.statusCode, 200, 'the session that made the change survives');

    const killed = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: withCookie(phone.cookie),
    });
    assert.equal(killed.statusCode, 401, 'the other session is gone');

    // And the new password is the one that works.
    assert.equal((await loginVia('rotator', PASSWORD)).status, 401);
    assert.equal((await loginVia('rotator', 'a-completely-different-secret')).status, 200);
  });

  test('a weak or unchanged password is refused with reasons', async () => {
    await makeUser('picky');
    const { cookie } = await loginVia('picky');

    const tooShort = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: withCookie(cookie),
      payload: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    assert.equal(tooShort.statusCode, 400);
    assert.equal(tooShort.json().error, 'weak_password');
    assert.ok(tooShort.json().problems.length > 0, 'the user needs to know what to fix');

    const unchanged = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: withCookie(cookie),
      payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    assert.equal(unchanged.statusCode, 400);
  });

  test('the wrong current password does not change anything', async () => {
    await makeUser('careful');
    const { cookie } = await loginVia('careful');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: withCookie(cookie),
      payload: { currentPassword: 'nope', newPassword: 'a-perfectly-fine-new-secret' },
    });

    assert.equal(rejected.statusCode, 401);
    assert.equal((await loginVia('careful')).status, 200, 'the old password must still work');
  });

  // ── must_change_password ───────────────────────────────────────────────

  test('a temporary password grants nothing until it is replaced', async () => {
    await makeUser('newjoiner');
    await sql`UPDATE dbo.users SET must_change_password = 1 WHERE user_id = ${id.newjoiner}`.execute(db);

    const { cookie, status } = await loginVia('newjoiner');
    assert.equal(status, 200, 'login itself succeeds');

    // /me and change-password are reachable; nothing else is. Without this an
    // admin handing out a temporary password hands out a working account.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withCookie(cookie) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.mustChangePassword, true);

    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: withCookie(cookie),
    });
    assert.equal(elsewhere.statusCode, 403);
    assert.equal(elsewhere.json().error, 'password_change_required');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: withCookie(cookie),
      payload: { currentPassword: PASSWORD, newPassword: 'the-replacement-secret-99' },
    });
    assert.equal(changed.statusCode, 200);

    const freed = await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: withCookie(cookie),
    });
    assert.equal(freed.statusCode, 200, 'the restriction lifts once the password is replaced');
  });

  // ── Direct service-layer checks ────────────────────────────────────────

  test('revokeAllSessions ends every session for one user only', async () => {
    await makeUser('shared');
    await makeUser('bystander');
    await loginVia('shared');
    await loginVia('shared');
    const other = await loginVia('bystander');

    const revoked = await sessions.revokeAllSessions(id.shared);
    assert.ok(revoked >= 2, `expected at least 2 revocations, got ${revoked}`);

    const survives = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: withCookie(other.cookie),
    });
    assert.equal(survives.statusCode, 200, 'another user must be unaffected');
  });

  test('login reports the super-admin flag', async () => {
    const { body, status } = await loginVia('boss');
    assert.equal(status, 200);
    assert.equal(body.user.isSuperAdmin, true);
  });
});
