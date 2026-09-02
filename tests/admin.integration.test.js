/**
 * Integration tests for administration.
 *
 * The permission model was built and tested first; this is the interface that
 * drives it. So these check the things that make the model safe to operate:
 * that every permission-affecting change invalidates the cache in the same
 * transaction, that a delegated folder owner can manage their own branch without
 * being an administrator, and that the obvious ways to lock yourself out are
 * refused.
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

async function signIn(username, password = PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200, `${username} could not sign in`);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

const call = (method, url, cookie, payload) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function epoch() {
  const r = await sql`SELECT epoch FROM dbo.acl_epoch WHERE lock_row = 1`.execute(db);
  return Number(r.rows[0].epoch);
}

async function permsOf(userId, folderId) {
  const r = await sql`
    SELECT perm_bits FROM dbo.fn_effective_permission(${userId}, ${folderId})
  `.execute(db);
  return Number(r.rows[0]?.perm_bits ?? 0);
}

describe('administration', { skip: CONFIGURED ? false : target.reason }, () => {
  let bossCookie;
  let clerkCookie;
  let ownerCookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('boss', { superAdmin: true });
    await makeUser('clerk');
    await makeUser('owner');
    await makeUser('subject');

    await makeFolder('cabinet');
    await makeFolder('legal', 'cabinet');

    // owner runs the legal branch without being an administrator.
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.legal}, ${id.owner}, ${PERM.BROWSE | PERM.READ | PERM.MANAGE_PERMS}, 0)
    `.execute(db);

    bossCookie = await signIn('boss');
    clerkCookie = await signIn('clerk');
    ownerCookie = await signIn('owner');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
  });

  // ── Who may administer ─────────────────────────────────────────────────

  test('identity administration is super-admin only', async () => {
    assert.equal((await call('GET', '/api/admin/users', clerkCookie)).statusCode, 403);
    assert.equal((await call('GET', '/api/admin/groups', clerkCookie)).statusCode, 403);
    assert.equal((await call('GET', '/api/admin/roles', clerkCookie)).statusCode, 403);
    assert.equal((await call('GET', '/api/admin/users', bossCookie)).statusCode, 200);
  });

  test('it requires a session at all', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/admin/users' });
    assert.equal(anonymous.statusCode, 401);
  });

  // ── Users ──────────────────────────────────────────────────────────────

  test('creating a user returns a one-time password and forces a change', async () => {
    const response = await call('POST', '/api/admin/users', bossCookie, {
      username: 'newhire',
      displayName: 'موظف جديد',
    });

    assert.equal(response.statusCode, 201);
    const { password, userId } = response.json();
    assert.ok(password, 'a generated password must be returned once');

    // It works exactly once, and only to change itself.
    const cookie = await signIn('newhire', password);
    assert.equal((await call('GET', '/api/auth/me', cookie)).json().user.mustChangePassword, true);
    assert.equal((await call('POST', '/api/auth/logout-all', cookie)).statusCode, 403);

    const stored = await sql`
      SELECT password_hash FROM dbo.users WHERE user_id = ${userId}
    `.execute(db);
    assert.notEqual(stored.rows[0].password_hash, password, 'the password must not be stored readable');
  });

  test('a duplicate username is refused', async () => {
    const response = await call('POST', '/api/admin/users', bossCookie, { username: 'clerk' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'username_taken');
  });

  test('a weak explicit password is refused with reasons', async () => {
    const response = await call('POST', '/api/admin/users', bossCookie, {
      username: 'weakling',
      password: 'short',
    });
    assert.equal(response.statusCode, 400);
    assert.ok(response.json().problems.length > 0);
  });

  /**
   * Deactivating changes what someone may do without touching a single ACE, so
   * it has to invalidate the permission cache like any other grant change.
   */
  test('deactivating a user bumps the permission epoch and ends their sessions', async () => {
    await makeUser('leaver');
    const cookie = await signIn('leaver');
    assert.equal((await call('GET', '/api/auth/me', cookie)).statusCode, 200);

    const before = await epoch();
    const response = await call('POST', `/api/admin/users/${id.leaver}/active`, bossCookie, {
      active: false,
    });

    assert.equal(response.statusCode, 200);
    assert.ok((await epoch()) > before, 'deactivation must invalidate cached permissions');
    assert.equal((await call('GET', '/api/auth/me', cookie)).statusCode, 401, 'session must be dead');
  });

  test('the last active super admin cannot be deactivated', async () => {
    // boss is the only super admin; removing them would leave nobody able to
    // administer the system and no way to undo it.
    const response = await call('POST', `/api/admin/users/${id.boss}/active`, bossCookie, {
      active: false,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'last_super_admin');
  });

  test('a super admin cannot demote themselves', async () => {
    const response = await call('POST', `/api/admin/users/${id.boss}/super-admin`, bossCookie, {
      isSuperAdmin: false,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'cannot_demote_self');
  });

  test('granting super admin bumps the epoch and takes effect', async () => {
    const before = await epoch();
    assert.equal(await permsOf(id.subject, id.cabinet), 0, 'no grants yet');

    const response = await call('POST', `/api/admin/users/${id.subject}/super-admin`, bossCookie, {
      isSuperAdmin: true,
    });

    assert.equal(response.statusCode, 200);
    assert.ok((await epoch()) > before);
    assert.ok(await permsOf(id.subject, id.cabinet), 'a super admin has permissions everywhere');

    await call('POST', `/api/admin/users/${id.subject}/super-admin`, bossCookie, {
      isSuperAdmin: false,
    });
    assert.equal(await permsOf(id.subject, id.cabinet), 0, 'and loses them again');
  });

  test('an administrator reset issues a temporary password and kills sessions', async () => {
    await makeUser('forgetful');
    const cookie = await signIn('forgetful');

    const response = await call('POST', `/api/admin/users/${id.forgetful}/reset-password`, bossCookie);
    assert.equal(response.statusCode, 200);

    const { password } = response.json();
    assert.equal((await call('GET', '/api/auth/me', cookie)).statusCode, 401, 'old session ends');
    assert.equal((await signIn('forgetful', password)) !== null, true, 'the new password works');
  });

  test('unlocking clears a lockout without changing the password', async () => {
    await makeUser('locked');
    for (let n = 0; n < 6; n += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'locked', password: 'wrong' },
      });
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'locked', password: PASSWORD },
    });
    assert.equal(blocked.statusCode, 423);

    assert.equal((await call('POST', `/api/admin/users/${id.locked}/unlock`, bossCookie)).statusCode, 200);
    await signIn('locked');
  });

  // ── Groups ─────────────────────────────────────────────────────────────

  test('group membership changes bump the epoch and grant access', async () => {
    const created = await call('POST', '/api/admin/groups', bossCookie, { name: 'الشؤون القانونية' });
    assert.equal(created.statusCode, 201);
    const groupId = created.json().groupId;

    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${groupId}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);

    assert.equal(await permsOf(id.clerk, id.cabinet), 0, 'not a member yet');

    const before = await epoch();
    const added = await call('POST', `/api/admin/groups/${groupId}/members`, bossCookie, {
      principalId: String(id.clerk),
    });

    assert.equal(added.statusCode, 200);
    assert.ok((await epoch()) > before, 'membership changes effective permissions');
    assert.ok(await permsOf(id.clerk, id.cabinet), 'the grant now reaches the member');

    await call('DELETE', `/api/admin/groups/${groupId}/members/${id.clerk}`, bossCookie);
    assert.equal(await permsOf(id.clerk, id.cabinet), 0, 'and stops when membership ends');
  });

  /**
   * Permission resolution already survives a cycle — there is a regression test
   * for one — but a cycle is never what an administrator meant, so the interface
   * that creates groups refuses to build one.
   */
  test('a group cycle is refused', async () => {
    const a = (await call('POST', '/api/admin/groups', bossCookie, { name: 'مجموعة أ' })).json().groupId;
    const b = (await call('POST', '/api/admin/groups', bossCookie, { name: 'مجموعة ب' })).json().groupId;

    assert.equal(
      (await call('POST', `/api/admin/groups/${a}/members`, bossCookie, { principalId: b })).statusCode,
      200,
    );

    // b is now inside a; putting a inside b would close the loop.
    const cyclic = await call('POST', `/api/admin/groups/${b}/members`, bossCookie, { principalId: a });
    assert.equal(cyclic.statusCode, 400);
    assert.equal(cyclic.json().error, 'cycle');

    const self = await call('POST', `/api/admin/groups/${a}/members`, bossCookie, { principalId: a });
    assert.equal(self.json().error, 'cycle');
  });

  // ── Folder permissions, delegated ──────────────────────────────────────

  test('MANAGE_PERMS lets a non-administrator run their own branch', async () => {
    // owner is an ordinary user with MANAGE_PERMS on `legal` only.
    assert.equal((await call('GET', `/api/admin/folders/${id.legal}/acl`, ownerCookie)).statusCode, 200);

    const granted = await call('PUT', `/api/admin/folders/${id.legal}/acl/${id.subject}`, ownerCookie, {
      allowBits: PERM.BROWSE | PERM.READ,
    });
    assert.equal(granted.statusCode, 200);
    assert.ok(await permsOf(id.subject, id.legal));
  });

  test('MANAGE_PERMS does not extend to folders it was not granted on', async () => {
    // `cabinet` is the parent; owner's grant is on `legal` and does not climb.
    const response = await call('GET', `/api/admin/folders/${id.cabinet}/acl`, ownerCookie);
    assert.equal(response.statusCode, 404, 'a folder they cannot browse must look absent');
  });

  test('an ordinary user cannot edit permissions', async () => {
    const response = await call('PUT', `/api/admin/folders/${id.legal}/acl/${id.clerk}`, clerkCookie, {
      allowBits: PERM.BROWSE,
    });
    assert.equal(response.statusCode, 404, 'clerk cannot browse legal, so it must look absent');
  });

  test('the ACL view shows inherited entries, not just local ones', async () => {
    await sql`
      MERGE dbo.access_control_entries AS t
      USING (SELECT ${id.cabinet} AS f, ${id.subject} AS p) AS s ON t.folder_id = s.f AND t.principal_id = s.p
      WHEN MATCHED THEN UPDATE SET allow_bits = ${PERM.BROWSE | PERM.READ}
      WHEN NOT MATCHED THEN INSERT (folder_id, principal_id, allow_bits, deny_bits)
        VALUES (s.f, s.p, ${PERM.BROWSE | PERM.READ}, 0);
    `.execute(db);

    const body = (await call('GET', `/api/admin/folders/${id.legal}/acl`, bossCookie)).json();

    // "Why can this person read this folder" is unanswerable from local entries
    // alone; the grant is usually several levels up.
    assert.ok(
      body.inherited.some((entry) => entry.principalId === String(id.subject)),
      'the ancestor grant should be shown',
    );
  });

  test('a grant that neither allows nor denies is refused as an empty entry', async () => {
    const response = await call('PUT', `/api/admin/folders/${id.legal}/acl/${id.clerk}`, bossCookie, {
      allowBits: 0,
      denyBits: 0,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'empty_entry');
  });

  test('DENY is storable and beats an inherited ALLOW', async () => {
    const response = await call('PUT', `/api/admin/folders/${id.legal}/acl/${id.subject}`, bossCookie, {
      allowBits: 0,
      denyBits: PERM.READ,
    });
    assert.equal(response.statusCode, 200);

    const bits = await permsOf(id.subject, id.legal);
    assert.equal((bits & PERM.READ) !== 0, false, 'deny must win over the inherited allow');
  });

  test('removing an entry revokes the access it granted', async () => {
    await call('PUT', `/api/admin/folders/${id.legal}/acl/${id.clerk}`, bossCookie, {
      allowBits: PERM.BROWSE,
    });
    assert.ok(await permsOf(id.clerk, id.legal));

    const before = await epoch();
    await call('DELETE', `/api/admin/folders/${id.legal}/acl/${id.clerk}`, bossCookie);

    assert.ok((await epoch()) > before);
    assert.equal(await permsOf(id.clerk, id.legal), 0);
  });

  // ── Inheritance ────────────────────────────────────────────────────────

  test('breaking inheritance copies the inherited entries down by default', async () => {
    await makeFolder('branch', 'cabinet');
    await call('PUT', `/api/admin/folders/${id.cabinet}/acl/${id.clerk}`, bossCookie, {
      allowBits: PERM.BROWSE | PERM.READ,
    });
    assert.ok(await permsOf(id.clerk, id.branch), 'inherited from cabinet');

    const response = await call('POST', `/api/admin/folders/${id.branch}/inheritance`, bossCookie, {
      inherits: false,
    });
    assert.equal(response.statusCode, 200);

    // "Stop following the parent, but keep what is here" is the usual intent;
    // without the copy, breaking inheritance silently locks everyone out.
    assert.ok(await permsOf(id.clerk, id.branch), 'access should survive the break');

    const acl = (await call('GET', `/api/admin/folders/${id.branch}/acl`, bossCookie)).json();
    assert.equal(acl.folder.inheritsAcl, false);
    assert.ok(acl.entries.some((e) => e.principalId === String(id.clerk)));
  });

  test('breaking inheritance without the copy severs access', async () => {
    await makeFolder('sealed', 'cabinet');
    assert.ok(await permsOf(id.clerk, id.sealed), 'inherited to start with');

    await call('POST', `/api/admin/folders/${id.sealed}/inheritance`, bossCookie, {
      inherits: false,
      copyInherited: false,
    });

    assert.equal(await permsOf(id.clerk, id.sealed), 0);
  });

  // ── Explaining a decision ──────────────────────────────────────────────

  test('explain reports the effective bits and the grants behind them', async () => {
    const response = await call(
      'GET',
      `/api/admin/folders/${id.legal}/acl/explain/${id.subject}`,
      bossCookie,
    );

    assert.equal(response.statusCode, 200);
    const body = response.json();

    // The bits come from the same function the real queries use, so the
    // explanation cannot drift from what is actually enforced.
    assert.equal(body.permissionBits, await permsOf(id.subject, id.legal));
    assert.ok(body.contributing.length > 0, 'the grants involved should be listed');
  });

  // ── Roles ──────────────────────────────────────────────────────────────

  test('a role is a template: editing it does not change existing grants', async () => {
    const created = await call('POST', '/api/admin/roles', bossCookie, {
      name: 'قارئ',
      permissionBits: PERM.BROWSE | PERM.READ,
    });
    assert.equal(created.statusCode, 201);
    const roleId = created.json().roleId;

    await makeFolder('roleTest', 'cabinet');
    await call('PUT', `/api/admin/folders/${id.roleTest}/acl/${id.subject}`, bossCookie, {
      allowBits: PERM.BROWSE | PERM.READ,
      roleId,
    });

    const before = await permsOf(id.subject, id.roleTest);

    // Reducing the role's bits must NOT silently reduce grants already made
    // from it — that was a reported bypass in the design review, and the reason
    // roles resolve to bits at grant time rather than staying a live reference.
    await call('PATCH', `/api/admin/roles/${roleId}`, bossCookie, { permissionBits: PERM.BROWSE });

    assert.equal(await permsOf(id.subject, id.roleTest), before, 'the existing grant is unchanged');
  });

  test('an out-of-range permission mask is refused', async () => {
    const response = await call('POST', '/api/admin/roles', bossCookie, {
      name: 'خارج النطاق',
      permissionBits: 9999,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_bits');
  });

  // ── Diagnostics ────────────────────────────────────────────────────────

  test('extraction stats are visible to an administrator', async () => {
    const response = await call('GET', '/api/admin/extraction/stats', bossCookie);
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(typeof body.queue.pending, 'number');
    // The OCR work list: documents stored and browsable whose contents nothing
    // can search.
    assert.equal(typeof body.documents.unindexed, 'number');
    assert.equal(typeof body.ocr.enabled, 'boolean');
  });

  /**
   * The cleanup button, over HTTP, including the part that explains a zero.
   *
   * The sweep and the folder rule are tested against the database elsewhere;
   * this covers the wire between them and the screen. A response of
   * `purged: 0` on its own is indistinguishable from a broken button — the
   * counts of what is still waiting are what make it readable, so they are part
   * of the contract, not a nicety.
   */
  test('the storage sweep reports what it did and what is still waiting', async () => {
    const dry = await call('POST', '/api/admin/storage/purge', bossCookie, { dryRun: true });
    assert.equal(dry.statusCode, 200, dry.body);

    const body = dry.json();
    assert.equal(body.documents.dryRun, true, 'a dry run must say so');
    assert.equal(typeof body.documents.purged, 'number');

    // Present whether or not anything was purged: this is the answer to "why 0?".
    assert.equal(typeof body.bin.waiting, 'number', 'still inside the grace period');
    assert.equal(typeof body.bin.tombstones, 'number', 'content already gone');
    assert.equal(typeof body.bin.graceDays, 'number');

    const real = await call('POST', '/api/admin/storage/purge', bossCookie, { dryRun: false });
    assert.equal(real.statusCode, 200, real.body);
    assert.equal(real.json().documents.dryRun, false);
    assert.equal(real.json().documents.failed, 0);
  });

  /** And it is an administrator's button, not everyone's. */
  test('an ordinary user cannot run the storage sweep', async () => {
    const response = await call('POST', '/api/admin/storage/purge', clerkCookie, { dryRun: false });
    assert.equal(response.statusCode, 403);
  });

  // ── User editing ───────────────────────────────────────────────────────

  test('creating a user with an email stores and returns it in the list', async () => {
    const response = await call('POST', '/api/admin/users', bossCookie, {
      username: 'emailuser',
      displayName: 'موظف بريد',
      email: 'emailuser@example.com',
    });
    assert.equal(response.statusCode, 201);

    // The list must surface the email that was stored at creation time.
    const list = await call('GET', '/api/admin/users', bossCookie);
    const found = list.json().find((u) => u.username === 'emailuser');
    assert.ok(found, 'user must appear in the list');
    assert.equal(found.email, 'emailuser@example.com');
  });

  test('PATCH /users/:userId changes display name and email and the list reflects both', async () => {
    await makeUser('editme');
    const userId = String(id.editme);

    const response = await call('PATCH', `/api/admin/users/${userId}`, bossCookie, {
      displayName: 'اسم معدّل',
      email: 'editme@example.com',
    });
    assert.equal(response.statusCode, 200);

    const list = await call('GET', '/api/admin/users', bossCookie);
    const found = list.json().find((u) => u.username === 'editme');
    assert.equal(found.displayName, 'اسم معدّل', 'display name must be updated');
    assert.equal(found.email, 'editme@example.com', 'email must be updated');
  });

  test('an invalid email in PATCH answers 400 invalid_email and changes nothing', async () => {
    await makeUser('nochange');
    const userId = String(id.nochange);

    // First set a valid email so we can assert it is unchanged after the bad request.
    await call('PATCH', `/api/admin/users/${userId}`, bossCookie, {
      displayName: 'لا تغيير',
      email: 'nochange@example.com',
    });

    const bad = await call('PATCH', `/api/admin/users/${userId}`, bossCookie, {
      displayName: 'لا تغيير',
      email: 'not-an-email',
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_email');

    // The stored email must be unchanged.
    const list = await call('GET', '/api/admin/users', bossCookie);
    const found = list.json().find((u) => u.username === 'nochange');
    assert.equal(found.email, 'nochange@example.com', 'email must not have changed after a failed update');
  });

  test('PATCH /users/:userId with an unknown id answers 404', async () => {
    const response = await call('PATCH', '/api/admin/users/999999999', bossCookie, {
      displayName: 'لا أحد',
    });
    assert.equal(response.statusCode, 404);
  });

  test('PATCH /users/:userId with only email keeps the display name and stores the email', async () => {
    await makeUser('emailonly');
    const userId = String(id.emailonly);

    // displayName is optional — sending only email must succeed.
    const response = await call('PATCH', `/api/admin/users/${userId}`, bossCookie, {
      email: 'only@example.test',
    });
    assert.equal(response.statusCode, 200, response.body);

    const list = await call('GET', '/api/admin/users', bossCookie);
    const found = list.json().find((u) => u.username === 'emailonly');
    assert.ok(found, 'user must still appear in the list');
    assert.equal(found.email, 'only@example.test', 'email must be stored');
    // The display name comes from makeUser — it must be unchanged.
    assert.ok(found.displayName, 'display name must be preserved');
  });

  // ── Group editing and activation ───────────────────────────────────────

  test('PATCH /groups/:groupId renames the group and the name appears in both the groups list and the principals picker', async () => {
    const created = await call('POST', '/api/admin/groups', bossCookie, { name: 'مجموعة قديمة' });
    assert.equal(created.statusCode, 201);
    const groupId = created.json().groupId;

    const renamed = await call('PATCH', `/api/admin/groups/${groupId}`, bossCookie, {
      name: 'مجموعة محدّثة',
    });
    assert.equal(renamed.statusCode, 200);

    // Both the groups list and the principals picker must reflect the new name.
    const groups = (await call('GET', '/api/admin/groups', bossCookie)).json().groups;
    assert.ok(
      groups.some((g) => g.groupId === groupId && g.name === 'مجموعة محدّثة'),
      'renamed group must appear in GET /groups',
    );

    const principals = (await call('GET', '/api/admin/principals?q=مجموعة محدّثة', bossCookie)).json().principals;
    assert.ok(
      principals.some((p) => p.principalId === groupId),
      'renamed group must appear in the principals picker under the new name',
    );
  });

  test('renaming a group to an already-taken name answers 409 name_taken', async () => {
    await call('POST', '/api/admin/groups', bossCookie, { name: 'اسم مأخوذ' });
    const second = await call('POST', '/api/admin/groups', bossCookie, { name: 'مجموعة ثانية' });
    const groupId = second.json().groupId;

    const response = await call('PATCH', `/api/admin/groups/${groupId}`, bossCookie, { name: 'اسم مأخوذ' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'name_taken');
  });

  /**
   * Deactivating a group must withdraw every permission it conveyed in the same
   * transaction. Reactivating must restore them without any manual step.
   */
  test('deactivating a group bumps the epoch, drops member permissions, and reactivating restores them', async () => {
    await makeUser('grpmember');

    // Create a group, give it an ACE on cabinet, add the member.
    const groupRes = await call('POST', '/api/admin/groups', bossCookie, { name: 'مجموعة مؤقتة' });
    assert.equal(groupRes.statusCode, 201);
    const groupId = groupRes.json().groupId;

    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${groupId}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);

    await call('POST', `/api/admin/groups/${groupId}/members`, bossCookie, {
      principalId: String(id.grpmember),
    });

    // The member must now have access.
    assert.ok((await permsOf(id.grpmember, id.cabinet)) > 0, 'member must have permission via the group');

    const before = await epoch();

    const deactivated = await call('POST', `/api/admin/groups/${groupId}/active`, bossCookie, { active: false });
    assert.equal(deactivated.statusCode, 200);

    // Epoch must have been bumped inside the same transaction.
    assert.ok((await epoch()) > before, 'deactivation must bump the ACL epoch');

    // The member must have lost access.
    assert.equal(await permsOf(id.grpmember, id.cabinet), 0, 'member must lose permission when group is deactivated');

    // The list must report the group as inactive.
    const groups = (await call('GET', '/api/admin/groups', bossCookie)).json().groups;
    const found = groups.find((g) => g.groupId === groupId);
    assert.equal(found.isActive, false, 'GET groups must show isActive false');

    // Reactivating must restore access without any manual intervention.
    await call('POST', `/api/admin/groups/${groupId}/active`, bossCookie, { active: true });
    assert.ok((await permsOf(id.grpmember, id.cabinet)) > 0, 'reactivation must restore the permission');
  });

  // ── Audit trail ────────────────────────────────────────────────────────

  /**
   * The audit tests run after all the mutation tests above so they can assert
   * that every expected action was recorded. They query the table directly
   * rather than through the API because the API paginates and filters — querying
   * the table is the only way to be certain a row is actually there.
   */
  test('audit log contains expected entries for identity and permission mutations by boss', async () => {
    const rows = await sql`
      SELECT action FROM dbo.audit_log WHERE actor_username = 'boss'
    `.execute(db);

    const actions = rows.rows.map((r) => r.action);

    // user.created: every POST /users call above writes this.
    assert.ok(actions.includes('user.created'), 'user.created must be in the audit log');

    // user.updated: PATCH /users/:userId above writes this.
    assert.ok(actions.includes('user.updated'), 'user.updated must be in the audit log');

    // group.updated: PATCH /groups/:groupId above writes this.
    assert.ok(actions.includes('group.updated'), 'group.updated must be in the audit log');

    // group.deactivated: POST /groups/:groupId/active with active false above writes this.
    assert.ok(actions.includes('group.deactivated'), 'group.deactivated must be in the audit log');

    // group.activated: the group is reactivated later in the same deactivation test.
    assert.ok(actions.includes('group.activated'), 'group.activated must be in the audit log');

    // acl.entry_set: PUT /folders/:folderId/acl/:principalId is called in several
    // tests above (e.g. "DENY is storable" and "a role is a template").
    assert.ok(actions.includes('acl.entry_set'), 'acl.entry_set must be in the audit log');
  });
});
