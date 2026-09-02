/**
 * Per-user interface preferences, over HTTP.
 *
 * ─── What is actually at risk here ──────────────────────────────────────────
 *
 * A remembered tile order is a small feature with two failure modes that are not
 * small at all.
 *
 * The first is leakage between accounts. The store is keyed on the user, and the
 * key comes from the session rather than from anything the caller sends — but
 * that is a claim, and a claim about whose data you get back is worth a test
 * that two sessions cannot see each other's.
 *
 * The second is the store becoming a place to write arbitrary rows. The value is
 * user-supplied JSON under a user-supplied key, which is exactly the shape that
 * turns into unbounded growth the moment nothing checks it. So the allowlist and
 * the validator are tested for what they refuse, not only for what they accept.
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

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

async function makeUser(username) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);

  const principal = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${username})
  `.execute(db);
  const pid = principal.rows[0].pid;

  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin)
    VALUES (${pid}, ${username}, ${hash}, 0)
  `.execute(db);

  id[username] = pid;
  return pid;
}

async function signIn(username) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

const call = (method, url, cookie, payload) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

describe('interface preferences', { skip: CONFIGURED ? false : 'no test database configured' }, () => {
  let annaCookie;
  let bakrCookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));

    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('anna');
    await makeUser('bakr');
    annaCookie = await signIn('anna');
    bakrCookie = await signIn('bakr');
  });

  after(async () => {
    await app?.close();
    await db?.destroy();
  });

  /**
   * The table has to exist for any of this to work, and it exists only because
   * the migration is in the manifest. A migration file that is never registered
   * is a file, not a schema change.
   */
  test('migration 0015 created the table', async () => {
    const found = await sql`
      SELECT COUNT(*) AS n FROM sys.tables WHERE name = 'user_preferences' AND schema_id = SCHEMA_ID('dbo')
    `.execute(db);
    assert.equal(Number(found.rows[0].n), 1, 'user_preferences is missing — is 0015 in the manifest?');
  });

  test('a user with no saved arrangement gets the default, not an error', async () => {
    const response = await call('GET', '/api/preferences', annaCookie);
    assert.equal(response.statusCode, 200, response.body);

    // An empty list, which the client reads as "registry order".
    assert.deepEqual(response.json().preferences['home.tileOrder'], []);
  });

  test('an arrangement is saved and comes back', async () => {
    const saved = await call('PUT', '/api/preferences/home.tileOrder', annaCookie, {
      value: ['search', 'folders', 'my'],
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const read = await call('GET', '/api/preferences', annaCookie);
    assert.deepEqual(read.json().preferences['home.tileOrder'], ['search', 'folders', 'my']);
  });

  test('saving again replaces rather than accumulates', async () => {
    await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value: ['my'] });
    await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value: ['recycle', 'my'] });

    const read = await call('GET', '/api/preferences', annaCookie);
    assert.deepEqual(read.json().preferences['home.tileOrder'], ['recycle', 'my']);

    const rows = await sql`
      SELECT COUNT(*) AS n FROM dbo.user_preferences
       WHERE user_id = ${id.anna} AND pref_key = 'home.tileOrder'
    `.execute(db);
    assert.equal(Number(rows.rows[0].n), 1, 'one row per user per key, not one per save');
  });

  /** The whole point of storing it server-side is that it is *their* order. */
  test('one user cannot see or affect another arrangement', async () => {
    await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value: ['admin', 'search'] });
    await call('PUT', '/api/preferences/home.tileOrder', bakrCookie, { value: ['my'] });

    const anna = await call('GET', '/api/preferences', annaCookie);
    const bakr = await call('GET', '/api/preferences', bakrCookie);

    assert.deepEqual(anna.json().preferences['home.tileOrder'], ['admin', 'search']);
    assert.deepEqual(bakr.json().preferences['home.tileOrder'], ['my']);
  });

  test('an empty list is how an arrangement is cleared', async () => {
    await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value: ['search'] });
    const cleared = await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value: [] });
    assert.equal(cleared.statusCode, 200, cleared.body);

    const read = await call('GET', '/api/preferences', annaCookie);
    assert.deepEqual(read.json().preferences['home.tileOrder'], []);
  });

  // ── What it refuses ────────────────────────────────────────────────────

  test('an unknown preference key is refused, so the table cannot be filled', async () => {
    const response = await call('PUT', '/api/preferences/whatever.i.like', annaCookie, {
      value: ['x'],
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'unknown_preference');

    const rows = await sql`SELECT COUNT(*) AS n FROM dbo.user_preferences WHERE pref_key = 'whatever.i.like'`
      .execute(db);
    assert.equal(Number(rows.rows[0].n), 0, 'nothing was stored under a key that does not exist');
  });

  test('a value of the wrong shape is refused', async () => {
    for (const value of [
      'not-a-list',
      42,
      null,
      [{ key: 'folders' }],
      ['folders', 123],
      ['Folders'],
      ['../etc/passwd'],
      ['a'.repeat(80)],
    ]) {
      const response = await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value });
      assert.equal(
        response.statusCode,
        400,
        `${JSON.stringify(value)} should have been refused, got ${response.statusCode}`,
      );
    }
  });

  test('a duplicated entry is refused, because the order would be ambiguous', async () => {
    const response = await call('PUT', '/api/preferences/home.tileOrder', annaCookie, {
      value: ['folders', 'folders'],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'duplicate_entry');
  });

  test('an absurdly long list is refused rather than stored', async () => {
    const value = Array.from({ length: 200 }, (_, index) => `module-${index}`);
    const response = await call('PUT', '/api/preferences/home.tileOrder', annaCookie, { value });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'too_many_entries');
  });

  test('preferences need a session', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/preferences' })).statusCode, 401);
    assert.equal(
      (await app.inject({
        method: 'PUT',
        url: '/api/preferences/home.tileOrder',
        payload: { value: [] },
      })).statusCode,
      401,
    );
  });

  /**
   * A row can outlive the rule that wrote it. The read path must survive that,
   * because the alternative is a home page that will not render — and the home
   * page is how every other screen is reached.
   */
  test('a stored value that no longer validates falls back to the default', async () => {
    await sql`
      UPDATE dbo.user_preferences SET value = ${'{"not":"a list"}'}
       WHERE user_id = ${id.anna} AND pref_key = 'home.tileOrder'
    `.execute(db);

    const response = await call('GET', '/api/preferences', annaCookie);
    assert.equal(response.statusCode, 200, 'a bad stored row must not break the read');
    assert.deepEqual(response.json().preferences['home.tileOrder'], []);
  });

  test('a stored value that is not JSON at all falls back too', async () => {
    await sql`
      UPDATE dbo.user_preferences SET value = ${'}{ this was never JSON'}
       WHERE user_id = ${id.anna} AND pref_key = 'home.tileOrder'
    `.execute(db);

    const response = await call('GET', '/api/preferences', annaCookie);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().preferences['home.tileOrder'], []);
  });
});
