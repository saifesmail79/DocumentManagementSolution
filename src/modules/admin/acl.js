/**
 * Folder permission management.
 *
 * Gated on MANAGE_PERMS for the folder in question, not on super-admin: the
 * point of having the verb is that a department can run its own branch without
 * an administrator in the loop. Super-admins pass the same check because
 * fn_effective_permission grants them every bit.
 *
 * Every mutation bumps acl_epoch inside its own transaction. See identity.js for
 * why that ordering matters.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, permissionBits, has, describeBits } from '../tree/service.js';

const log = moduleLogger('admin');

async function bumpEpoch(trx, reason) {
  await sql`EXEC dbo.sp_bump_acl_epoch @reason = ${reason}`.execute(trx);
}

/**
 * Checks MANAGE_PERMS, distinguishing "no such folder" from "not allowed".
 *
 * A folder the caller cannot even browse reports not_found, so probing ids
 * cannot be used to map the filing structure.
 */
async function requireManage(userId, folderId) {
  const bits = await permissionBits(userId, folderId);
  if (has(bits, PERM.MANAGE_PERMS)) return { ok: true };
  return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
}

/**
 * The access list for one folder: its own entries, plus what it inherits.
 *
 * Inherited entries are shown because "why can this person read this folder" is
 * unanswerable from the folder's own ACEs alone — the grant is usually several
 * levels up, and hiding it is what makes permission systems feel like guesswork.
 */
export async function getFolderAcl(userId, folderId) {
  const allowed = await requireManage(userId, folderId);
  if (!allowed.ok) return allowed;

  const folder = await sql`
    SELECT folder_id, name, mpath, inherits_acl, parent_id
      FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);

  if (!folder.rows[0]) return { ok: false, reason: 'not_found' };
  const row = folder.rows[0];

  const own = await sql`
    SELECT a.ace_id, a.principal_id, a.allow_bits, a.deny_bits, a.from_role_id,
           a.created_at, p.display_name, p.principal_type, p.is_active,
           r.name AS role_name
      FROM dbo.access_control_entries a
      JOIN dbo.principals p ON p.principal_id = a.principal_id
      LEFT JOIN dbo.roles r ON r.role_id = a.from_role_id
     WHERE a.folder_id = ${folderId}
     ORDER BY p.principal_type, p.display_name
  `.execute(db);

  // Ancestors from the materialized path, stopping where inheritance is broken.
  const ancestorIds = String(row.mpath)
    .split('/')
    .filter(Boolean)
    .filter((value) => value !== String(folderId));

  let inherited = [];
  if (Number(row.inherits_acl) === 1 && ancestorIds.length > 0) {
    const result = await sql`
      SELECT a.folder_id, f.name AS folder_name, a.principal_id, a.allow_bits, a.deny_bits,
             p.display_name, p.principal_type
        FROM dbo.access_control_entries a
        JOIN dbo.folders f ON f.folder_id = a.folder_id
        JOIN dbo.principals p ON p.principal_id = a.principal_id
       WHERE a.folder_id IN (${sql.join(ancestorIds.map((value) => sql`${value}`))})
       ORDER BY f.depth
    `.execute(db);
    inherited = result.rows;
  }

  return {
    ok: true,
    folder: {
      folderId: String(row.folder_id),
      name: row.name,
      parentId: row.parent_id === null ? null : String(row.parent_id),
      inheritsAcl: Number(row.inherits_acl) === 1,
    },
    entries: own.rows.map((entry) => ({
      aceId: String(entry.ace_id),
      principalId: String(entry.principal_id),
      principalType: entry.principal_type,
      displayName: entry.display_name,
      isActive: Number(entry.is_active) === 1,
      allow: describeBits(Number(entry.allow_bits)),
      deny: describeBits(Number(entry.deny_bits)),
      allowBits: Number(entry.allow_bits),
      denyBits: Number(entry.deny_bits),
      fromRole: entry.role_name,
      createdAt: entry.created_at,
    })),
    inherited: inherited.map((entry) => ({
      folderId: String(entry.folder_id),
      folderName: entry.folder_name,
      principalId: String(entry.principal_id),
      principalType: entry.principal_type,
      displayName: entry.display_name,
      allowBits: Number(entry.allow_bits),
      denyBits: Number(entry.deny_bits),
      allow: describeBits(Number(entry.allow_bits)),
      deny: describeBits(Number(entry.deny_bits)),
    })),
  };
}

/**
 * Creates or replaces one principal's entry on a folder.
 *
 * allow and deny are stored separately rather than as one value, because DENY
 * beats ALLOW globally and "no opinion" has to be distinguishable from "denied".
 */
export async function setFolderAce({ userId, folderId, principalId, allowBits, denyBits = 0, roleId = null }) {
  const allowed = await requireManage(userId, folderId);
  if (!allowed.ok) return allowed;

  const allow = Number(allowBits) || 0;
  const deny = Number(denyBits) || 0;

  if (!Number.isInteger(allow) || allow < 0 || allow > 63) return { ok: false, reason: 'invalid_bits' };
  if (!Number.isInteger(deny) || deny < 0 || deny > 63) return { ok: false, reason: 'invalid_bits' };
  // CK_ace_bits refuses an entry that neither allows nor denies anything; such
  // an entry means "remove the entry", so say that rather than failing on a
  // constraint the caller cannot see.
  if ((allow | deny) === 0) return { ok: false, reason: 'empty_entry' };

  const principal = await sql`
    SELECT principal_id FROM dbo.principals WHERE principal_id = ${principalId}
  `.execute(db);
  if (!principal.rows[0]) return { ok: false, reason: 'principal_not_found' };

  await db.transaction().execute(async (trx) => {
    // MERGE on the (folder, principal) unique constraint: one entry per
    // principal per folder, edited in place.
    await sql`
      MERGE dbo.access_control_entries WITH (HOLDLOCK) AS target
      USING (SELECT ${folderId} AS folder_id, ${principalId} AS principal_id) AS source
         ON target.folder_id = source.folder_id AND target.principal_id = source.principal_id
      WHEN MATCHED THEN
        UPDATE SET allow_bits = ${allow}, deny_bits = ${deny}, from_role_id = ${roleId}
      WHEN NOT MATCHED THEN
        INSERT (folder_id, principal_id, allow_bits, deny_bits, from_role_id, created_by)
        VALUES (source.folder_id, source.principal_id, ${allow}, ${deny}, ${roleId}, ${userId});
    `.execute(trx);

    await bumpEpoch(trx, 'ace set');
  });

  log.info(
    { folderId: String(folderId), principalId: String(principalId), allow, deny },
    'permission entry set',
  );
  return { ok: true };
}

export async function removeFolderAce({ userId, folderId, principalId }) {
  const allowed = await requireManage(userId, folderId);
  if (!allowed.ok) return allowed;

  await db.transaction().execute(async (trx) => {
    await sql`
      DELETE FROM dbo.access_control_entries
       WHERE folder_id = ${folderId} AND principal_id = ${principalId}
    `.execute(trx);
    await bumpEpoch(trx, 'ace removed');
  });

  log.info({ folderId: String(folderId), principalId: String(principalId) }, 'permission entry removed');
  return { ok: true };
}

/**
 * Breaks or restores inheritance.
 *
 * Breaking it severs the folder from everything above: whoever had access
 * through an ancestor loses it here immediately. When breaking, the currently
 * inherited entries are optionally copied down first, so the common intent —
 * "stop following the parent from now on, but keep what is here" — does not
 * require re-granting everything by hand.
 */
export async function setInheritance({ userId, folderId, inherits, copyInherited = true }) {
  const allowed = await requireManage(userId, folderId);
  if (!allowed.ok) return allowed;

  const current = await getFolderAcl(userId, folderId);
  if (!current.ok) return current;

  await db.transaction().execute(async (trx) => {
    if (!inherits && copyInherited && current.inherited.length > 0) {
      // Nearest ancestor wins when the same principal appears at several levels:
      // inherited is ordered by depth, so a later row overwrites an earlier one.
      const effective = new Map();
      for (const entry of current.inherited) {
        effective.set(entry.principalId, entry);
      }

      for (const entry of effective.values()) {
        await sql`
          MERGE dbo.access_control_entries WITH (HOLDLOCK) AS target
          USING (SELECT ${folderId} AS folder_id, ${entry.principalId} AS principal_id) AS source
             ON target.folder_id = source.folder_id AND target.principal_id = source.principal_id
          WHEN NOT MATCHED THEN
            INSERT (folder_id, principal_id, allow_bits, deny_bits, created_by)
            VALUES (source.folder_id, source.principal_id, ${entry.allowBits}, ${entry.denyBits}, ${userId});
        `.execute(trx);
      }
    }

    await sql`
      UPDATE dbo.folders
         SET inherits_acl = ${inherits ? 1 : 0}, updated_at = SYSUTCDATETIME()
       WHERE folder_id = ${folderId}
    `.execute(trx);

    await bumpEpoch(trx, `inheritance ${inherits ? 'restored' : 'broken'}`);
  });

  log.info({ folderId: String(folderId), inherits }, 'folder inheritance changed');
  return { ok: true };
}

/**
 * Answers "what can this person actually do here, and why".
 *
 * The bits come from the same function the queries use, so the answer cannot
 * drift from the enforcement. The ACEs alongside are the explanation.
 */
export async function explainPermission({ userId, folderId, subjectId }) {
  const allowed = await requireManage(userId, folderId);
  if (!allowed.ok) return allowed;

  const bits = await permissionBits(subjectId, folderId);

  // The chain that can contribute: the folder itself and its ancestors, read
  // straight out of the materialized path rather than walked.
  const target = await sql`
    SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);

  if (!target.rows[0]) return { ok: false, reason: 'not_found' };

  const chain = String(target.rows[0].mpath).split('/').filter(Boolean);

  const contributing = await sql`
    SELECT a.folder_id, f.name AS folder_name, f.depth, f.inherits_acl,
           a.allow_bits, a.deny_bits, p.display_name, p.principal_type
      FROM dbo.access_control_entries a
      JOIN dbo.folders f ON f.folder_id = a.folder_id
      JOIN dbo.principals p ON p.principal_id = a.principal_id
     WHERE a.folder_id IN (${sql.join(chain.map((value) => sql`${value}`))})
       -- The subject's own id plus every group it belongs to, transitively.
       AND a.principal_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${subjectId}))
     ORDER BY f.depth
  `.execute(db);

  return {
    ok: true,
    permissions: describeBits(bits),
    permissionBits: bits,
    contributing: contributing.rows.map((row) => ({
      folderId: String(row.folder_id),
      folderName: row.folder_name,
      principalName: row.display_name,
      principalType: row.principal_type,
      allow: describeBits(Number(row.allow_bits)),
      deny: describeBits(Number(row.deny_bits)),
    })),
  };
}
