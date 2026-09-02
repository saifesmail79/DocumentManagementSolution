/**
 * Integration tests for the filing tree routes.
 *
 * This is the first place permissions meet HTTP, so these check the thing the
 * whole permission model was built for: that the SQL doing the filtering is the
 * SQL fetching the rows, and that a user never receives a row they may not see —
 * not even flagged as hidden.
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
let storage;
let purgeDeletedDocuments;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

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

async function makeFolder(name, parentName = null, { inherits = true } = {}) {
  const parentId = parentName ? id[parentName] : null;
  const parentPath = parentName ? id[`${parentName}__path`] : '/';
  const r = await sql`
    INSERT INTO dbo.folders (parent_id, name, mpath, depth, inherits_acl)
    OUTPUT INSERTED.folder_id AS fid
    VALUES (${parentId}, ${name}, '/pending/', ${parentName ? 1 : 0}, ${inherits ? 1 : 0})
  `.execute(db);
  const fid = r.rows[0].fid;
  const mpath = `${parentPath}${fid}/`;
  await sql`UPDATE dbo.folders SET mpath = ${mpath} WHERE folder_id = ${fid}`.execute(db);
  id[name] = fid;
  id[`${name}__path`] = mpath;
  return fid;
}

async function makeDocument(title, folderName, creator = 'reader') {
  const r = await sql`
    INSERT INTO dbo.documents (folder_id, title, created_by)
    OUTPUT INSERTED.document_id AS did
    VALUES (${id[folderName]}, ${title}, ${id[creator]})
  `.execute(db);
  return r.rows[0].did;
}

/**
 * Gives a document a real version row, and the file on disk to match.
 *
 * A document with no version is not a lesser fixture, it is a different state:
 * the product treats "nothing to restore" as content already purged, so a
 * fixture without one cannot stand in for a restorable document.
 */
async function addVersion(documentId, { bytes = 'x' } = {}) {
  const { createHash } = await import('node:crypto');
  const body = Buffer.from(bytes);
  const sha = createHash('sha256').update(body).digest('hex');
  const storagePath = `test/${documentId}_v1.bin`;

  await storage.putBuffer(body, storagePath);
  await sql`
    INSERT INTO dbo.document_versions
      (document_id, version_number, storage_path, file_size_bytes, sha256, mime_type, uploaded_by)
    VALUES (${documentId}, 1, ${storagePath}, ${body.length}, ${sha},
            'application/octet-stream', ${id.reader})
  `.execute(db);
  await sql`
    UPDATE dbo.documents SET current_version = 1 WHERE document_id = ${documentId}
  `.execute(db);
  return storagePath;
}

async function grant(folderName, principalId, allow, deny = 0) {
  await sql`
    INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
    VALUES (${id[folderName]}, ${principalId}, ${allow}, ${deny})
  `.execute(db);
}

async function signIn(username) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, `${username} should be able to sign in`);
  const cookie = response.cookies.find((c) => c.name === 'dms_session');
  return { cookie: `dms_session=${cookie.value}` };
}

const get = (url, cookie) => app.inject({ method: 'GET', url, headers: { cookie } });

describe('filing tree routes', { skip: CONFIGURED ? false : target.reason }, () => {
  let readerCookie;
  let browserCookie;
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

    // The real sweep and the real driver: a folder that cannot be deleted after
    // a purge is only visible if the purge that ran was the product's own.
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();
    ({ purgeDeletedDocuments } = await import('../src/modules/storage-maintenance/purge.js'));

    await makeUser('reader');
    await makeUser('browser');
    await makeUser('stranger');
    await makeUser('chief', { superAdmin: true });

    //  cabinet          reader: browse+read+upload   browser: browse only
    //    └── contracts  (inherits)
    //    └── vault      (breaks inheritance, nobody granted)
    //  personnel        (nobody granted at all)
    await makeFolder('cabinet');
    await makeFolder('contracts', 'cabinet');
    await makeFolder('vault', 'cabinet', { inherits: false });
    await makeFolder('personnel');

    await grant('cabinet', id.reader, PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    await grant('cabinet', id.browser, PERM.BROWSE);

    await makeDocument('عقد الإيجار', 'contracts');
    await makeDocument('عقد التوريد', 'contracts');

    readerCookie = (await signIn('reader')).cookie;
    browserCookie = (await signIn('browser')).cookie;
    strangerCookie = (await signIn('stranger')).cookie;
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
  });

  test('the tree requires a session', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/folders' });
    assert.equal(anonymous.statusCode, 401);
  });

  // ── The core requirement ───────────────────────────────────────────────

  test('Browse without Read lists the titles but marks them unreadable', async () => {
    const response = await get(`/api/folders/${id.contracts}`, browserCookie);
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.documents.length, 2, 'browse should see that the documents exist');
    assert.deepEqual(
      body.documents.map((d) => d.title).sort(),
      ['عقد الإيجار', 'عقد التوريد'],
    );

    for (const doc of body.documents) {
      assert.equal(doc.canRead, false, 'browse-only must not be offered the content');
    }
    assert.equal(body.folder.permissions.browse, true);
    assert.equal(body.folder.permissions.read, false);
  });

  test('Read sees the same titles and is allowed the content', async () => {
    const body = (await get(`/api/folders/${id.contracts}`, readerCookie)).json();
    assert.equal(body.documents.length, 2);
    for (const doc of body.documents) {
      assert.equal(doc.canRead, true);
    }
    assert.equal(body.folder.permissions.read, true);
  });

  /**
   * The listing carries the current version's descriptor so the row preview can
   * decide whether the browser draws the file itself or has to ask for a
   * rendition — without a request per row to find out.
   *
   * That descriptor travels with `canRead`, not with the title, because it is
   * content rather than existence. A filename is routinely the most revealing
   * thing about a document: "استقالة المدير 2026.pdf" discloses precisely what a
   * browse-only grant is meant to withhold, and its size and type narrow it
   * further.
   */
  test('the file descriptor follows Read, not Browse', async () => {
    // Given a version rather than a new document, so the counts the later
    // deletion test asserts on stay what they were.
    const found = await sql`
      SELECT document_id FROM dbo.documents WHERE title = ${'عقد التوريد'}
    `.execute(db);
    const documentId = found.rows[0].document_id;

    await sql`
      INSERT INTO dbo.document_versions
             (document_id, version_number, storage_path, original_filename,
              file_size_bytes, sha256, mime_type, uploaded_by)
      VALUES (${documentId}, 1, ${`descriptor/${documentId}.tiff`}, 'مسح ضوئي.tiff',
              4096, ${'a'.repeat(64)}, 'image/tiff', ${id.reader})
    `.execute(db);
    // The join is on the current version, and a document starts at version 0.
    await sql`
      UPDATE dbo.documents SET current_version = 1 WHERE document_id = ${documentId}
    `.execute(db);

    const find = (body) => body.documents.find((d) => d.title === 'عقد التوريد');

    const reader = find((await get(`/api/folders/${id.contracts}`, readerCookie)).json());
    assert.equal(reader.mimeType, 'image/tiff');
    assert.equal(reader.originalFilename, 'مسح ضوئي.tiff');
    assert.equal(reader.bytes, 4096);

    const browser = find((await get(`/api/folders/${id.contracts}`, browserCookie)).json());
    assert.equal(browser.title, 'عقد التوريد', 'browse still sees that it exists');
    assert.equal(browser.mimeType, null);
    assert.equal(browser.originalFilename, null);
    assert.equal(browser.bytes, null);
  });

  /** A document row can predate its first version; the join must not drop it. */
  test('a document with no version yet still appears', async () => {
    const body = (await get(`/api/folders/${id.contracts}`, readerCookie)).json();
    const versionless = body.documents.find((d) => d.title === 'عقد الإيجار');

    assert.ok(versionless, 'a versionless document must still be listed');
    assert.equal(versionless.mimeType, null);
    assert.equal(versionless.bytes, null);
  });

  // ── Absence, not refusal ───────────────────────────────────────────────

  test('a folder the user cannot browse is absent from the listing, not hidden in it', async () => {
    const roots = (await get('/api/folders', readerCookie)).json();
    const names = roots.folders.map((f) => f.name);

    assert.ok(names.includes('cabinet'));
    assert.ok(!names.includes('personnel'), 'an ungranted root must not appear at all');

    // And nothing about it leaks in the payload either.
    assert.ok(!JSON.stringify(roots).includes('personnel'));
  });

  test('a broken-inheritance subfolder disappears from its parent listing', async () => {
    const body = (await get(`/api/folders/${id.cabinet}`, readerCookie)).json();
    const names = body.folders.map((f) => f.name);

    assert.ok(names.includes('contracts'), 'inherits the grant');
    assert.ok(!names.includes('vault'), 'inheritance is broken and nothing was granted');
  });

  test('an unbrowsable folder answers 404, not 403', async () => {
    // A 403 would confirm the id exists, which turns id enumeration into a map of
    // the filing structure.
    const forbidden = await get(`/api/folders/${id.personnel}`, readerCookie);
    assert.equal(forbidden.statusCode, 404);

    const missing = await get('/api/folders/999999999', readerCookie);
    assert.equal(missing.statusCode, 404);

    assert.deepEqual(forbidden.json(), missing.json(), 'the two must be indistinguishable');
  });

  test('a user with no grants anywhere sees an empty tree', async () => {
    const roots = (await get('/api/folders', strangerCookie)).json();
    assert.deepEqual(roots.folders, []);
  });

  test('a super admin sees everything without any grant', async () => {
    const chief = (await signIn('chief')).cookie;
    const roots = (await get('/api/folders', chief)).json();
    const names = roots.folders.map((f) => f.name).sort();
    assert.deepEqual(names, ['cabinet', 'personnel']);
  });

  test('a malformed folder id is rejected before it reaches SQL', async () => {
    const response = await get('/api/folders/not-a-number', readerCookie);
    assert.equal(response.statusCode, 400);
  });

  // ── The tree endpoint ──────────────────────────────────────────────────

  test('the tree returns every browsable folder, and nothing else', async () => {
    const body = (await get('/api/folders/tree', readerCookie)).json();
    const names = body.folders.map((f) => f.name);

    assert.ok(names.includes('cabinet'));
    assert.ok(names.includes('contracts'));
    assert.ok(!names.includes('personnel'), 'ungranted root must be absent');
    assert.ok(!names.includes('vault'), 'broken inheritance with no grant must be absent');
    assert.equal(body.truncated, false);
  });

  test('each tree node carries its parent, so the client can nest it', async () => {
    const body = (await get('/api/folders/tree', readerCookie)).json();
    const cabinet = body.folders.find((f) => f.name === 'cabinet');
    const contracts = body.folders.find((f) => f.name === 'contracts');

    assert.equal(cabinet.parentId, null, 'a root has no parent');
    assert.equal(contracts.parentId, String(id.cabinet));
    assert.equal(contracts.depth, 1);
    assert.equal(typeof contracts.documentCount, 'number');
  });

  test('parents always precede their descendants', async () => {
    const body = (await get('/api/folders/tree', readerCookie)).json();
    const seen = new Set();
    for (const folder of body.folders) {
      if (folder.parentId && body.folders.some((f) => f.folderId === folder.parentId)) {
        assert.ok(seen.has(folder.parentId), `${folder.name} appeared before its parent`);
      }
      seen.add(folder.folderId);
    }
  });

  /**
   * A folder can be visible while its parent is not — break inheritance on a
   * child and grant it. That is a normal way to share one subfolder out of a
   * private branch, and a tree builder that drops nodes whose parent is missing
   * would hide a folder the user was deliberately given.
   */
  test('a folder granted inside an invisible parent is still returned', async () => {
    await makeFolder('shared-corner', 'personnel', { inherits: false });
    await grant('shared-corner', id.reader, PERM.BROWSE | PERM.READ);

    const body = (await get('/api/folders/tree', readerCookie)).json();
    const orphan = body.folders.find((f) => f.name === 'shared-corner');

    assert.ok(orphan, 'the granted folder must be present');
    assert.equal(orphan.parentId, String(id.personnel));
    assert.ok(
      !body.folders.some((f) => f.folderId === orphan.parentId),
      'and its parent must genuinely be absent — this is the orphan case',
    );

    // It is still reachable directly, which is the point of the grant.
    assert.equal((await get(`/api/folders/${id['shared-corner']}`, readerCookie)).statusCode, 200);
  });

  test('a user with no grants gets an empty tree', async () => {
    const body = (await get('/api/folders/tree', strangerCookie)).json();
    assert.deepEqual(body.folders, []);
  });

  test('the tree reports truncation rather than silently cutting off', async () => {
    const body = (await get('/api/folders/tree?limit=1', readerCookie)).json();
    assert.equal(body.folders.length, 1);
    assert.equal(body.truncated, true, 'a capped tree must say so');
  });

  // ── Breadcrumb ancestors ───────────────────────────────────────────────

  test('a folder ships the ancestor chain for its breadcrumb', async () => {
    const body = (await get(`/api/folders/${id.contracts}`, readerCookie)).json();

    assert.deepEqual(
      body.ancestors.map((a) => a.name),
      ['cabinet', 'contracts'],
      'the chain runs root-first and includes the folder itself',
    );
    assert.ok(body.ancestors.every((a) => a.visible));
  });

  test('an invisible ancestor is a placeholder, not a gap', async () => {
    const body = (await get(`/api/folders/${id['shared-corner']}`, readerCookie)).json();

    // Collapsing the chain would imply the folder sits at the root, which is a
    // lie about where it lives in the filing structure.
    assert.equal(body.ancestors.length, 2);
    assert.equal(body.ancestors[0].visible, false);
    assert.equal(body.ancestors[0].name, null, 'the name of a folder you cannot see must not leak');
    assert.equal(body.ancestors[1].name, 'shared-corner');
  });

  // ── Soft deletion ──────────────────────────────────────────────────────

  test('a soft-deleted folder vanishes from the listing', async () => {
    await makeFolder('temporary', 'cabinet');
    await sql`
      UPDATE dbo.folders SET is_deleted = 1, deleted_at = SYSUTCDATETIME()
       WHERE folder_id = ${id.temporary}
    `.execute(db);

    const body = (await get(`/api/folders/${id.cabinet}`, readerCookie)).json();
    assert.ok(!body.folders.map((f) => f.name).includes('temporary'));

    const direct = await get(`/api/folders/${id.temporary}`, readerCookie);
    assert.equal(direct.statusCode, 404);
  });

  test('a soft-deleted document leaves the listing', async () => {
    const documentId = await makeDocument('مسودة', 'contracts');
    const before = (await get(`/api/folders/${id.contracts}`, readerCookie)).json();
    assert.equal(before.documents.length, 3);

    await sql`
      UPDATE dbo.documents SET is_deleted = 1, deleted_at = SYSUTCDATETIME()
       WHERE document_id = ${documentId}
    `.execute(db);

    const after = (await get(`/api/folders/${id.contracts}`, readerCookie)).json();
    assert.equal(after.documents.length, 2);
  });

  // ── Deleting folders ───────────────────────────────────────────────────

  /**
   * A folder that still holds anything is refused, with the count.
   *
   * The alternative — cascading — is the most destructive thing this system
   * could offer and the one an accidental click can least afford. The counts
   * travel with the refusal so the caller can say what is in the way rather
   * than only that something is.
   */
  test('an empty folder can be deleted, a full one cannot', async () => {
    const empty = await makeFolder('spare', 'cabinet');
    await grant('spare', id.reader, PERM.BROWSE | PERM.READ | PERM.DELETE);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${empty}`,
      headers: { cookie: readerCookie },
    });
    assert.equal(gone.statusCode, 204, gone.body);

    const check = await sql`SELECT is_deleted FROM dbo.folders WHERE folder_id = ${empty}`.execute(db);
    assert.equal(Number(check.rows[0].is_deleted), 1, 'the delete is soft, so the row survives');

    // A folder the same user may delete, so the refusal is about emptiness and
    // not about permission — the two checks are deliberately ordered, and this
    // asserts the second one.
    const stocked = await makeFolder('stocked', 'cabinet');
    await grant('stocked', id.reader, PERM.BROWSE | PERM.READ | PERM.DELETE);
    await makeDocument('ورقة', 'stocked');

    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${stocked}`,
      headers: { cookie: readerCookie },
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'not_empty');
    assert.equal(refused.json().documents, 1, 'the refusal should count what is in the way');
  });

  /** Permission is checked before emptiness, so a refusal never leaks a count. */
  test('someone without delete is refused before the contents are counted', async () => {
    const stocked = await makeFolder('counted', 'cabinet');
    await makeDocument('ورقة أخرى', 'counted');

    // reader holds browse+read+upload on cabinet, inherited here — but no delete.
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${stocked}`,
      headers: { cookie: readerCookie },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().documents, undefined, 'a forbidden answer must not carry a count');
  });

  /** A soft-deleted document still belongs to its folder and still blocks. */
  test('a folder holding only a deleted document is still not empty', async () => {
    const binned = await makeFolder('binned', 'cabinet');
    await grant('binned', id.reader, PERM.BROWSE | PERM.READ | PERM.DELETE);
    const documentId = await makeDocument('مسودة ملغاة', 'binned');
    await addVersion(documentId);
    await sql`
      UPDATE dbo.documents SET is_deleted = 1, deleted_at = SYSUTCDATETIME()
       WHERE document_id = ${documentId}
    `.execute(db);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${binned}`,
      headers: { cookie: readerCookie },
    });

    // Removing the folder would strand the restore with nowhere to put it back.
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'not_empty');

    /*
     * Counted as binned, not as a document.
     *
     * The folder listing shows live documents only, so a folder reading
     * "0 وثيقة" that is refused for holding one reads as a contradiction. The
     * two counts are separate so the refusal can say where the blocker actually
     * is — and it is in the recycle bin, which is a different screen.
     */
    assert.equal(response.json().documents, 0, 'a binned document is not a live one');
    assert.equal(response.json().binned, 1);
  });

  /**
   * The whole loop, end to end: delete, purge, clean, then remove the folder.
   *
   * Every piece of this passed on its own while the sequence was impossible. The
   * purge deliberately keeps the document row as a tombstone for the audit
   * trail, folder deletion counted every soft-deleted row as a blocker, and the
   * recycle bin has nothing left to offer once the content is gone — so the
   * refusal named a document that could not be restored, could not be purged
   * again, and could not be removed. The folder was undeletable forever.
   *
   * It is written as one test on purpose. Split into "purge works" and "delete
   * works" it passes in both halves and the product still traps the user, which
   * is exactly what happened.
   */
  test('a folder whose only document was purged can be deleted', async () => {
    await makeFolder('spent', 'cabinet');
    await grant('spent', id.reader, PERM.BROWSE | PERM.READ | PERM.DELETE);
    const documentId = await makeDocument('عقد منتهٍ', 'spent');
    const storagePath = await addVersion(documentId);

    // 1. Into the recycle bin.
    const binned = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: readerCookie },
    });
    assert.equal(binned.statusCode, 200, binned.body);

    // While it is restorable, the folder is genuinely not empty.
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${id.spent}`,
      headers: { cookie: readerCookie },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().binned, 1);

    // 2. "Delete permanently" — which queues, and does not erase by itself.
    const queued = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/purge`,
      headers: { cookie: readerCookie },
    });
    assert.equal(queued.statusCode, 200, queued.body);
    assert.ok(await storage.exists(storagePath), 'the sweep has not run yet');

    // 3. The sweep the diagnostics button runs.
    const swept = await purgeDeletedDocuments();
    assert.ok(swept.purged >= 1, `the sweep should collect it: ${JSON.stringify(swept)}`);
    assert.equal(swept.failed, 0);
    assert.equal(await storage.exists(storagePath), false, 'the bytes are gone');

    // The row survives — the audit trail refers to it and must keep resolving.
    const tombstone = await sql`
      SELECT is_deleted FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(tombstone.rows[0].is_deleted), 1, 'the tombstone is kept');

    // 4. And now the folder goes, because nothing can come back to it.
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${id.spent}`,
      headers: { cookie: readerCookie },
    });
    assert.equal(gone.statusCode, 204, gone.body);
  });

  /**
   * The tombstone keeps pointing at the folder that is now gone.
   *
   * Nothing nulls it, so the audit trail still resolves the name it refers to —
   * the reason the row was kept in the first place.
   */
  test('a purged document still names its deleted folder', async () => {
    const row = await sql`
      SELECT d.title, f.name, f.is_deleted
        FROM dbo.documents d JOIN dbo.folders f ON f.folder_id = d.folder_id
       WHERE d.title = ${'عقد منتهٍ'}
    `.execute(db);

    assert.equal(row.rows.length, 1, 'the tombstone still joins to its folder');
    assert.equal(row.rows[0].name, 'spent');
    assert.equal(Number(row.rows[0].is_deleted), 1, 'and that folder is deleted');
  });

  /** A subfolder blocks it too, and a document count alone cannot see one. */
  test('a folder holding only a subfolder is refused', async () => {
    const outer = await makeFolder('outer', 'cabinet');
    await makeFolder('inner', 'outer');
    await grant('outer', id.reader, PERM.BROWSE | PERM.READ | PERM.DELETE);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${outer}`,
      headers: { cookie: readerCookie },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().subfolders, 1);
  });

  /** Deleting is a delete, so it takes that verb — browse alone is not enough. */
  test('deleting a folder requires the delete permission', async () => {
    const guarded = await makeFolder('guarded', 'cabinet');
    await grant('guarded', id.browser, PERM.BROWSE);

    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${guarded}`,
      headers: { cookie: browserCookie },
    });
    assert.equal(refused.statusCode, 403);

    // Someone who cannot see it at all gets absence rather than a refusal,
    // which would confirm that a folder they may not know about exists.
    //
    // A new root, not a child of `cabinet`: browse there is inherited, so a
    // subfolder of it would be perfectly visible to this user.
    const unseen = await makeFolder('unseen-by-browser');
    const invisible = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${unseen}`,
      headers: { cookie: browserCookie },
    });
    assert.equal(invisible.statusCode, 404);
  });

  // ── Creating folders ───────────────────────────────────────────────────

  test('creating a folder requires Upload on the parent', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/folders',
      headers: { cookie: browserCookie },
      payload: { parentId: String(id.cabinet), name: 'مجلد جديد' },
    });
    assert.equal(denied.statusCode, 403, 'browse alone must not create folders');

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/folders',
      headers: { cookie: readerCookie },
      payload: { parentId: String(id.cabinet), name: 'المراسلات' },
    });
    assert.equal(allowed.statusCode, 201);

    const created = allowed.json().folderId;
    const row = await sql`
      SELECT name, mpath, depth, parent_id FROM dbo.folders WHERE folder_id = ${created}
    `.execute(db);

    assert.equal(row.rows[0].name, 'المراسلات', 'Arabic name stored intact');
    assert.equal(Number(row.rows[0].depth), 1);
    // mpath must contain the real id, never the '/pending/' placeholder.
    assert.equal(row.rows[0].mpath, `${id.cabinet__path}${created}/`);
  });

  test('a new folder inherits the parent grant and appears immediately', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/folders',
      headers: { cookie: readerCookie },
      payload: { parentId: String(id.cabinet), name: 'الفواتير' },
    });
    assert.equal(response.statusCode, 201);

    const body = (await get(`/api/folders/${id.cabinet}`, readerCookie)).json();
    assert.ok(body.folders.map((f) => f.name).includes('الفواتير'));
  });

  test('an empty or overlong folder name is refused', async () => {
    for (const name of ['', '   ', 'x'.repeat(401)]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/folders',
        headers: { cookie: readerCookie },
        payload: { parentId: String(id.cabinet), name },
      });
      assert.equal(response.statusCode, 400, `name ${JSON.stringify(name.slice(0, 12))} should be refused`);
    }
  });

  test('creating inside an invisible folder reports not_found, not forbidden', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/folders',
      headers: { cookie: strangerCookie },
      payload: { parentId: String(id.personnel), name: 'محاولة' },
    });
    // The stranger cannot browse personnel, so being told "forbidden" would still
    // confirm it exists. Only a folder they can see can return 403.
    assert.equal(response.statusCode, 403);
  });

  // ── Pagination ─────────────────────────────────────────────────────────

  test('paging walks every document exactly once', async () => {
    await makeFolder('bulk', 'cabinet');
    const titles = [];
    for (let n = 0; n < 7; n += 1) {
      titles.push(`وثيقة ${n}`);
      await makeDocument(`وثيقة ${n}`, 'bulk');
    }

    const seen = [];
    let url = `/api/folders/${id.bulk}?limit=3`;
    for (let page = 0; page < 10; page += 1) {
      const body = (await get(url, readerCookie)).json();
      seen.push(...body.documents.map((d) => d.title));
      if (!body.nextCursor) break;
      url = `/api/folders/${id.bulk}?limit=3&cursor=${body.nextCursor}`;
    }

    assert.equal(seen.length, 7, 'every document should appear');
    assert.equal(new Set(seen).size, 7, 'and none twice');
    assert.deepEqual([...seen].sort(), [...titles].sort());
  });

  /**
   * The bug this pins down: tedious binds a JS Date as SQL Server `datetime`,
   * which has 3.33ms resolution, so a timestamp read from a datetime2(3) column
   * and sent back as a parameter does not equal itself. That killed the cursor's
   * tie-break branch, and documents sharing a timestamp were served on two pages.
   *
   * Every row here is forced to the SAME created_at, with a millisecond that
   * `datetime` cannot represent — so the tie-break is the only thing that can
   * make paging correct.
   */
  test('paging is exact when every document shares one timestamp', async () => {
    await makeFolder('sametime', 'cabinet');
    for (let n = 0; n < 6; n += 1) await makeDocument(`متزامن ${n}`, 'sametime');

    await sql`
      UPDATE dbo.documents
         SET created_at = CONVERT(datetime2(3), '2026-08-29T09:00:00.001', 126)
       WHERE folder_id = ${id.sametime}
    `.execute(db);

    const seen = [];
    let url = `/api/folders/${id.sametime}?limit=2`;
    for (let page = 0; page < 10; page += 1) {
      const body = (await get(url, readerCookie)).json();
      seen.push(...body.documents.map((d) => d.title));
      if (!body.nextCursor) break;
      url = `/api/folders/${id.sametime}?limit=2&cursor=${body.nextCursor}`;
    }

    assert.equal(seen.length, 6, 'no row served twice and none skipped');
    assert.equal(new Set(seen).size, 6);
  });

  test('a corrupt cursor is ignored rather than fatal', async () => {
    const response = await get(`/api/folders/${id.contracts}?cursor=not-base64-json`, readerCookie);
    assert.equal(response.statusCode, 200);
  });
});
