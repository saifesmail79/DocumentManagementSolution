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

/**
 * Drains at the production attempt bound.
 *
 * `render()` pins maxAttempts to 1 so a failure surfaces at once, which is right
 * for the rendering tests and wrong for the recovery ones: a row stranded by a
 * dead worker already carries the attempt that worker used, so a bound of 1
 * refuses it over the attempt count and never exercises the claim rule at all.
 */
async function drainAtProductionBound() {
  for (let n = 0; n < 20; n += 1) {
    const result = await renditions.processOne({ maxAttempts: 3 });
    if (!result.claimed) break;
  }
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
   * The format the scanner actually produces, and the one no browser draws.
   *
   * A PNG or a PDF needs no preview because the browser opens it unaided; a TIFF
   * is only ever readable in the app through this rendition, so it is the case
   * that decides whether "preview without downloading" is true or marketing.
   */
  test('a TIFF scan gets a web-viewable preview', async () => {
    const documentId = await upload(cookie, 'arabic-scan.tiff', 'image/tiff');
    const rendition = await render(documentId, 'preview');

    assert.ok(rendition, `no preview produced — ${await queueError(documentId, 'preview')}`);
    assert.equal(rendition.mime_type, 'image/webp');

    const bytes = await readFile(storage.absolute(rendition.storage_path));
    assert.ok(isWebp(bytes), 'the preview must be a format a browser can draw');

    // Bigger than the 320px thumbnail — a preview that is only thumbnail-sized
    // is not a preview — and still a fraction of the source.
    const thumbnail = await render(documentId, 'thumbnail');
    assert.ok(
      Number(rendition.bytes) > Number(thumbnail.bytes) * 2,
      `preview ${rendition.bytes}B is not meaningfully larger than thumbnail ${thumbnail.bytes}B`,
    );
  });

  /**
   * A scan with more than one page becomes a PDF, and keeps all of them.
   *
   * The single-page case above passes whether or not page two survives, which is
   * exactly how a two-page decision came to be previewed as a one-page one for
   * as long as it did: sharp reads page one by default, the rendition was a
   * single image, and nothing anywhere counted pages. There was no error and no
   * badge — the document simply appeared to be shorter than it was, which is the
   * one kind of wrong an archive cannot tolerate.
   *
   * So the assertion is on the page count, not merely on the format: producing a
   * PDF with page one in it would satisfy the type and still lose the document.
   */
  test('a multi-page scan keeps every page, as a PDF', async () => {
    const documentId = await upload(cookie, 'arabic-scan-2page.tiff', 'image/tiff');
    const rendition = await render(documentId, 'preview');

    assert.ok(rendition, `no preview produced — ${await queueError(documentId, 'preview')}`);
    assert.equal(
      rendition.mime_type,
      'application/pdf',
      'more than one page cannot be carried by a single image',
    );

    const bytes = await readFile(storage.absolute(rendition.storage_path));
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 2, 'every page of the source belongs in the preview');
  });

  /** A file a browser opens itself does not get a second, worse copy made of it. */
  test('a PNG is its own preview, so none is rendered', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');
    assert.equal(await render(documentId, 'preview'), null);

    const queue = await sql`
      SELECT status FROM dbo.rendition_queue
       WHERE document_id = ${documentId} AND kind = 'preview'
    `.execute(db);
    assert.equal(Number(queue.rows[0].status), 5, 'should be SKIPPED, not failed');
  });

  /**
   * The route used to answer every missing rendition with 202 and re-queue it.
   *
   * For a type with no renderer that is a loop: the enqueue resets the SKIPPED
   * row to PENDING, the worker skips it again, and the caller is told "queued"
   * forever. One request an hour hid it; a preview pane that asks as the user
   * moves down a folder does not.
   */
  test('a type with no renderer is reported as unsupported, not queued again', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');
    await render(documentId, 'preview');

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/rendition/preview`,
      headers: { cookie },
    });

    assert.equal(response.statusCode, 415);
    assert.equal(response.json().error, 'rendition_unsupported');

    const queue = await sql`
      SELECT status FROM dbo.rendition_queue
       WHERE document_id = ${documentId} AND kind = 'preview'
    `.execute(db);
    assert.equal(Number(queue.rows[0].status), 5, 'asking must not resurrect a terminal job');
  });

  /**
   * A claim left behind by a worker that died.
   *
   * ─── The failure this guards ────────────────────────────────────────────
   *
   * `claim()` selected only PENDING and RETRYABLE, so a row stranded in RUNNING
   * — the process killed, the server restarted mid-conversion — was invisible
   * to every worker from then on. The document stayed listed and searchable and
   * simply never got a thumbnail, with nothing recorded anywhere. Three rows
   * were in that state on the live deployment, two of them from an ordinary
   * restart.
   *
   * The extraction queue had this recovery already; renditions did not.
   */
  test('a claim abandoned by a dead worker is taken back, not stranded', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');

    // Exactly what a killed worker leaves: claimed, never finished, and old
    // enough that no honest run could still be going.
    await sql`
      UPDATE dbo.rendition_queue
         SET status = 1, attempts = 1, started_at = DATEADD(hour, -2, SYSUTCDATETIME())
       WHERE document_id = ${documentId} AND kind = 'thumbnail'
    `.execute(db);

    await drainAtProductionBound();

    const row = await sql`
      SELECT status FROM dbo.rendition_queue
       WHERE document_id = ${documentId} AND kind = 'thumbnail'
    `.execute(db);

    assert.equal(Number(row.rows[0].status), 2, await queueError(documentId, 'thumbnail'));
  });

  /**
   * A row stranded before migration 0011 has no start time at all, and it is
   * precisely the set of rows the recovery exists to rescue — so a NULL must
   * read as abandoned rather than as "started just now".
   */
  test('a claim with no recorded start time is treated as abandoned', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');

    await sql`
      UPDATE dbo.rendition_queue
         SET status = 1, attempts = 1, started_at = NULL
       WHERE document_id = ${documentId} AND kind = 'thumbnail'
    `.execute(db);

    await drainAtProductionBound();

    const row = await sql`
      SELECT status FROM dbo.rendition_queue
       WHERE document_id = ${documentId} AND kind = 'thumbnail'
    `.execute(db);

    assert.equal(Number(row.rows[0].status), 2, await queueError(documentId, 'thumbnail'));
  });

  /**
   * The other half of the same rule: a job claimed moments ago is being worked
   * on, and stealing it would run two conversions of one file at once.
   */
  test('a claim made moments ago is left alone', async () => {
    const documentId = await upload(cookie, 'arabic-scan.png', 'image/png');

    await sql`
      UPDATE dbo.rendition_queue
         SET status = 1, attempts = 1, started_at = SYSUTCDATETIME()
       WHERE document_id = ${documentId} AND kind = 'thumbnail'
    `.execute(db);

    await drainAtProductionBound();

    const row = await sql`
      SELECT status FROM dbo.rendition_queue
       WHERE document_id = ${documentId} AND kind = 'thumbnail'
    `.execute(db);

    assert.equal(Number(row.rows[0].status), 1, 'a live claim must not be stolen');
  });

  /**
   * A constituent of a multi-file document, previewed on its own.
   *
   * ─── What this covers that nothing else did ─────────────────────────────
   *
   * Renditions were keyed (document_id, version_number, kind), and a multi-file
   * document deliberately has no version row — migration 0012 keeps
   * current_version at 0 so nothing joins to a wrong one. So there was neither a
   * source to render nor a key to file the result under, and every constituent
   * that a browser cannot open natively was undisplayable no matter what the
   * converter could do with it.
   *
   * Migration 0013 adds a nullable file_id to both tables. This asserts the part
   * that matters: two constituents of one document each get their own preview,
   * they do not overwrite one another, and the document-level slot stays free.
   *
   * CRLF is built from char codes rather than written as an escape, because the
   * multipart body is byte-exact and a stray literal newline here would produce
   * a malformed request that fails for the wrong reason.
   */
  test('each constituent of a multi-file document gets its own preview', async () => {
    const CRLF = String.fromCharCode(13, 10);
    const OFFICE_MIME =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const office = await readFile(path.join(FIXTURES, 'arabic-contract.docx'));
    const boundary = '----dmsmultirender0';

    const part = (filename) => Buffer.concat([
      Buffer.from(
        `--${boundary}${CRLF}`
          + `Content-Disposition: form-data; name="files"; filename="${filename}"${CRLF}`
          + `Content-Type: ${OFFICE_MIME}${CRLF}${CRLF}`,
        'utf8',
      ),
      office,
    ]);

    // Fields precede the files, which the server reads from the same stream —
    // anything after the file parts is not visible while they are consumed.
    const field = (name, value) => Buffer.from(
      `--${boundary}${CRLF}`
        + `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`
        + `${value}${CRLF}`,
      'utf8',
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/folders/${id.cabinet}/documents/batch`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        // `single` is what files the batch as ONE document with constituent
        // files; the default `separate` would make two ordinary documents and
        // exercise nothing this test is about.
        field('mode', 'single'),
        field('title', 'عقد من جزأين'),
        part('جزء-١.docx'),
        Buffer.from(CRLF, 'utf8'),
        part('جزء-٢.docx'),
        Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'),
      ]),
    });

    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(body.mode, 'single', `expected one multi-file document, got ${response.body}`);
    const documentId = body.documentId ?? body.created?.[0]?.documentId;
    assert.ok(documentId, `no documentId in ${response.body}`);

    const files = await sql`
      SELECT file_id, sort_order FROM dbo.document_files
       WHERE document_id = ${documentId} ORDER BY sort_order
    `.execute(db);
    assert.equal(files.rows.length, 2, 'the batch should have filed two constituents');

    const produced = [];
    for (const file of files.rows) {
      // Version 0 is the multi-file key, matching the worker and the route.
      await renditions.enqueueRendition(db, documentId, 0, 'preview', file.file_id);
      for (let n = 0; n < 20; n += 1) {
        const result = await renditions.processOne({ maxAttempts: 1 });
        if (!result.claimed) break;
      }

      const rendition = await renditions.getRendition({
        documentId,
        versionNumber: 0,
        kind: 'preview',
        fileId: file.file_id,
      });
      assert.ok(rendition, `no preview for file ${file.file_id}`);
      assert.equal(rendition.mimeType, 'application/pdf');

      const bytes = await readFile(storage.absolute(rendition.storagePath));
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      produced.push(rendition.storagePath);
    }

    // Why file_id belongs in the path as well as the key: without it the second
    // constituent silently overwrites the first and both rows point at one file.
    assert.notEqual(produced[0], produced[1], 'the two previews share a storage path');

    // A per-file rendition must not be mistaken for the document's own.
    const documentLevel = await renditions.getRendition({
      documentId,
      versionNumber: 0,
      kind: 'preview',
      fileId: null,
    });
    assert.equal(documentLevel, null, 'a per-file preview must not fill the document-level slot');
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
