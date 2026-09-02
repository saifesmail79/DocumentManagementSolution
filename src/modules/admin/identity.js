/**
 * User, group and role administration.
 *
 * ─── The rule every mutation here obeys ─────────────────────────────────────
 *
 * Anything that can change what someone is allowed to do bumps acl_epoch, in
 * the SAME transaction as the change. Bumping afterwards leaves a window where
 * the ACL has moved but every cached permission row still looks current, and
 * that window is exactly when a just-revoked user makes their next request.
 *
 * That covers more than ACL edits: adding someone to a group, deactivating an
 * account and granting super-admin all change effective permissions without
 * touching an ACE.
 *
 * ─── Deactivate, do not delete ──────────────────────────────────────────────
 *
 * There is no user delete. Documents reference their creator, versions their
 * uploader, and the audit trail is worthless if the actor can be erased.
 * Deactivating ends every session immediately and removes all access, which is
 * what "remove this person" actually means here.
 */

import { randomBytes } from 'node:crypto';

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { hashPassword, checkPassword } from '../auth/passwords.js';
import { revokeAllSessions } from '../auth/sessions.js';

const log = moduleLogger('admin');

/** Bumps the permission-cache epoch. Must run inside the caller's transaction. */
async function bumpEpoch(trx, reason) {
  await sql`EXEC dbo.sp_bump_acl_epoch @reason = ${reason}`.execute(trx);
}

/**
 * Sentinel returned by cleanEmail when the address fails validation.
 * Using a symbol means callers cannot accidentally confuse it with null or a
 * string, so the check `=== INVALID_EMAIL` is always unambiguous.
 */
const INVALID_EMAIL = Symbol('invalid_email');

/**
 * Normalises and validates an email value from a request body.
 *
 * undefined  → undefined  (caller omitted the field; leave the DB row alone)
 * null / ''  → null       (explicit clear)
 * string     → trimmed address, or INVALID_EMAIL if it fails the plausibility
 *              check (one @, no whitespace, a dot after the @, max 255 chars)
 *
 * Callers turn INVALID_EMAIL into { ok: false, reason: 'invalid_email' }.
 */
function cleanEmail(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  if (trimmed.length > 255) return INVALID_EMAIL;
  // One @, no whitespace in either part, at least one dot after the @.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return INVALID_EMAIL;
  return trimmed;
}

// ── Users ────────────────────────────────────────────────────────────────

export async function listUsers({ search, includeInactive = true } = {}) {
  const pattern = search ? `%${String(search).replace(/[[\]%_]/g, (c) => `[${c}]`)}%` : null;

  const result = await sql`
    SELECT u.user_id, u.username, u.email, u.is_super_admin, u.must_change_password,
           u.failed_login_count, u.locked_until, u.last_login_at, u.created_at,
           p.display_name, p.is_active,
           (SELECT COUNT(*) FROM dbo.group_members gm WHERE gm.member_principal_id = u.user_id) AS group_count
      FROM dbo.users u
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE (${includeInactive ? 1 : 0} = 1 OR p.is_active = 1)
       AND (${pattern} IS NULL OR u.username LIKE ${pattern} OR p.display_name LIKE ${pattern})
     ORDER BY p.display_name
  `.execute(db);

  return result.rows.map((row) => ({
    userId: String(row.user_id),
    username: row.username,
    email: row.email ?? null,
    displayName: row.display_name,
    isActive: Number(row.is_active) === 1,
    isSuperAdmin: Number(row.is_super_admin) === 1,
    mustChangePassword: Number(row.must_change_password) === 1,
    isLocked: row.locked_until ? new Date(row.locked_until) > new Date() : false,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    groupCount: Number(row.group_count),
  }));
}

/**
 * Creates a user. With no password given, one is generated and returned once —
 * the account is flagged must_change_password so it works for a single login.
 */
export async function createUser({ username, displayName, email, password, isSuperAdmin = false }) {
  const name = String(username ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(name)) return { ok: false, reason: 'invalid_username' };

  const existing = await sql`SELECT user_id FROM dbo.users WHERE username = ${name}`.execute(db);
  if (existing.rows.length > 0) return { ok: false, reason: 'username_taken' };

  const cleanedEmail = cleanEmail(email);
  if (cleanedEmail === INVALID_EMAIL) return { ok: false, reason: 'invalid_email' };

  const generated = !password;
  const secret = generated ? randomBytes(18).toString('base64url') : password;

  const policy = await checkPassword(secret, { username: name });
  if (!policy.ok) {
    return { ok: false, reason: 'weak_password', problems: policy.problems, details: policy.details };
  }

  const hash = await hashPassword(secret);

  const userId = await db.transaction().execute(async (trx) => {
    const principal = await sql`
      INSERT INTO dbo.principals (principal_type, display_name)
      OUTPUT INSERTED.principal_id AS pid
      VALUES ('user', ${String(displayName ?? name).trim()})
    `.execute(trx);

    const pid = principal.rows[0].pid;

    await sql`
      INSERT INTO dbo.users
        (user_id, username, email, password_hash, is_super_admin, must_change_password, password_changed_at)
      VALUES (${pid}, ${name}, ${cleanedEmail ?? null}, ${hash}, ${isSuperAdmin ? 1 : 0}, ${generated ? 1 : 0}, SYSUTCDATETIME())
    `.execute(trx);

    // A new super admin gains permissions everywhere without any ACE.
    if (isSuperAdmin) await bumpEpoch(trx, `user created as super admin: ${name}`);
    return pid;
  });

  log.info({ userId: String(userId), username: name, isSuperAdmin }, 'user created');

  // The password is returned only when generated, and only here — it is never
  // stored or logged in readable form.
  return { ok: true, userId: String(userId), username: name, ...(generated ? { password: secret } : {}) };
}

/**
 * Updates a user's display name and/or email address.
 *
 * The username is intentionally not editable here. It is the login identity and
 * the audit trail stores usernames as plain text; renaming a user would silently
 * rewrite who every historical audit entry says acted, turning a reliable record
 * into a lie. Deactivate and recreate if the login name genuinely needs to change.
 *
 * No epoch bump: changing a display name or email address does not change what
 * the user may do, so cached permission rows remain valid.
 */
export async function updateUser({ userId, displayName, email }) {
  // displayName is optional — omitting it leaves the column alone.
  let name;
  if (displayName !== undefined) {
    name = String(displayName).trim();
    if (!name || name.length > 200) return { ok: false, reason: 'invalid_name' };
  }

  const cleanedEmail = cleanEmail(email);
  if (cleanedEmail === INVALID_EMAIL) return { ok: false, reason: 'invalid_email' };

  const found = await sql`SELECT user_id FROM dbo.users WHERE user_id = ${userId}`.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  // Nothing supplied: report success without touching the database.
  if (name === undefined && cleanedEmail === undefined) return { ok: true };

  // Two tables, one transaction: a name that changed while the address did not
  // is a half-applied edit the screen has no way to show.
  await db.transaction().execute(async (trx) => {
    if (name !== undefined) {
      await sql`
        UPDATE dbo.principals SET display_name = ${name} WHERE principal_id = ${userId}
      `.execute(trx);
    }

    // Only touch the email column if the caller explicitly sent it; undefined
    // means "leave it alone", null/'' means "clear it".
    if (cleanedEmail !== undefined) {
      await sql`UPDATE dbo.users SET email = ${cleanedEmail} WHERE user_id = ${userId}`.execute(trx);
    }
  });

  return { ok: true };
}

export async function setUserActive({ userId, active, actorId }) {
  const found = await sql`
    SELECT u.username, u.is_super_admin FROM dbo.users u WHERE u.user_id = ${userId}
  `.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  // Locking out the last way in is a real way to brick the system.
  if (!active && Number(found.rows[0].is_super_admin) === 1) {
    const remaining = await sql`
      SELECT COUNT(*) AS n FROM dbo.users u
        JOIN dbo.principals p ON p.principal_id = u.user_id
       WHERE u.is_super_admin = 1 AND p.is_active = 1 AND u.user_id <> ${userId}
    `.execute(db);
    if (Number(remaining.rows[0].n) === 0) return { ok: false, reason: 'last_super_admin' };
  }

  await db.transaction().execute(async (trx) => {
    await sql`
      UPDATE dbo.principals SET is_active = ${active ? 1 : 0} WHERE principal_id = ${userId}
    `.execute(trx);
    await bumpEpoch(trx, `user ${active ? 'activated' : 'deactivated'}: ${found.rows[0].username}`);
  });

  // Sessions are checked against principals.is_active on every request, so this
  // is belt and braces — but leaving a revoked user's session row alive is the
  // kind of detail that later becomes a bug.
  if (!active) await revokeAllSessions(userId);

  log.info({ userId: String(userId), active, actorId: String(actorId) }, 'user activation changed');
  return { ok: true };
}

export async function setSuperAdmin({ userId, isSuperAdmin, actorId }) {
  if (String(userId) === String(actorId) && !isSuperAdmin) {
    // Removing your own last privilege is almost always a mistake, and it can
    // leave nobody able to undo it.
    return { ok: false, reason: 'cannot_demote_self' };
  }

  const found = await sql`SELECT username FROM dbo.users WHERE user_id = ${userId}`.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  await db.transaction().execute(async (trx) => {
    await sql`
      UPDATE dbo.users SET is_super_admin = ${isSuperAdmin ? 1 : 0} WHERE user_id = ${userId}
    `.execute(trx);
    await bumpEpoch(trx, `super admin ${isSuperAdmin ? 'granted' : 'revoked'}: ${found.rows[0].username}`);
  });

  log.info({ userId: String(userId), isSuperAdmin }, 'super admin flag changed');
  return { ok: true };
}

/** Issues a temporary password. Every existing session is ended. */
export async function resetPassword({ userId }) {
  const found = await sql`SELECT username FROM dbo.users WHERE user_id = ${userId}`.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  const password = randomBytes(18).toString('base64url');

  await sql`
    UPDATE dbo.users
       SET password_hash = ${await hashPassword(password)},
           must_change_password = 1,
           password_changed_at = SYSUTCDATETIME(),
           failed_login_count = 0,
           locked_until = NULL
     WHERE user_id = ${userId}
  `.execute(db);

  const revoked = await revokeAllSessions(userId);

  log.info({ userId: String(userId), revoked }, 'password reset by an administrator');
  return { ok: true, password, revokedSessions: revoked };
}

/** Clears a lockout without changing the password. */
export async function unlockUser({ userId }) {
  const result = await sql`
    UPDATE dbo.users SET failed_login_count = 0, locked_until = NULL WHERE user_id = ${userId}
  `.execute(db);

  return Number(result.numAffectedRows ?? 0) === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

// ── Groups ───────────────────────────────────────────────────────────────

export async function listGroups() {
  const result = await sql`
    SELECT g.group_id, g.name, g.description, g.created_at, p.is_active,
           (SELECT COUNT(*) FROM dbo.group_members gm WHERE gm.group_id = g.group_id) AS member_count
      FROM dbo.groups g
      JOIN dbo.principals p ON p.principal_id = g.group_id
     ORDER BY g.name
  `.execute(db);

  return result.rows.map((row) => ({
    groupId: String(row.group_id),
    name: row.name,
    description: row.description,
    isActive: Number(row.is_active) === 1,
    memberCount: Number(row.member_count),
    createdAt: row.created_at,
  }));
}

export async function createGroup({ name, description }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };

  const existing = await sql`SELECT group_id FROM dbo.groups WHERE name = ${clean}`.execute(db);
  if (existing.rows.length > 0) return { ok: false, reason: 'name_taken' };

  const groupId = await db.transaction().execute(async (trx) => {
    const principal = await sql`
      INSERT INTO dbo.principals (principal_type, display_name)
      OUTPUT INSERTED.principal_id AS pid VALUES ('group', ${clean})
    `.execute(trx);
    const pid = principal.rows[0].pid;
    await sql`
      INSERT INTO dbo.groups (group_id, name, description)
      VALUES (${pid}, ${clean}, ${description?.trim() || null})
    `.execute(trx);
    return pid;
  });

  // A new empty group grants nothing, so no epoch bump is needed.
  log.info({ groupId: String(groupId), name: clean }, 'group created');
  return { ok: true, groupId: String(groupId) };
}

/**
 * Renames a group and optionally updates its description.
 *
 * The name change propagates to dbo.principals.display_name in the same
 * transaction because pickers, ACL views and member lists all read the
 * principal row, not the groups table. One transaction means the two columns
 * are never momentarily out of step.
 *
 * No epoch bump: renaming a group does not change the permissions it conveys.
 */
export async function updateGroup({ groupId, name, description }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };

  const found = await sql`
    SELECT g.group_id FROM dbo.groups g WHERE g.group_id = ${groupId}
  `.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  const duplicate = await sql`
    SELECT group_id FROM dbo.groups WHERE name = ${clean} AND group_id <> ${groupId}
  `.execute(db);
  if (duplicate.rows.length > 0) return { ok: false, reason: 'name_taken' };

  // description undefined → leave the column alone; null/'' → set to NULL.
  const desc = description === undefined ? undefined : (String(description ?? '').trim() || null);

  await db.transaction().execute(async (trx) => {
    if (desc !== undefined) {
      await sql`
        UPDATE dbo.groups SET name = ${clean}, description = ${desc} WHERE group_id = ${groupId}
      `.execute(trx);
    } else {
      await sql`
        UPDATE dbo.groups SET name = ${clean} WHERE group_id = ${groupId}
      `.execute(trx);
    }
    // Pickers and ACL views read display_name from principals, so keep it in sync.
    await sql`
      UPDATE dbo.principals SET display_name = ${clean} WHERE principal_id = ${groupId}
    `.execute(trx);
  });

  return { ok: true };
}

/**
 * Activates or deactivates a group.
 *
 * fn_expand_principals joins on principals.is_active = 1, so setting a group
 * inactive immediately stops it from conveying any permission to its members —
 * every cached permission row that came through the group becomes stale. The
 * epoch bump inside the transaction closes that window.
 *
 * Membership rows and ACEs are preserved so reactivating the group restores
 * exactly the access it had before, without any manual work by an administrator.
 */
export async function setGroupActive({ groupId, active }) {
  const found = await sql`
    SELECT principal_type FROM dbo.principals WHERE principal_id = ${groupId}
  `.execute(db);
  if (!found.rows[0] || found.rows[0].principal_type !== 'group') {
    return { ok: false, reason: 'not_found' };
  }

  await db.transaction().execute(async (trx) => {
    await sql`
      UPDATE dbo.principals SET is_active = ${active ? 1 : 0} WHERE principal_id = ${groupId}
    `.execute(trx);
    await bumpEpoch(trx, `group ${active ? 'activated' : 'deactivated'}: ${groupId}`);
  });

  log.info({ groupId: String(groupId), active }, 'group activation changed');
  return { ok: true };
}

export async function listGroupMembers(groupId) {
  const result = await sql`
    SELECT p.principal_id, p.principal_type, p.display_name, p.is_active, gm.added_at
      FROM dbo.group_members gm
      JOIN dbo.principals p ON p.principal_id = gm.member_principal_id
     WHERE gm.group_id = ${groupId}
     ORDER BY p.principal_type, p.display_name
  `.execute(db);

  return result.rows.map((row) => ({
    principalId: String(row.principal_id),
    type: row.principal_type,
    displayName: row.display_name,
    isActive: Number(row.is_active) === 1,
    addedAt: row.added_at,
  }));
}

/**
 * Adds a member to a group.
 *
 * Refuses to create a cycle. Permission resolution already survives one — there
 * is a regression test for a cyclic definition — but a cycle is never what an
 * administrator meant, and letting the UI build one produces a group structure
 * nobody can reason about.
 */
export async function addGroupMember({ groupId, principalId }) {
  if (String(groupId) === String(principalId)) return { ok: false, reason: 'cycle' };

  const principal = await sql`
    SELECT principal_type FROM dbo.principals WHERE principal_id = ${principalId}
  `.execute(db);
  if (!principal.rows[0]) return { ok: false, reason: 'not_found' };

  // If the group we are adding TO is already reachable from the member, adding
  // it would close a loop. Walk upward from the group through its ancestors.
  if (principal.rows[0].principal_type === 'group') {
    const reachable = await sql`
      WITH ancestors AS (
        SELECT group_id, member_principal_id FROM dbo.group_members
         WHERE member_principal_id = ${groupId}
        UNION ALL
        SELECT gm.group_id, gm.member_principal_id
          FROM dbo.group_members gm
          JOIN ancestors a ON a.group_id = gm.member_principal_id
      )
      SELECT COUNT(*) AS n FROM ancestors WHERE group_id = ${principalId}
      OPTION (MAXRECURSION 64)
    `.execute(db);

    if (Number(reachable.rows[0].n) > 0) return { ok: false, reason: 'cycle' };
  }

  const already = await sql`
    SELECT 1 AS x FROM dbo.group_members
     WHERE group_id = ${groupId} AND member_principal_id = ${principalId}
  `.execute(db);
  if (already.rows.length > 0) return { ok: true, alreadyMember: true };

  await db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO dbo.group_members (group_id, member_principal_id)
      VALUES (${groupId}, ${principalId})
    `.execute(trx);
    // Group membership is how most grants reach a user, so this changes
    // effective permissions without touching an ACE.
    await bumpEpoch(trx, 'group member added');
  });

  return { ok: true };
}

export async function removeGroupMember({ groupId, principalId }) {
  await db.transaction().execute(async (trx) => {
    await sql`
      DELETE FROM dbo.group_members
       WHERE group_id = ${groupId} AND member_principal_id = ${principalId}
    `.execute(trx);
    await bumpEpoch(trx, 'group member removed');
  });
  return { ok: true };
}

// ── Roles ────────────────────────────────────────────────────────────────

export async function listRoles() {
  const result = await sql`
    SELECT role_id, name, description, permission_bits, is_system
      FROM dbo.roles ORDER BY name
  `.execute(db);

  return result.rows.map((row) => ({
    roleId: Number(row.role_id),
    name: row.name,
    description: row.description,
    permissionBits: Number(row.permission_bits),
    isSystem: Number(row.is_system) === 1,
  }));
}

/**
 * Roles are templates. Their bits are copied onto an ACE when a grant is made
 * and are never consulted again, so editing a role does NOT change existing
 * grants — and therefore needs no epoch bump. That is deliberate: a live
 * reference would let reducing a role's bits silently leave inheriting
 * descendants over-permitted, which was a reported bypass in the design review.
 */
export async function createRole({ name, description, permissionBits }) {
  const clean = String(name ?? '').trim();
  const bits = Number(permissionBits);

  if (!clean || clean.length > 100) return { ok: false, reason: 'invalid_name' };
  if (!Number.isInteger(bits) || bits < 0 || bits > 63) return { ok: false, reason: 'invalid_bits' };

  const existing = await sql`SELECT role_id FROM dbo.roles WHERE name = ${clean}`.execute(db);
  if (existing.rows.length > 0) return { ok: false, reason: 'name_taken' };

  const result = await sql`
    INSERT INTO dbo.roles (name, description, permission_bits)
    OUTPUT INSERTED.role_id AS rid
    VALUES (${clean}, ${description?.trim() || null}, ${bits})
  `.execute(db);

  return { ok: true, roleId: Number(result.rows[0].rid) };
}

export async function updateRole({ roleId, name, description, permissionBits }) {
  const found = await sql`SELECT is_system FROM dbo.roles WHERE role_id = ${roleId}`.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };
  if (Number(found.rows[0].is_system) === 1) return { ok: false, reason: 'system_role' };

  const bits = permissionBits === undefined ? null : Number(permissionBits);
  if (bits !== null && (!Number.isInteger(bits) || bits < 0 || bits > 63)) {
    return { ok: false, reason: 'invalid_bits' };
  }

  await sql`
    UPDATE dbo.roles
       SET name = COALESCE(${name?.trim() || null}, name),
           description = COALESCE(${description?.trim() || null}, description),
           permission_bits = COALESCE(${bits}, permission_bits)
     WHERE role_id = ${roleId}
  `.execute(db);

  return { ok: true };
}

export async function deleteRole({ roleId }) {
  const found = await sql`SELECT is_system FROM dbo.roles WHERE role_id = ${roleId}`.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };
  if (Number(found.rows[0].is_system) === 1) return { ok: false, reason: 'system_role' };

  // Existing grants keep working: from_role_id is display metadata, and the bits
  // that matter were copied onto the ACE. Clearing the reference is enough.
  await db.transaction().execute(async (trx) => {
    await sql`
      UPDATE dbo.access_control_entries SET from_role_id = NULL WHERE from_role_id = ${roleId}
    `.execute(trx);
    await sql`DELETE FROM dbo.roles WHERE role_id = ${roleId}`.execute(trx);
  });

  return { ok: true };
}

/** Principals that can be granted permissions, for a picker. */
export async function listPrincipals({ search } = {}) {
  const pattern = search ? `%${String(search).replace(/[[\]%_]/g, (c) => `[${c}]`)}%` : null;

  const result = await sql`
    SELECT TOP (100) p.principal_id, p.principal_type, p.display_name, p.is_active,
           u.username
      FROM dbo.principals p
      LEFT JOIN dbo.users u ON u.user_id = p.principal_id
     WHERE p.is_active = 1
       AND (${pattern} IS NULL OR p.display_name LIKE ${pattern} OR u.username LIKE ${pattern})
     ORDER BY p.principal_type, p.display_name
  `.execute(db);

  return result.rows.map((row) => ({
    principalId: String(row.principal_id),
    type: row.principal_type,
    displayName: row.display_name,
    username: row.username,
  }));
}
