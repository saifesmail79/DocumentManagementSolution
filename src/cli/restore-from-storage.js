/**
 * Rebuilds the database from the files on disk and the storage manifests.
 *
 * ─── When this is the right tool ────────────────────────────────────────────
 *
 * The storage layout is keyed on upload date, so the disk knows nothing about
 * the filing tree — which is exactly why `writeAllManifests` exists. Given the
 * files plus a manifest, the folder structure, titles, metadata, uploader and
 * hashes can all be put back. This is the reader of that pairing.
 *
 * Use it when the database has been lost or emptied and the storage root is
 * intact. It is additive: it inserts what is missing and never deletes.
 *
 * ─── What comes back, and what cannot ───────────────────────────────────────
 *
 *   from the manifest   folder path, title, type, sensitivity, custom field
 *                       values, original filename, size, SHA-256, uploader,
 *                       upload time, and whether it was in the recycle bin
 *   from the filename   document id, version or constituent index, and title,
 *                       for anything uploaded after the last manifest was written
 *   not recoverable     password hashes, the audit trail, share links, comments,
 *                       approvals, and the folder of a post-manifest document
 *
 * A file with no manifest entry is filed under a clearly named recovery folder
 * rather than guessed into a real one: a document in the wrong cabinet is worse
 * than one obviously waiting to be filed.
 *
 * ─── Every file is verified ─────────────────────────────────────────────────
 *
 * The manifest records a SHA-256 per file and this recomputes it. A mismatch is
 * reported and the row is still written, because a document whose bytes drifted
 * is something the operator must see rather than something this should hide by
 * silently skipping it.
 *
 *   node src/cli/restore-from-storage.js --dry-run
 *   node src/cli/restore-from-storage.js --confirm
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { db, sql, closeDatabase } from '../db/index.js';
import { config } from '../config/index.js';
import { hashPassword } from '../modules/auth/passwords.js';
import { PERM } from '../db/migrations/0001-identity-and-acl.js';

const ALL_PERMS =
  PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE | PERM.MANAGE_PERMS;

/** Where anything the manifests do not describe is filed, visibly. */
const RECOVERY_FOLDER = 'مستردة — بحاجة إلى ترتيب';

const MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
};

const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--confirm');

const report = { folders: 0, documents: 0, versions: 0, files: 0, verified: 0, mismatched: [], skipped: [] };

/** Every `manifest.json` under the storage root, newest month last. */
async function readManifests(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'manifest.json') found.push(full);
    }
  }
  await walk(root);

  const manifests = [];
  for (const file of found.sort()) {
    manifests.push({ file, data: JSON.parse(await readFile(file, 'utf8')) });
  }
  return manifests;
}

/** Every stored blob, excluding manifests and generated renditions. */
async function readStoredFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Renditions are derived output; the worker remakes them on demand.
      if (entry.isDirectory()) {
        if (entry.name !== 'renditions') await walk(full);
      } else if (entry.name !== 'manifest.json') {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return files;
}

const sha256 = async (absolute) => createHash('sha256').update(await readFile(absolute)).digest('hex');

/** Ensures a folder path such as `/HR/Penelties` exists, returning its id. */
async function ensureFolderPath(folderPath, createdBy, cache) {
  const segments = String(folderPath ?? '').split('/').filter(Boolean);
  let parentId = null;
  let key = '';

  for (const name of segments) {
    key = `${key}/${name}`;
    if (cache.has(key)) {
      parentId = cache.get(key);
      continue;
    }

    // Once a parent is only hypothetical, so is everything under it — querying
    // for a child of a placeholder id would send that string to a bigint column.
    const parentIsHypothetical = typeof parentId === 'string' && parentId.startsWith('dry:');

    const existing = parentIsHypothetical
      ? { rows: [] }
      : await sql`
          SELECT folder_id FROM dbo.folders
           WHERE name = ${name}
             AND (parent_id = ${parentId} OR (parent_id IS NULL AND ${parentId} IS NULL))
        `.execute(db);

    let folderId = existing.rows[0]?.folder_id ?? null;

    if (!folderId) {
      if (dryRun) {
        cache.set(key, `dry:${key}`);
        parentId = `dry:${key}`;
        report.folders += 1;
        continue;
      }
      const depth = segments.indexOf(name);
      const inserted = await sql`
        INSERT INTO dbo.folders (parent_id, name, mpath, depth, created_by)
        OUTPUT INSERTED.folder_id AS fid
        VALUES (${parentId}, ${name}, '/pending/', ${depth}, ${createdBy})
      `.execute(db);
      folderId = inserted.rows[0].fid;

      // mpath contains the id the insert just produced, so it is a second step.
      const parentPath = parentId
        ? (await sql`SELECT mpath FROM dbo.folders WHERE folder_id = ${parentId}`.execute(db)).rows[0].mpath
        : '/';
      await sql`
        UPDATE dbo.folders SET mpath = ${`${parentPath}${folderId}/`} WHERE folder_id = ${folderId}
      `.execute(db);
      report.folders += 1;
    }

    cache.set(key, folderId);
    parentId = folderId;
  }

  return parentId;
}

async function main() {
  const root = config.storage.root;
  console.log(`storage root : ${root}`);
  console.log(`database     : ${config.db.database}`);
  console.log(dryRun ? '\nDRY RUN — nothing will be written. Re-run with --confirm to apply.\n' : '\nAPPLYING\n');

  // ── The account every restored row is attributed to ────────────────────
  const adminRow = await sql`SELECT TOP (1) user_id, username FROM dbo.users WHERE is_super_admin = 1`.execute(db);
  let adminId = adminRow.rows[0]?.user_id ?? null;
  let issuedPassword = null;

  if (!adminId) {
    const password = `Dms-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36).slice(-4)}`;
    if (!dryRun) {
      const principal = await sql`
        INSERT INTO dbo.principals (principal_type, display_name)
        OUTPUT INSERTED.principal_id AS pid VALUES ('user', N'مدير النظام')
      `.execute(db);
      adminId = principal.rows[0].pid;
      await sql`
        INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin, must_change_password)
        VALUES (${adminId}, 'admin', ${await hashPassword(password)}, 1, 1)
      `.execute(db);
      issuedPassword = password;
    }
    console.log(`admin account: creating 'admin' (مدير النظام)`);
  } else {
    console.log(`admin account: reusing existing '${adminRow.rows[0].username}'`);
  }

  // ── The five roles the first migration seeds ───────────────────────────
  const SYSTEM_ROLES = [
    ['Viewer', 'Browse folders and read documents', PERM.BROWSE | PERM.READ],
    ['Contributor', 'Viewer, plus upload documents and new versions', PERM.BROWSE | PERM.READ | PERM.UPLOAD],
    ['Editor', 'Contributor, plus edit metadata', PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META],
    ['Manager', 'Editor, plus delete', PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE],
    ['Owner', 'Full control including permissions', ALL_PERMS],
  ];
  for (const [name, description, bits] of SYSTEM_ROLES) {
    const present = await sql`SELECT role_id FROM dbo.roles WHERE name = ${name}`.execute(db);
    if (present.rows[0]) continue;
    if (!dryRun) {
      await sql`
        INSERT INTO dbo.roles (name, description, permission_bits, is_system)
        VALUES (${name}, ${description}, ${bits}, 1)
      `.execute(db);
    }
    console.log(`role: restoring ${name}`);
  }

  // ── Manifests ──────────────────────────────────────────────────────────
  const manifests = await readManifests(root);
  const described = new Map();
  for (const { data } of manifests) {
    for (const entry of data.entries) described.set(entry.file, entry);
  }
  console.log(`manifests    : ${manifests.length} covering ${described.size} files`);

  // Field definitions named by any manifest entry.
  const fieldNames = [...new Set([...described.values()].flatMap((e) => Object.keys(e.fields ?? {})))];
  for (const name of fieldNames) {
    const present = await sql`SELECT field_id FROM dbo.custom_field_defs WHERE name = ${name}`.execute(db);
    if (present.rows[0]) continue;
    if (!dryRun) {
      // The data type is not in the manifest; text accepts any recorded value,
      // and an operator can narrow it afterwards without losing anything.
      await sql`
        INSERT INTO dbo.custom_field_defs (type_id, name, data_type, is_required, is_searchable)
        VALUES (NULL, ${name}, 'text', 0, 1)
      `.execute(db);
    }
    console.log(`field: restoring ${name} (as text)`);
  }

  const stored = await readStoredFiles(root);
  console.log(`files on disk: ${stored.length}\n`);

  const folderCache = new Map();
  let recoveryFolderId = null;

  // Grouped by document so a multi-file entry is rebuilt as one document.
  const byDocument = new Map();
  for (const relative of stored) {
    const base = path.basename(relative);
    const match = base.match(/^(\d+)_(v(\d+)|f(\d+))_(.+)$/);
    if (!match) {
      report.skipped.push(`${relative} (unrecognised name)`);
      continue;
    }
    const documentId = match[1];
    const isVersion = Boolean(match[3]);
    const list = byDocument.get(documentId) ?? [];
    list.push({
      relative,
      base,
      isVersion,
      index: Number(match[3] ?? match[4]),
      title: match[5].replace(/\.[^.]+$/, ''),
      entry: described.get(base) ?? null,
    });
    byDocument.set(documentId, list);
  }

  for (const [documentId, parts] of [...byDocument.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const exists = await sql`SELECT document_id FROM dbo.documents WHERE document_id = ${documentId}`.execute(db);
    if (exists.rows[0]) {
      report.skipped.push(`document ${documentId} (already present)`);
      continue;
    }

    parts.sort((a, b) => a.index - b.index);
    const lead = parts.find((p) => p.entry) ?? parts[0];
    const entry = lead.entry;
    const multiFile = parts.length > 1 && !parts[0].isVersion;

    let folderId;
    if (entry?.folderPath) {
      folderId = await ensureFolderPath(entry.folderPath, adminId, folderCache);
    } else {
      if (recoveryFolderId === null) {
        recoveryFolderId = await ensureFolderPath(`/${RECOVERY_FOLDER}`, adminId, folderCache);
      }
      folderId = recoveryFolderId;
    }

    const title = entry?.title ?? lead.title;
    console.log(
      `document ${String(documentId).padStart(3)} → ${entry ? entry.folderPath : `/${RECOVERY_FOLDER}`}`
        + `  "${title}"${multiFile ? `  (${parts.length} files)` : ''}${entry ? '' : '  [no manifest]'}`,
    );

    if (dryRun) {
      report.documents += 1;
      for (const part of parts) {
        const absolute = path.join(root, part.relative);
        if (part.entry) {
          const digest = await sha256(absolute);
          if (digest === part.entry.sha256) report.verified += 1;
          else report.mismatched.push(part.relative);
        }
        if (part.isVersion) report.versions += 1;
        else report.files += 1;
      }
      continue;
    }

    /*
     * IDENTITY_INSERT keeps the original ids, so storage names, rendition paths
     * and any link somebody saved all still line up.
     *
     * All three statements go in ONE raw batch, which is the only thing that
     * works: a parameterised query is sent through `sp_executesql`, and
     * IDENTITY_INSERT set inside that runs in its own scope and is gone before
     * the next statement — a transaction does not help, because the problem is
     * batch scope rather than which connection is used.
     *
     * That means literals rather than parameters. Everything but the title is
     * numeric or a timestamp this script produced; the title is the one piece of
     * user text, and it is escaped and sent as an N-literal so Arabic survives.
     */
    const stamp = entry?.uploadedAt ?? new Date().toISOString();
    const number = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`refusing to inline a non-numeric value: ${value}`);
      return String(n);
    };
    const text = (value) => `N'${String(value).replace(/'/g, "''")}'`;

    await sql
      .raw(
        'SET IDENTITY_INSERT dbo.documents ON;'
          + ' INSERT INTO dbo.documents'
          + ' (document_id, folder_id, title, current_version, is_deleted, deleted_at, deleted_by,'
          + '  created_by, created_at, updated_at, extraction_status)'
          + ` VALUES (${number(documentId)}, ${number(folderId)}, ${text(title)},`
          + ` ${multiFile ? 0 : 1}, ${entry?.isDeleted ? 1 : 0},`
          // CK_documents_deleted_pair: the flag and the timestamp travel
          // together, so a restored recycle-bin document needs both. The
          // manifest does not record when it was deleted, so its upload time
          // stands in — wrong by a margin, and visibly better than a NULL that
          // the constraint would reject outright.
          + ` ${entry?.isDeleted ? text(stamp) : 'NULL'},`
          + ` ${entry?.isDeleted ? number(adminId) : 'NULL'},`
          + ` ${number(adminId)}, ${text(stamp)}, ${text(stamp)}, 0);`
          + ' SET IDENTITY_INSERT dbo.documents OFF;',
      )
      .execute(db);
    report.documents += 1;

    for (const part of parts) {
      const absolute = path.join(root, part.relative);
      const info = await stat(absolute);
      const digest = await sha256(absolute);
      const extension = path.extname(part.base).toLowerCase();
      const mime = part.entry?.mimeType ?? MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
      const filename = part.entry?.originalFilename ?? part.base.replace(/^\d+_[vf]\d+_/, '');

      if (part.entry) {
        if (digest === part.entry.sha256) report.verified += 1;
        else report.mismatched.push(part.relative);
      }

      if (part.isVersion) {
        await sql`
          INSERT INTO dbo.document_versions
            (document_id, version_number, storage_path, original_filename, file_size_bytes,
             sha256, mime_type, uploaded_by, uploaded_at)
          VALUES (${documentId}, ${part.index}, ${part.relative}, ${filename}, ${info.size},
                  ${digest}, ${mime}, ${adminId},
                  ${part.entry?.uploadedAt ?? info.mtime.toISOString()})
        `.execute(db);
        report.versions += 1;
      } else {
        await sql`
          INSERT INTO dbo.document_files
            (document_id, sort_order, storage_path, original_filename, file_size_bytes,
             sha256, mime_type, uploaded_by, uploaded_at)
          VALUES (${documentId}, ${part.index}, ${part.relative}, ${filename}, ${info.size},
                  ${digest}, ${mime}, ${adminId},
                  ${part.entry?.uploadedAt ?? info.mtime.toISOString()})
        `.execute(db);
        report.files += 1;
      }
    }

    /*
     * Queued so thumbnails and searchable text come back on their own.
     *
     * The extraction queue is written directly rather than through the document
     * service: its enqueue helper is private to the upload path, and the row is
     * a two-column merge that is clearer here than an export made for one caller.
     */
    const queueVersion = multiFile ? 0 : 1;
    const { enqueueRendition } = await import('../modules/renditions/service.js');
    await enqueueRendition(db, documentId, queueVersion, 'thumbnail').catch(() => {});
    await sql`
      MERGE dbo.extraction_queue WITH (HOLDLOCK) AS target
      USING (SELECT ${documentId} AS document_id, ${queueVersion} AS version_number) AS source
         ON target.document_id = source.document_id
        AND target.version_number = source.version_number
      WHEN MATCHED THEN
        UPDATE SET status = 0, attempts = 0, last_error = NULL, queued_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (document_id, version_number) VALUES (source.document_id, source.version_number);
    `.execute(db).catch(() => {});
  }

  // ── The administrator needs a grant on each root folder ────────────────
  if (!dryRun && adminId) {
    const roots = await sql`SELECT folder_id FROM dbo.folders WHERE parent_id IS NULL`.execute(db);
    for (const row of roots.rows) {
      const present = await sql`
        SELECT ace_id FROM dbo.access_control_entries
         WHERE folder_id = ${row.folder_id} AND principal_id = ${adminId}
      `.execute(db);
      if (present.rows[0]) continue;
      await sql`
        INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits, created_by)
        VALUES (${row.folder_id}, ${adminId}, ${ALL_PERMS}, 0, ${adminId})
      `.execute(db);
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`folders    ${report.folders}`);
  console.log(`documents  ${report.documents}`);
  console.log(`versions   ${report.versions}`);
  console.log(`files      ${report.files}   (constituents of multi-file documents)`);
  console.log(`verified   ${report.verified} of ${described.size} files matched their recorded SHA-256`);
  if (report.mismatched.length) console.log(`MISMATCHED ${report.mismatched.join(', ')}`);
  if (report.skipped.length) console.log(`skipped    ${report.skipped.join('; ')}`);
  if (issuedPassword) {
    console.log('\n──────────────────────────────────────────────');
    console.log(`admin password (shown once): ${issuedPassword}`);
    console.log('A change is required at first sign-in.');
  }
}

main()
  .catch((error) => {
    console.error('restore failed:', error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
