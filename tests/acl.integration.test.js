/**
 * Integration tests for the permission model.
 *
 * These run against a real SQL Server and are skipped when DB_SERVER is not set,
 * so the offline suite stays fast. With .env configured, run them with:
 *
 *   npm run test:db
 *
 * seed() below DELETES every row in principals, users, groups, folders and
 * access_control_entries, so the suite never touches the application database:
 * resolveTestDatabase() redirects it to DB_NAME + "_test" (override with
 * TEST_DB_NAME) and throws if that resolves back to DB_NAME. The database is
 * created and migrated on first run.
 *
 * Each case below corresponds to a bypass or correctness bug reported by the
 * adversarial review of the schema design. They are regression tests for attacks,
 * not just happy-path coverage.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase } from './helpers/test-database.js';

// Load .env here as well as in src/config. The skip decision below is made at
// module-evaluation time, before anything imports the app's config, so without
// this the suite silently skips even when a database is configured.
loadEnv();

// Must happen before any dynamic import of src/config, src/db or src/lib/logger:
// config reads process.env once at import time and freezes it.
const target = resolveTestDatabase();
const CONFIGURED = target.configured;

let db;
let sql;
let PERM;
let ALL_PERMS;

/** Folder and principal ids created by seed(), keyed by name. */
const id = {};

async function seed() {
  // Clean slate, children before parents.
  await sql`DELETE FROM dbo.effective_permissions`.execute(db);
  await sql`DELETE FROM dbo.access_control_entries`.execute(db);
  await sql`DELETE FROM dbo.group_members`.execute(db);
  await sql`DELETE FROM dbo.folders WHERE parent_id IS NOT NULL`.execute(db);
  await sql`DELETE FROM dbo.folders`.execute(db);
  await sql`DELETE FROM dbo.users`.execute(db);
  await sql`DELETE FROM dbo.groups`.execute(db);
  await sql`DELETE FROM dbo.principals`.execute(db);

  const newUser = async (username, { superAdmin = false, active = true } = {}) => {
    const p = await sql`
      INSERT INTO dbo.principals (principal_type, display_name, is_active)
      OUTPUT INSERTED.principal_id AS pid
      VALUES ('user', ${username}, ${active ? 1 : 0})
    `.execute(db);
    const pid = p.rows[0].pid;
    await sql`
      INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin)
      VALUES (${pid}, ${username}, 'x', ${superAdmin ? 1 : 0})
    `.execute(db);
    id[username] = pid;
    return pid;
  };

  const newGroup = async (name) => {
    const p = await sql`
      INSERT INTO dbo.principals (principal_type, display_name)
      OUTPUT INSERTED.principal_id AS pid
      VALUES ('group', ${name})
    `.execute(db);
    const pid = p.rows[0].pid;
    await sql`INSERT INTO dbo.groups (group_id, name) VALUES (${pid}, ${name})`.execute(db);
    id[name] = pid;
    return pid;
  };

  /** Folders are created with the mpath the application layer would assign. */
  const newFolder = async (name, parentName = null, { inherits = true } = {}) => {
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
  };

  await newUser('alice');
  await newUser('bob');
  await newUser('root', { superAdmin: true });
  await newUser('ghost', { active: false });
  await newGroup('legal');
  await newGroup('everyone');

  // everyone contains legal contains alice  → alice is transitively in everyone.
  await sql`INSERT INTO dbo.group_members (group_id, member_principal_id) VALUES (${id.legal}, ${id.alice})`.execute(db);
  await sql`INSERT INTO dbo.group_members (group_id, member_principal_id) VALUES (${id.everyone}, ${id.legal})`.execute(db);

  //  cabinet
  //    └── contracts
  //          └── secret         (breaks inheritance)
  //    └── archive              (soft-deleted later)
  await newFolder('cabinet');
  await newFolder('contracts', 'cabinet');
  await newFolder('secret', 'contracts', { inherits: false });
  await newFolder('archive', 'cabinet');
}

async function grant(folderName, principalId, allow, deny = 0) {
  await sql`
    INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
    VALUES (${id[folderName]}, ${principalId}, ${allow}, ${deny})
  `.execute(db);
}

async function perms(userName, folderName) {
  const r = await sql`
    SELECT perm_bits FROM dbo.fn_effective_permission(${id[userName]}, ${id[folderName]})
  `.execute(db);
  return Number(r.rows[0]?.perm_bits ?? -1);
}

const has = (bits, verb) => (bits & verb) !== 0;

/**
 * Soft-deletes a folder for the duration of fn, then restores it.
 * Restoring in `finally` keeps one failing assertion from cascading into every
 * later test — which is exactly what happened the first time these were run.
 */
async function withDeleted(folderName, fn) {
  await sql`UPDATE dbo.folders SET is_deleted = 1 WHERE folder_id = ${id[folderName]}`.execute(db);
  try {
    await fn();
  } finally {
    await sql`UPDATE dbo.folders SET is_deleted = 0 WHERE folder_id = ${id[folderName]}`.execute(db);
  }
}

describe('permission model', { skip: CONFIGURED ? false : target.reason }, () => {
  before(async () => {
    // Create the test database before the pool tries to connect to it, then
    // migrate it — a fresh clone has no schema to seed into.
    await ensureTestDatabase(target.database);

    ({ db, sql } = await import('../src/db/index.js'));
    ({ PERM, ALL_PERMS } = await import('../src/db/migrations/0001-identity-and-acl.js'));

    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();

    await seed();
  });

  after(async () => {
    if (db) await db.destroy();
  });

  test('no grant means no access — absence denies', async () => {
    assert.equal(await perms('alice', 'cabinet'), 0);
  });

  test('a direct grant applies to the folder itself', async () => {
    await grant('cabinet', id.alice, PERM.BROWSE | PERM.READ);
    const bits = await perms('alice', 'cabinet');
    assert.ok(has(bits, PERM.BROWSE) && has(bits, PERM.READ));
    assert.ok(!has(bits, PERM.DELETE));
  });

  test('permissions inherit down the tree', async () => {
    const bits = await perms('alice', 'contracts');
    assert.ok(has(bits, PERM.READ), 'contracts should inherit from cabinet');
  });

  test('breaking inheritance stops the chain above it', async () => {
    // `secret` has inherits_acl = 0 and no ACE of its own.
    assert.equal(await perms('alice', 'secret'), 0);
  });

  test('a grant on a broken-inheritance folder still applies to it', async () => {
    await grant('secret', id.alice, PERM.BROWSE);
    const bits = await perms('alice', 'secret');
    assert.ok(has(bits, PERM.BROWSE));
    assert.ok(!has(bits, PERM.READ), 'must not pick up READ from the severed ancestor');
  });

  test('Browse without Read is representable — the core requirement', async () => {
    const bits = await perms('alice', 'secret');
    assert.ok(has(bits, PERM.BROWSE), 'can see the folder and its document titles');
    assert.ok(!has(bits, PERM.READ), 'cannot open the content');
  });

  test('group membership grants access', async () => {
    await grant('archive', id.legal, PERM.BROWSE | PERM.READ);
    assert.ok(has(await perms('alice', 'archive'), PERM.READ), 'alice is in legal');
    assert.equal(await perms('bob', 'archive'), 0, 'bob is not');
  });

  test('nested group membership is transitive', async () => {
    await grant('contracts', id.everyone, PERM.UPLOAD);
    // alice -> legal -> everyone
    assert.ok(has(await perms('alice', 'contracts'), PERM.UPLOAD));
  });

  test('DENY beats ALLOW regardless of where each sits in the chain', async () => {
    // alice has READ on cabinet, inherited by contracts. Deny READ further down.
    await grant('contracts', id.alice, 0, PERM.READ);
    const bits = await perms('alice', 'contracts');
    assert.ok(!has(bits, PERM.READ), 'a deny anywhere in the chain wins');
    assert.ok(has(bits, PERM.BROWSE), 'other verbs are unaffected');
  });

  test('a DENY on a group applies to its members', async () => {
    await grant('archive', id.alice, PERM.DELETE);
    await sql`
      UPDATE dbo.access_control_entries SET deny_bits = ${PERM.DELETE}
      WHERE folder_id = ${id.archive} AND principal_id = ${id.legal}
    `.execute(db);
    assert.ok(!has(await perms('alice', 'archive'), PERM.DELETE));
  });

  test('a soft-deleted folder yields no permissions', async () => {
    // Reported bypass: the hot query never joined back to the tree, so documents
    // in a soft-deleted folder stayed readable. The check lives in the function.
    const before_ = await perms('alice', 'archive');
    assert.ok(before_ > 0, 'precondition: alice can see archive');
    await withDeleted('archive', async () => {
      assert.equal(await perms('alice', 'archive'), 0);
    });
  });

  test('a soft-deleted ancestor severs its descendants', async () => {
    await withDeleted('cabinet', async () => {
      assert.equal(await perms('alice', 'contracts'), 0, 'a deleted ancestor severs the subtree');
      assert.equal(await perms('alice', 'secret'), 0,
        'even a folder that BREAKS ACL inheritance is severed — deletion is not an ACL concern');
    });
  });

  test('a deactivated user has no permissions anywhere', async () => {
    await grant('cabinet', id.ghost, ALL_PERMS);
    assert.equal(await perms('ghost', 'cabinet'), 0);
  });

  test('a super admin has every permission without any grant', async () => {
    assert.equal(await perms('root', 'secret'), ALL_PERMS);
    assert.equal(await perms('root', 'cabinet'), ALL_PERMS);
  });

  test('a super admin is still denied on a deleted folder', async () => {
    await withDeleted('archive', async () => {
      assert.equal(await perms('root', 'archive'), 0, 'deleted means gone, even for admins');
    });
  });

  test('a nonexistent folder or user returns 0, never an error', async () => {
    const r1 = await sql`SELECT perm_bits FROM dbo.fn_effective_permission(${id.alice}, 999999)`.execute(db);
    assert.equal(Number(r1.rows[0].perm_bits), 0);
    const r2 = await sql`SELECT perm_bits FROM dbo.fn_effective_permission(999999, ${id.cabinet})`.execute(db);
    assert.equal(Number(r2.rows[0].perm_bits), 0);
  });

  test('a cyclic group definition does not crash permission resolution', async () => {
    // Reported bug: a flat-membership cache rebuild aborted on a cycle and left the
    // table EMPTY, silently dropping every group-based DENY. Live expansion with a
    // depth cap cannot fail that way.
    await sql`INSERT INTO dbo.group_members (group_id, member_principal_id) VALUES (${id.legal}, ${id.everyone})`.execute(db);
    const bits = await perms('alice', 'archive');
    assert.ok(bits >= 0, 'resolution still returns a value with a group cycle present');
    await sql`DELETE FROM dbo.group_members WHERE group_id = ${id.legal} AND member_principal_id = ${id.everyone}`.execute(db);
  });

  test('the acl epoch advances and is single-row', async () => {
    const before_ = await sql`SELECT epoch FROM dbo.acl_epoch`.execute(db);
    await sql`EXEC dbo.sp_bump_acl_epoch @reason = 'test'`.execute(db);
    const after_ = await sql`SELECT epoch FROM dbo.acl_epoch`.execute(db);
    assert.equal(Number(after_.rows[0].epoch), Number(before_.rows[0].epoch) + 1);
    assert.equal(after_.rows.length, 1);
  });
});
