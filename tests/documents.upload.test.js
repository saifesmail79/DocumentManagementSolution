/**
 * Integration tests for upload, versioning and content access.
 *
 * These use a throwaway STORAGE_ROOT under the OS temp directory, set before
 * src/config is imported — the config module reads process.env once and freezes
 * it, and the alternative is writing test files into the real document store.
 *
 * The properties under test are the ones that are expensive to get wrong: that a
 * committed row always has its file, that READ gates the bytes rather than the
 * listing flag, and that Arabic filenames survive the whole round trip.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

// Must precede any import of src/config.
const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-upload-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

let db;
let sql;
let app;
let PERM;
let storage;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

async function makeUser(username) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${username})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash)
    VALUES (${pid}, ${username}, ${hash})
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

async function grant(folderName, principalId, allow) {
  await sql`
    INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
    VALUES (${id[folderName]}, ${principalId}, ${allow}, 0)
  `.execute(db);
}

async function signIn(username) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

/** Builds a multipart body by hand so the exact bytes and filename are controlled. */
function multipart({ filename, content, fields = {} }) {
  const boundary = '----dmstest0123456789';
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
      'utf8',
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(cookie, folderId, { filename = 'contract.pdf', content = 'PDF-BYTES', fields } = {}) {
  const body = multipart({ filename, content, fields });
  return app.inject({
    method: 'POST',
    url: `/api/folders/${folderId}/documents`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
}

describe('document upload and content', { skip: CONFIGURED ? false : target.reason }, () => {
  let uploaderCookie;
  let viewerCookie;
  let browserCookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('uploader');
    await makeUser('viewer');
    await makeUser('peeker');
    await makeFolder('cabinet');
    await makeFolder('locked');

    await grant('cabinet', id.uploader, PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.DELETE);
    await grant('cabinet', id.viewer, PERM.BROWSE | PERM.READ);
    await grant('cabinet', id.peeker, PERM.BROWSE);

    uploaderCookie = await signIn('uploader');
    viewerCookie = await signIn('viewer');
    browserCookie = await signIn('peeker');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The invariant ──────────────────────────────────────────────────────

  test('a committed document row always has its file on disk', async () => {
    const response = await upload(uploaderCookie, id.cabinet, {
      filename: 'عقد الإيجار.pdf',
      content: 'ARABIC-CONTRACT-BYTES',
    });

    assert.equal(response.statusCode, 201);
    const { documentId, sha256, bytes } = response.json();
    assert.equal(bytes, Buffer.byteLength('ARABIC-CONTRACT-BYTES'));

    const row = await sql`
      SELECT storage_path, sha256, file_size_bytes FROM dbo.document_versions
       WHERE document_id = ${documentId} AND version_number = 1
    `.execute(db);

    const stored = row.rows[0];
    assert.equal(stored.sha256, sha256);

    // The row is committed, so the file must be there, at that exact path, with
    // that exact hash. This is the one guarantee the write ordering exists for.
    assert.ok(await storage.exists(stored.storage_path), 'file missing for a committed row');
    assert.ok(await storage.verify(stored.storage_path, stored.sha256), 'stored bytes do not match the hash');
  });

  test('the stored path keeps the Arabic title and the date partition', async () => {
    const response = await upload(uploaderCookie, id.cabinet, {
      filename: 'ملف.pdf',
      fields: { title: 'عقد إيجار مبنى الإدارة' },
    });
    assert.equal(response.statusCode, 201);

    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${response.json().documentId}
    `.execute(db);

    const storedPath = row.rows[0].storage_path;
    assert.match(storedPath, /^\d{4}\/\d{2}\//, 'Option C layout is year/month');
    assert.ok(storedPath.includes('عقد'), `Arabic lost from the path: ${storedPath}`);
    assert.ok(storedPath.endsWith('.pdf'));
  });

  test('a failed upload leaves nothing behind', async () => {
    // No UPLOAD on `locked`, and no grant at all, so this is refused outright.
    const refused = await upload(uploaderCookie, id.locked, { content: 'SHOULD-NOT-LAND' });
    assert.equal(refused.statusCode, 404);

    // Staging must be empty: a rejected upload that leaves a .part file behind
    // fills the disk one refusal at a time.
    const staging = await readdir(path.join(STORAGE_ROOT, '.staging')).catch(() => []);
    assert.equal(staging.length, 0, `staging not cleaned: ${staging.join(', ')}`);
  });

  // ── Permission gating ──────────────────────────────────────────────────

  test('uploading requires Upload, not merely Browse', async () => {
    const response = await upload(browserCookie, id.cabinet);
    assert.equal(response.statusCode, 403);
  });

  test('content requires Read — the listing flag is not the gate', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'SECRET-BYTES' });
    const { documentId } = created.json();

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: viewerCookie },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body, 'SECRET-BYTES');

    // Browse-only sees the document in listings but must not get the bytes, even
    // asking directly and ignoring canRead.
    const denied = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: browserCookie },
    });
    assert.equal(denied.statusCode, 404);
    assert.ok(!denied.body.includes('SECRET-BYTES'));
  });

  test('browse-only gets metadata but no version history', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'HISTORY-BYTES' });
    const { documentId } = created.json();

    const asBrowser = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
      headers: { cookie: browserCookie },
    });
    assert.equal(asBrowser.statusCode, 200);
    assert.equal(asBrowser.json().canRead, false);
    assert.deepEqual(asBrowser.json().versions, [], 'history reveals who touched the document and when');

    const asViewer = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
      headers: { cookie: viewerCookie },
    });
    assert.equal(asViewer.json().versions.length, 1);
  });

  // ── Versioning ─────────────────────────────────────────────────────────

  test('a new version never overwrites the previous file', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'VERSION-ONE' });
    const { documentId } = created.json();

    const body = multipart({ filename: 'v2.pdf', content: 'VERSION-TWO' });
    const second = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { ...body.headers, cookie: uploaderCookie },
      payload: body.payload,
    });

    assert.equal(second.statusCode, 201);
    assert.equal(second.json().version, 2);

    const rows = await sql`
      SELECT version_number, storage_path FROM dbo.document_versions
       WHERE document_id = ${documentId} ORDER BY version_number
    `.execute(db);

    assert.equal(rows.rows.length, 2);
    assert.notEqual(rows.rows[0].storage_path, rows.rows[1].storage_path, 'versions must not share a path');

    // Both files still exist — the old version stays readable.
    for (const row of rows.rows) {
      assert.ok(await storage.exists(row.storage_path), `version ${row.version_number} lost its file`);
    }

    // Default content is the newest; the old one is still addressable.
    const latest = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: viewerCookie },
    });
    assert.equal(latest.body, 'VERSION-TWO');

    const original = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content?version=1`,
      headers: { cookie: viewerCookie },
    });
    assert.equal(original.body, 'VERSION-ONE');
  });

  test('current_version tracks the newest version', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'ONE' });
    const { documentId } = created.json();

    const body = multipart({ filename: 'v2.pdf', content: 'TWO' });
    await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { ...body.headers, cookie: uploaderCookie },
      payload: body.payload,
    });

    const row = await sql`SELECT current_version FROM dbo.documents WHERE document_id = ${documentId}`.execute(db);
    assert.equal(Number(row.rows[0].current_version), 2);
  });

  // ── Content delivery ───────────────────────────────────────────────────

  test('range requests return exactly the requested slice', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'ABCDEFGHIJ' });
    const { documentId } = created.json();

    const partial = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: viewerCookie, range: 'bytes=2-5' },
    });

    assert.equal(partial.statusCode, 206);
    assert.equal(partial.body, 'CDEF');
    assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
    assert.equal(partial.headers['accept-ranges'], 'bytes');
  });

  test('an unsatisfiable range is refused with 416', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'SHORT' });
    const { documentId } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: viewerCookie, range: 'bytes=900-999' },
    });

    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], 'bytes */5');
  });

  test('an Arabic filename survives the Content-Disposition header', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { filename: 'تقرير سنوي.pdf' });
    const { documentId } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: viewerCookie },
    });

    const header = response.headers['content-disposition'];
    // RFC 5987: the ASCII fallback plus a percent-encoded UTF-8 filename*. A
    // header with only the fallback delivers the file as question marks.
    assert.match(header, /filename\*=UTF-8''/, `no RFC 5987 encoding: ${header}`);
    assert.ok(header.includes('%D8%AA'), 'the Arabic bytes should be percent-encoded');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });

  // ── Deletion ───────────────────────────────────────────────────────────

  test('deleting is soft and keeps the bytes for the grace period', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'DELETE-ME' });
    const { documentId } = created.json();

    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    const storedPath = row.rows[0].storage_path;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: uploaderCookie },
    });
    assert.equal(deleted.statusCode, 200);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: viewerCookie },
    });
    assert.equal(gone.statusCode, 404);

    // "Someone deleted the wrong contract" is a routine support call, so the
    // bytes must still be there until the purge grace period expires.
    assert.ok(await storage.exists(storedPath), 'a soft delete must not destroy content');
  });

  test('deleting requires the Delete verb', async () => {
    const created = await upload(uploaderCookie, id.cabinet, { content: 'KEEP-ME' });
    const { documentId } = created.json();

    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: viewerCookie },
    });
    assert.equal(refused.statusCode, 403, 'read does not imply delete');
  });

  test('an upload with no file part is a clean 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/folders/${id.cabinet}/documents`,
      headers: { cookie: uploaderCookie, 'content-type': 'multipart/form-data; boundary=x' },
      payload: Buffer.from('--x--\r\n'),
    });
    assert.equal(response.statusCode, 400);
  });

  // ── Duplicates, scoped to one folder ───────────────────────────────────
  //
  // The rule is deliberately narrow: a folder may not hold the same file twice,
  // and a subfolder is a different folder. Searching the whole archive was the
  // alternative and is wrong in an office — the same circular genuinely is filed
  // under several departments, and refusing that leaves the clerk no way out but
  // to alter the file until its bytes differ.

  describe('duplicate policy', () => {
    const SAME = 'IDENTICAL-BYTES-FOR-DUPLICATE-TESTS';

    async function setPolicy(value) {
      const { setSetting, resetSettingsCache } = await import('../src/modules/settings/service.js');
      await setSetting({ key: 'upload.duplicate_policy', value });
      resetSettingsCache();
    }

    async function makeSubfolder(name, parentName) {
      const parent = id[parentName];
      const r = await sql`
        INSERT INTO dbo.folders (parent_id, name, mpath, depth)
        OUTPUT INSERTED.folder_id AS fid
        VALUES (${parent}, ${name}, '/pending/', 1)
      `.execute(db);
      const fid = r.rows[0].fid;
      const parentPath = await sql`SELECT mpath FROM dbo.folders WHERE folder_id = ${parent}`.execute(db);
      await sql`
        UPDATE dbo.folders SET mpath = ${`${parentPath.rows[0].mpath}${fid}/`} WHERE folder_id = ${fid}
      `.execute(db);
      id[name] = fid;
      return fid;
    }

    after(async () => {
      const { clearSetting, resetSettingsCache } = await import('../src/modules/settings/service.js');
      await clearSetting({ key: 'upload.duplicate_policy' });
      resetSettingsCache();
    });

    test('block refuses a second identical file in the same folder', async () => {
      await setPolicy('block');

      const first = await upload(uploaderCookie, id.cabinet, { filename: 'a.pdf', content: SAME });
      assert.equal(first.statusCode, 201);

      const second = await upload(uploaderCookie, id.cabinet, { filename: 'b.pdf', content: SAME });
      assert.equal(second.statusCode, 409);
      assert.equal(second.json().error, 'duplicate');

      // The colliding document is named, because "where is the copy I already
      // have?" is always the next question.
      const collided = second.json().duplicates ?? [];
      assert.ok(collided.length > 0, 'the refusal named nothing to look at');
      assert.equal(String(collided[0].folderId), String(id.cabinet));
    });

    test('block leaves nothing behind when it refuses', async () => {
      await setPolicy('block');
      const before = await sql`SELECT COUNT(*) AS n FROM dbo.documents WHERE is_deleted = 0`.execute(db);

      await upload(uploaderCookie, id.cabinet, { filename: 'again.pdf', content: SAME });

      const after = await sql`SELECT COUNT(*) AS n FROM dbo.documents WHERE is_deleted = 0`.execute(db);
      assert.equal(
        Number(after.rows[0].n),
        Number(before.rows[0].n),
        'a refused upload created a row anyway',
      );
    });

    test('a subfolder may hold its own copy even under block', async () => {
      await setPolicy('block');
      await makeSubfolder('subcabinet', 'cabinet');
      await grant('subcabinet', id.uploader, PERM.BROWSE | PERM.READ | PERM.UPLOAD);

      const response = await upload(uploaderCookie, id.subcabinet, { filename: 'c.pdf', content: SAME });
      assert.equal(
        response.statusCode,
        201,
        'the rule is per folder — a subfolder is a different folder',
      );
    });

    test('warn stores the file and reports the collision', async () => {
      await setPolicy('warn');

      const response = await upload(uploaderCookie, id.cabinet, { filename: 'd.pdf', content: SAME });
      assert.equal(response.statusCode, 201, 'warn must not refuse');
      assert.ok(response.json().duplicateOf?.length, 'warn must still report the collision');
    });

    test('allow says nothing at all', async () => {
      await setPolicy('allow');

      const response = await upload(uploaderCookie, id.cabinet, { filename: 'e.pdf', content: SAME });
      assert.equal(response.statusCode, 201);
    });

    test('different content in the same folder is never a duplicate', async () => {
      await setPolicy('block');

      const response = await upload(uploaderCookie, id.cabinet, {
        filename: 'f.pdf',
        content: `${SAME}-but-different`,
      });
      assert.equal(response.statusCode, 201);
    });
  });
});
