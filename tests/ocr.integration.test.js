/**
 * Integration tests for OCR.
 *
 * ─── How the engine is substituted, and what that does and does not prove ───
 *
 * Tesseract is not installed on this machine, so these point OCR_TESSERACT_PATH
 * at `node` and hand it a file whose bytes are a JavaScript program that prints
 * Arabic to stdout. Tesseract's contract is "read a file, write text to stdout,
 * exit 0", and node satisfies that contract exactly — so every part of the
 * pipeline is exercised for real: process spawning with an argument array,
 * stdout capture, the timeout, Arabic normalisation, the database write, the
 * status transition, and the document becoming findable by its content.
 *
 * What this does NOT prove is Tesseract's own recognition accuracy on Arabic
 * script. That needs Tesseract installed and a real scan, and no amount of test
 * scaffolding here substitutes for it.
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

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-ocr-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

// Must precede any import of src/config: it reads process.env once and freezes.
process.env.OCR_ENABLED = 'true';
process.env.OCR_TESSERACT_PATH = 'node';
process.env.OCR_OCRMYPDF_PATH = 'definitely-not-a-real-binary-xyz';
process.env.OCR_TIMEOUT_MS = '20000';

let db;
let sql;
let app;
let PERM;
let storage;
let worker;
let ocr;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

/** The text the stubbed engine "recognises". Carries tashkeel, so normalisation is observable. */
const RECOGNISED = 'هذا نصٌ مُستخرَج ضوئياً ويحتوي كلمة الاستقصاء المميزة';

/** A file that is an image by extension and a printing program by content. */
const STUB_SCAN = `console.log(${JSON.stringify(RECOGNISED)});`;

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

async function upload(cookie, filename, content, contentType = 'image/png') {
  const boundary = '----dmsocr0123456789';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
    Buffer.from(content, 'utf8'),
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

async function statusOf(documentId) {
  const r = await sql`
    SELECT extraction_status, content_normalized FROM dbo.documents WHERE document_id = ${documentId}
  `.execute(db);
  return r.rows[0];
}

async function waitForFullText(term, { attempts = 60, delayMs = 250 } = {}) {
  for (let n = 0; n < attempts; n += 1) {
    const found = await sql`
      SELECT COUNT(*) AS n FROM dbo.documents WHERE CONTAINS(content_normalized, ${`"${term}"`})
    `.execute(db);
    if (Number(found.rows[0].n) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

describe('OCR', { skip: CONFIGURED ? false : target.reason }, () => {
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
    worker = await import('../src/modules/extraction/worker.js');
    ocr = await import('../src/modules/extraction/ocr.js');

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('scanner');
    await makeFolder('cabinet');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.scanner}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD}, 0)
    `.execute(db);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'scanner', password: PASSWORD },
    });
    cookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── Detection and reporting ────────────────────────────────────────────

  test('detection reports what is present and what is not', async () => {
    const tools = await ocr.detectOcrTools({ force: true });

    assert.equal(tools.tesseract.available, true, 'the stubbed engine should be found');
    assert.ok(tools.tesseract.version, 'and report a version');

    // A binary that does not exist must read as absent, not throw.
    assert.equal(tools.ocrmypdf.available, false);
  });

  /**
   * The specific failure worth surfacing: engine present, Arabic data absent.
   * It produces empty results rather than an error, so it is invisible without
   * a status screen.
   */
  test('status reports whether Arabic data is actually installed', async () => {
    const status = await ocr.ocrStatus();

    assert.equal(status.enabled, true);
    assert.equal(status.configuredLanguages, 'ara+eng');
    assert.equal(typeof status.arabicAvailable, 'boolean');
    assert.ok(Array.isArray(status.installedLanguages));
  });

  test('an administrator can see the OCR situation', async () => {
    await makeUser('boss');
    await sql`UPDATE dbo.users SET is_super_admin = 1 WHERE user_id = ${id.boss}`.execute(db);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'boss', password: PASSWORD },
    });
    const bossCookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/extraction/stats',
      headers: { cookie: bossCookie },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.ocr.enabled, 'boolean');
    assert.equal(typeof body.documents.unindexed, 'number');
    assert.equal(typeof body.queue.pending, 'number');
  });

  // ── The pipeline ───────────────────────────────────────────────────────

  /**
   * The whole point of OCR here: a file with no text layer becomes searchable.
   * Everything in this path is real except the recognition itself.
   */
  test('a page with no text layer becomes searchable through OCR', async () => {
    const documentId = await upload(cookie, 'scan.png', STUB_SCAN);

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(
      Number(row.extraction_status),
      worker.DOC_EXTRACTION.OCR_EXTRACTED,
      'OCR text is flagged distinctly from an exact text layer',
    );
    assert.ok(row.content_normalized?.length > 0);

    // Normalisation ran on the OCR output too: the source carries tashkeel
    // (نصٌ مُستخرَج) which the collation does not strip.
    assert.ok(!/[ً-ٟ]/.test(row.content_normalized), 'tashkeel should be stripped');

    assert.ok(await waitForFullText('الاستقصاء'), 'the full-text index did not catch up');

    const search = await app.inject({
      method: 'GET',
      url: '/api/search?q=الاستقصاء',
      headers: { cookie },
    });

    assert.ok(
      search.json().results.some((r) => r.documentId === documentId),
      'the scan should be findable by a word only OCR could have produced',
    );
  });

  /**
   * OCR output is roughly 85-93% right on clean Arabic print. It is good enough
   * to find a document and not good enough to read as one, so it must never
   * leave the server as text.
   */
  test('recognised text is never returned by any API', async () => {
    const documentId = await upload(cookie, 'private-scan.png', STUB_SCAN);
    await worker.drainQueue();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
      headers: { cookie },
    });
    assert.ok(!detail.body.includes('الاستقصاء'), 'document detail must not carry OCR text');

    const results = await app.inject({
      method: 'GET',
      url: '/api/search?q=الاستقصاء',
      headers: { cookie },
    });
    assert.ok(!results.body.includes('مُستخرَج'), 'search results must not carry OCR text');
  });

  test('OCR does not touch the stored file', async () => {
    const documentId = await upload(cookie, 'untouched.png', STUB_SCAN);
    const row = await sql`
      SELECT storage_path, sha256 FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);

    await worker.drainQueue();

    // The document's SHA-256 is recorded and verified on read, so an OCR step
    // that rewrote the file would break every later integrity check.
    assert.ok(
      await storage.verify(row.rows[0].storage_path, row.rows[0].sha256),
      'the stored bytes must be exactly what was uploaded',
    );
  });

  test('a document with a real text layer never reaches OCR', async () => {
    const documentId = await upload(cookie, 'digital.txt', 'نص أصلي كامل لا يحتاج إلى معالجة ضوئية', 'text/plain');

    await worker.drainQueue();

    const row = await statusOf(documentId);
    // Plain extraction, not OCR: spending minutes recognising a page whose text
    // is already exact would be pure waste.
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.EXTRACTED);
  });

  test('a PDF cannot be OCR\'d without OCRmyPDF, and says so', async () => {
    const BLANK_PDF = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj',
      'trailer<</Root 1 0 R/Size 4>>',
      '%%EOF',
    ].join('\n');

    const documentId = await upload(cookie, 'scanned.pdf', BLANK_PDF, 'application/pdf');
    await worker.drainQueue();

    const queued = await sql`
      SELECT status, last_error FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);

    assert.equal(Number(queued.rows[0].status), worker.QUEUE.SKIPPED);
    // Tesseract cannot read a PDF; rasterising is OCRmyPDF's job. Naming the
    // missing tool is what makes this fixable.
    assert.match(queued.rows[0].last_error, /ocrmypdf_not_installed/);
  });

  test('OCR that finds nothing is recorded as such, not as success', async () => {
    // A program that prints almost nothing: below the minimum, so it counts as
    // having found no text rather than indexing two stray characters.
    const documentId = await upload(cookie, 'blank.png', 'console.log("x");');

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.UNSUPPORTED);
    assert.equal(row.content_normalized, null);

    const queued = await sql`
      SELECT last_error FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);
    assert.match(queued.rows[0].last_error, /ocr_found_no_text/);
  });

  test('an engine that fails is a bounded failure, not a stuck queue', async () => {
    // A program that exits non-zero, which is how a broken engine behaves.
    const documentId = await upload(cookie, 'broken.png', 'process.exit(3);');

    await worker.drainQueue();

    const queued = await sql`
      SELECT status, attempts FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);

    // Either skipped with a reason or retried and stopped — never left claimable
    // forever, which would burn a worker slot on every poll.
    assert.ok(
      [worker.QUEUE.SKIPPED, worker.QUEUE.FAILED, worker.QUEUE.RETRYABLE].includes(
        Number(queued.rows[0].status),
      ),
    );
    assert.ok(Number(queued.rows[0].attempts) >= 1);
  });

  test('a filename with shell metacharacters is passed safely', async () => {
    // spawn() with an argument array and no shell: this filename must reach the
    // engine as a filename, never as command syntax.
    const documentId = await upload(cookie, 'a & b; echo pwned.png', STUB_SCAN);

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.OCR_EXTRACTED);
    assert.ok(!row.content_normalized.includes('pwned'), 'nothing was executed as a command');
  });

  // ── Gating ─────────────────────────────────────────────────────────────

  test('attemptOcr refuses a type it cannot help with', async () => {
    const result = await ocr.attemptOcr('/tmp/whatever.docx', {
      filename: 'whatever.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_ocrable');
  });
});
