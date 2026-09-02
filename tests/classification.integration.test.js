/**
 * The recognition pilot, end to end, on real scans through the real engines.
 *
 * Six synthetic scans of two layouts — an official letter and an internal
 * memo, see fixtures/README.md — go in through the upload route as typed
 * documents, the worker fingerprints them, and the measurements come back
 * out through the administration route. What is asserted is what the pilot
 * would be judged on: the switch really gates everything, page one really
 * gets read, each fixture is recognised from the other five, and the header
 * fields agree with what was typed where the digits were legible.
 *
 * Skips when Tesseract with Arabic data or Ghostscript is absent. A skip is
 * not a pass — it means the claim went unverified on this machine.
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

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'classify');
const target = resolveTestDatabase();

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-classify-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

// Must precede any import of src/config, which reads process.env once and
// freezes. The pilot starts OFF in the environment, exactly as it ships; the
// tests switch it on through the settings route, which is what an operator does.
process.env.CLASSIFICATION_ENABLED = 'false';
process.env.RENDITIONS_ENABLED = 'false';
process.env.OCR_ENABLED = 'false';

const page = await import('../src/modules/classification/page.js');
const ocr = await import('../src/modules/extraction/ocr.js');
const tools = await page.classificationTools({ force: true });
const ocrState = await ocr.ocrStatus({ enabled: true });

const missing = [];
if (!tools.tesseract.available) missing.push('tesseract');
if (tools.tesseract.available && !ocrState.arabicAvailable) missing.push('Arabic language data');
if (!tools.ghostscript.available) missing.push('Ghostscript');

const toolsSkip = missing.length > 0 ? `recognition toolchain incomplete — missing ${missing.join(', ')}` : false;
const SKIP = target.configured ? toolsSkip : target.reason;

const PASSWORD = 'correct-horse-battery-staple';

let db;
let sql;
let app;
let PERM;
let storage;
let worker;

const id = {};
const docs = {};

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

async function signIn(username) {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  return `dms_session=${login.cookies.find((c) => c.name === 'dms_session').value}`;
}

/** A multipart body: text fields first (the server reads the stream in order), then the file. */
function multipart({ filename, content, contentType, fields = {} }) {
  const boundary = '----dmsclassify0123456789';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Uploads one fixture as a typed document with its header typed into the custom fields. */
async function upload(cookie, fixture, { typeId, subject, number } = {}) {
  const fieldValues = [];
  if (subject) fieldValues.push({ fieldId: id.subjectField, value: subject });
  if (number) fieldValues.push({ fieldId: id.numberField, value: number });

  const body = multipart({
    filename: fixture,
    content: await readFile(path.join(FIXTURES, fixture)),
    contentType: 'application/pdf',
    fields: {
      typeId: typeId ?? undefined,
      fields: fieldValues.length > 0 ? JSON.stringify(fieldValues) : undefined,
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id.cabinet}/documents`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 201, `upload of ${fixture} failed: ${response.body}`);
  return response.json().documentId;
}

async function queueRow(documentId) {
  const r = await sql`SELECT status, attempts, last_error FROM dbo.classification_queue WHERE document_id = ${documentId}`.execute(db);
  return r.rows[0] ?? null;
}

describe('document recognition pilot', { skip: SKIP }, () => {
  let clerk;
  let admin;
  let browser;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();
    worker = await import('../src/modules/classification/worker.js');

    // Settings survive the shared reset on purpose (see helpers/test-database.js),
    // so an override left by an earlier run — including this suite's own last
    // step — would make "off in the environment" read as "off in the database".
    await sql`DELETE FROM dbo.app_settings WHERE setting_key = 'classification.enabled'`.execute(db);
    const { resetSettingsCache } = await import('../src/modules/settings/service.js');
    resetSettingsCache();

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('clerk');
    await makeUser('browser');
    await makeUser('admin', { superAdmin: true });
    await makeFolder('cabinet');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.clerk}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD}, 0),
             (${id.cabinet}, ${id.browser}, ${PERM.BROWSE}, 0)
    `.execute(db);

    const letter = await sql`
      INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (N'كتاب رسمي')
    `.execute(db);
    id.letterType = Number(letter.rows[0].tid);
    const memo = await sql`
      INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (N'مذكرة داخلية')
    `.execute(db);
    id.memoType = Number(memo.rows[0].tid);

    // Global fields named the way an office names them, so the pilot's
    // name-based role matching finds them without configuration.
    const subjectField = await sql`
      INSERT INTO dbo.custom_field_defs (type_id, name, data_type)
      OUTPUT INSERTED.field_id AS fid VALUES (NULL, N'الموضوع', 'text')
    `.execute(db);
    id.subjectField = Number(subjectField.rows[0].fid);
    const numberField = await sql`
      INSERT INTO dbo.custom_field_defs (type_id, name, data_type)
      OUTPUT INSERTED.field_id AS fid VALUES (NULL, N'رقم الكتاب', 'text')
    `.execute(db);
    id.numberField = Number(numberField.rows[0].fid);

    clerk = await signIn('clerk');
    admin = await signIn('admin');
    browser = await signIn('browser');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The switch ─────────────────────────────────────────────────────────

  test('with the switch off, an upload queues nothing and every route says so', async () => {
    docs.letter1 = await upload(clerk, 'letter-1.pdf', {
      typeId: id.letterType,
      subject: 'طلب تزويد المديرية بمستلزمات مكتبية',
      number: '١٢٣٤/٥/٧',
    });

    assert.equal(await queueRow(docs.letter1), null, 'nothing is queued while the pilot is off');

    const detail = await app.inject({ method: 'GET', url: `/api/documents/${docs.letter1}/classification`, headers: { cookie: clerk } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().enabled, false);

    const run = await app.inject({ method: 'POST', url: `/api/documents/${docs.letter1}/classification/run`, headers: { cookie: clerk }, payload: {} });
    assert.equal(run.statusCode, 409);
    assert.equal(run.json().error, 'classification_disabled');

    const status = await app.inject({ method: 'GET', url: '/api/admin/classification/status', headers: { cookie: admin } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().enabled, false);
    assert.equal(status.json().source, 'environment');

    const rebuild = await app.inject({ method: 'POST', url: '/api/admin/classification/rebuild', headers: { cookie: admin }, payload: {} });
    assert.equal(rebuild.statusCode, 409);

    const metrics = await app.inject({ method: 'GET', url: '/api/admin/classification/metrics', headers: { cookie: admin } });
    assert.equal(metrics.statusCode, 409);
  });

  test('the administration routes refuse a non-administrator', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/admin/classification/status', headers: { cookie: clerk } });
    assert.equal(status.statusCode, 403);
  });

  test('switching it on from the settings queues new uploads, and rebuild catches up the rest', async () => {
    const enable = await app.inject({
      method: 'PUT',
      url: '/api/settings/classification.enabled',
      headers: { cookie: admin },
      payload: { value: true },
    });
    assert.equal(enable.statusCode, 200, enable.body);

    docs.letter2 = await upload(clerk, 'letter-2.pdf', {
      typeId: id.letterType,
      subject: 'ترشيح موظفين لدورة تدريبية',
      number: '٢٠٧١/٣/١٢',
    });
    const queued = await queueRow(docs.letter2);
    assert.ok(queued, 'an upload made while the pilot is on is queued');
    assert.equal(Number(queued.status), worker.QUEUE?.PENDING ?? 0);

    // The document uploaded while the pilot was off has no fingerprint; this
    // is the button that reaches it.
    const rebuild = await app.inject({ method: 'POST', url: '/api/admin/classification/rebuild', headers: { cookie: admin }, payload: {} });
    assert.equal(rebuild.statusCode, 200, rebuild.body);
    assert.equal(rebuild.json().queued, 1, 'exactly the document without a fingerprint');
    assert.ok(await queueRow(docs.letter1));

    const status = await app.inject({ method: 'GET', url: '/api/admin/classification/status', headers: { cookie: admin } });
    assert.equal(status.json().enabled, true);
    assert.equal(status.json().source, 'database');
    assert.equal(status.json().queue.pending, 2);
  });

  // ── The worker ─────────────────────────────────────────────────────────

  test('the worker reads page one of every scan and stores its fingerprint', async () => {
    docs.letter3 = await upload(clerk, 'letter-3.pdf', {
      typeId: id.letterType,
      subject: 'إعادة تأهيل قاعة الاجتماعات',
      number: '٣٣٤٨/٧/٢',
    });
    docs.memo1 = await upload(clerk, 'memo-1.pdf', { typeId: id.memoType, subject: 'عطل في الطابعة المركزية', number: '٥٥' });
    docs.memo2 = await upload(clerk, 'memo-2.pdf', { typeId: id.memoType, subject: 'طلب رفوف إضافية للمخزن', number: '٦٨' });
    docs.memo3 = await upload(clerk, 'memo-3.pdf', { typeId: id.memoType, subject: 'مستندات صرف ناقصة', number: '٩١' });

    const processed = await worker.drainQueue();
    assert.equal(processed, 6);

    const rows = await sql`
      SELECT document_id, word_count, char_count, ocr_psm, page_width, page_height
        FROM dbo.classification_pages
    `.execute(db);
    assert.equal(rows.rows.length, 6);
    for (const row of rows.rows) {
      assert.ok(Number(row.word_count) >= 10, `document ${row.document_id} read only ${row.word_count} words`);
      assert.ok(Number(row.page_width) > 1000 && Number(row.page_height) > 1000, 'page one was rasterised at a usable size');
    }

    const queue = await sql`SELECT status, last_error FROM dbo.classification_queue`.execute(db);
    assert.ok(queue.rows.every((row) => Number(row.status) === 2), JSON.stringify(queue.rows));
  });

  // ── The measurements ───────────────────────────────────────────────────

  test('every fixture is recognised from the other five', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/classification/metrics', headers: { cookie: admin } });
    assert.equal(response.statusCode, 200, response.body);
    const metrics = response.json();

    assert.equal(metrics.samples.typed, 6);
    assert.equal(metrics.accuracy, 1, JSON.stringify(metrics.mismatches));
    assert.equal(metrics.unknown, 0);

    const perType = Object.fromEntries(metrics.perType.map((row) => [row.name, row]));
    assert.equal(perType['كتاب رسمي'].support, 3);
    assert.equal(perType['كتاب رسمي'].recall, 1);
    assert.equal(perType['مذكرة داخلية'].precision, 1);

    // Two clearly different layouts with three samples each: the configured
    // rule decides all six without a person, and is right every time.
    const policy = metrics.curve.find((row) => row.policy);
    assert.equal(policy.automated, 6);
    assert.equal(policy.precision, 1);
  });

  test('the header fields are measured against what was typed', async () => {
    const metrics = (await app.inject({ method: 'GET', url: '/api/admin/classification/metrics', headers: { cookie: admin } })).json();

    const subject = metrics.fields.subject;
    assert.deepEqual(subject.fields, ['الموضوع'], 'the field was matched by its name');
    assert.ok(subject.extracted >= 5, `subject read on ${subject.extracted} of 6`);
    assert.ok(subject.match >= 4, `subject matched what was typed on ${subject.match}, close ${subject.close}, miss ${subject.miss}`);

    // The digits are where these synthetic scans are hardest: Tesseract reads
    // the Arabic-Indic numerals in the letters' header as Latin letters. The
    // memos' numerals are read. That gap is exactly what the pilot is for.
    const number = metrics.fields.number;
    assert.deepEqual(number.fields, ['رقم الكتاب']);
    assert.ok(number.match >= 2, `number matched on ${number.match} (${JSON.stringify(number.examples)})`);
  });

  test('a document shows its prediction, its neighbours and its header, next to the truth', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/documents/${docs.letter1}/classification`, headers: { cookie: clerk } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();

    assert.equal(result.enabled, true);
    assert.equal(result.status, 'done');
    assert.equal(result.stale, false);
    assert.equal(result.truth.typeId, id.letterType);

    assert.equal(result.prediction.typeId, id.letterType);
    assert.equal(result.prediction.typeName, 'كتاب رسمي');
    assert.equal(result.prediction.decision, 'auto');
    assert.ok(result.prediction.neighbours.length >= 2);
    assert.ok(result.prediction.neighbours.every((n) => n.documentId !== String(docs.letter1)), 'never its own neighbour');
    assert.equal(result.prediction.neighbours[0].typeName, 'كتاب رسمي');

    assert.equal(result.fields.subject.value, 'طلب تزويد المديرية بمستلزمات مكتبية');
    assert.equal(result.fields.subject.validated, true);
    assert.equal(result.fields.addressee.value, 'مديرية الشؤون المالية');
    assert.ok(result.fields.date, 'the date label was found, whatever was read beside it');
    assert.ok(result.ocr.words > 10);

    const memo = (await app.inject({ method: 'GET', url: `/api/documents/${docs.memo1}/classification`, headers: { cookie: clerk } })).json();
    assert.equal(memo.prediction.typeName, 'مذكرة داخلية');
    assert.equal(memo.fields.number.value, '55');
    assert.equal(memo.fields.addressee.value, 'قسم الصيانة');
  });

  test('browse-only cannot read the result: the header and the neighbours are content', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/documents/${docs.letter1}/classification`, headers: { cookie: browser } });
    assert.equal(response.statusCode, 404);
  });

  test('an untyped document is predicted but never trained on', async () => {
    docs.untyped = await upload(clerk, 'memo-2.pdf');
    await worker.drainQueue();

    const result = (await app.inject({ method: 'GET', url: `/api/documents/${docs.untyped}/classification`, headers: { cookie: clerk } })).json();
    assert.equal(result.truth.typeId, null);
    assert.equal(result.prediction.typeId, id.memoType);
    assert.equal(result.prediction.decision, 'auto');

    const status = (await app.inject({ method: 'GET', url: '/api/admin/classification/status', headers: { cookie: admin } })).json();
    assert.equal(status.samples.total, 7);
    assert.equal(status.samples.labelled, 6);
    assert.equal(status.samples.unlabelled, 1);

    const metrics = (await app.inject({ method: 'GET', url: '/api/admin/classification/metrics', headers: { cookie: admin } })).json();
    assert.equal(metrics.samples.typed, 6, 'the untyped document is not a training sample');
  });

  test('a new version makes the fingerprint stale and re-queues it', async () => {
    const body = multipart({
      filename: 'memo-3.pdf',
      content: await readFile(path.join(FIXTURES, 'memo-3.pdf')),
      contentType: 'application/pdf',
    });
    const version = await app.inject({
      method: 'POST',
      url: `/api/documents/${docs.letter1}/versions`,
      headers: { ...body.headers, cookie: clerk },
      payload: body.payload,
    });
    assert.equal(version.statusCode, 201, version.body);

    const before = (await app.inject({ method: 'GET', url: `/api/documents/${docs.letter1}/classification`, headers: { cookie: clerk } })).json();
    assert.equal(before.stale, true, 'the stored fingerprint is from version 1');
    assert.equal((await queueRow(docs.letter1)).status, 0);

    await worker.drainQueue();

    const after = (await app.inject({ method: 'GET', url: `/api/documents/${docs.letter1}/classification`, headers: { cookie: clerk } })).json();
    assert.equal(after.stale, false);
    // The page is now a memo, whatever the document's type says.
    assert.equal(after.prediction.typeId, id.memoType);
    assert.equal(after.fields.number.value, '91');
  });

  test('reverting the setting to the environment stops queueing and the routes go quiet, with the data kept', async () => {
    // The revert rather than a stored "false": it leaves the row exactly as a
    // fresh install has it, which is also what the next run of this suite expects.
    const disable = await app.inject({
      method: 'DELETE',
      url: '/api/settings/classification.enabled',
      headers: { cookie: admin },
    });
    assert.equal(disable.statusCode, 200, disable.body);

    const status = (await app.inject({ method: 'GET', url: '/api/admin/classification/status', headers: { cookie: admin } })).json();
    assert.equal(status.enabled, false);
    assert.equal(status.source, 'environment');

    const documentId = await upload(clerk, 'letter-3.pdf', { typeId: id.letterType });
    assert.equal(await queueRow(documentId), null);

    const detail = (await app.inject({ method: 'GET', url: `/api/documents/${docs.memo1}/classification`, headers: { cookie: clerk } })).json();
    assert.equal(detail.enabled, false);

    const kept = await sql`SELECT COUNT(*) AS n FROM dbo.classification_pages`.execute(db);
    assert.equal(Number(kept.rows[0].n), 7, 'switching off discards nothing');
  });
});
