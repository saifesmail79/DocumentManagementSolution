/**
 * Integration tests for text extraction.
 *
 * The valuable one is end to end: upload a file, run the worker, and confirm the
 * document becomes findable by its CONTENT — that exercises the queue, the
 * extractor, Arabic normalisation and the full-text index in one pass, which is
 * the whole chain content search depends on.
 *
 * The worker is driven directly rather than by starting its polling loop, so the
 * tests are deterministic instead of racing a timer.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';
import { normalizeArabic } from '../src/lib/arabic.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-extract-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let db;
let sql;
let app;
let PERM;
let storage;
let worker;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

/**
 * A structurally minimal PDF with one blank page and no text operators.
 *
 * This is what a scan looks like to an extractor: a page with no text layer.
 * Built by hand rather than with a PDF library so the test has no extra
 * dependency and the bytes are exactly what is intended.
 */
const BLANK_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj',
  'trailer<</Root 1 0 R/Size 4>>',
  '%%EOF',
].join('\n');

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

function multipart({ filename, content, contentType = 'text/plain' }) {
  const boundary = '----dmsextract0123456789';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      ),
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(cookie, filename, content, contentType) {
  const body = multipart({ filename, content, contentType });
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id.cabinet}/documents`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 201, `upload of ${filename} failed: ${response.body}`);
  return response.json().documentId;
}

/** The queue's own account of why a document failed, for a legible assertion. */
async function lastError(documentId) {
  const r = await sql`
    SELECT status, attempts, last_error FROM dbo.extraction_queue WHERE document_id = ${documentId}
  `.execute(db);
  return r.rows[0] ?? null;
}

async function statusOf(documentId) {
  const r = await sql`
    SELECT extraction_status, content_normalized FROM dbo.documents WHERE document_id = ${documentId}
  `.execute(db);
  return r.rows[0];
}

/** Polls until the full-text index catches up, rather than sleeping and hoping. */
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

describe('text extraction', { skip: CONFIGURED ? false : target.reason }, () => {
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

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('clerk');
    await makeFolder('cabinet');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.clerk}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD}, 0)
    `.execute(db);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'clerk', password: PASSWORD },
    });
    cookie = `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  test('uploading enqueues the document for extraction', async () => {
    const documentId = await upload(cookie, 'note.txt', 'محتوى تجريبي بسيط للاختبار');

    const queued = await sql`
      SELECT status, version_number FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);

    assert.equal(queued.rows.length, 1);
    assert.equal(Number(queued.rows[0].status), worker.QUEUE.PENDING);
    assert.equal(Number(queued.rows[0].version_number), 1);
  });

  // ── The chain that content search depends on ───────────────────────────

  test('an uploaded document becomes findable by its content', async () => {
    const documentId = await upload(
      cookie,
      'contract.txt',
      'هذا العقد يتضمن كلمة مُميّزة جداً وهي الاستئجار الطويل',
    );

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.EXTRACTED);
    assert.ok(row.content_normalized?.length > 0, 'text should have been stored');

    // Normalisation must have been applied on the way in: the source has
    // tashkeel (مُميّزة) which the collation does not strip, so an unnormalised
    // store would be unfindable by the plain spelling.
    assert.ok(!/[ً-ٟ]/.test(row.content_normalized), 'tashkeel should be stripped');

    assert.ok(await waitForFullText('الاستئجار'), 'full-text index did not catch up');

    const search = await app.inject({
      method: 'GET',
      url: '/api/search?q=الاستئجار',
      headers: { cookie },
    });

    assert.equal(search.statusCode, 200);
    assert.equal(search.json().contentSearched, true);
    assert.ok(
      search.json().results.some((r) => r.documentId === documentId),
      'the document should be findable by a word that appears only in its body',
    );
  });

  test('content is findable through an Arabic spelling variant', async () => {
    const documentId = await upload(cookie, 'library.txt', 'يوجد في المكتبة أرشيف قديم جداً');
    await worker.drainQueue();
    assert.ok(await waitForFullText('المكتبه'), 'the normalised form should be indexed');

    // The stored word is المكتبة; the user types المكتبه. Neither the collation
    // nor the word breaker closes that — only normalising both sides does.
    const search = await app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent('المكتبه')}`,
      headers: { cookie },
    });

    assert.ok(search.json().results.some((r) => r.documentId === documentId));
  });

  // ── Honest outcomes for things that cannot be indexed ───────────────────

  /**
   * The case that matters most for this deployment: a scan is a photograph of a
   * page, so it has no text layer and there is nothing to index. Reporting it as
   * "unsupported" rather than "failed" is what makes it a work list for OCR
   * instead of noise in an error log.
   */
  test('a PDF with no text layer is recorded as such, not as a failure', async () => {
    const documentId = await upload(cookie, 'scan.pdf', BLANK_PDF, 'application/pdf');

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.UNSUPPORTED);
    assert.equal(row.content_normalized, null, 'nothing should be indexed');

    const queued = await sql`
      SELECT status, last_error FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);

    assert.equal(Number(queued.rows[0].status), worker.QUEUE.SKIPPED);
    assert.match(queued.rows[0].last_error, /no_text_layer/);
  });

  test('an image is unsupported rather than retried', async () => {
    // A one-pixel PNG. Nothing to extract until OCR exists.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const documentId = await upload(cookie, 'page.png', png, 'image/png');

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.UNSUPPORTED);

    const queued = await sql`
      SELECT status, attempts FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(queued.rows[0].status), worker.QUEUE.SKIPPED);
    assert.equal(Number(queued.rows[0].attempts), 1, 'an unsupported type must not be retried');
  });

  // ── Failure handling ───────────────────────────────────────────────────

  /**
   * The concern raised when this design was chosen: a failing background job
   * would silently break search. It does not — the failure is bounded, recorded
   * with its reason, and visible.
   */
  test('a missing file fails, retries, then stops permanently with the reason kept', async () => {
    const documentId = await upload(cookie, 'vanishing.txt', 'نص سيختفي ملفه قبل الاستخراج');

    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    await storage.remove(row.rows[0].storage_path);

    // Each pass claims the job, fails, and marks it retryable until attempts run out.
    for (let pass = 0; pass < 4; pass += 1) await worker.processOne({ maxAttempts: 3 });

    const queued = await sql`
      SELECT status, attempts, last_error FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);

    assert.equal(Number(queued.rows[0].status), worker.QUEUE.FAILED);
    assert.equal(Number(queued.rows[0].attempts), 3, 'retries must be bounded');
    assert.ok(queued.rows[0].last_error, 'the reason must be kept for diagnosis');

    assert.equal(Number((await statusOf(documentId)).extraction_status), worker.DOC_EXTRACTION.FAILED);
  });

  test('one failing document does not stop the queue', async () => {
    const broken = await upload(cookie, 'broken.txt', 'سيُحذف هذا الملف');
    const fine = await upload(cookie, 'fine.txt', 'هذه وثيقة سليمة تحتوي كلمة الفريدة تماما');

    const row = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${broken}
    `.execute(db);
    await storage.remove(row.rows[0].storage_path);

    await worker.drainQueue();

    assert.equal(Number((await statusOf(fine)).extraction_status), worker.DOC_EXTRACTION.EXTRACTED);
  });

  // ── Queue mechanics ────────────────────────────────────────────────────

  test('a job is claimed once, so two workers cannot duplicate work', async () => {
    await upload(cookie, 'solo.txt', 'وثيقة واحدة فقط في الطابور');

    // Two claims in flight at once. READPAST makes the second skip the row the
    // first has locked rather than block on it.
    const [first, second] = await Promise.all([worker.processOne(), worker.processOne()]);

    const claims = [first, second].filter((r) => r.claimed && r.documentId).map((r) => r.documentId);
    assert.equal(new Set(claims).size, claims.length, 'the same job was claimed twice');
  });

  test('a new version re-queues the document', async () => {
    const documentId = await upload(cookie, 'v1.txt', 'النسخة الأولى من الوثيقة');
    await worker.drainQueue();

    const body = multipart({ filename: 'v2.txt', content: 'النسخة الثانية تحتوي كلمة الاستبدال' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { ...body.headers, cookie },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 201);

    const queued = await sql`
      SELECT version_number, status FROM dbo.extraction_queue
       WHERE document_id = ${documentId} ORDER BY version_number
    `.execute(db);

    assert.equal(queued.rows.length, 2, 'each version gets its own queue entry');
    assert.equal(Number(queued.rows[1].status), worker.QUEUE.PENDING);

    await worker.drainQueue();

    // The indexed content must now be the new version's, not the old one's.
    const row = await statusOf(documentId);
    assert.ok(row.content_normalized.includes('الاستبدال'));
  });

  test('queueStats reports what happened', async () => {
    const stats = await worker.queueStats();
    assert.ok(stats.done > 0, 'some jobs completed');
    assert.ok(stats.skipped > 0, 'some were skipped as unindexable');
    assert.equal(typeof stats.pending, 'number');
  });

  // ── Office documents ───────────────────────────────────────────────────
  //
  // These use real .docx and .xlsx files rather than synthesised bytes, because
  // the bug they exist to catch was in the library call itself and no amount of
  // fake input would have reached it. officeparser 6 renamed parseOfficeAsync to
  // parseOffice; calling the old name threw on every Word and Excel upload, the
  // job retried three times and gave up, and the documents were stored, listed,
  // and silently never searchable. There was no Office coverage at all.

  test('a Word document becomes searchable', async () => {
    const bytes = await readFile(path.join(FIXTURES, 'arabic-contract.docx'));
    const documentId = await upload(
      cookie,
      'contract.docx',
      bytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(
      Number(row.extraction_status),
      worker.DOC_EXTRACTION.EXTRACTED,
      `extraction did not succeed: ${JSON.stringify(await lastError(documentId))}`,
    );

    // The specific near-miss worth pinning: the parser returns a result object,
    // not a string. String(result) yields "[object Object]", which is long
    // enough to pass a "did we get text?" check and would have indexed that
    // literal for every Office document in the system.
    assert.ok(!row.content_normalized.includes('object Object'), 'the result object was stringified');
    assert.ok(row.content_normalized.includes('الاتصالات'), 'the document text was not indexed');
  });

  test('a spreadsheet becomes searchable', async () => {
    const bytes = await readFile(path.join(FIXTURES, 'arabic-sheet.xlsx'));
    const documentId = await upload(
      cookie,
      'sheet.xlsx',
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(
      Number(row.extraction_status),
      worker.DOC_EXTRACTION.EXTRACTED,
      `extraction did not succeed: ${JSON.stringify(await lastError(documentId))}`,
    );
    assert.ok(!row.content_normalized.includes('object Object'));
    assert.ok(
      row.content_normalized.includes('servermaintenancecontract')
        || row.content_normalized.includes('ServerMaintenanceContract'),
      'cell text was not indexed',
    );
  });

  /**
   * A worker killed mid-job leaves its row in RUNNING. Nothing moved it out
   * again, so the document stayed unsearchable for good — no error, no retry,
   * and nothing visible but a queue row nobody reads. It had already happened in
   * production here.
   */
  test('a job abandoned by a dead worker is reclaimed', async () => {
    const documentId = await upload(cookie, 'abandoned.txt', 'الوثيقة المهجورة تماماً', 'text/plain');

    // Exactly the state a killed process leaves behind: claimed, started long
    // ago, never finished.
    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.RUNNING},
             started_at = DATEADD(hour, -2, SYSUTCDATETIME()),
             finished_at = NULL
       WHERE document_id = ${documentId}
    `.execute(db);

    await worker.drainQueue();

    const row = await statusOf(documentId);
    assert.equal(
      Number(row.extraction_status),
      worker.DOC_EXTRACTION.EXTRACTED,
      'the abandoned job was never picked up again',
    );
    assert.ok(row.content_normalized.includes(normalizeArabic('المهجورة')));
  });

  /**
   * The remedy after fixing a server-side cause. Both real cases here were
   * exactly that: Office documents failed on a library rename, and scans were
   * skipped because OCRmyPDF was not yet configured. Neither document was at
   * fault, and neither would ever have been retried.
   */
  test('reindexing requeues what failed, and leaves indexed documents alone', async () => {
    const broken = await upload(cookie, 'was-broken.txt', 'محتوى كان يفشل سابقاً', 'text/plain');
    const fine = await upload(cookie, 'was-fine.txt', 'محتوى نجح من أول مرة', 'text/plain');

    await worker.drainQueue();

    // Exactly the two terminal states a server-side fault leaves behind.
    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.FAILED}, attempts = 3, last_error = 'parseOfficeAsync is not a function'
       WHERE document_id = ${broken}
    `.execute(db);

    const { requeued } = await worker.requeueUnsearchable();
    assert.ok(requeued >= 1, 'nothing was requeued');

    const after = await sql`
      SELECT document_id, status, attempts, last_error FROM dbo.extraction_queue
       WHERE document_id IN (${broken}, ${fine})
    `.execute(db);

    const brokenRow = after.rows.find((r) => String(r.document_id) === String(broken));
    assert.equal(Number(brokenRow.status), worker.QUEUE.PENDING);
    assert.equal(Number(brokenRow.attempts), 0, 'attempts must reset or it fails again immediately');
    assert.equal(brokenRow.last_error, null, 'the stale reason should not outlive the retry');

    // A document that extracted cleanly must not be dragged through OCR again.
    const fineRow = after.rows.find((r) => String(r.document_id) === String(fine));
    assert.equal(Number(fineRow.status), worker.QUEUE.DONE, 'an indexed document was requeued needlessly');

    await worker.drainQueue();
    const row = await statusOf(broken);
    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.EXTRACTED);
  });

  /**
   * Restarting the server during a reindex leaves a row claimed by a process
   * that no longer exists. That is the state most obviously in need of the
   * button, and it was the one state the button ignored — the operator saw
   * nothing happen and had no way to know they were waiting out a thirty-minute
   * timer.
   */
  test('reindexing also takes back a claim abandoned by a dead worker', async () => {
    const documentId = await upload(cookie, 'orphaned.txt', 'وثيقة يتيمة بلا عامل', 'text/plain');

    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.RUNNING},
             started_at = DATEADD(minute, -5, SYSUTCDATETIME()),
             finished_at = NULL
       WHERE document_id = ${documentId}
    `.execute(db);

    await worker.requeueUnsearchable();

    const row = await sql`
      SELECT status FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(row.rows[0].status), worker.QUEUE.PENDING, 'the abandoned claim was not released');

    await worker.drainQueue();
    assert.equal(
      Number((await statusOf(documentId)).extraction_status),
      worker.DOC_EXTRACTION.EXTRACTED,
    );
  });

  test('reindexing does not interrupt a job that just started', async () => {
    const documentId = await upload(cookie, 'just-started.txt', 'قيد التنفيذ فعلاً', 'text/plain');

    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.RUNNING}, started_at = SYSUTCDATETIME(), finished_at = NULL
       WHERE document_id = ${documentId}
    `.execute(db);

    await worker.requeueUnsearchable();

    const row = await sql`
      SELECT status FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(
      Number(row.rows[0].status),
      worker.QUEUE.RUNNING,
      'a live job was taken away from the worker running it',
    );
  });

  // ── Telling somebody ───────────────────────────────────────────────────
  //
  // Every fault in this system's history was recorded correctly and shown to
  // nobody. These assert the reporting, not the processing.

  test('the document API says whether its contents are searchable', async () => {
    const documentId = await upload(cookie, 'readable.txt', 'نص واضح وقابل للفهرسة تماماً', 'text/plain');
    await worker.drainQueue();

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
      headers: { cookie },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(
      body.extractionStatus,
      worker.DOC_EXTRACTION.EXTRACTED,
      'the client cannot tell a searchable document from an unsearchable one',
    );
    assert.equal(body.extractionError, null);
  });

  test('a document that failed carries the reason to the client', async () => {
    const documentId = await upload(cookie, 'doomed.txt', 'محتوى سيفشل استخراجه', 'text/plain');

    // The queue's own record of a permanent failure, as a dead worker or a
    // missing tool would leave it.
    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.FAILED}, attempts = 3, finished_at = SYSUTCDATETIME(),
             last_error = 'ocrmypdf_not_installed'
       WHERE document_id = ${documentId}
    `.execute(db);
    await sql`
      UPDATE dbo.documents SET extraction_status = ${worker.DOC_EXTRACTION.FAILED}
       WHERE document_id = ${documentId}
    `.execute(db);

    const body = (
      await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie } })
    ).json();

    assert.equal(body.extractionStatus, worker.DOC_EXTRACTION.FAILED);
    assert.equal(body.extractionError, 'ocrmypdf_not_installed', 'the reason never reached the user');
  });

  /**
   * A completed OCR job stores its engine in last_error ("ocr:ocrmypdf"). Read
   * carelessly that reads as a failure, and would be shown to a user as one.
   */
  test('a successful OCR note is never reported as an error', async () => {
    const documentId = await upload(cookie, 'scanned.txt', 'محتوى من التعرف الضوئي', 'text/plain');
    await worker.drainQueue();

    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.DONE}, last_error = 'ocr:ocrmypdf'
       WHERE document_id = ${documentId}
    `.execute(db);

    const body = (
      await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie } })
    ).json();

    assert.equal(body.extractionError, null, 'a success note was surfaced as a failure reason');
  });

  test('the unsearchable list names the documents and their reasons', async () => {
    const documentId = await upload(cookie, 'listed.txt', 'وثيقة ستظهر في قائمة الأعطال', 'text/plain');
    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.FAILED}, attempts = 3, finished_at = SYSUTCDATETIME(),
             last_error = 'parseOfficeAsync is not a function'
       WHERE document_id = ${documentId}
    `.execute(db);

    const failures = await worker.listUnsearchable();
    const mine = failures.find((f) => String(f.documentId) === String(documentId));

    assert.ok(mine, 'a permanently failed document was missing from the list');
    assert.equal(mine.reason, 'parseOfficeAsync is not a function');
    assert.ok(mine.title, 'a reason with no document title is not actionable');
  });

  test('worker health distinguishes idle from switched off', async () => {
    const { setSetting, clearSetting, resetSettingsCache } = await import(
      '../src/modules/settings/service.js'
    );

    const healthy = await worker.workerHealth();
    assert.equal(healthy.running, true);
    assert.equal(typeof healthy.stuckJobs, 'number');

    await setSetting({ key: 'extraction.enabled', value: 'false', actorId: id.scanner });
    resetSettingsCache();
    try {
      const paused = await worker.workerHealth();
      assert.equal(paused.running, false, 'a switched-off worker still reported as running');
      assert.equal(paused.enabledInEnvironment, true, 'the two switches must be distinguishable');
    } finally {
      await clearSetting({ key: 'extraction.enabled' });
      resetSettingsCache();
    }
  });

  test('a job still running is left alone', async () => {
    const documentId = await upload(cookie, 'in-progress.txt', 'قيد المعالجة الآن', 'text/plain');

    // Claimed a moment ago: another worker is presumably still on it, and
    // stealing it would mean two workers on one document.
    await sql`
      UPDATE dbo.extraction_queue
         SET status = ${worker.QUEUE.RUNNING}, started_at = SYSUTCDATETIME(), finished_at = NULL
       WHERE document_id = ${documentId}
    `.execute(db);

    await worker.drainQueue();

    const queued = await sql`
      SELECT status FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(
      Number(queued.rows[0].status),
      worker.QUEUE.RUNNING,
      'a fresh claim was stolen from the worker holding it',
    );
  });
});
