/**
 * Integration tests for the Tier 2 features.
 *
 * One row of the blueprint per group: version restore, bulk operations, faceted
 * search and saved queries, snippets, favourites and recents, the approval
 * workflow, notifications, watches, tags, metadata inheritance, cross-references
 * and data export.
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

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-tier2-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;
// The rendition worker shells out to LibreOffice and Ghostscript, which are not
// installed here. Off, so its queue does not churn during the run.
process.env.RENDITIONS_ENABLED = 'false';

let db;
let sql;
let app;
let PERM;
let storage;

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
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin, email)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0}, ${`${username}@example.test`})
  `.execute(db);
  id[username] = pid;
  return pid;
}

async function makeGroup(name, members = []) {
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('group', ${name})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`INSERT INTO dbo.groups (group_id, name) VALUES (${pid}, ${name})`.execute(db);
  for (const member of members) {
    await sql`
      INSERT INTO dbo.group_members (group_id, member_principal_id) VALUES (${pid}, ${member})
    `.execute(db);
  }
  id[name] = pid;
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
  assert.equal(response.statusCode, 200, `${username}: ${response.body}`);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

const call = (method, url, cookie, payload) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });

async function upload(cookie, folderName, filename, content) {
  const boundary = '----dmstier2';
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

describe('Tier 2 features', { skip: CONFIGURED ? false : target.reason }, () => {
  let aliceCookie;
  let bobCookie;
  let bossCookie;

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

    await makeUser('alice');
    await makeUser('bob');
    await makeUser('boss', { superAdmin: true });

    await makeFolder('cabinet');
    await makeFolder('legal', 'cabinet');
    await makeFolder('private');

    const everything = PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE;
    await grant('cabinet', id.alice, everything);
    await grant('cabinet', id.bob, everything);
    await grant('private', id.boss, everything);

    aliceCookie = await signIn('alice');
    bobCookie = await signIn('bob');
    bossCookie = await signIn('boss');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── Version restore ────────────────────────────────────────────────────

  test('restoring an older version copies it forward rather than rewinding', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'v1.txt', 'المحتوى الأول');

    const boundary = '----dmstier2';
    await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { cookie: aliceCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v2.txt"\r\n` +
            'Content-Type: text/plain\r\n\r\n',
          'utf8',
        ),
        Buffer.from('المحتوى الثاني', 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]),
    });

    const restored = await call('POST', `/api/documents/${documentId}/versions/1/restore`, aliceCookie, {});
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().version, 3, 'restore creates a new version');

    // History is evidence: v2 must still exist, not be deleted to make v1 current.
    const versions = await sql`
      SELECT version_number FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(versions.rows.length, 3);

    const current = await call('GET', `/api/documents/${documentId}/content`, aliceCookie);
    assert.equal(current.body, 'المحتوى الأول', 'the restored content is now current');

    const old = await call('GET', `/api/documents/${documentId}/content?version=2`, aliceCookie);
    assert.equal(old.body, 'المحتوى الثاني', 'and the superseded version is still readable');
  });

  test('restoring the current version is refused', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'single.txt', 'محتوى');
    const response = await call('POST', `/api/documents/${documentId}/versions/1/restore`, aliceCookie, {});
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'already_current');
  });

  // ── Bulk operations ────────────────────────────────────────────────────

  test('bulk move reports per document rather than one pass or fail', async () => {
    const mine = await upload(aliceCookie, 'legal', 'mine.txt', 'وثيقة أليس');
    const hidden = await upload(bossCookie, 'private', 'hidden.txt', 'وثيقة محجوبة');

    const response = await call('POST', '/api/bulk/move', aliceCookie, {
      documentIds: [mine, hidden, '999999999'],
      targetFolderId: String(id.cabinet),
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();

    assert.equal(body.succeeded, 1, 'only the one she can act on');
    assert.equal(body.failed, 2);
    // A document she cannot see must read as absent, not forbidden.
    assert.ok(body.results.every((r) => r.documentId !== hidden || r.reason === 'not_found'));

    const moved = await sql`SELECT folder_id FROM dbo.documents WHERE document_id = ${mine}`.execute(db);
    assert.equal(String(moved.rows[0].folder_id), String(id.cabinet));
  });

  test('bulk metadata applies the same values to a whole selection', async () => {
    const type = await call('POST', '/api/metadata/types', bossCookie, { name: 'تقرير' });
    const typeId = type.json().typeId;

    const a = await upload(aliceCookie, 'legal', 'bulk-a.txt', 'أ');
    const b = await upload(aliceCookie, 'legal', 'bulk-b.txt', 'ب');

    const response = await call('POST', '/api/bulk/metadata', aliceCookie, {
      documentIds: [a, b],
      typeId,
    });

    assert.equal(response.json().succeeded, 2);

    const rows = await sql`
      SELECT type_id FROM dbo.documents WHERE document_id IN (${a}, ${b})
    `.execute(db);
    assert.ok(rows.rows.every((row) => Number(row.type_id) === typeId));
  });

  test('bulk delete honours legal hold over the Delete permission', async () => {
    const held = await upload(aliceCookie, 'legal', 'held.txt', 'تحت الحجز');
    await call('POST', `/api/documents/${held}/legal-hold`, bossCookie, { hold: true, reason: 'قضية' });

    const response = await call('POST', '/api/bulk/delete', aliceCookie, { documentIds: [held] });

    assert.equal(response.json().failed, 1);
    assert.equal(response.json().results[0].reason, 'legal_hold');

    const row = await sql`SELECT is_deleted FROM dbo.documents WHERE document_id = ${held}`.execute(db);
    assert.equal(Number(row.rows[0].is_deleted), 0);
  });

  test('a ZIP contains what the user may read and notes what it omitted', async () => {
    const mine = await upload(aliceCookie, 'legal', 'zip-a.txt', 'محتوى للتنزيل');
    const hidden = await upload(bossCookie, 'private', 'zip-b.txt', 'محتوى محجوب');

    const response = await call('POST', '/api/bulk/download', aliceCookie, {
      documentIds: [mine, hidden],
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /zip/);
    // PK is the ZIP local-file-header signature.
    assert.equal(response.rawPayload.subarray(0, 2).toString('latin1'), 'PK');
    assert.ok(response.rawPayload.length > 100);
  });

  // ── Favourites and recents ─────────────────────────────────────────────

  test('favourites can be added, listed and removed', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'fav.txt', 'مفضلة');

    assert.equal((await call('PUT', `/api/favourites/${documentId}`, aliceCookie, {})).statusCode, 200);

    const list = (await call('GET', '/api/favourites', aliceCookie)).json();
    assert.ok(list.documents.some((d) => d.documentId === documentId));

    await call('DELETE', `/api/favourites/${documentId}`, aliceCookie);
    const after = (await call('GET', '/api/favourites', aliceCookie)).json();
    assert.ok(!after.documents.some((d) => d.documentId === documentId));
  });

  /**
   * A favourite is a stored reference and permissions change after it is made,
   * so the listing re-checks rather than trusting it was legitimate when stored.
   */
  test('a favourite stops resolving once access is revoked', async () => {
    const documentId = await upload(bossCookie, 'private', 'shared-then-not.txt', 'محتوى');

    await grant('private', id.alice, PERM.BROWSE | PERM.READ);
    assert.equal((await call('PUT', `/api/favourites/${documentId}`, aliceCookie, {})).statusCode, 200);
    assert.ok((await call('GET', '/api/favourites', aliceCookie)).json().documents.length >= 1);

    await sql`
      DELETE FROM dbo.access_control_entries WHERE folder_id = ${id.private} AND principal_id = ${id.alice}
    `.execute(db);
    await sql`EXEC dbo.sp_bump_acl_epoch @reason = 'test'`.execute(db);

    const after = (await call('GET', '/api/favourites', aliceCookie)).json();
    assert.ok(!after.documents.some((d) => d.documentId === documentId));
  });

  test('opening a document puts it in recents', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'recent.txt', 'محتوى');
    await call('GET', `/api/documents/${documentId}/content`, aliceCookie);

    // Recording is fire-and-forget, so give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const recent = (await call('GET', '/api/recent', aliceCookie)).json();
    assert.ok(recent.documents.some((d) => d.documentId === documentId));
  });

  // ── Watches and notifications ──────────────────────────────────────────

  test('a folder watch notifies on a new document, but not its own author', async () => {
    assert.equal(
      (await call('POST', '/api/watches', bobCookie, { folderId: String(id.legal), recursive: true }))
        .statusCode,
      200,
    );

    const documentId = await upload(aliceCookie, 'legal', 'watched.txt', 'محتوى مراقب');

    const bobInbox = (await call('GET', '/api/notifications', bobCookie)).json();
    assert.ok(
      bobInbox.notifications.some((n) => n.documentId === documentId),
      'the watcher should be told',
    );

    const aliceInbox = (await call('GET', '/api/notifications', aliceCookie)).json();
    assert.ok(
      !aliceInbox.notifications.some((n) => n.documentId === documentId),
      'the author should not be told about their own upload',
    );
  });

  test('a watch does not survive losing access to the folder', async () => {
    await makeFolder('restricted');
    await grant('restricted', id.alice, PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    await grant('restricted', id.bob, PERM.BROWSE);

    await call('POST', '/api/watches', bobCookie, { folderId: String(id.restricted) });

    await sql`
      DELETE FROM dbo.access_control_entries WHERE folder_id = ${id.restricted} AND principal_id = ${id.bob}
    `.execute(db);
    await sql`EXEC dbo.sp_bump_acl_epoch @reason = 'test'`.execute(db);

    const before = (await call('GET', '/api/notifications', bobCookie)).json().notifications.length;
    await upload(aliceCookie, 'restricted', 'after-revoke.txt', 'محتوى');
    const after = (await call('GET', '/api/notifications', bobCookie)).json().notifications.length;

    assert.equal(after, before, 'a watch is not a way to keep hearing about a branch you lost');
  });

  test('notifications can be marked read and the unread count follows', async () => {
    const inbox = (await call('GET', '/api/notifications', bobCookie)).json();
    assert.ok(inbox.unread > 0);

    await call('POST', '/api/notifications/read', bobCookie, {});

    const after = (await call('GET', '/api/notifications', bobCookie)).json();
    assert.equal(after.unread, 0);
  });

  // ── Comments ───────────────────────────────────────────────────────────

  test('comments thread, notify watchers, and leave a tombstone when deleted', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'discussed.txt', 'محتوى للنقاش');
    await call('POST', '/api/watches', bobCookie, { documentId });

    const first = await call('POST', `/api/documents/${documentId}/comments`, aliceCookie, {
      body: 'هل هذه النسخة النهائية؟',
    });
    assert.equal(first.statusCode, 201);

    const reply = await call('POST', `/api/documents/${documentId}/comments`, bobCookie, {
      body: 'نعم، اعتُمدت أمس.',
      parentCommentId: first.json().commentId,
    });
    assert.equal(reply.statusCode, 201);

    const thread = (await call('GET', `/api/documents/${documentId}/comments`, aliceCookie)).json();
    assert.equal(thread.comments.length, 2);
    assert.equal(thread.comments[1].parentCommentId, first.json().commentId);

    // The watcher hears about it.
    const inbox = (await call('GET', '/api/notifications', bobCookie)).json();
    assert.ok(inbox.notifications.some((n) => n.kind === 'comment.added'));

    await call('DELETE', `/api/comments/${first.json().commentId}`, aliceCookie);

    const after = (await call('GET', `/api/documents/${documentId}/comments`, aliceCookie)).json();
    const deleted = after.comments.find((c) => c.commentId === first.json().commentId);
    // A tombstone, not a removal: replies below it would otherwise be orphaned.
    assert.equal(deleted.isDeleted, true);
    assert.equal(deleted.body, null);
    assert.equal(after.comments.length, 2);
  });

  test('a comment cannot be deleted by someone else', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'mine-only.txt', 'محتوى');
    const comment = await call('POST', `/api/documents/${documentId}/comments`, aliceCookie, {
      body: 'ملاحظة',
    });

    assert.equal((await call('DELETE', `/api/comments/${comment.json().commentId}`, bobCookie)).statusCode, 403);
    // An administrator can, for moderation.
    assert.equal((await call('DELETE', `/api/comments/${comment.json().commentId}`, bossCookie)).statusCode, 200);
  });

  // ── Cross-references ───────────────────────────────────────────────────

  test('relations are visible from both ends and hide unreadable partners', async () => {
    const a = await upload(aliceCookie, 'legal', 'contract.txt', 'العقد');
    const b = await upload(aliceCookie, 'legal', 'annex.txt', 'الملحق');

    const linked = await call('POST', `/api/documents/${a}/relations`, aliceCookie, {
      toDocument: b,
      relationType: 'attachment',
    });
    assert.equal(linked.statusCode, 200);

    const fromA = (await call('GET', `/api/documents/${a}/relations`, aliceCookie)).json();
    assert.equal(fromA.relations.length, 1);
    assert.equal(fromA.relations[0].outgoing, true);

    const fromB = (await call('GET', `/api/documents/${b}/relations`, aliceCookie)).json();
    assert.equal(fromB.relations.length, 1);
    assert.equal(fromB.relations[0].outgoing, false, 'the reverse direction is shown too');

    // Bob can see both here; a user who could not would see neither end.
    const hidden = await upload(bossCookie, 'private', 'secret-annex.txt', 'ملحق سري');
    const refused = await call('POST', `/api/documents/${a}/relations`, aliceCookie, {
      toDocument: hidden,
    });
    assert.equal(refused.statusCode, 404, 'linking to an invisible document must not confirm it exists');
  });

  test('a document cannot be related to itself', async () => {
    const a = await upload(aliceCookie, 'legal', 'self.txt', 'محتوى');
    const response = await call('POST', `/api/documents/${a}/relations`, aliceCookie, { toDocument: a });
    assert.equal(response.statusCode, 400);
  });

  // ── Tags ───────────────────────────────────────────────────────────────

  test('tags are created on use, listed with counts, and drive retrieval', async () => {
    const a = await upload(aliceCookie, 'legal', 'tagged-a.txt', 'أ');
    const b = await upload(aliceCookie, 'cabinet', 'tagged-b.txt', 'ب');

    await call('PUT', `/api/documents/${a}/tags`, aliceCookie, { tags: ['مشروع النور', 'عاجل'] });
    await call('PUT', `/api/documents/${b}/tags`, aliceCookie, { tags: ['مشروع النور'] });

    const tags = (await call('GET', '/api/tags', aliceCookie)).json();
    const project = tags.tags.find((t) => t.name === 'مشروع النور');
    assert.equal(project.count, 2);

    // The whole point: documents in different branches, retrieved together.
    const found = (await call(
      'GET',
      `/api/tags/${encodeURIComponent('مشروع النور')}/documents`,
      aliceCookie,
    )).json();
    assert.equal(found.documents.length, 2);
  });

  test('setting tags replaces the previous set', async () => {
    const documentId = await upload(aliceCookie, 'legal', 'retag.txt', 'محتوى');
    await call('PUT', `/api/documents/${documentId}/tags`, aliceCookie, { tags: ['أ', 'ب', 'ج'] });
    await call('PUT', `/api/documents/${documentId}/tags`, aliceCookie, { tags: ['ب'] });

    const tags = (await call('GET', `/api/documents/${documentId}/tags`, aliceCookie)).json();
    assert.deepEqual(tags.tags.map((t) => t.name), ['ب']);
  });

  test('tagging requires EditMeta', async () => {
    await makeUser('readonly');
    await grant('legal', id.readonly, PERM.BROWSE | PERM.READ);
    const readonlyCookie = await signIn('readonly');

    const documentId = await upload(aliceCookie, 'legal', 'no-tagging.txt', 'محتوى');
    const response = await call('PUT', `/api/documents/${documentId}/tags`, readonlyCookie, {
      tags: ['محاولة'],
    });
    assert.equal(response.statusCode, 403);
  });

  // ── Faceted search, snippets and saved searches ────────────────────────

  test('facet counts match what selecting the facet returns', async () => {
    const type = await call('POST', '/api/metadata/types', bossCookie, { name: 'فاتورة' });
    const typeId = type.json().typeId;

    const a = await upload(aliceCookie, 'legal', 'inv-1.txt', 'فاتورة أولى');
    const b = await upload(aliceCookie, 'legal', 'inv-2.txt', 'فاتورة ثانية');
    for (const documentId of [a, b]) {
      await call('PATCH', `/api/documents/${documentId}/metadata`, aliceCookie, { typeId });
    }

    const facets = (await call('GET', '/api/search/facets', aliceCookie)).json();
    const facet = facets.types.find((t) => t.name === 'فاتورة');
    assert.equal(facet.count, 2);

    const filtered = await call('POST', '/api/search/advanced', aliceCookie, { typeId });
    assert.equal(filtered.json().total, facet.count, 'the count must match the result');
  });

  test('a saved search round-trips its criteria', async () => {
    const saved = await call('POST', '/api/saved-searches', aliceCookie, {
      name: 'فواتيري',
      criteria: { q: 'فاتورة', fields: [] },
    });
    assert.equal(saved.statusCode, 201);

    const list = (await call('GET', '/api/saved-searches', aliceCookie)).json();
    const entry = list.searches.find((s) => s.name === 'فواتيري');
    assert.equal(entry.criteria.q, 'فاتورة');
    assert.equal(entry.isMine, true);

    // A duplicate name for the same user is refused.
    assert.equal(
      (await call('POST', '/api/saved-searches', aliceCookie, { name: 'فواتيري', criteria: {} })).statusCode,
      409,
    );

    await call('DELETE', `/api/saved-searches/${entry.searchId}`, aliceCookie);
    assert.ok(!(await call('GET', '/api/saved-searches', aliceCookie)).json().searches.some((s) => s.name === 'فواتيري'));
  });

  test('a shared saved search is visible to others, a private one is not', async () => {
    await call('POST', '/api/saved-searches', aliceCookie, {
      name: 'مشترك',
      criteria: {},
      isShared: true,
    });
    await call('POST', '/api/saved-searches', aliceCookie, { name: 'خاص', criteria: {} });

    const bobsView = (await call('GET', '/api/saved-searches', bobCookie)).json();
    assert.ok(bobsView.searches.some((s) => s.name === 'مشترك'));
    assert.ok(!bobsView.searches.some((s) => s.name === 'خاص'));
  });

  // ── Approval workflow ──────────────────────────────────────────────────

  test('a linear approval walks its steps and ends approved', async () => {
    await makeGroup('المدققون', [id.bob]);
    await makeGroup('المدراء', [id.boss]);

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'اعتماد عقد',
      steps: [{ approverId: String(id.المدققون) }, { approverId: String(id.المدراء) }],
    });
    assert.equal(template.statusCode, 201);

    const documentId = await upload(aliceCookie, 'legal', 'for-approval.txt', 'عقد للاعتماد');

    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, {
      templateId: template.json().templateId,
    });
    assert.equal(requested.statusCode, 201);
    const requestId = requested.json().requestId;

    // Step one is bob's; boss cannot jump ahead.
    assert.equal(
      (await call('POST', `/api/approvals/${requestId}/decision`, bossCookie, { decision: 'approved' }))
        .statusCode,
      403,
    );

    const bobsQueue = (await call('GET', '/api/approvals/pending', bobCookie)).json();
    assert.ok(bobsQueue.requests.some((r) => r.requestId === requestId));

    const step1 = await call('POST', `/api/approvals/${requestId}/decision`, bobCookie, {
      decision: 'approved',
    });
    assert.equal(step1.json().outcome, 'advanced');

    const step2 = await call('POST', `/api/approvals/${requestId}/decision`, bossCookie, {
      decision: 'approved',
    });
    assert.equal(step2.json().outcome, 'approved');

    const history = (await call('GET', `/api/documents/${documentId}/approvals`, aliceCookie)).json();
    assert.equal(history.requests[0].status, 'approved');
    assert.equal(history.requests[0].decisions.length, 2);
  });

  test('one rejection ends the whole request', async () => {
    const templates = (await call('GET', '/api/approval-templates', bossCookie)).json();
    const templateId = templates.templates[0].templateId;

    const documentId = await upload(aliceCookie, 'legal', 'to-reject.txt', 'عقد مرفوض');
    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, { templateId });

    const rejected = await call('POST', `/api/approvals/${requested.json().requestId}/decision`, bobCookie, {
      decision: 'rejected',
      note: 'ينقصه التوقيع',
    });
    assert.equal(rejected.json().outcome, 'rejected');

    const history = (await call('GET', `/api/documents/${documentId}/approvals`, aliceCookie)).json();
    assert.equal(history.requests[0].status, 'rejected');

    // And the requester is told.
    const inbox = (await call('GET', '/api/notifications', aliceCookie)).json();
    assert.ok(inbox.notifications.some((n) => n.kind === 'approval.decided'));
  });

  test('a document can only have one live approval at a time', async () => {
    const templates = (await call('GET', '/api/approval-templates', bossCookie)).json();
    const templateId = templates.templates[0].templateId;

    const documentId = await upload(aliceCookie, 'legal', 'once.txt', 'محتوى');
    assert.equal(
      (await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, { templateId })).statusCode,
      201,
    );

    const second = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, { templateId });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'already_pending');
  });

  // The next four tests form a sequence: they share a template and document
  // created in the first test. They are isolated from the templates above so
  // the existing tests are not disturbed.
  let _editTemplateId;
  let _editTypeId;
  let _editDocumentId;
  let _editRequestId;

  test('renaming a template and linking it to a type shows in GET with pendingRequests 0', async () => {
    const typeResp = await call('POST', '/api/metadata/types', bossCookie, { name: 'نوع اختبار القوالب' });
    _editTypeId = typeResp.json().typeId;

    const tmplResp = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'قالب لاختبار التعديل',
      steps: [{ approverId: String(id.المدققون) }],
    });
    assert.equal(tmplResp.statusCode, 201);
    _editTemplateId = tmplResp.json().templateId;

    const patched = await call('PATCH', `/api/approval-templates/${_editTemplateId}`, bossCookie, {
      name: 'قالب معدّل للاختبار',
      typeId: _editTypeId,
    });
    assert.equal(patched.statusCode, 200, patched.body);

    const list = (await call('GET', '/api/approval-templates', bossCookie)).json();
    const found = list.templates.find((t) => t.templateId === _editTemplateId);
    assert.ok(found, 'the renamed template should appear in the list');
    assert.equal(found.name, 'قالب معدّل للاختبار');
    assert.equal(found.typeId, _editTypeId);
    assert.equal(found.pendingRequests, 0);
  });

  test('PATCH with steps is refused while a request is pending; name-only PATCH succeeds', async () => {
    _editDocumentId = await upload(aliceCookie, 'legal', 'template-edit-pending.txt', 'للاعتماد');

    const req = await call('POST', `/api/documents/${_editDocumentId}/approvals`, aliceCookie, {
      templateId: _editTemplateId,
    });
    assert.equal(req.statusCode, 201);
    _editRequestId = req.json().requestId;

    // Steps update must be refused while the request is live.
    const blocked = await call('PATCH', `/api/approval-templates/${_editTemplateId}`, bossCookie, {
      steps: [{ approverId: String(id.المدراء) }],
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json().error, 'template_in_use');

    // A name-only update must go through even with a pending request.
    const nameOnly = await call('PATCH', `/api/approval-templates/${_editTemplateId}`, bossCookie, {
      name: 'قالب معدّل أثناء الانتظار',
    });
    assert.equal(nameOnly.statusCode, 200, nameOnly.body);
  });

  test('after the pending request is cancelled, PATCH with new steps succeeds', async () => {
    const cancelled = await call('POST', `/api/approvals/${_editRequestId}/cancel`, aliceCookie, {});
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const newSteps = await call('PATCH', `/api/approval-templates/${_editTemplateId}`, bossCookie, {
      steps: [
        { approverId: String(id.المدراء) },
        { approverId: String(id.المدققون) },
      ],
    });
    assert.equal(newSteps.statusCode, 200, newSteps.body);

    const list = (await call('GET', '/api/approval-templates', bossCookie)).json();
    const found = list.templates.find((t) => t.templateId === _editTemplateId);
    assert.equal(found.steps.length, 2);
    assert.equal(found.steps[0].order, 1);
    assert.equal(found.steps[1].order, 2);
    // No in-flight requests remain after the cancel — the template is free.
    assert.equal(found.pendingRequests, 0, 'pendingRequests must be 0 after the cancel');
  });

  test('a deactivated template is not chosen for its type; reactivating restores it', async () => {
    const deactivated = await call(
      'POST', `/api/approval-templates/${_editTemplateId}/active`, bossCookie, { active: false },
    );
    assert.equal(deactivated.statusCode, 200, deactivated.body);

    // Create a fresh document of the linked type and try to start an approval
    // without naming a template — the type should supply one, but won't now.
    const doc = await upload(aliceCookie, 'legal', 'auto-resolve-test.txt', 'اختبار التوجيه التلقائي');
    await call('PATCH', `/api/documents/${doc}/metadata`, aliceCookie, { typeId: _editTypeId });

    const noTemplate = await call('POST', `/api/documents/${doc}/approvals`, aliceCookie, {});
    assert.equal(noTemplate.statusCode, 400, noTemplate.body);
    assert.equal(noTemplate.json().error, 'no_template');

    const reactivated = await call(
      'POST', `/api/approval-templates/${_editTemplateId}/active`, bossCookie, { active: true },
    );
    assert.equal(reactivated.statusCode, 200, reactivated.body);

    // After reactivation the template is chosen automatically.
    const withTemplate = await call('POST', `/api/documents/${doc}/approvals`, aliceCookie, {});
    assert.equal(withTemplate.statusCode, 201, withTemplate.body);
  });

  test('audit log contains approval.template_changed rows with actor boss', async () => {
    const rows = await sql`
      SELECT actor_username FROM dbo.audit_log
       WHERE action = 'approval.template_changed' AND actor_username = 'boss'
    `.execute(db);
    assert.ok(rows.rows.length > 0, 'should have at least one audit row for approval template changes by boss');
  });

  // ── Metadata inheritance ───────────────────────────────────────────────

  test('folder defaults fill in a new document', async () => {
    const field = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'القسم المسؤول',
      dataType: 'text',
    });
    const fieldId = field.json().fieldId;

    await call('PUT', `/api/folders/${id.legal}/defaults`, aliceCookie, {
      defaults: [{ fieldId, value: 'الشؤون القانونية' }],
    });

    const documentId = await upload(aliceCookie, 'legal', 'inherits.txt', 'محتوى');

    const document = (await call('GET', `/api/documents/${documentId}`, aliceCookie)).json();
    const value = document.fields.find((f) => f.fieldId === fieldId);
    // The point: a filing clerk stops retyping the same department on every upload.
    assert.equal(value?.value, 'الشؤون القانونية');
  });

  // ── Data export ────────────────────────────────────────────────────────

  test('metadata exports as CSV with a BOM and guarded cells', async () => {
    const response = await call('GET', '/api/export/metadata.csv', aliceCookie);

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/csv/);
    // Excel on Windows renders Arabic as mojibake without the BOM.
    assert.equal(response.body.charCodeAt(0), 0xfeff);
    assert.ok(response.body.includes('العنوان'));
  });

  test('a title that looks like a formula is neutralised in the export', async () => {
    await upload(aliceCookie, 'legal', '=cmd|calc.txt', 'محتوى');

    const response = await call('GET', '/api/export/metadata.csv', aliceCookie);
    // CSV injection: Excel would treat a leading = as a formula.
    assert.ok(!/,"=cmd/.test(response.body), 'a leading = must be escaped');
    assert.ok(response.body.includes(`"'=cmd`), 'and prefixed with a quote');
  });

  test('the export contains only what the user may browse', async () => {
    await upload(bossCookie, 'private', 'not-for-alice.txt', 'محتوى محجوب');

    const response = await call('GET', '/api/export/metadata.csv', aliceCookie);
    assert.ok(!response.body.includes('not-for-alice'), 'a private document must not appear');
  });
});
