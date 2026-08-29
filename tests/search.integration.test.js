/**
 * Integration tests for search.
 *
 * Title search runs off an indexed LIKE on the normalised column and is
 * synchronous, so most of these are deterministic. Content search goes through
 * the full-text index, which populates asynchronously under CHANGE_TRACKING
 * AUTO — those tests poll for the index to catch up rather than sleeping a fixed
 * amount and hoping.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

let db;
let sql;
let app;
let PERM;

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

/** Inserts a document the way the upload path does — title AND normalised title. */
async function makeDocument(title, folderName, { content = null } = {}) {
  const { normalizeArabic } = await import('../src/lib/arabic.js');
  const r = await sql`
    INSERT INTO dbo.documents
      (folder_id, title, title_normalized, content_normalized, current_version, created_by)
    OUTPUT INSERTED.document_id AS did
    VALUES (${id[folderName]}, ${title}, ${normalizeArabic(title)},
            ${content === null ? null : normalizeArabic(content)}, 1, ${id.searcher})
  `.execute(db);
  return r.rows[0].did;
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

const find = (cookie, qs) => app.inject({ method: 'GET', url: `/api/search?${qs}`, headers: { cookie } });
const titles = (body) => body.results.map((r) => r.title).sort();

/**
 * Waits for the full-text index to catch up.
 *
 * CHANGE_TRACKING AUTO populates in the background, so a document is searchable
 * "shortly" after it is written. Polling for the expected row is deterministic
 * where a fixed sleep is a race that passes on a fast machine and fails in CI.
 */
async function waitForFullText(term, { attempts = 60, delayMs = 250 } = {}) {
  for (let n = 0; n < attempts; n += 1) {
    const found = await sql`
      SELECT COUNT(*) AS n FROM dbo.documents
       WHERE CONTAINS(content_normalized, ${`"${term}"`})
    `.execute(db);
    if (Number(found.rows[0].n) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

describe('search', { skip: CONFIGURED ? false : target.reason }, () => {
  let searcherCookie;
  let peekerCookie;
  let strangerCookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('searcher');
    await makeUser('peeker');
    await makeUser('stranger');

    await makeFolder('cabinet');
    await makeFolder('legal', 'cabinet');
    await makeFolder('private');

    await grant('cabinet', id.searcher, PERM.BROWSE | PERM.READ);
    await grant('cabinet', id.peeker, PERM.BROWSE);
    // Nobody is granted anything on `private`.

    await makeDocument('عقد إيجار مبنى الإدارة', 'legal');
    await makeDocument('مكتبة الوثائق القديمة', 'cabinet');
    await makeDocument('فاتورة شهر أغسطس', 'cabinet');
    await makeDocument('عقد سري للغاية', 'private');

    searcherCookie = await signIn('searcher');
    peekerCookie = await signIn('peeker');
    strangerCookie = await signIn('stranger');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
  });

  test('search requires a session and a query', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/search?q=x' })).statusCode, 401);
    assert.equal((await find(searcherCookie, 'q=')).statusCode, 400);
    assert.equal((await find(searcherCookie, 'q=%20%20')).statusCode, 400);
  });

  // ── Permission filtering ───────────────────────────────────────────────

  test('results never include documents from folders the user cannot browse', async () => {
    const body = (await find(searcherCookie, 'q=عقد')).json();

    assert.deepEqual(titles(body), ['عقد إيجار مبنى الإدارة']);
    // The private document matches the query and must not be present in any form.
    assert.ok(!JSON.stringify(body).includes('سري'), 'a forbidden document leaked into search');
  });

  test('a user with no grants gets nothing, not an error', async () => {
    const body = (await find(strangerCookie, 'q=عقد')).json();
    assert.deepEqual(body.results, []);
    assert.equal(body.total, 0);
  });

  test('browse-only finds documents by title but is marked unable to read', async () => {
    const body = (await find(peekerCookie, 'q=مكتبة')).json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].canRead, false);

    const asReader = (await find(searcherCookie, 'q=مكتبة')).json();
    assert.equal(asReader.results[0].canRead, true);
  });

  // ── Arabic normalisation ───────────────────────────────────────────────

  /**
   * The collation handles neither of these, which is why the normalised column
   * exists. Each is a document a user would otherwise fail to find by typing the
   * word the way they normally write it.
   */
  test('searching finds documents across Arabic spelling variants', async () => {
    // ة vs ه — the commonest Arabic typing variation.
    const taaMarbuta = (await find(searcherCookie, 'q=مكتبه')).json();
    assert.equal(taaMarbuta.results.length, 1, 'مكتبه should find مكتبة');

    // Tashkeel in the query, none in the stored title.
    const withTashkeel = (await find(searcherCookie, `q=${encodeURIComponent('مَكْتَبَة')}`)).json();
    assert.equal(withTashkeel.results.length, 1, 'a diacritic-bearing query should still match');

    // Alef hamza.
    await makeDocument('أحمد الموظف', 'cabinet');
    const alef = (await find(searcherCookie, 'q=احمد')).json();
    assert.equal(alef.results.length, 1, 'احمد should find أحمد');
  });

  test('a query matching nothing returns an empty result, not an error', async () => {
    const body = (await find(searcherCookie, 'q=لاشيءمطلقا')).json();
    assert.deepEqual(body.results, []);
  });

  // ── Scoping ────────────────────────────────────────────────────────────

  test('scoping to a folder searches its whole subtree and nothing else', async () => {
    const wide = (await find(searcherCookie, `q=ا&folderId=${id.cabinet}`)).json();
    const narrow = (await find(searcherCookie, `q=عقد&folderId=${id.legal}`)).json();

    assert.ok(wide.results.length >= 2, 'the parent scope includes the child folder');
    assert.deepEqual(titles(narrow), ['عقد إيجار مبنى الإدارة']);

    // Scoping to a sibling must exclude it.
    const elsewhere = (await find(searcherCookie, `q=مكتبة&folderId=${id.legal}`)).json();
    assert.deepEqual(elsewhere.results, []);
  });

  test('scoping to an unknown folder returns nothing rather than everything', async () => {
    // The dangerous failure is a bad scope being ignored and silently widening
    // the search to the whole system.
    const body = (await find(searcherCookie, 'q=عقد&folderId=999999999')).json();
    assert.deepEqual(body.results, []);
  });

  // ── Injection ──────────────────────────────────────────────────────────

  test('full-text operators in the query are neutralised', async () => {
    // Each of these is a CONTAINS operator. They must be treated as text, not
    // syntax — otherwise the search box is a full-text injection point.
    for (const nasty of ['عقد OR سري', 'عقد" OR "سري', 'عقد AND NOT x', '*', '"', '()']) {
      const response = await find(searcherCookie, `q=${encodeURIComponent(nasty)}`);
      assert.equal(response.statusCode, 200, `query ${nasty} should not error`);
      assert.ok(
        !JSON.stringify(response.json()).includes('سري'),
        `operator injection leaked a forbidden document: ${nasty}`,
      );
    }
  });

  test('LIKE wildcards in the query are literal', async () => {
    await makeDocument('خصم 50% نهائي', 'cabinet');

    // '%' must match the character, not act as "match anything".
    const body = (await find(searcherCookie, `q=${encodeURIComponent('50%')}`)).json();
    assert.equal(body.results.length, 1);
    assert.ok(body.results[0].title.includes('50%'));
  });

  // ── Content search ─────────────────────────────────────────────────────

  test('content search finds text inside a document, still permission-filtered', async () => {
    await makeDocument('تقرير بلا عنوان مميز', 'cabinet', {
      content: 'هذه الوثيقة تذكر كلمة استثنائية جدا في متنها',
    });
    await makeDocument('تقرير محجوب', 'private', {
      content: 'هذه الوثيقة تذكر كلمة استثنائية جدا في متنها',
    });

    const indexed = await waitForFullText('استثنائية');
    assert.ok(indexed, 'the full-text index did not populate within the timeout');

    const body = (await find(searcherCookie, 'q=استثنائية')).json();
    assert.equal(body.contentSearched, true, 'content search should have been used');
    assert.equal(body.results.length, 1, 'only the permitted document');
    assert.equal(body.results[0].title, 'تقرير بلا عنوان مميز');
  });

  test('capabilities reports that content search is available', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search/capabilities',
      headers: { cookie: searcherCookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().contentSearch, true);
  });

  test('disabling content search restricts matching to titles', async () => {
    const body = (await find(searcherCookie, 'q=استثنائية&content=false')).json();
    assert.equal(body.contentSearched, false);
    assert.equal(body.results.length, 0, 'the term appears only in the body');
  });

  // ── Metadata field search ──────────────────────────────────────────────

  test('a number field filters numerically, not as text', async () => {
    const field = await sql`
      INSERT INTO dbo.custom_field_defs (name, data_type)
      OUTPUT INSERTED.field_id AS fid VALUES (N'قيمة العقد', 'number')
    `.execute(db);
    const fieldId = field.rows[0].fid;

    const cheap = await makeDocument('عقد صغير', 'cabinet');
    const dear = await makeDocument('عقد كبير', 'cabinet');
    await sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_number)
              VALUES (${cheap}, ${fieldId}, 900)`.execute(db);
    await sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_number)
              VALUES (${dear}, ${fieldId}, 5000)`.execute(db);

    const response = await app.inject({
      method: 'GET',
      url: `/api/search/fields/${fieldId}?min=1000`,
      headers: { cookie: searcherCookie },
    });

    assert.equal(response.statusCode, 200);
    // As text, '900' > '1000'. Getting one result is the typed column working.
    assert.equal(response.json().results.length, 1);
    assert.equal(response.json().results[0].title, 'عقد كبير');
  });

  test('field search is permission-filtered too', async () => {
    const field = await sql`
      INSERT INTO dbo.custom_field_defs (name, data_type)
      OUTPUT INSERTED.field_id AS fid VALUES (N'مرجع', 'text')
    `.execute(db);
    const fieldId = field.rows[0].fid;

    const hidden = await makeDocument('وثيقة محجوبة', 'private');
    await sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_text)
              VALUES (${hidden}, ${fieldId}, N'REF-1')`.execute(db);

    const response = await app.inject({
      method: 'GET',
      url: `/api/search/fields/${fieldId}?equals=REF-1`,
      headers: { cookie: searcherCookie },
    });

    assert.deepEqual(response.json().results, []);
  });

  // ── Paging ─────────────────────────────────────────────────────────────

  test('total reflects every match, not just the page', async () => {
    await makeFolder('bulk', 'cabinet');
    for (let n = 0; n < 5; n += 1) await makeDocument(`ملف مرقم ${n}`, 'bulk');

    const first = (await find(searcherCookie, `q=مرقم&folderId=${id.bulk}&limit=2`)).json();
    assert.equal(first.results.length, 2);
    assert.equal(first.total, 5, 'total should count all matches');

    const second = (await find(searcherCookie, `q=مرقم&folderId=${id.bulk}&limit=2&offset=2`)).json();
    assert.equal(second.results.length, 2);

    const overlap = first.results.filter((r) =>
      second.results.some((s) => s.documentId === r.documentId),
    );
    assert.equal(overlap.length, 0, 'pages must not repeat rows');
  });
});
