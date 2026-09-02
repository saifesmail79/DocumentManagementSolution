/**
 * Every editable setting, tested for its effect — not for whether it stores.
 *
 * ─── The failure this suite exists to prevent ───────────────────────────────
 *
 * Nine of the thirteen settings offered by the administration screen were read
 * by no code at all. Each accepted a value, persisted it, displayed it back and
 * reported its source as the database — and the behaviour it named went on
 * obeying whatever the environment said at boot. Storage tests passed the whole
 * time, because storing was the only part that worked.
 *
 * So nothing here asserts that a value was saved. Every test changes a setting
 * and then asserts the system behaves differently: a session gets shorter, an
 * account locks sooner, an upload is refused, a sweep collects earlier. If a
 * setting's consumer is ever unplugged again, the storage keeps working and one
 * of these fails.
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
let settings;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

async function makeUser(username, { superAdmin = false } = {}) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);

  const principal = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${username})
  `.execute(db);
  const pid = principal.rows[0].pid;

  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0})
  `.execute(db);

  id[username] = pid;
  return pid;
}

async function signIn(username, password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
}

async function cookieFor(username) {
  const response = await signIn(username);
  assert.equal(response.statusCode, 200, response.body);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

/** One text file, multipart, into the given folder. */
async function upload(cookie, folderId, filename, content) {
  const boundary = '----dmseffect';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + 'Content-Type: text/plain\r\n\r\n',
      'utf8',
    ),
    Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  return app.inject({
    method: 'POST',
    url: `/api/folders/${folderId}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

/** Sets one setting and drops the read cache, as the admin screen effectively does. */
async function apply(key, value) {
  const result = await settings.setSetting({ key, value, actorId: null });
  assert.equal(result.ok, true, `could not set ${key}: ${result.reason}`);
  settings.resetSettingsCache();
}

async function revert(key) {
  await settings.clearSetting({ key });
  settings.resetSettingsCache();
}

describe('settings take effect', { skip: CONFIGURED ? false : target.reason }, () => {
  let folderId;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));

    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    settings = await import('../src/modules/settings/service.js');

    await makeUser('worker');
    await makeUser('victim');

    const { PERM } = await import('../src/db/migrations/0001-identity-and-acl.js');
    const folder = await sql`
      INSERT INTO dbo.folders (parent_id, name, mpath, depth)
      OUTPUT INSERTED.folder_id AS fid VALUES (NULL, ${'خزانة'}, '/pending/', 0)
    `.execute(db);
    folderId = folder.rows[0].fid;
    await sql`UPDATE dbo.folders SET mpath = ${`/${folderId}/`} WHERE folder_id = ${folderId}`.execute(db);

    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${folderId}, ${id.worker}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.DELETE}, 0)
    `.execute(db);
  });

  after(async () => {
    await app?.close();
    await db?.destroy();
  });

  // ── Sessions ───────────────────────────────────────────────────────────

  test('session lifetime follows auth.session_ttl_hours', async () => {
    try {
      await apply('auth.session_ttl_hours', 2);
      await cookieFor('worker');

      const row = await sql`
        SELECT TOP 1 DATEDIFF(minute, SYSUTCDATETIME(), expires_at) AS minutes_left
          FROM dbo.user_sessions WHERE user_id = ${id.worker} ORDER BY session_id DESC
      `.execute(db);

      const minutes = Number(row.rows[0].minutes_left);
      // Two hours, give or take the clock skew between app and database.
      assert.ok(minutes > 110 && minutes <= 125, `expected ~120 minutes, got ${minutes}`);
    } finally {
      await revert('auth.session_ttl_hours');
    }
  });

  // ── Lockout ────────────────────────────────────────────────────────────

  test('the lockout threshold and duration follow their settings', async () => {
    try {
      await apply('auth.max_failed_logins', 3);
      await apply('auth.lockout_minutes', 45);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await signIn('victim', 'wrong-password-entirely');
        assert.equal(failed.statusCode, 401);
      }

      // The right password no longer helps: three wrong tries was the limit.
      const locked = await signIn('victim');
      assert.equal(locked.statusCode, 423, `expected a locked account, got ${locked.statusCode}`);

      const until = await sql`
        SELECT DATEDIFF(minute, SYSUTCDATETIME(), locked_until) AS minutes
          FROM dbo.users WHERE user_id = ${id.victim}
      `.execute(db);
      const minutes = Number(until.rows[0].minutes);
      assert.ok(minutes > 40 && minutes <= 46, `expected ~45 minutes of lockout, got ${minutes}`);
    } finally {
      await revert('auth.max_failed_logins');
      await revert('auth.lockout_minutes');
      await sql`
        UPDATE dbo.users SET failed_login_count = 0, locked_until = NULL
         WHERE user_id = ${id.victim}
      `.execute(db);
    }
  });

  // ── Uploads ────────────────────────────────────────────────────────────

  test('upload.max_bytes is enforced on the upload itself', async () => {
    const cookie = await cookieFor('worker');
    try {
      await apply('upload.max_bytes', 2048);

      const big = await upload(cookie, folderId, 'big.txt', 'x'.repeat(3000));
      assert.equal(big.statusCode, 413, `3000 bytes against a 2048 limit: ${big.body}`);

      const small = await upload(cookie, folderId, 'small.txt', 'x'.repeat(500));
      assert.equal(small.statusCode, 201, small.body);
    } finally {
      await revert('upload.max_bytes');
    }
  });

  test('upload.allowed_extensions admits what it names and nothing else', async () => {
    const cookie = await cookieFor('worker');
    try {
      await apply('upload.allowed_extensions', 'txt, pdf');

      const admitted = await upload(cookie, folderId, 'ملاحظات.txt', 'محتوى عادي');
      assert.equal(admitted.statusCode, 201, admitted.body);

      const refused = await upload(cookie, folderId, 'run-me.exe', 'MZ pretend binary');
      assert.equal(refused.statusCode, 415, refused.body);
      assert.equal(refused.json().error, 'blocked_extension');
      // The refusal names what would have been accepted.
      assert.deepEqual(refused.json().allowed, ['txt', 'pdf']);

      // A file that declines to say what it is cannot pass a rule about kinds.
      const nameless = await upload(cookie, folderId, 'noextension', 'plain');
      assert.equal(nameless.statusCode, 415, nameless.body);
    } finally {
      await revert('upload.allowed_extensions');
    }
  });

  test('an empty extension list means no restriction, as the label promises', async () => {
    const cookie = await cookieFor('worker');
    const anything = await upload(cookie, folderId, 'انظر.xyz', 'أي محتوى');
    assert.equal(anything.statusCode, 201, anything.body);
  });

  // ── Purge grace ────────────────────────────────────────────────────────

  test('the purge sweep collects by storage.purge_grace_days, not by boot config', async () => {
    const cookie = await cookieFor('worker');
    const { purgeDeletedDocuments } = await import('../src/modules/storage-maintenance/purge.js');

    const created = await upload(cookie, folderId, 'قديمة.txt', 'وثيقة ستحذف');
    assert.equal(created.statusCode, 201, created.body);
    const documentId = created.json().documentId;

    // Deleted five days ago, which the default 30-day grace protects.
    await sql`
      UPDATE dbo.documents
         SET is_deleted = 1, deleted_at = DATEADD(day, -5, SYSUTCDATETIME()), deleted_by = ${id.worker}
       WHERE document_id = ${documentId}
    `.execute(db);

    try {
      const protectedRun = await purgeDeletedDocuments({ dryRun: true });
      assert.equal(protectedRun.purged, 0, 'five days old must survive a 30-day grace');

      await apply('storage.purge_grace_days', 2);
      const collected = await purgeDeletedDocuments({ dryRun: true });
      assert.equal(collected.purged, 1, 'five days old must be eligible under a 2-day grace');
    } finally {
      await revert('storage.purge_grace_days');
    }
  });

  // ── Password rules ─────────────────────────────────────────────────────

  test('the predictability rule can be turned off, and stays on by default', async () => {
    const { checkPassword } = await import('../src/modules/auth/passwords.js');
    try {
      await apply('auth.min_password_length', 4);

      const onByDefault = await checkPassword('1234', { username: 'worker' });
      assert.equal(onByDefault.ok, false, 'predictable passwords are refused until someone decides otherwise');

      await apply('auth.password_block_predictable', false);
      const off = await checkPassword('1234', { username: 'worker' });
      assert.equal(off.ok, true, `with the rule off, 1234 passes a minimum of 4: ${off.problems}`);
    } finally {
      await revert('auth.password_block_predictable');
      await revert('auth.min_password_length');
    }
  });

  test('the username rule can be turned off too', async () => {
    const { checkPassword } = await import('../src/modules/auth/passwords.js');
    try {
      const on = await checkPassword('worker-styles-long-password', { username: 'worker' });
      assert.equal(on.ok, false, 'a password containing the username is refused by default');

      await apply('auth.password_block_username', false);
      const off = await checkPassword('worker-styles-long-password', { username: 'worker' });
      assert.equal(off.ok, true, `${off.problems}`);
    } finally {
      await revert('auth.password_block_username');
    }
  });

  test('each composition rule is off until asked for, and then enforced', async () => {
    const { checkPassword } = await import('../src/modules/auth/passwords.js');
    const base = { username: 'worker' };

    // Long enough and unpredictable enough that only composition can refuse it.
    const plain = 'correcthorsebatterystaple';

    try {
      const before = await checkPassword(plain, base);
      assert.equal(before.ok, true, `no composition rule applies by default: ${before.problems}`);

      const cases = [
        { key: 'auth.password_require_lowercase', failing: 'CORRECTHORSEBATTERYSTAPLE', passing: plain },
        { key: 'auth.password_require_uppercase', failing: plain, passing: 'Correcthorsebatterystaple' },
        { key: 'auth.password_require_digit', failing: plain, passing: 'correcthorsebattery7' },
        { key: 'auth.password_require_symbol', failing: plain, passing: 'correcthorse#battery' },
      ];

      for (const { key, failing, passing } of cases) {
        await apply(key, true);
        const refused = await checkPassword(failing, base);
        assert.equal(refused.ok, false, `${key} on: "${failing}" should be refused`);
        const admitted = await checkPassword(passing, base);
        assert.equal(admitted.ok, true, `${key} on: "${passing}" should pass: ${admitted.problems}`);
        await revert(key);
      }
    } finally {
      for (const { key } of [
        { key: 'auth.password_require_lowercase' },
        { key: 'auth.password_require_uppercase' },
        { key: 'auth.password_require_digit' },
        { key: 'auth.password_require_symbol' },
      ]) await revert(key);
    }
  });

  /**
   * The Arabic cases, decided rather than discovered.
   *
   * The digit and symbol rules are script-blind — ٣ is a digit and ؟ is a
   * symbol, because both come off keyboards this system actually faces. The
   * case rules are not blind and cannot be: Arabic has no case, so requiring
   * one forces Latin letters into the password. That trade-off is asserted here
   * so it stays a documented decision and not a surprise in a bug report.
   */
  test('composition rules meet Arabic input the way the help says they do', async () => {
    const { checkPassword } = await import('../src/modules/auth/passwords.js');
    const base = { username: 'worker' };

    try {
      await apply('auth.password_require_digit', true);
      const arabicDigit = await checkPassword('كلمة سر طويلة جداً ٣', base);
      assert.equal(arabicDigit.ok, true, `٣ satisfies the digit rule: ${arabicDigit.problems}`);
      await revert('auth.password_require_digit');

      await apply('auth.password_require_symbol', true);
      const arabicSymbol = await checkPassword('كلمة سر طويلة جداً؟', base);
      assert.equal(arabicSymbol.ok, true, `؟ satisfies the symbol rule: ${arabicSymbol.problems}`);

      const noSymbol = await checkPassword('كلمة سر طويلة جداً بلا رمز', base);
      assert.equal(noSymbol.ok, false, 'spaces are not symbols, in any script');
      await revert('auth.password_require_symbol');

      // The documented trap: a case rule cannot be satisfied from Arabic script.
      await apply('auth.password_require_uppercase', true);
      const arabicOnly = await checkPassword('كلمة سر عربية طويلة تماماً', base);
      assert.equal(arabicOnly.ok, false, 'requiring case forces Latin letters — the help says so');
    } finally {
      await revert('auth.password_require_digit');
      await revert('auth.password_require_symbol');
      await revert('auth.password_require_uppercase');
    }
  });

  test('invisible format characters do not satisfy the symbol rule', async () => {
    const { checkPassword } = await import('../src/modules/auth/passwords.js');
    try {
      await apply('auth.password_require_symbol', true);

      // ZWNJ and ZWJ steer Arabic ligatures and render as nothing at all. A
      // symbol nobody can see satisfies the administrator's rule while the
      // user typed no symbol — so neither counts.
      const zwnj = await checkPassword('كلمة سر طويلة' + String.fromCharCode(0x200c) + 'تماماً', { username: 'worker' });
      assert.equal(zwnj.ok, false, 'ZWNJ must not count as a symbol');

      const zwj = await checkPassword('كلمة سر طويلة' + String.fromCharCode(0x200d) + 'تماماً', { username: 'worker' });
      assert.equal(zwj.ok, false, 'ZWJ must not count as a symbol');
    } finally {
      await revert('auth.password_require_symbol');
    }
  });

  /**
   * The refusal reaches the screen as codes, not only as English sentences.
   *
   * The interface is Arabic and the server's sentences are not; the codes are
   * what the client translates from, so they are part of the API and each one
   * must ride alongside its sentence, index for index.
   */
  test('a weak password comes back with parallel codes over HTTP', async () => {
    const cookie = await cookieFor('worker');
    try {
      await apply('auth.password_require_digit', true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie },
        payload: { currentPassword: PASSWORD, newPassword: 'entirely-letters-here' },
      });

      assert.equal(response.statusCode, 400, response.body);
      const body = response.json();
      assert.equal(body.error, 'weak_password');
      assert.ok(Array.isArray(body.details), 'details must accompany problems');
      assert.equal(body.details.length, body.problems.length, 'one code per sentence');
      assert.ok(body.details.some((d) => d.code === 'needs_digit'), JSON.stringify(body.details));

      // The parametrised code carries its parameter.
      await apply('auth.min_password_length', 30);
      const short = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie },
        payload: { currentPassword: PASSWORD, newPassword: 'short-but-not-that-short-1' },
      });
      const tooShort = short.json().details?.find((d) => d.code === 'too_short');
      assert.equal(tooShort?.min, 30, 'the minimum travels with the refusal');
    } finally {
      await revert('auth.password_require_digit');
      await revert('auth.min_password_length');
    }
  });

  // ── Branding ───────────────────────────────────────────────────────────

  test('the organisation name is public and follows its setting', async () => {
    try {
      // No cookie on purpose: the sign-in screen reads this before anyone signs in.
      const before = await app.inject({ method: 'GET', url: '/api/settings/branding' });
      assert.equal(before.statusCode, 200);
      // Whatever the name currently is — settings survive the database reset by
      // design, so another suite's choice may still be standing. The contract
      // under test is that the endpoint is public and follows the setting, not
      // that nobody has ever changed it.
      assert.ok(before.json().organisationName?.length > 0);

      await apply('organisation.name', 'أرشيف بلدية الكرخ');
      const after = await app.inject({ method: 'GET', url: '/api/settings/branding' });
      assert.equal(after.json().organisationName, 'أرشيف بلدية الكرخ');

      // And nothing else leaked past the super-admin gate on the way.
      const list = await app.inject({ method: 'GET', url: '/api/settings' });
      assert.equal(list.statusCode, 401, 'the settings list itself still needs a session');
    } finally {
      await revert('organisation.name');
    }
  });

  /** The screen offers exactly what the server honours — no dead rows. */
  test('every setting the screen offers appears in a section', async () => {
    const { readFile } = await import('node:fs/promises');
    const adminSource = await readFile(new URL('../client/src/pages/Admin.jsx', import.meta.url), 'utf8');

    const missing = Object.keys(settings.EDITABLE)
      .filter((key) => key !== 'storage.root') // owned by its own guided card
      .filter((key) => !adminSource.includes(`'${key}'`));

    assert.deepEqual(missing, [], `settings with no place on the screen: ${missing.join(', ')}`);
  });
});
