/**
 * Document state: check-out locks, lifecycle, expiry, legal hold, and version
 * restore.
 *
 * ─── The lock is advisory, and says so ──────────────────────────────────────
 *
 * Checking a document out blocks other people's uploads through this system.
 * It cannot stop someone editing a copy they downloaded, and pretending
 * otherwise would be worse than not having it — so the lock is enforced on the
 * write path and surfaced plainly in the UI as "checked out by X".
 *
 * ─── Legal hold outranks permissions ────────────────────────────────────────
 *
 * A held document cannot be deleted or purged by anyone, including a super
 * admin. A hold that an administrator can lift in the same click as the delete
 * is not a hold; lifting it is a separate, audited act.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, has } from '../tree/service.js';
import { documentPermission } from '../collaboration/service.js';
import { notifyMany, KIND } from '../notifications/service.js';

const log = moduleLogger('documents');

export const LIFECYCLE_STATES = Object.freeze(['draft', 'active', 'superseded', 'obsolete']);

// ── Check-in / check-out ─────────────────────────────────────────────────

export async function checkOut({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.UPLOAD)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  // The WHERE clause is the lock: two simultaneous check-outs cannot both
  // update a row that is already claimed, and the loser is told who holds it.
  const result = await sql`
    UPDATE dbo.documents
       SET locked_by = ${userId}, locked_at = SYSUTCDATETIME()
     WHERE document_id = ${documentId}
       AND is_deleted = 0
       AND (locked_by IS NULL OR locked_by = ${userId})
  `.execute(db);

  if (Number(result.numAffectedRows ?? 0) !== 1) {
    const holder = await lockHolder(documentId);
    return { ok: false, reason: 'locked', lockedBy: holder };
  }

  return { ok: true };
}

export async function checkIn({ userId, documentId, isSuperAdmin = false }) {
  const found = await sql`
    SELECT locked_by FROM dbo.documents WHERE document_id = ${documentId}
  `.execute(db);

  if (!found.rows[0]) return { ok: false, reason: 'not_found' };
  if (found.rows[0].locked_by === null) return { ok: true, alreadyOpen: true };

  // A lock nobody can break is a document nobody can edit once its holder
  // leaves, so an administrator can force it — and it is audited as such.
  if (String(found.rows[0].locked_by) !== String(userId) && !isSuperAdmin) {
    return { ok: false, reason: 'not_your_lock', lockedBy: await lockHolder(documentId) };
  }

  await sql`
    UPDATE dbo.documents SET locked_by = NULL, locked_at = NULL WHERE document_id = ${documentId}
  `.execute(db);

  return { ok: true, forced: String(found.rows[0].locked_by) !== String(userId) };
}

async function lockHolder(documentId) {
  const result = await sql`
    SELECT p.display_name, d.locked_at
      FROM dbo.documents d
      JOIN dbo.principals p ON p.principal_id = d.locked_by
     WHERE d.document_id = ${documentId}
  `.execute(db);

  return result.rows[0] ? { name: result.rows[0].display_name, since: result.rows[0].locked_at } : null;
}

/** True when someone other than `userId` holds the lock. */
export async function isLockedByOther({ userId, documentId }) {
  const result = await sql`
    SELECT locked_by FROM dbo.documents WHERE document_id = ${documentId}
  `.execute(db);

  const lockedBy = result.rows[0]?.locked_by;
  return lockedBy !== null && lockedBy !== undefined && String(lockedBy) !== String(userId);
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export async function setLifecycle({ userId, documentId, state }) {
  if (!LIFECYCLE_STATES.includes(state)) return { ok: false, reason: 'invalid_state' };

  const bits = await documentPermission(userId, documentId);
  if (bits === null) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.EDIT_META)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  await sql`
    UPDATE dbo.documents
       SET lifecycle_state = ${state}, updated_at = SYSUTCDATETIME(), updated_by = ${userId}
     WHERE document_id = ${documentId}
  `.execute(db);

  return { ok: true };
}

// ── Expiry ───────────────────────────────────────────────────────────────

export async function setExpiry({ userId, documentId, expiresAt }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.EDIT_META)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  // ISO text converted server-side, never a bound Date: tedious binds one as
  // `datetime`, whose resolution rounds a datetime2(3) value.
  const iso = expiresAt ? new Date(expiresAt).toISOString() : null;
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
    return { ok: false, reason: 'invalid_date' };
  }

  await sql`
    UPDATE dbo.documents
       SET expires_at = ${iso === null ? sql`NULL` : sql`CONVERT(datetime2(3), ${iso}, 126)`},
           expiry_notified_at = NULL,
           updated_at = SYSUTCDATETIME(),
           updated_by = ${userId}
     WHERE document_id = ${documentId}
  `.execute(db);

  return { ok: true };
}

/**
 * Notifies about documents expiring within `withinDays`.
 *
 * expiry_notified_at is stamped so a document is announced once rather than on
 * every nightly run — a reminder that arrives daily for a month is a reminder
 * people filter out.
 */
export async function notifyExpiring({ withinDays = 30 } = {}) {
  const due = await sql`
    SELECT d.document_id, d.title, d.folder_id, d.expires_at, d.created_by
      FROM dbo.documents d
     WHERE d.is_deleted = 0
       AND d.expires_at IS NOT NULL
       AND d.expiry_notified_at IS NULL
       AND d.expires_at <= DATEADD(day, ${Math.abs(withinDays)}, SYSUTCDATETIME())
  `.execute(db);

  if (due.rows.length === 0) return { notified: 0 };

  const { watchersOf } = await import('../collaboration/service.js');
  let notified = 0;

  for (const row of due.rows) {
    const watchers = await watchersOf({ documentId: row.document_id });
    const audience = [...new Set([String(row.created_by), ...watchers])];

    await notifyMany({
      userIds: audience,
      kind: KIND.DOCUMENT_EXPIRING,
      title: `وثيقة تقترب من تاريخ انتهائها: ${row.title}`,
      body: `تنتهي صلاحية هذه الوثيقة في ${new Date(row.expires_at).toISOString().slice(0, 10)}.`,
      documentId: row.document_id,
      folderId: row.folder_id,
    });

    await sql`
      UPDATE dbo.documents SET expiry_notified_at = SYSUTCDATETIME() WHERE document_id = ${row.document_id}
    `.execute(db);

    notified += 1;
  }

  log.info({ notified }, 'expiry reminders sent');
  return { notified };
}

// ── Legal hold ───────────────────────────────────────────────────────────

/**
 * Places or lifts a legal hold. Super-admin only, and always audited by the
 * caller: this is the switch that overrides deletion for everyone.
 */
export async function setLegalHold({ userId, documentId, hold, reason = null }) {
  const found = await sql`SELECT document_id FROM dbo.documents WHERE document_id = ${documentId}`.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  await sql`
    UPDATE dbo.documents
       SET legal_hold = ${hold ? 1 : 0},
           legal_hold_reason = ${hold ? reason : null},
           updated_at = SYSUTCDATETIME(),
           updated_by = ${userId}
     WHERE document_id = ${documentId}
  `.execute(db);

  log.warn({ documentId: String(documentId), hold }, 'legal hold changed');
  return { ok: true };
}

// ── Version restore ──────────────────────────────────────────────────────

/**
 * Restores an older version by copying it forward as a new one.
 *
 * Nothing is rewound. Versions are immutable and the history is evidence: making
 * v2 the current version by deleting v3 destroys the record that v3 ever
 * existed. Copying forward means "the content of v1 is now current" is itself a
 * versioned, attributable event.
 */
export async function restoreVersion({ userId, documentId, versionNumber, comment = null }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null) return { ok: false, reason: 'not_found' };
  if (!has(bits, PERM.UPLOAD)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  if (await isLockedByOther({ userId, documentId })) {
    return { ok: false, reason: 'locked', lockedBy: await lockHolder(documentId) };
  }

  const source = await sql`
    SELECT v.storage_path, v.original_filename, v.file_size_bytes, v.sha256, v.mime_type,
           d.current_version, d.title, d.created_at
      FROM dbo.document_versions v
      JOIN dbo.documents d ON d.document_id = v.document_id
     WHERE v.document_id = ${documentId} AND v.version_number = ${versionNumber}
  `.execute(db);

  const version = source.rows[0];
  if (!version) return { ok: false, reason: 'version_not_found' };
  if (Number(version.current_version) === Number(versionNumber)) {
    return { ok: false, reason: 'already_current' };
  }

  const next = Number(version.current_version) + 1;

  const { buildRelativePath } = await import('../../storage/paths.js');
  const { storage } = await import('../../storage/index.js');
  const { config } = await import('../../config/index.js');

  const relativePath = buildRelativePath({
    documentId,
    version: next,
    title: version.title,
    originalFilename: version.original_filename,
    createdAt: version.created_at,
    maxTitleLength: config.storage.maxTitleLength,
  });

  // The bytes are copied on disk before the row is written, so the invariant
  // holds here exactly as it does for an upload: a committed version always has
  // a file behind it.
  await storage.copy(version.storage_path, relativePath);

  try {
    await db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO dbo.document_versions
          (document_id, version_number, storage_path, original_filename,
           file_size_bytes, sha256, mime_type, comment, uploaded_by)
        VALUES (${documentId}, ${next}, ${relativePath}, ${version.original_filename},
                ${version.file_size_bytes}, ${version.sha256}, ${version.mime_type},
                ${comment ?? `استعادة الإصدار ${versionNumber}`}, ${userId})
      `.execute(trx);

      const updated = await sql`
        UPDATE dbo.documents
           SET current_version = ${next}, updated_at = SYSUTCDATETIME(), updated_by = ${userId}
         WHERE document_id = ${documentId} AND current_version = ${version.current_version}
      `.execute(trx);

      if (Number(updated.numAffectedRows ?? 0) !== 1) throw new Error('concurrent version conflict');
    });
  } catch (error) {
    await storage.remove(relativePath).catch(() => {});
    if (String(error.message).includes('concurrent version conflict')) {
      return { ok: false, reason: 'conflict' };
    }
    throw error;
  }

  log.info({ documentId: String(documentId), from: versionNumber, to: next }, 'version restored');
  return { ok: true, version: next };
}
