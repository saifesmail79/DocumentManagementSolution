/**
 * Integration tests for filing a batch of documents.
 *
 * Two outcomes are under test, because the user is asked which one they want:
 * N files as N documents, and N files as one document with N constituent files.
 *
 * The properties that matter here are the ones that are expensive to get wrong:
 * that "one entry" really is atomic (a failure part-way through commits
 * nothing), that reading order survives the round trip, that a multi-file
 * document refuses the endpoints that can only serve one blob rather than
 * quietly serving the wrong one, and that Arabic filenames survive all of it.
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

// Must precede any import of src/config.
const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-multifile-test-'));
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

/**
 * Builds a multipart body carrying several files.
 *
 * Written by hand rather than with FormData so the part ORDER is controlled:
 * fields must precede files or the handler cannot read them, and that ordering
 * requirement is itself part of what these tests cover.
 */
function multipartBatch({ files, fields = {} }) {
  const boundary = '----dmsbatch0123456789';
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.mimeType ?? 'application/pdf'}\r\n\r\n`,
        'utf8',
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function uploadBatch(cookie, folderId, { files, fields = {} }) {
  const body = multipartBatch({ files, fields });
  return app.inject({
    method: 'POST',
    url: `/api/folders/${folderId}/documents/batch`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
}

const THREE_PAGES = [
  { filename: 'صفحة-١.pdf', content: 'PAGE-ONE-BYTES' },
  { filename: 'صفحة-٢.pdf', content: 'PAGE-TWO-BYTES' },
  { filename: 'صفحة-٣.pdf', content: 'PAGE-THREE-BYTES' },
];

describe('filing a batch of documents', { skip: CONFIGURED ? false : target.reason }, () => {
  let uploaderCookie;
  let peekerCookie;

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

    await makeUser('filer');
    await makeUser('peeker');
    await makeFolder('cabinet');

    await grant('cabinet', id.filer, PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.DELETE);
    await grant('cabinet', id.peeker, PERM.BROWSE);

    uploaderCookie = await signIn('filer');
    peekerCookie = await signIn('peeker');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── One entry ──────────────────────────────────────────────────────────

  test('three files filed as one entry become one document with three files', async () => {
    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'عقد الإيجار' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.mode, 'single');
    assert.equal(body.created.length, 1);

    const [document] = body.created;
    assert.equal(document.multiFile, true);
    assert.equal(document.fileCount, 3);

    const rows = await sql`
      SELECT sort_order, original_filename, file_size_bytes, storage_path
        FROM dbo.document_files WHERE document_id = ${document.documentId}
       ORDER BY sort_order
    `.execute(db);

    assert.equal(rows.rows.length, 3);
    // Reading order is the upload order, and it is what sort_order records.
    assert.deepEqual(
      rows.rows.map((r) => r.original_filename),
      THREE_PAGES.map((f) => f.filename),
    );
    assert.deepEqual(
      rows.rows.map((r) => Number(r.sort_order)),
      [0, 1, 2],
    );

    // The invariant the whole write ordering exists to protect.
    for (const row of rows.rows) {
      assert.equal(await storage.exists(row.storage_path), true, `missing blob ${row.storage_path}`);
    }

    // Versions and constituent files are disjoint axes: a multi-file document
    // has no version row, and says so with current_version = 0.
    const document_row = await sql`
      SELECT current_version FROM dbo.documents WHERE document_id = ${document.documentId}
    `.execute(db);
    assert.equal(Number(document_row.rows[0].current_version), 0);

    const versions = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_versions WHERE document_id = ${document.documentId}
    `.execute(db);
    assert.equal(Number(versions.rows[0].n), 0);
  });

  test('one file filed as "one entry" is an ordinary single-file document', async () => {
    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [{ filename: 'خطاب.pdf', content: 'SINGLE-LETTER' }],
      fields: { mode: 'single', title: 'خطاب رسمي' },
    });

    assert.equal(response.statusCode, 201);
    const [document] = response.json().created;

    // One file IS one entry already. Recording it as a multi-file document
    // would cost it versioning and preview for no benefit.
    assert.equal(document.multiFile, false);
    assert.equal(document.version, 1);

    const files = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_files WHERE document_id = ${document.documentId}
    `.execute(db);
    assert.equal(Number(files.rows[0].n), 0);

    const versions = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_versions WHERE document_id = ${document.documentId}
    `.execute(db);
    assert.equal(Number(versions.rows[0].n), 1);
  });

  test('a failure part-way through a batch commits nothing', async () => {
    const before = await sql`SELECT COUNT(*) AS n FROM dbo.documents`.execute(db);

    // An empty file is refused by the storage layer. It sits between two good
    // files, so a non-atomic implementation would leave a document holding the
    // first page only.
    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [
        { filename: 'أول.pdf', content: 'FIRST-PAGE' },
        { filename: 'فارغ.pdf', content: '' },
        { filename: 'ثالث.pdf', content: 'THIRD-PAGE' },
      ],
      fields: { mode: 'single', title: 'دفعة معطوبة' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'empty_file');

    const after = await sql`SELECT COUNT(*) AS n FROM dbo.documents`.execute(db);
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n), 'a partial document was committed');
  });

  // ── Separate documents ─────────────────────────────────────────────────

  test('three files filed separately become three documents', async () => {
    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [
        { filename: 'فاتورة-أ.pdf', content: 'INVOICE-A' },
        { filename: 'فاتورة-ب.pdf', content: 'INVOICE-B' },
        { filename: 'فاتورة-ج.pdf', content: 'INVOICE-C' },
      ],
      fields: { mode: 'separate' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.created.length, 3);
    assert.equal(body.failed.length, 0);

    // Each is a normal single-file document, titled from its own filename.
    assert.deepEqual(
      body.created.map((d) => d.title),
      ['فاتورة-أ', 'فاتورة-ب', 'فاتورة-ج'],
    );

    for (const document of body.created) {
      const versions = await sql`
        SELECT COUNT(*) AS n FROM dbo.document_versions WHERE document_id = ${document.documentId}
      `.execute(db);
      assert.equal(Number(versions.rows[0].n), 1);
    }
  });

  test('one bad file in a separate batch does not abandon the good ones', async () => {
    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [
        { filename: 'سليم-أ.pdf', content: 'GOOD-A' },
        { filename: 'فارغ.pdf', content: '' },
        { filename: 'سليم-ب.pdf', content: 'GOOD-B' },
      ],
      fields: { mode: 'separate' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();

    // The point of the separate mode: nineteen good scans are not refused
    // because the twentieth was empty.
    assert.equal(body.created.length, 2);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].filename, 'فارغ.pdf');
    assert.equal(body.failed[0].reason, 'empty_file');
  });

  test('the mode defaults to separate when the client omits it', async () => {
    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [
        { filename: 'بلا-وضع-أ.pdf', content: 'NOMODE-A' },
        { filename: 'بلا-وضع-ب.pdf', content: 'NOMODE-B' },
      ],
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.mode, 'separate');
    assert.equal(body.created.length, 2);
  });

  // ── Reading a multi-file document ──────────────────────────────────────

  test('a multi-file document lists its files in reading order', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'محضر اجتماع' },
    });
    const { documentId } = created.json().created[0];

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files`,
      headers: { cookie: uploaderCookie },
    });

    assert.equal(response.statusCode, 200);
    const { files } = response.json();
    assert.deepEqual(
      files.map((f) => f.filename),
      THREE_PAGES.map((f) => f.filename),
    );
    // The storage path is an internal detail and must not leak to a client.
    assert.equal(files[0].storagePath, undefined);
  });

  test('each constituent file streams its own bytes', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'تقرير سنوي' },
    });
    const { documentId } = created.json().created[0];

    const listed = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files`,
      headers: { cookie: uploaderCookie },
    });

    const { files } = listed.json();

    for (const [index, file] of files.entries()) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/documents/${documentId}/files/${file.fileId}/content`,
        headers: { cookie: uploaderCookie },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body, THREE_PAGES[index].content);
      // RFC 5987 encoding is what keeps an Arabic filename readable in the
      // download dialog rather than arriving as question marks.
      assert.match(response.headers['content-disposition'], /filename\*=UTF-8''/);
    }
  });

  test('a range request on a constituent file returns the slice', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'مرفقات' },
    });
    const { documentId } = created.json().created[0];
    const { files } = (
      await app.inject({
        method: 'GET',
        url: `/api/documents/${documentId}/files`,
        headers: { cookie: uploaderCookie },
      })
    ).json();

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files/${files[0].fileId}/content`,
      headers: { cookie: uploaderCookie, range: 'bytes=0-3' },
    });

    // Without this the preview pane downloads every file whole before showing
    // a page, which is what Range support on the version route exists to avoid.
    assert.equal(response.statusCode, 206);
    assert.equal(response.body, 'PAGE');
  });

  test('the whole document downloads as one zip', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'ملف الموظف' },
    });
    const { documentId } = created.json().created[0];

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files.zip`,
      headers: { cookie: uploaderCookie },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/zip');
    // PK\x03\x04 — a real zip, not an error page with a zip content type.
    assert.equal(response.rawPayload.subarray(0, 4).toString('binary'), 'PK');
    // Every constituent is in it, prefixed so extraction preserves the order.
    const listing = response.rawPayload.toString('binary');
    for (const page of THREE_PAGES) assert.ok(listing.includes(page.content), `${page.filename} missing`);
  });

  // ── Refusals that keep the two axes disjoint ───────────────────────────

  test('the single-blob content route refuses a multi-file document by name', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'مستند متعدد' },
    });
    const { documentId } = created.json().created[0];

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/content`,
      headers: { cookie: uploaderCookie },
    });

    // 404 would be a lie the client cannot recover from — the document exists
    // and is readable, it just has no single blob to hand over.
    assert.equal(response.statusCode, 409);
    const body = response.json();
    assert.equal(body.error, 'multi_file_document');
    assert.match(body.zipUrl, /files\.zip$/);
  });

  test('BROWSE without READ cannot read a constituent file', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'سري' },
    });
    const { documentId } = created.json().created[0];

    const listed = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files`,
      headers: { cookie: peekerCookie },
    });
    assert.equal(listed.statusCode, 403);

    const zipped = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files.zip`,
      headers: { cookie: peekerCookie },
    });
    assert.equal(zipped.statusCode, 403);
  });

  test('uploading without UPLOAD permission is refused before anything is stored', async () => {
    const before = await sql`SELECT COUNT(*) AS n FROM dbo.document_files`.execute(db);

    const response = await uploadBatch(peekerCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'ممنوع' },
    });

    assert.equal(response.statusCode, 403);

    const after = await sql`SELECT COUNT(*) AS n FROM dbo.document_files`.execute(db);
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));
  });

  test('a version cannot be added to a multi-file document', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'محضر لا يُصدَّر' },
    });
    const { documentId } = created.json().created[0];

    const body = multipartBatch({ files: [{ filename: 'إصدار.pdf', content: 'NEW-VERSION' }] });
    const response = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { ...body.headers, cookie: uploaderCookie },
      payload: body.payload,
    });

    // The two axes must stay disjoint: accepting this would leave the document
    // both versioned and multi-file, a hybrid every current_version join would
    // then have to branch on.
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'multi_file_document');

    const versions = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(versions.rows[0].n), 0);
  });

  test('a share link cannot be created for a multi-file document', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'غير قابل للمشاركة' },
    });
    const { documentId } = created.json().created[0];

    const response = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/shares`,
      headers: { cookie: uploaderCookie },
      payload: { expiresInHours: 24 },
    });

    // A share link resolves one file by version number. Left unchecked it would
    // resolve to version 0, find nothing, and hand the recipient a broken page
    // while the sharer's own screen showed a link that looked fine.
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'multi_file_document');
  });

  test('a batch larger than the cap is refused with a readable reason', async () => {
    const { config } = await import('../src/config/index.js');
    const tooMany = Array.from({ length: config.storage.maxFilesPerUpload + 5 }, (_, index) => ({
      filename: `ورقة-${index}.pdf`,
      content: `PAGE-${index}`,
    }));

    const response = await uploadBatch(uploaderCookie, id.cabinet, {
      files: tooMany,
      fields: { mode: 'single', title: 'دفعة ضخمة' },
    });

    // Not a 500, and not a silently truncated document holding the first fifty
    // files as though that were what was asked for.
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error, 'too_many_files');

    const orphans = await sql`
      SELECT COUNT(*) AS n FROM dbo.documents WHERE title = N'دفعة ضخمة'
    `.execute(db);
    assert.equal(Number(orphans.rows[0].n), 0);
  });

  // ── Extraction ─────────────────────────────────────────────────────────

  test('every constituent file contributes to the document text', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [
        { filename: 'ص-١.txt', content: 'الصفحة الأولى تذكر الاستئجار', mimeType: 'text/plain' },
        { filename: 'ص-٢.txt', content: 'الصفحة الثانية تذكر التعويض', mimeType: 'text/plain' },
        { filename: 'ص-٣.txt', content: 'الصفحة الثالثة تذكر الفسخ', mimeType: 'text/plain' },
      ],
      fields: { mode: 'single', title: 'عقد من ثلاث صفحات' },
    });
    const { documentId } = created.json().created[0];

    const worker = await import('../src/modules/extraction/worker.js');
    await worker.drainQueue();

    const row = (
      await sql`
        SELECT extraction_status, content_normalized FROM dbo.documents
         WHERE document_id = ${documentId}
      `.execute(db)
    ).rows[0];

    assert.equal(Number(row.extraction_status), worker.DOC_EXTRACTION.EXTRACTED);

    // One job, not one per file: the worker writes content_normalized for the
    // whole document, so per-file jobs would each overwrite the last and the
    // document would end up findable only by whichever finished last.
    for (const word of ['الاستئجار', 'التعويض', 'الفسخ']) {
      assert.ok(
        row.content_normalized?.includes(word),
        `"${word}" is missing — a file's text was lost`,
      );
    }

    // Exactly one queue row, keyed at version 0.
    const queued = await sql`
      SELECT version_number FROM dbo.extraction_queue WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(queued.rows.length, 1);
    assert.equal(Number(queued.rows[0].version_number), 0);
  });

  // ── Deletion, restoration and purge ────────────────────────────────────

  test('a deleted multi-file document is restorable, not a tombstone', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'للحذف والاسترجاع' },
    });
    const { documentId } = created.json().created[0];

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: uploaderCookie },
    });
    assert.equal(deleted.statusCode, 200);

    const bin = await app.inject({
      method: 'GET',
      url: '/api/recycle-bin',
      headers: { cookie: uploaderCookie },
    });

    const entry = bin.json().documents.find((d) => d.documentId === documentId);
    assert.ok(entry, 'the deleted document is missing from the recycle bin');
    // The bin checked document_versions only, so a multi-file document reported
    // itself unrestorable while every one of its files was still on disk.
    assert.equal(entry.restorable, true);

    const restored = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/restore`,
      headers: { cookie: uploaderCookie },
    });
    assert.equal(restored.statusCode, 200);
  });

  test('purging a multi-file document removes every one of its blobs', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'للإزالة النهائية' },
    });
    const { documentId } = created.json().created[0];

    const paths = (
      await sql`
        SELECT storage_path FROM dbo.document_files WHERE document_id = ${documentId}
      `.execute(db)
    ).rows.map((row) => row.storage_path);
    assert.equal(paths.length, 3);

    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: uploaderCookie },
    });
    await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/purge`,
      headers: { cookie: uploaderCookie },
    });

    const { purgeDeletedDocuments } = await import('../src/modules/storage-maintenance/purge.js');
    await purgeDeletedDocuments({ graceDays: 0 });

    // The purge enumerated document_versions only, so these three blobs would
    // have stayed on disk forever: unreferenced, unreported, and missed by the
    // orphan sweep, which only looks at .tmp and .staging.
    for (const storagePath of paths) {
      assert.equal(await storage.exists(storagePath), false, `blob leaked: ${storagePath}`);
    }

    const rows = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_files WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(rows.rows[0].n), 0);
  });

  test('a bulk download includes multi-file documents rather than skipping them', async () => {
    const single = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [{ filename: 'مفرد.pdf', content: 'BULK-SINGLE' }],
      fields: { mode: 'separate' },
    });
    const multi = await uploadBatch(uploaderCookie, id.cabinet, {
      files: THREE_PAGES,
      fields: { mode: 'single', title: 'مجمّع متعدد' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/bulk/download',
      headers: { cookie: uploaderCookie },
      payload: {
        documentIds: [single.json().created[0].documentId, multi.json().created[0].documentId],
      },
    });

    assert.equal(response.statusCode, 200);

    // Asserted on the entry NAMES, not the payload: this archive is deflated,
    // so the file contents are not present as plain bytes. Zip stores names
    // uncompressed, as UTF-8, which is what the latin1 round trip reads back.
    const archive = response.rawPayload.toString('binary');
    const inArchive = (name) => archive.includes(Buffer.from(name, 'utf8').toString('binary'));

    // Matching only on current_version dropped every multi-file document
    // silently: ten selected, eight delivered, nothing to say why.
    assert.ok(inArchive('مفرد.pdf'), 'the single-file document is missing');
    for (const page of THREE_PAGES) {
      assert.ok(inArchive(page.filename), `${page.filename} is missing from the archive`);
    }
    // Its files are grouped under the document's own name rather than scattered
    // loose beside everything else.
    assert.ok(inArchive('مجمّع متعدد/'), 'the multi-file document was not grouped');
  });

  test('a single-file document still answers the files endpoint with an empty list', async () => {
    const created = await uploadBatch(uploaderCookie, id.cabinet, {
      files: [{ filename: 'وحيد.pdf', content: 'ONLY-ONE' }],
      fields: { mode: 'separate' },
    });
    const { documentId } = created.json().created[0];

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/files`,
      headers: { cookie: uploaderCookie },
    });

    // Not a 404: the document exists and simply has no constituent files, and a
    // client rendering a file list should show an empty one rather than an error.
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().files, []);
  });
});
