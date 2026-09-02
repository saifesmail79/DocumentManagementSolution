/**
 * Moving the storage root, and finding out what did not arrive.
 *
 * ─── Why this is a guided operation rather than a text box ──────────────────
 *
 * `storage_path` is relative to the root, so repointing the system is one
 * setting and no row rewrites — migration 0002 chose that layout precisely so
 * the NAS mount or drive letter could change. What is not free is the copying:
 * a large archive moves over hours, and the administrator will inevitably point
 * the system at the destination before every file has landed.
 *
 * So the change is split into the three things that actually go wrong:
 *
 *   1. the path is wrong, unreachable or read-only  → `validateRoot` refuses
 *      before anything is written
 *   2. the path is right but the copy is incomplete → `reconcile` lists exactly
 *      which files are not there, and the list survives restarts
 *   3. the copy finishes later                      → re-running `reconcile`
 *      clears what has arrived, so the number falls to zero as work is done
 *
 * ─── The old location is never touched ──────────────────────────────────────
 *
 * Nothing here copies, moves or deletes a single byte. Moving terabytes is a job
 * for robocopy or rsync with resume, retry and bandwidth control, and doing it
 * badly from inside a web request is how an archive gets half-deleted. This
 * points the system at the new place and tells the truth about what is there.
 */

import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('storage-relocation');

/**
 * Checks a candidate root before anything is committed to it.
 *
 * Writability is proved by writing, not by reading a permission bit: a network
 * share can advertise write access and refuse the write, and an ACL that looks
 * right to the OS can still be wrong for the service account. The probe file is
 * removed again whatever happens.
 *
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string, sameAsCurrent?: boolean}>}
 */
export async function validateRoot(candidate) {
  const target = String(candidate ?? '').trim();
  if (!target) return { ok: false, reason: 'empty_path' };

  // A relative path resolves against the server's working directory, which is
  // not something an operator can reason about and changes with how it is
  // started. UNC paths are absolute and are the normal case on a NAS.
  if (!path.isAbsolute(target) && !target.startsWith('\\\\')) {
    return { ok: false, reason: 'not_absolute' };
  }

  let info;
  try {
    info = await stat(target);
  } catch (error) {
    return { ok: false, reason: 'not_found', detail: error.code };
  }
  if (!info.isDirectory()) return { ok: false, reason: 'not_a_directory' };

  try {
    await access(target, FS.R_OK);
  } catch {
    return { ok: false, reason: 'not_readable' };
  }

  const probe = path.join(target, `.dms-write-probe-${process.pid}`);
  try {
    await writeFile(probe, 'probe', { flag: 'w' });
  } catch (error) {
    return { ok: false, reason: 'not_writable', detail: error.code };
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }

  // A non-empty destination is normal — it is where the copy landed — but an
  // empty one is worth saying out loud, because it usually means the copy has
  // not started rather than that the archive is empty.
  let entries = [];
  try {
    entries = await readdir(target);
  } catch {
    entries = [];
  }

  return {
    ok: true,
    resolved: path.resolve(target),
    sameAsCurrent: path.resolve(target) === path.resolve(storage.root),
    isEmpty: entries.filter((name) => !name.startsWith('.')).length === 0,
  };
}

/** Every path the database expects to find on disk, both axes plus renditions. */
async function referencedPaths() {
  const rows = await sql`
    SELECT v.storage_path, 'version' AS kind, v.document_id, v.file_size_bytes AS bytes, d.title
      FROM dbo.document_versions v
      JOIN dbo.documents d ON d.document_id = v.document_id
    UNION ALL
    SELECT f.storage_path, 'file', f.document_id, f.file_size_bytes, d.title
      FROM dbo.document_files f
      JOIN dbo.documents d ON d.document_id = f.document_id
    UNION ALL
    -- Renditions are derived and the worker can remake them, so they are
    -- reported but never treated as data loss.
    SELECT r.storage_path, 'rendition', r.document_id, r.bytes, d.title
      FROM dbo.document_renditions r
      JOIN dbo.documents d ON d.document_id = r.document_id
  `.execute(db);

  return rows.rows.map((row) => ({
    storagePath: row.storage_path,
    kind: row.kind,
    documentId: row.document_id === null ? null : String(row.document_id),
    bytes: row.bytes === null ? null : Number(row.bytes),
    title: row.title,
  }));
}

/**
 * Checks every referenced file against the live root and records what is absent.
 *
 * Safe to run repeatedly — that is the point. A file that has since been copied
 * across is marked resolved rather than deleted from the list, so the screen can
 * show what arrived as well as what is left.
 */
export async function reconcile() {
  const root = storage.root;
  const references = await referencedPaths();

  let present = 0;
  const missing = [];

  for (const reference of references) {
    if (await storage.exists(reference.storagePath)) present += 1;
    else missing.push(reference);
  }

  const missingPaths = new Set(missing.map((entry) => entry.storagePath));

  for (const entry of missing) {
    await sql`
      MERGE dbo.storage_reconciliation WITH (HOLDLOCK) AS target
      USING (SELECT ${entry.storagePath} AS storage_path) AS source
         ON target.storage_path = source.storage_path
      WHEN MATCHED THEN
        UPDATE SET last_checked_at = SYSUTCDATETIME(), checked_root = ${root},
                   resolved_at = NULL, kind = ${entry.kind},
                   document_id = ${entry.documentId}, title = ${entry.title},
                   expected_bytes = ${entry.bytes}
      WHEN NOT MATCHED THEN
        INSERT (storage_path, kind, document_id, title, expected_bytes, checked_root)
        VALUES (source.storage_path, ${entry.kind}, ${entry.documentId}, ${entry.title},
                ${entry.bytes}, ${root});
    `.execute(db);
  }

  // Anything on the outstanding list that is now present has arrived. Marked
  // rather than deleted, so "12 of 40 copied" is answerable.
  const outstanding = await sql`
    SELECT recon_id, storage_path FROM dbo.storage_reconciliation WHERE resolved_at IS NULL
  `.execute(db);

  let resolved = 0;
  for (const row of outstanding.rows) {
    if (missingPaths.has(row.storage_path)) continue;
    await sql`
      UPDATE dbo.storage_reconciliation
         SET resolved_at = SYSUTCDATETIME(), last_checked_at = SYSUTCDATETIME(), checked_root = ${root}
       WHERE recon_id = ${row.recon_id}
    `.execute(db);
    resolved += 1;
  }

  log.info(
    { root, total: references.length, present, missing: missing.length, resolved },
    'storage reconciliation complete',
  );

  return {
    root,
    checkedAt: new Date().toISOString(),
    total: references.length,
    present,
    missing: missing.length,
    resolvedThisRun: resolved,
    // Renditions are rebuildable, so a caller can tell recoverable gaps from
    // real ones rather than treating every absence as data loss.
    missingByKind: missing.reduce((into, entry) => {
      into[entry.kind] = (into[entry.kind] ?? 0) + 1;
      return into;
    }, {}),
  };
}

/** The outstanding list, for the screen that walks an operator through the copy. */
export async function reconciliationReport({ limit = 500 } = {}) {
  const summary = await sql`
    SELECT
      SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
      MAX(last_checked_at) AS last_checked_at,
      MAX(checked_root) AS checked_root
    FROM dbo.storage_reconciliation
  `.execute(db);

  const rows = await sql`
    SELECT TOP (${limit}) storage_path, kind, document_id, title, expected_bytes,
           first_seen_at, last_checked_at
      FROM dbo.storage_reconciliation
     WHERE resolved_at IS NULL
     ORDER BY kind, document_id
  `.execute(db);

  const stats = summary.rows[0] ?? {};

  return {
    pending: Number(stats.pending ?? 0),
    resolved: Number(stats.resolved ?? 0),
    lastCheckedAt: stats.last_checked_at ?? null,
    checkedRoot: stats.checked_root ?? null,
    currentRoot: storage.root,
    items: rows.rows.map((row) => ({
      storagePath: row.storage_path,
      kind: row.kind,
      documentId: row.document_id === null ? null : String(row.document_id),
      title: row.title,
      expectedBytes: row.expected_bytes === null ? null : Number(row.expected_bytes),
      firstSeenAt: row.first_seen_at,
      lastCheckedAt: row.last_checked_at,
    })),
  };
}

/**
 * Points the running system at a new root.
 *
 * Validated first, then applied to the live driver, which re-runs its durability
 * probe against the new location — so a share that passes a write test but
 * cannot be read back still stops the change rather than silently accepting it.
 */
export async function applyRoot(candidate, { actorId = null } = {}) {
  const check = await validateRoot(candidate);
  if (!check.ok) return check;

  const previous = storage.root;
  try {
    await storage.setRoot(check.resolved);
  } catch (error) {
    return { ok: false, reason: 'unusable_root', detail: error.message };
  }

  // The staging directory lives under the root so a promote is a same-volume
  // rename; a new root needs its own before the next upload, not during one.
  await mkdir(path.join(check.resolved, storage.tempDirName ?? '.tmp'), { recursive: true }).catch(() => {});

  /*
   * Persisted only after the live driver accepted it.
   *
   * Written first, a rejected root would survive the next restart and take the
   * system down with it — the boot path applies whatever is stored here. This
   * order means the database only ever records a location the process has
   * proved it can read and write.
   */
  const { setSetting } = await import('../settings/service.js');
  const stored = await setSetting({
    key: 'storage.root',
    value: check.resolved,
    actorId,
    allowGuarded: true,
  });
  if (!stored.ok) {
    await storage.setRoot(previous).catch(() => {});
    return { ok: false, reason: 'not_saved', detail: stored.reason };
  }

  log.warn({ from: previous, to: check.resolved }, 'storage root changed');

  // Reported immediately, because "what is not here yet" is the only question
  // that matters in the minutes after a move.
  const report = await reconcile();
  return { ok: true, from: previous, to: check.resolved, report };
}

/**
 * Applies the stored root at startup, if one was ever set.
 *
 * The environment value stays the fallback and the safety net: if the stored
 * location is gone — an unplugged NAS, a share that did not mount — this logs
 * loudly and leaves the process on the environment's root rather than refusing
 * to start. A system that boots and says which documents it cannot reach is far
 * more useful than one that will not boot at all.
 */
export async function applyStoredRoot() {
  const { getSetting } = await import('../settings/service.js');
  const stored = await getSetting('storage.root').catch(() => null);
  if (!stored) return { applied: false, reason: 'not_set' };

  const resolved = path.resolve(String(stored));
  if (resolved === path.resolve(storage.root)) return { applied: false, reason: 'already_current' };

  const check = await validateRoot(resolved);
  if (!check.ok) {
    log.error(
      { configured: resolved, reason: check.reason, fallback: storage.root },
      'stored storage root is unusable — staying on the environment value',
    );
    return { applied: false, reason: check.reason };
  }

  await storage.setRoot(check.resolved);
  log.info({ root: check.resolved }, 'storage root applied from settings');
  return { applied: true, root: check.resolved };
}
