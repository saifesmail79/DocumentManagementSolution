/**
 * Integration tests for filtering documents by their parameters.
 *
 * "Parameters, not contents" is the whole point: these filters answer what a
 * document IS — its type, label, tags, who filed it, when, how big, what kind
 * of file — with no keyword involved. So the first property under test is that
 * a search with no query term at all returns results rather than a 400.
 *
 * The second is that Browse and Search agree. They page differently and are
 * reached from different screens, but they compose the same predicates, and a
 * filter that means one thing in one place and something else in the other is
 * the failure this shared module exists to prevent.
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

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-filters-test-'));
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

function multipart({ files, fields = {} }) {
  const boundary = '----dmsfilter0123456789';
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
      Buffer.from(file.content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function fileBatch(cookie, folderId, { files, fields = {} }) {
  const body = multipart({ files, fields });
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${folderId}/documents/batch`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

/** Runs a parameter search with no keyword at all. */
async function filter(cookie, criteria) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/search/advanced',
    headers: { cookie },
    payload: criteria,
  });
  return response;
}

/** Runs the same filters against the folder listing Browse renders. */
async function browse(cookie, folderId, query = '') {
  return app.inject({
    method: 'GET',
    url: `/api/folders/${folderId}${query ? `?${query}` : ''}`,
    headers: { cookie },
  });
}

const titlesOf = (response) => response.json().results.map((r) => r.title).sort();

describe('filtering documents by their parameters', { skip: CONFIGURED ? false : target.reason }, () => {
  let filerCookie;
  let clerkCookie;
  let outsiderCookie;
  let contractTypeId;
  let secretLabelId;

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
    await makeUser('clerk');
    await makeUser('outsider');
    await makeFolder('registry');
    await makeFolder('vault');

    await grant('registry', id.filer, PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    await grant('registry', id.clerk, PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    await grant('vault', id.filer, PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    // `outsider` gets no ACE at all — an all-zero one is refused by CK_ace_bits,
    // and absence of a grant is the real-world shape of "cannot see this".

    filerCookie = await signIn('filer');
    clerkCookie = await signIn('clerk');
    outsiderCookie = await signIn('outsider');

    const type = await sql`
      INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (N'عقد')
    `.execute(db);
    contractTypeId = Number(type.rows[0].tid);

    const label = await sql`
      INSERT INTO dbo.sensitivity_labels (name, severity_rank)
      OUTPUT INSERTED.label_id AS lid VALUES (N'سري', 30)
    `.execute(db);
    secretLabelId = Number(label.rows[0].lid);

    // ── The corpus ─────────────────────────────────────────────────────
    // Filed by `filer`: a typed, labelled, tagged contract.
    const contract = await fileBatch(filerCookie, id.registry, {
      files: [{ filename: 'عقد-إيجار.pdf', content: 'X'.repeat(5000) }],
      fields: { mode: 'separate', typeId: String(contractTypeId) },
    });
    id.contract = contract.created[0].documentId;

    await sql`
      UPDATE dbo.documents SET sensitivity_label_id = ${secretLabelId}
       WHERE document_id = ${id.contract}
    `.execute(db);

    const tag = await sql`
      INSERT INTO dbo.tags (name) OUTPUT INSERTED.tag_id AS tid VALUES (N'مراجعة')
    `.execute(db);
    await sql`
      INSERT INTO dbo.document_tags (document_id, tag_id)
      VALUES (${id.contract}, ${tag.rows[0].tid})
    `.execute(db);

    // Filed by `clerk`: an untyped spreadsheet, small.
    const sheet = await fileBatch(clerkCookie, id.registry, {
      files: [
        {
          filename: 'ميزانية.xlsx',
          content: 'S',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
      fields: { mode: 'separate' },
    });
    id.sheet = sheet.created[0].documentId;

    // Filed by `filer`: a multi-file scan batch, three pages of 1000 bytes each.
    const scan = await fileBatch(filerCookie, id.registry, {
      files: [
        { filename: 'مسح-١.pdf', content: 'A'.repeat(1000) },
        { filename: 'مسح-٢.pdf', content: 'B'.repeat(1000) },
        { filename: 'مسح-٣.pdf', content: 'C'.repeat(1000) },
      ],
      fields: { mode: 'single', title: 'محضر ممسوح' },
    });
    id.scan = scan.created[0].documentId;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The premise ────────────────────────────────────────────────────────

  test('a parameter search runs with no keyword at all', async () => {
    const response = await filter(filerCookie, { typeId: contractTypeId });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(titlesOf(response), ['عقد-إيجار']);
    // Nothing was read out of any document to answer this.
    assert.equal(response.json().contentSearched, false);
  });

  test('no criteria at all returns everything the user may browse', async () => {
    const response = await filter(filerCookie, {});
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 3);
  });

  // ── Each parameter ─────────────────────────────────────────────────────

  test('filters by document type', async () => {
    assert.deepEqual(titlesOf(await filter(filerCookie, { typeId: contractTypeId })), ['عقد-إيجار']);
  });

  test('filters by sensitivity label', async () => {
    assert.deepEqual(titlesOf(await filter(filerCookie, { labelId: secretLabelId })), ['عقد-إيجار']);
  });

  test('filters by who filed it', async () => {
    assert.deepEqual(titlesOf(await filter(filerCookie, { createdBy: String(id.clerk) })), ['ميزانية']);
  });

  test('filters by tag', async () => {
    assert.deepEqual(titlesOf(await filter(filerCookie, { tags: ['مراجعة'] })), ['عقد-إيجار']);
  });

  test('filters by file type across both file axes', async () => {
    const pdfs = await filter(filerCookie, { mimeTypes: ['application/pdf'] });
    // The scan batch is a multi-file document; its files are PDFs, so it is a
    // PDF document to anyone filtering for one.
    assert.deepEqual(titlesOf(pdfs), ['عقد-إيجار', 'محضر ممسوح'].sort());

    const sheets = await filter(filerCookie, {
      mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    });
    assert.deepEqual(titlesOf(sheets), ['ميزانية']);
  });

  test('filters by file extension', async () => {
    assert.deepEqual(titlesOf(await filter(filerCookie, { extensions: ['xlsx'] })), ['ميزانية']);
    // Tolerates a leading dot, because that is how people write an extension.
    assert.deepEqual(titlesOf(await filter(filerCookie, { extensions: ['.xlsx'] })), ['ميزانية']);
  });

  test('filters by total size, summing a multi-file document', async () => {
    // The scan batch is three 1000-byte files. Asked for documents of at least
    // 2500 bytes it must appear: the document is 3000 bytes even though no
    // single file in it is.
    const large = await filter(filerCookie, { minBytes: '2500' });
    assert.deepEqual(titlesOf(large), ['عقد-إيجار', 'محضر ممسوح'].sort());

    const small = await filter(filerCookie, { maxBytes: '100' });
    assert.deepEqual(titlesOf(small), ['ميزانية']);
  });

  test('filters to multi-file documents, or away from them', async () => {
    assert.deepEqual(titlesOf(await filter(filerCookie, { multiFile: true })), ['محضر ممسوح']);
    assert.deepEqual(titlesOf(await filter(filerCookie, { multiFile: false })), ['عقد-إيجار', 'ميزانية'].sort());
  });

  test('filters by a created-date range', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await filter(filerCookie, { createdFrom: future })).json().total, 0);

    const past = new Date(Date.now() - 86_400_000).toISOString();
    assert.equal((await filter(filerCookie, { createdFrom: past })).json().total, 3);
  });

  test('combining criteria narrows rather than widens', async () => {
    // Type AND creator, both of which the contract satisfies.
    assert.equal(
      (await filter(filerCookie, { typeId: contractTypeId, createdBy: String(id.filer) })).json().total,
      1,
    );
    // The same type, but a creator who filed nothing of it.
    assert.equal(
      (await filter(filerCookie, { typeId: contractTypeId, createdBy: String(id.clerk) })).json().total,
      0,
    );
  });

  // ── Failure and permission ─────────────────────────────────────────────

  test('a malformed date is a 400 naming the field, not a 500', async () => {
    const response = await filter(filerCookie, { createdFrom: 'not-a-date' });

    // Previously this reached new Date(...).toISOString() and threw a
    // RangeError, so a mistyped filter came back as an unexplained 500.
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_filter');
    assert.match(response.json().detail, /createdFrom/);
  });

  test('filters never widen what a user may see', async () => {
    // `outsider` holds no grant anywhere.
    const response = await filter(outsiderCookie, {});
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 0);
  });

  test('the filter vocabulary is scoped to what the caller can browse', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/search/filter-options',
      headers: { cookie: filerCookie },
    });

    assert.equal(mine.statusCode, 200);
    const options = mine.json();
    assert.deepEqual(
      options.types.map((t) => t.name),
      ['عقد'],
    );
    assert.deepEqual(
      options.creators.map((c) => c.name).sort(),
      ['clerk', 'filer'],
    );
    // Derived from what is filed, both axes — not from a hardcoded list.
    assert.ok(options.fileTypes.some((f) => f.mimeType === 'application/pdf'));
    assert.deepEqual(
      options.tags.map((t) => t.name),
      ['مراجعة'],
    );

    // Someone who can see nothing is offered nothing to filter by, rather than
    // being shown that a type called "عقد" exists.
    const theirs = await app.inject({
      method: 'GET',
      url: '/api/search/filter-options',
      headers: { cookie: outsiderCookie },
    });
    assert.deepEqual(theirs.json().types, []);
    assert.deepEqual(theirs.json().creators, []);
  });

  // ── Sorting ────────────────────────────────────────────────────────────

  test('results can be sorted by size in either direction', async () => {
    const ascending = await filter(filerCookie, { sortBy: 'size', sortDir: 'asc' });
    assert.deepEqual(
      ascending.json().results.map((r) => r.title),
      ['ميزانية', 'محضر ممسوح', 'عقد-إيجار'],
    );

    const descending = await filter(filerCookie, { sortBy: 'size', sortDir: 'desc' });
    assert.deepEqual(
      descending.json().results.map((r) => r.title),
      ['عقد-إيجار', 'محضر ممسوح', 'ميزانية'],
    );
  });

  // ── Browse and Search must agree ───────────────────────────────────────

  test('the folder listing applies the same filters as the search page', async () => {
    const listing = await browse(filerCookie, id.registry, `typeId=${contractTypeId}`);

    assert.equal(listing.statusCode, 200);
    assert.deepEqual(
      listing.json().documents.map((d) => d.title),
      ['عقد-إيجار'],
    );

    // The same question asked of the search endpoint, scoped to the folder.
    const searched = await filter(filerCookie, { typeId: contractTypeId, folderId: String(id.registry) });
    assert.deepEqual(
      searched.json().results.map((r) => r.title),
      ['عقد-إيجار'],
    );
  });

  test('the folder listing reports a multi-file document as such, with its total size', async () => {
    const listing = await browse(filerCookie, id.registry, 'multiFile=true');
    const documents = listing.json().documents;

    assert.equal(documents.length, 1);
    assert.equal(documents[0].title, 'محضر ممسوح');
    assert.equal(documents[0].multiFile, true);
    assert.equal(documents[0].fileCount, 3);
    // Previously this was NULL: the listing's LEFT JOIN to document_versions
    // finds nothing for a multi-file document, and the row rendered blank.
    assert.equal(documents[0].bytes, 3000);
  });

  test('a malformed filter on the folder listing is a 400', async () => {
    const listing = await browse(filerCookie, id.registry, 'createdFrom=rubbish');
    assert.equal(listing.statusCode, 400);
    assert.equal(listing.json().error, 'invalid_filter');
  });

  test('filtering the folder listing leaves its paging intact', async () => {
    // Every document in the folder matches, so a filtered listing must walk the
    // same rows the unfiltered one does — the cursor is unaffected by filtering.
    const seen = new Set();
    let cursor = null;

    for (let page = 0; page < 5; page += 1) {
      const query = `limit=1&multiFile=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await browse(filerCookie, id.registry, query);
      assert.equal(response.statusCode, 200);

      const body = response.json();
      for (const document of body.documents) {
        assert.ok(!seen.has(document.documentId), 'a document was served twice');
        seen.add(document.documentId);
      }

      cursor = body.nextCursor;
      if (!cursor) break;
    }

    assert.equal(seen.size, 2, 'paging did not walk every matching document exactly once');
  });
});
