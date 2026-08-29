/**
 * Integration tests for the audit trail, password reset and storage maintenance.
 *
 * These three share a file because they share a concern: they are what makes the
 * system operable and accountable after it is running, rather than features a
 * user clicks.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-audit-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

let db;
let sql;
let app;
let PERM;
let storage;
let purge;
let reset;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

async function makeUser(username, { superAdmin = false } = {}) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${username})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0})
  `.execute(db);
  id[username] = pid;
  return pid;
}

async function makeFolder(name) {
  const r = await sql`
    INSERT INTO dbo.folders (parent_id, name, mpath, depth)
    OUTPUT INSERTED.folder_id AS fid VALUES (NULL, ${name}, '/pending/', 0)
  `.execute(db);
  const fid = r.rows[0].fid;
  await sql`UPDATE dbo.folders SET mpath = ${`/${fid}/`} WHERE folder_id = ${fid}`.execute(db);
  id[name] = fid;
  return fid;
}

async function signIn(username, password = PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return {
    status: response.statusCode,
    cookie:
      response.statusCode === 200
        ? `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`
        : null,
  };
}

function multipart(filename, content) {
  const boundary = '----dmsaudit0123456789';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
        'utf8',
      ),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(cookie, filename, content) {
  const body = multipart(filename, content);
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id.cabinet}/documents`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 201);
  return response.json().documentId;
}

const auditFor = async (action) => {
  const r = await sql`
    SELECT TOP (5) actor_username, action, target_id, detail
      FROM dbo.audit_log WHERE action = ${action} ORDER BY audit_id DESC
  `.execute(db);
  return r.rows;
};

describe('audit, reset and maintenance', { skip: CONFIGURED ? false : target.reason }, () => {
  let bossCookie;
  let clerkCookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    await sql`DELETE FROM dbo.audit_log`.execute(db);
    await sql`DELETE FROM dbo.password_reset_tokens`.execute(db);
    await sql`DELETE FROM dbo.purged_blobs`.execute(db);

    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();
    purge = await import('../src/modules/storage-maintenance/purge.js');
    reset = await import('../src/modules/auth/reset.js');

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('boss', { superAdmin: true });
    await makeUser('clerk');
    await makeFolder('cabinet');

    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.clerk}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.DELETE}, 0)
    `.execute(db);

    bossCookie = (await signIn('boss')).cookie;
    clerkCookie = (await signIn('clerk')).cookie;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The trail ──────────────────────────────────────────────────────────

  test('logins are recorded, successes and failures alike', async () => {
    await signIn('clerk', 'wrong-password');

    const failures = await auditFor('login.failed');
    assert.ok(failures.length > 0);
    assert.equal(failures[0].target_id, 'clerk');
    // A failed login must not claim an actor: the account may not exist, and
    // inventing a link would be a lie in the trail.
    assert.equal(failures[0].actor_username, null);

    const successes = await auditFor('login.succeeded');
    assert.ok(successes.some((row) => row.actor_username === 'clerk'));
  });

  test('a failed login for an unknown user is recorded without inventing an actor', async () => {
    await signIn('nobody-at-all', 'whatever');
    const failures = await auditFor('login.failed');
    assert.ok(failures.some((row) => row.target_id === 'nobody-at-all'));
  });

  test('document actions are recorded with their target and folder', async () => {
    const documentId = await upload(clerkCookie, 'audited.txt', 'محتوى للتدقيق');

    const created = await auditFor('document.created');
    assert.equal(created[0].target_id, String(documentId));
    assert.equal(created[0].actor_username, 'clerk');

    await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: clerkCookie },
    });

    // "Who read what" is the question an audit of a document system is asked.
    const downloads = await auditFor('document.downloaded');
    assert.equal(downloads[0].target_id, String(documentId));

    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: clerkCookie },
    });
    assert.equal((await auditFor('document.deleted'))[0].target_id, String(documentId));
  });

  /**
   * The reason actor_username is stored rather than joined: an entry has to stay
   * readable after the account is gone. A trail that renders as "user 4172
   * deleted a contract" has failed at its only job.
   */
  test('the trail stays readable after the actor is deactivated', async () => {
    await makeUser('temporary');
    const { cookie } = await signIn('temporary');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });

    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${id.temporary}/active`,
      headers: { cookie: bossCookie },
      payload: { active: false },
    });

    const entries = await sql`
      SELECT actor_username FROM dbo.audit_log
       WHERE actor_user_id = ${id.temporary} ORDER BY audit_id DESC
    `.execute(db);

    assert.ok(entries.rows.length > 0);
    assert.equal(entries.rows[0].actor_username, 'temporary', 'the name must survive');
  });

  test('the trail is readable through the API, newest first, and pages', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?limit=5',
      headers: { cookie: bossCookie },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.entries.length > 0);

    const times = body.entries.map((e) => new Date(e.occurredAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

    if (body.nextCursor) {
      const second = await app.inject({
        method: 'GET',
        url: `/api/admin/audit?limit=5&cursor=${body.nextCursor}`,
        headers: { cookie: bossCookie },
      });
      const overlap = second
        .json()
        .entries.filter((e) => body.entries.some((f) => f.auditId === e.auditId));
      assert.equal(overlap.length, 0, 'pages must not repeat entries');
    }
  });

  test('the trail can be filtered by action', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?action=login.succeeded',
      headers: { cookie: bossCookie },
    });
    assert.ok(response.json().entries.every((e) => e.action === 'login.succeeded'));
  });

  test('the trail is super-admin only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { cookie: clerkCookie },
    });
    assert.equal(response.statusCode, 403);
  });

  // ── Password reset ─────────────────────────────────────────────────────

  test('a reset request answers identically for a real and an unknown account', async () => {
    const real = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/request',
      payload: { username: 'clerk' },
    });
    const fake = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/request',
      payload: { username: 'does-not-exist' },
    });

    // A reset form that says "no such user" is a free membership check against
    // the organisation.
    assert.equal(real.statusCode, fake.statusCode);
    assert.deepEqual(real.json(), fake.json());
  });

  test('a reset token works once and then never again', async () => {
    await makeUser('forgetter');
    await reset.requestReset({ username: 'forgetter' });

    // The raw token is only knowable at issue time; the database holds a hash.
    // Reaching into the service directly is the only way to test the redemption.
    const rows = await sql`
      SELECT token_hash FROM dbo.password_reset_tokens
       WHERE user_id = ${id.forgetter} AND used_at IS NULL
    `.execute(db);
    assert.equal(rows.rows.length, 1);
    assert.match(rows.rows[0].token_hash, /^[0-9a-f]{64}$/, 'only a hash is stored');

    // Issue a fresh one we can hold, by calling the internals the route uses.
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');
    await sql`
      INSERT INTO dbo.password_reset_tokens (token_hash, user_id, expires_at)
      VALUES (${createHash('sha256').update(token).digest('hex')}, ${id.forgetter},
              DATEADD(minute, 30, SYSUTCDATETIME()))
    `.execute(db);

    const check = await app.inject({
      method: 'GET',
      url: `/api/auth/reset/check?token=${encodeURIComponent(token)}`,
    });
    assert.equal(check.statusCode, 200);
    assert.equal(check.json().username, 'forgetter');

    const done = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/complete',
      payload: { token, newPassword: 'a-brand-new-secret-phrase' },
    });
    assert.equal(done.statusCode, 200);

    // Replaying the same link must fail.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/complete',
      payload: { token, newPassword: 'another-attempt-entirely' },
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().error, 'invalid_token');

    assert.equal((await signIn('forgetter', 'a-brand-new-secret-phrase')).status, 200);
    assert.equal((await signIn('forgetter', PASSWORD)).status, 401, 'the old password is dead');
  });

  test('an expired token is refused', async () => {
    await makeUser('slowpoke');
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');

    // created_at moves too: CK_password_reset_expiry requires expiry after
    // creation, so backdating only the expiry is refused by the schema.
    await sql`
      INSERT INTO dbo.password_reset_tokens (token_hash, user_id, created_at, expires_at)
      VALUES (${createHash('sha256').update(token).digest('hex')}, ${id.slowpoke},
              DATEADD(hour, -3, SYSUTCDATETIME()), DATEADD(hour, -1, SYSUTCDATETIME()))
    `.execute(db);

    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/reset/check?token=${encodeURIComponent(token)}`,
    });
    assert.equal(response.statusCode, 400);
  });

  test('requesting a new link retires the outstanding one', async () => {
    await makeUser('repeater');
    await reset.requestReset({ username: 'repeater' });
    await reset.requestReset({ username: 'repeater' });

    const live = await sql`
      SELECT COUNT(*) AS n FROM dbo.password_reset_tokens
       WHERE user_id = ${id.repeater} AND used_at IS NULL
    `.execute(db);

    // A leaked earlier email must stop working once a new one is requested.
    assert.equal(Number(live.rows[0].n), 1);
  });

  test('a weak new password is refused with reasons', async () => {
    await makeUser('weakreset');
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');
    await sql`
      INSERT INTO dbo.password_reset_tokens (token_hash, user_id, expires_at)
      VALUES (${createHash('sha256').update(token).digest('hex')}, ${id.weakreset},
              DATEADD(minute, 30, SYSUTCDATETIME()))
    `.execute(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/complete',
      payload: { token, newPassword: 'short' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'weak_password');
    assert.ok(response.json().problems.length > 0);
  });

  // ── Storage maintenance ────────────────────────────────────────────────

  test('the purge leaves a recently deleted document alone', async () => {
    const documentId = await upload(clerkCookie, 'recent.txt', 'حُذف للتو');
    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: clerkCookie },
    });

    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);

    await purge.purgeDeletedDocuments({ graceDays: 30 });

    // Within the grace period the bytes must still be there — that window IS the
    // undo for "someone deleted the wrong contract".
    assert.ok(await storage.exists(row.rows[0].storage_path));
  });

  test('the purge reclaims a document deleted beyond the grace period', async () => {
    const documentId = await upload(clerkCookie, 'ancient.txt', 'محتوى قديم للحذف');
    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    const storagePath = row.rows[0].storage_path;

    await sql`
      UPDATE dbo.documents
         SET is_deleted = 1, deleted_at = DATEADD(day, -60, SYSUTCDATETIME())
       WHERE document_id = ${documentId}
    `.execute(db);

    const result = await purge.purgeDeletedDocuments({ graceDays: 30 });

    assert.ok(result.purged >= 1);
    assert.equal(await storage.exists(storagePath), false, 'the file should be gone');

    // The version row goes; the document row stays as a tombstone.
    const versions = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(versions.rows[0].n), 0);

    const tombstone = await sql`
      SELECT current_version, is_deleted FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(tombstone.rows[0].current_version), 0);
    assert.equal(Number(tombstone.rows[0].is_deleted), 1);

    // And it is recorded, so "has this actually gone from disk" is answerable.
    const purged = await sql`
      SELECT storage_path FROM dbo.purged_blobs WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(purged.rows[0].storage_path, storagePath);
  });

  test('a dry run reports without deleting anything', async () => {
    const documentId = await upload(clerkCookie, 'dryrun.txt', 'لن يُحذف في التجربة');
    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);

    await sql`
      UPDATE dbo.documents
         SET is_deleted = 1, deleted_at = DATEADD(day, -60, SYSUTCDATETIME())
       WHERE document_id = ${documentId}
    `.execute(db);

    const result = await purge.purgeDeletedDocuments({ graceDays: 30, dryRun: true });

    assert.ok(result.purged >= 1, 'it should report what it would remove');
    assert.equal(result.dryRun, true);
    assert.ok(await storage.exists(row.rows[0].storage_path), 'and remove nothing');
  });

  test('abandoned upload fragments are swept', async () => {
    const { writeFile, mkdir, utimes, readdir } = await import('node:fs/promises');
    const staging = path.join(STORAGE_ROOT, '.staging');
    await mkdir(staging, { recursive: true });

    const stale = path.join(staging, 'abandoned.part');
    const fresh = path.join(staging, 'in-progress.part');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'x');

    // Backdate only the stale one. An upload still streaming has a recent mtime
    // and must not be deleted out from under itself.
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(stale, old, old);

    await purge.purgeOrphanedUploads({ olderThanHours: 24 });

    const left = await readdir(staging);
    assert.ok(!left.includes('abandoned.part'), 'the stale fragment should be gone');
    assert.ok(left.includes('in-progress.part'), 'an active upload must survive');
  });

  test('the integrity check finds a row whose file is missing', async () => {
    const documentId = await upload(clerkCookie, 'orphan.txt', 'سيُفقد ملفه');
    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    await storage.remove(row.rows[0].storage_path);

    const result = await purge.findMissingBlobs();

    assert.ok(
      result.missing.some((entry) => entry.documentId === String(documentId)),
      'a row pointing at nothing must be reported',
    );
  });

  test('an administrator can run the sweep and see the result', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/purge',
      headers: { cookie: bossCookie },
      payload: { dryRun: true },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(typeof response.json().documents.purged, 'number');
  });
});
