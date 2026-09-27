/**
 * Seeds a ready-to-test correspondence setup: two departments with their
 * groups and users, a mail-room group and user, the المراسلات folder branch
 * with sensible permissions, the units, and the module's settings — so the
 * whole وارد/صادر flow can be walked through minutes after running this.
 *
 *   node src/cli/seed-correspondence-demo.js
 *
 * Idempotent: anything that already exists (by name) is reused, not
 * duplicated, so running it twice is safe. Demo accounts get one shared,
 * printed password and no forced change — these are TEST users; deactivate
 * them before production.
 */

import { db, sql, closeDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from '../modules/auth/passwords.js';
import { PERM } from '../db/migrations/0001-identity-and-acl.js';

const PASSWORD = 'Demo!Wared2026';

const USERS = [
  { username: 'diwan', display: 'موظف قلم الوارد', group: 'قلم الوارد' },
  { username: 'fin1', display: 'موظف المالية الأول', group: 'الشؤون المالية' },
  { username: 'fin2', display: 'موظف المالية الثاني', group: 'الشؤون المالية' },
  { username: 'hr1', display: 'موظف الموارد البشرية', group: 'الموارد البشرية' },
];

const GROUPS = ['قلم الوارد', 'الشؤون المالية', 'الموارد البشرية'];

const UNITS = [
  { name: 'الشؤون المالية', group: 'الشؤون المالية' },
  { name: 'الموارد البشرية', group: 'الموارد البشرية' },
];

async function findGroup(name) {
  const found = await sql`SELECT group_id FROM dbo.groups WHERE name = ${name}`.execute(db);
  return found.rows[0]?.group_id ?? null;
}

async function ensureGroup(name) {
  const existing = await findGroup(name);
  if (existing) return { id: existing, created: false };

  const id = await db.transaction().execute(async (trx) => {
    const principal = await sql`
      INSERT INTO dbo.principals (principal_type, display_name)
      OUTPUT INSERTED.principal_id AS pid VALUES ('group', ${name})
    `.execute(trx);
    const pid = principal.rows[0].pid;
    await sql`INSERT INTO dbo.groups (group_id, name) VALUES (${pid}, ${name})`.execute(trx);
    return pid;
  });
  return { id, created: true };
}

async function ensureUser({ username, display }, passwordHash) {
  const found = await sql`SELECT user_id FROM dbo.users WHERE username = ${username}`.execute(db);
  if (found.rows[0]) return { id: found.rows[0].user_id, created: false };

  const id = await db.transaction().execute(async (trx) => {
    const principal = await sql`
      INSERT INTO dbo.principals (principal_type, display_name)
      OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${display})
    `.execute(trx);
    const pid = principal.rows[0].pid;
    await sql`
      INSERT INTO dbo.users
        (user_id, username, password_hash, is_super_admin, must_change_password, password_changed_at)
      VALUES (${pid}, ${username}, ${passwordHash}, 0, 0, SYSUTCDATETIME())
    `.execute(trx);
    return pid;
  });
  return { id, created: true };
}

async function ensureMembership(groupId, memberId) {
  await sql`
    IF NOT EXISTS (SELECT 1 FROM dbo.group_members
                    WHERE group_id = ${groupId} AND member_principal_id = ${memberId})
      INSERT INTO dbo.group_members (group_id, member_principal_id)
      VALUES (${groupId}, ${memberId})
  `.execute(db);
}

async function ensureFolder(name, parentId) {
  const found = await sql`
    SELECT folder_id FROM dbo.folders
     WHERE name = ${name} AND is_deleted = 0
       AND ((${parentId} IS NULL AND parent_id IS NULL) OR parent_id = ${parentId})
  `.execute(db);
  if (found.rows[0]) return { id: found.rows[0].folder_id, created: false };

  const id = await db.transaction().execute(async (trx) => {
    const parent = parentId
      ? await sql`SELECT mpath, depth FROM dbo.folders WHERE folder_id = ${parentId}`.execute(trx)
      : null;
    const depth = parent ? Number(parent.rows[0].depth) + 1 : 0;

    const inserted = await sql`
      INSERT INTO dbo.folders (parent_id, name, mpath, depth)
      OUTPUT INSERTED.folder_id AS fid
      VALUES (${parentId}, ${name}, '/pending/', ${depth})
    `.execute(trx);
    const fid = inserted.rows[0].fid;
    const mpath = parent ? `${parent.rows[0].mpath}${fid}/` : `/${fid}/`;
    await sql`UPDATE dbo.folders SET mpath = ${mpath} WHERE folder_id = ${fid}`.execute(trx);
    return fid;
  });
  return { id, created: true };
}

async function ensureAce(folderId, principalId, allowBits) {
  await sql`
    MERGE dbo.access_control_entries WITH (HOLDLOCK) AS target
    USING (SELECT ${folderId} AS folder_id, ${principalId} AS principal_id) AS source
       ON target.folder_id = source.folder_id AND target.principal_id = source.principal_id
    WHEN MATCHED THEN UPDATE SET allow_bits = target.allow_bits | ${allowBits}
    WHEN NOT MATCHED THEN
      INSERT (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (source.folder_id, source.principal_id, ${allowBits}, 0);
  `.execute(db);
}

async function ensureUnit({ name, groupId }) {
  const found = await sql`
    SELECT unit_id FROM dbo.correspondence_units WHERE name = ${name} AND is_active = 1
  `.execute(db);
  if (found.rows[0]) return { id: found.rows[0].unit_id, created: false };

  const inserted = await sql`
    INSERT INTO dbo.correspondence_units (name, group_id)
    OUTPUT INSERTED.unit_id AS uid VALUES (${name}, ${groupId})
  `.execute(db);
  return { id: inserted.rows[0].uid, created: true };
}

async function setSettingRow(key, value, type) {
  await sql`
    MERGE dbo.app_settings WITH (HOLDLOCK) AS target
    USING (SELECT ${key} AS setting_key) AS source
       ON target.setting_key = source.setting_key
    WHEN MATCHED THEN UPDATE SET value = ${value}, value_type = ${type}, updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (setting_key, value, value_type) VALUES (${key}, ${value}, ${type});
  `.execute(db);
}

async function main() {
  await runMigrations();

  const passwordHash = await hashPassword(PASSWORD);
  const made = [];

  const groupIds = {};
  for (const name of GROUPS) {
    const group = await ensureGroup(name);
    groupIds[name] = group.id;
    if (group.created) made.push(`group ${name}`);
  }

  for (const user of USERS) {
    const created = await ensureUser(user, passwordHash);
    await ensureMembership(groupIds[user.group], created.id);
    if (created.created) made.push(`user ${user.username}`);
  }

  const root = await ensureFolder('المراسلات', null);
  const incoming = await ensureFolder('الوارد', root.id);
  const outgoing = await ensureFolder('الصادر', root.id);
  if (root.created) made.push('folder المراسلات');

  // The mail room scans into the branch and fixes titles; departments read.
  const mailroomBits = PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META;
  const readerBits = PERM.BROWSE | PERM.READ;
  for (const folderId of [root.id, incoming.id, outgoing.id]) {
    await ensureAce(folderId, groupIds['قلم الوارد'], mailroomBits);
    await ensureAce(folderId, groupIds['الشؤون المالية'], readerBits);
    await ensureAce(folderId, groupIds['الموارد البشرية'], readerBits);
  }
  await sql`EXEC dbo.sp_bump_acl_epoch @reason = ${'correspondence demo seed'}`.execute(db);

  for (const unit of UNITS) {
    const created = await ensureUnit({ name: unit.name, groupId: groupIds[unit.group] });
    if (created.created) made.push(`unit ${unit.name}`);
  }

  await setSettingRow('correspondence.enabled', 'true', 'bool');
  await setSettingRow('correspondence.mailroom_group', String(groupIds['قلم الوارد']), 'int');
  // One common intake branch: the تسجيل كتاب screen scans here, and the
  // register (not the folder) says which book a letter belongs to.
  await setSettingRow('correspondence.intake_folder', String(root.id), 'int');

  console.log('');
  console.log('  Correspondence demo seed complete.');
  console.log(made.length ? `  Created: ${made.join(', ')}` : '  Everything already existed — nothing changed.');
  console.log('');
  console.log('  Test accounts (shared password, no forced change):');
  for (const user of USERS) {
    console.log(`    ${user.username.padEnd(8)} ${user.display} — ${user.group}`);
  }
  console.log(`  Password: ${PASSWORD}`);
  console.log('');
  console.log('  Module enabled, mail room = قلم الوارد, units: الشؤون المالية، الموارد البشرية.');
  console.log('  Folders: المراسلات/الوارد and المراسلات/الصادر (mail room uploads, departments read).');
  console.log('  If the server is running, restart it or wait ~10s for the settings cache.');
  console.log('');
}

try {
  await main();
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => {});
}
