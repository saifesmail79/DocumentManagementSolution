/**
 * Integration tests for the per-month storage manifests and the mail transport.
 *
 * The manifest exists to pay back the cost of the storage layout: files are
 * keyed on upload date, not on the filing tree, so the disk alone cannot say
 * which cabinet a document belonged in. These check that the manifest carries
 * exactly what a recovery would need.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-manifest-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

let db;
let sql;
let app;
let PERM;
let storage;
let manifest;

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
    INSERT INTO dbo.users (user_id, username, password_hash) VALUES (${pid}, ${username}, ${hash})
  `.execute(db);
  id[username] = pid;
  return pid;
}

async function makeFolder(name, parentName = null) {
  const parentId = parentName ? id[parentName] : null;
  const parentPath = parentName ? id[`${parentName}__path`] : '/';
  const r = await sql`
    INSERT INTO dbo.folders (parent_id, name, mpath, depth)
    OUTPUT INSERTED.folder_id AS fid
    VALUES (${parentId}, ${name}, '/pending/', ${parentName ? 1 : 0})
  `.execute(db);
  const fid = r.rows[0].fid;
  const mpath = `${parentPath}${fid}/`;
  await sql`UPDATE dbo.folders SET mpath = ${mpath} WHERE folder_id = ${fid}`.execute(db);
  id[name] = fid;
  id[`${name}__path`] = mpath;
  return fid;
}

async function upload(cookie, folderName, filename, content) {
  const boundary = '----dmsman0123456789';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/plain\r\n\r\n',
      'utf8',
    ),
    Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id[folderName]}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().documentId;
}

/** The yyyy/MM the storage layer is currently writing into. */
function currentPeriod() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

describe('storage manifests and mail', { skip: CONFIGURED ? false : target.reason }, () => {
  let cookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();
    manifest = await import('../src/modules/storage-maintenance/manifest.js');

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('archivist');
    await makeFolder('cabinet');
    await makeFolder('legal', 'cabinet');

    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.archivist},
              ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE}, 0)
    `.execute(db);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'archivist', password: PASSWORD },
    });
    cookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * The property the manifest exists for. The storage layout deliberately does
   * not mirror the filing tree, so this is the only thing on disk that records
   * where a document actually lived.
   */
  test('the manifest records the folder path the disk layout does not encode', async () => {
    const documentId = await upload(cookie, 'legal', 'contract.txt', 'محتوى العقد');
    const { year, month } = currentPeriod();

    await manifest.writeManifest(year, month);
    const written = await manifest.readManifest(year, month);

    assert.ok(written, 'a manifest should exist for this month');
    const entry = written.entries.find((e) => e.documentId === String(documentId));

    assert.ok(entry, 'the document should be listed');
    assert.equal(entry.folderPath, '/cabinet/legal', 'the full path, by name');
    assert.equal(entry.title, 'contract');
    assert.ok(entry.sha256, 'and the hash, so integrity is checkable without the database');
    assert.equal(entry.uploadedBy, 'archivist');
  });

  test('the manifest lands beside the files it describes', async () => {
    const { year, month } = currentPeriod();
    const directory = path.join(STORAGE_ROOT, String(year), String(month).padStart(2, '0'));
    const files = await readdir(directory);

    assert.ok(files.includes('manifest.json'));
    // No temp file left behind: it is written to .tmp and renamed, so a crash
    // never leaves a truncated manifest that looks complete.
    assert.ok(!files.some((name) => name.endsWith('.tmp')));
  });

  test('the manifest is plain, readable JSON', async () => {
    const { year, month } = currentPeriod();
    const raw = await readFile(
      path.join(STORAGE_ROOT, String(year), String(month).padStart(2, '0'), 'manifest.json'),
      'utf8',
    );

    // The reader is a person recovering from a bad day, possibly with Notepad.
    assert.ok(raw.includes('\n  '), 'pretty-printed');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.manifestVersion, 1);
    assert.ok(parsed.note.length > 0, 'it should explain what it is for');
    assert.ok(parsed.generatedAt);
  });

  test('metadata and type land in the manifest', async () => {
    const type = await sql`
      INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (N'عقد')
    `.execute(db);
    const field = await sql`
      INSERT INTO dbo.custom_field_defs (name, data_type)
      OUTPUT INSERTED.field_id AS fid VALUES (N'الرقم المرجعي', 'text')
    `.execute(db);

    const documentId = await upload(cookie, 'legal', 'meta.txt', 'محتوى');
    await app.inject({
      method: 'PATCH',
      url: `/api/documents/${documentId}/metadata`,
      headers: { cookie },
      payload: {
        typeId: Number(type.rows[0].tid),
        fields: [{ fieldId: Number(field.rows[0].fid), value: 'L-2026-118' }],
      },
    });

    const { year, month } = currentPeriod();
    await manifest.writeManifest(year, month);
    const written = await manifest.readManifest(year, month);
    const entry = written.entries.find((e) => e.documentId === String(documentId));

    assert.equal(entry.type, 'عقد');
    // Without this, recovery gives you a file with no idea what it was.
    assert.equal(entry.fields['الرقم المرجعي'], 'L-2026-118');
  });

  test('Arabic survives into the manifest intact', async () => {
    await makeFolder('الشؤون القانونية', 'cabinet');
    const documentId = await upload(cookie, 'الشؤون القانونية', 'عقد إيجار.txt', 'محتوى');

    const { year, month } = currentPeriod();
    await manifest.writeManifest(year, month);
    const written = await manifest.readManifest(year, month);
    const entry = written.entries.find((e) => e.documentId === String(documentId));

    assert.ok(entry.folderPath.includes('الشؤون القانونية'));
    assert.equal(entry.title, 'عقد إيجار');
  });

  test('every version is listed, not just the current one', async () => {
    const documentId = await upload(cookie, 'legal', 'versioned.txt', 'الإصدار الأول');

    const boundary = '----dmsman0123456789';
    await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v2.txt"\r\n` +
            'Content-Type: text/plain\r\n\r\n',
          'utf8',
        ),
        Buffer.from('الإصدار الثاني', 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]),
    });

    const { year, month } = currentPeriod();
    await manifest.writeManifest(year, month);
    const written = await manifest.readManifest(year, month);

    const entries = written.entries.filter((e) => e.documentId === String(documentId));
    assert.equal(entries.length, 2, 'both versions belong in the manifest');
    assert.deepEqual(
      entries.map((e) => e.version).sort(),
      [1, 2],
    );
  });

  test('a deleted document is listed and marked, not silently dropped', async () => {
    const documentId = await upload(cookie, 'legal', 'deleted.txt', 'سيُحذف');
    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie },
    });

    const { year, month } = currentPeriod();
    await manifest.writeManifest(year, month);
    const written = await manifest.readManifest(year, month);
    const entry = written.entries.find((e) => e.documentId === String(documentId));

    // The file is still on disk during the grace period, so the manifest that
    // describes the directory has to account for it.
    assert.ok(entry, 'a soft-deleted document still has a file on disk');
    assert.equal(entry.isDeleted, true);
  });

  test('regenerating covers every month that holds documents', async () => {
    const result = await manifest.writeAllManifests();
    assert.ok(result.manifests >= 1);
    assert.ok(result.entries >= 1);
  });

  test('an administrator can regenerate the manifests', async () => {
    await makeUser('boss');
    await sql`UPDATE dbo.users SET is_super_admin = 1 WHERE user_id = ${id.boss}`.execute(db);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'boss', password: PASSWORD },
    });
    const bossCookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/manifests',
      headers: { cookie: bossCookie },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.json().manifests >= 1);
  });

  // ── Mail ───────────────────────────────────────────────────────────────

  test('mail status reports that SMTP is not configured, rather than failing', async () => {
    const { verifyMail } = await import('../src/lib/mailer.js');
    const status = await verifyMail();

    // No MAIL_HOST in this environment. Saying so plainly is what lets an
    // administrator tell "not set up" from "set up and broken".
    assert.equal(status.configured, false);
    assert.match(status.reason, /MAIL_HOST/);
  });

  /**
   * The one place user-influenced text reaches a message envelope. A newline in
   * an address or subject is how header injection works.
   */
  test('a newline in an address or subject is refused', async () => {
    const { sendMail } = await import('../src/lib/mailer.js');

    await assert.rejects(
      () => sendMail({ to: 'victim@example.com\nBcc: attacker@evil.test', subject: 'x', text: 'y' }),
      /newline/,
    );

    await assert.rejects(
      () => sendMail({ to: 'someone@example.com', subject: 'x\r\nBcc: attacker@evil.test', text: 'y' }),
      /newline/,
    );
  });

  test('a malformed address is refused before any connection is attempted', async () => {
    const { sendMail } = await import('../src/lib/mailer.js');
    await assert.rejects(() => sendMail({ to: 'not-an-address', subject: 'x', text: 'y' }), /valid address/);
  });

  test('the reset flow still answers identically with no mail configured', async () => {
    // Delivery failing must not change the response, or the response reveals
    // whether the account exists.
    const real = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/request',
      payload: { username: 'archivist' },
    });
    const fake = await app.inject({
      method: 'POST',
      url: '/api/auth/reset/request',
      payload: { username: 'nobody-here' },
    });

    assert.equal(real.statusCode, 200);
    assert.deepEqual(real.json(), fake.json());
  });
});
