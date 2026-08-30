/**
 * Renditions against the real LibreOffice and Ghostscript.
 *
 * ─── What this covers that the Tier 2 suite does not ────────────────────────
 *
 * `tier2.integration.test.js` sets RENDITIONS_ENABLED=false so its queue does
 * not churn, which means the three renderers have never been executed by a
 * test. This runs all of them for real and checks the bytes that come back:
 *
 *   image  → sharp alone, no external tool
 *   PDF    → Ghostscript rasterises page 1, then sharp
 *   Office → LibreOffice converts to PDF, then the PDF path
 *
 * It skips when the tools are absent, so a checkout without them still passes.
 *
 * ─── The Windows detail worth stating ───────────────────────────────────────
 *
 * `soffice.exe` is a GUI-subsystem binary: it launches `soffice.bin` and
 * returns immediately, so a caller that waits on it sees success before the
 * output file exists. `soffice.com` is the console front end that actually
 * waits. A conversion that "fails" by producing no file, with exit code 0 and
 * no error text, is this and nothing else — which is why the Office assertions
 * below check for produced bytes rather than for a zero exit.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const target = resolveTestDatabase();

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-render-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

// Must precede any import of src/config, which reads process.env once and
// freezes. The tool paths themselves come from .env, so this exercises the
// deployment's real configuration.
process.env.RENDITIONS_ENABLED = 'true';
// OCR would otherwise run on the same uploads and add ten seconds a file for
// text this suite never looks at.
process.env.OCR_ENABLED = 'false';

const renditions = await import('../src/modules/renditions/service.js');
const tools = await renditions.detectTools({ force: true });

const missing = [];
if (!tools.libreoffice.available) missing.push('LibreOffice');
if (!tools.ghostscript.available) missing.push('Ghostscript');

const toolsSkip = missing.length > 0 ? `rendering toolchain incomplete — missing ${missing.join(', ')}` : false;
const SKIP = target.configured ? toolsSkip : target.reason;

const PASSWORD = 'correct-horse-battery-staple';

let db;
let sql;
let app;
let PERM;
let storage;

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

/** Uploads a real fixture file and returns its document id. */
async function upload(cookie, fixture, contentType) {
  const bytes = await readFile(path.join(FIXTURES, fixture));
  const boundary = '----dmsrender0123456789';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fixture}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id.cabinet}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  assert.equal(response.statusCode, 201, response.body);
  return response.json().documentId;
}

/**
 * Drains the queue and returns the rendition row for a document.
 *
 * Renditions are queued at upload, so draining is what actually runs the
 * renderer. maxAttempts 1 so a failure surfaces immediately rather than being
 * retried into a timeout.
 */
async function render(documentId, kind = 'thumbnail') {
  if (kind === 'preview') {
    await sql`
      INSERT INTO dbo.rendition_queue (document_id, version_number, kind)
      VALUES (${documentId}, 1, 'preview')
    `.execute(db);
  }

  for (let n = 0; n < 20; n += 1) {
    const result = await renditions.processOne({ maxAttempts: 1 });
    if (!result.claimed) break;
  }

  const row = await sql`
    SELECT storage_path, mime_type, bytes FROM dbo.document_renditions
     WHERE document_id = ${documentId} AND version_number = 1 AND kind = ${kind}
  `.execute(db);

  return row.rows[0] ?? null;
}

/** Why a queue entry did not produce a rendition, for a legible assertion message. */
async function queueError(documentId, kind) {
  const row = await sql`
    SELECT status, last_error FROM dbo.rendition_queue
     WHERE document_id = ${documentId} AND kind = ${kind}
  `.execute(db);
  const entry = row.rows[0];
  return entry ? `status=${entry.status} error=${entry.last_error ?? 'none'}` : 'no queue entry';
}

/** WebP inside a RIFF container: 'RIFF' at 0, 'WEBP' at 8. */
function isWebp(buffer) {
  return buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
}

describe('renditions (real LibreOffice and Ghostscript)', { skip: SKIP }, () => {
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

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('renderer');
    await makeFolder('cabinet');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.renderer}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD}, 0)
    `.execute(db);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'renderer', password: PASSWORD },
    });
    cookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  test('status reports which renderers are actually usable', async () => {
    const status = await renditions.renditionStatus();

    assert.equal(status.enabled, true);
    assert.equal(status.officePreview, true, 'LibreOffice should be reachable');
    assert.equal(status.pdfThumbnails, true, 'Ghostscript should be reachable');
    // sharp is bundled, so image thumbnails never depend on an install.
    assert.equal(status.imageThumbnails, true);
  });

  test('an image gets a thumbnail with no external tool', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');
    const rendition = await render(documentId);

    assert.ok(rendition, `no thumbnail produced — ${await queueError(documentId, 'thumbnail')}`);
    assert.equal(rendition.mime_type, 'image/webp');

    const bytes = await readFile(storage.absolute(rendition.storage_path));
    assert.ok(isWebp(bytes), 'the stored thumbnail should be a WebP');

    // The source is a 300 dpi page; a thumbnail that is not dramatically
    // smaller means the resize silently did nothing.
    const source = await readFile(path.join(FIXTURES, 'arabic-scan.png'));
    assert.ok(bytes.length < source.length / 4, `thumbnail is ${bytes.length}B against a ${source.length}B source`);
  });

  test('a PDF gets a thumbnail through Ghostscript', async () => {
    const documentId = await upload(cookie, 'arabic-scan.pdf', 'application/pdf');
    const rendition = await render(documentId);

    assert.ok(rendition, `no thumbnail produced — ${await queueError(documentId, 'thumbnail')}`);
    assert.equal(rendition.mime_type, 'image/webp');

    const bytes = await readFile(storage.absolute(rendition.storage_path));
    assert.ok(isWebp(bytes));
    assert.ok(bytes.length > 500, 'a blank rasterisation would be tiny');
  });

  test('an Office document gets a thumbnail through LibreOffice and Ghostscript', async () => {
    const documentId = await upload(
      cookie,
      'arabic-contract.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const rendition = await render(documentId);

    assert.ok(rendition, `no thumbnail produced — ${await queueError(documentId, 'thumbnail')}`);

    const bytes = await readFile(storage.absolute(rendition.storage_path));
    assert.ok(isWebp(bytes));
    assert.ok(bytes.length > 500, 'a blank page would rasterise to almost nothing');
  });

  test('an Office document gets a PDF preview the browser can display', async () => {
    const documentId = await upload(
      cookie,
      'arabic-contract.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const rendition = await render(documentId, 'preview');

    assert.ok(rendition, `no preview produced — ${await queueError(documentId, 'preview')}`);
    assert.equal(rendition.mime_type, 'application/pdf');

    const bytes = await readFile(storage.absolute(rendition.storage_path));
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the preview should be a real PDF');
  });

  /**
   * A thumbnail is a legible low-resolution copy of the document, not metadata,
   * so it is gated on READ rather than on BROWSE.
   */
  test('a rendition is served over HTTP and gated on READ', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');
    await render(documentId);

    const ok = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/rendition/thumbnail`,
      headers: { cookie },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/webp');
    assert.ok(isWebp(ok.rawPayload));

    // A user with BROWSE but not READ may see that the document exists and must
    // not receive a picture of its first page.
    await makeUser('peeker');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.peeker}, ${PERM.BROWSE}, 0)
    `.execute(db);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'peeker', password: PASSWORD },
    });
    const peekerCookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;

    const denied = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/rendition/thumbnail`,
      headers: { cookie: peekerCookie },
    });
    assert.equal(denied.statusCode, 404, 'browse-only must not receive a thumbnail');
  });
});
