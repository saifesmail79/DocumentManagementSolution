/**
 * Per-month manifests.
 *
 * ─── What this is for ───────────────────────────────────────────────────────
 *
 * The storage layout is keyed on upload date, not on the filing tree, so a
 * folder move is a pure database operation and no files ever move. The cost of
 * that choice is that the disk knows nothing about the filing structure: lose
 * the database and you have a pile of identifiable files with no idea which
 * cabinet they belonged in, what type they were, or what metadata they carried.
 *
 * The manifest is what pays that cost back. Each month directory gets a plain
 * JSON file listing every document version stored in it, with the full folder
 * path, the metadata, the uploader and the hash. With the files plus the
 * manifests, the whole system is reconstructible without the database.
 *
 * It is deliberately plain, pretty-printed JSON rather than anything compact:
 * the reader is a person trying to recover from a bad day, possibly with nothing
 * but Notepad.
 *
 * ─── Written atomically ─────────────────────────────────────────────────────
 *
 * Temp file, then rename — the same discipline as document writes. A manifest is
 * a recovery tool, and a half-written one is worse than none because it looks
 * complete until you need the part that is missing.
 */

import { writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('manifest');

export const MANIFEST_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;

/**
 * Every version stored under one yyyy/MM prefix, with everything needed to
 * rebuild its context.
 */
async function collect(year, month) {
  const prefix = `${year}/${String(month).padStart(2, '0')}/%`;

  // Versions AND constituent files.
  //
  // The manifest exists so that losing the database does not mean losing what
  // the files were. A constituent file left out of it would be an unlabelled
  // blob on disk with a filename nobody could interpret — which is precisely
  // the situation the manifest was written to prevent, so both axes belong in
  // it. `sort_order` carries the reading order, which for a multi-file document
  // is the one piece of structure that cannot be recovered from the bytes.
  const result = await sql`
    SELECT c.document_id, c.version_number, c.sort_order, c.kind,
           c.storage_path, c.original_filename,
           c.file_size_bytes, c.sha256, c.mime_type, c.uploaded_at,
           uploader.display_name AS uploaded_by,
           d.title, d.is_deleted, d.created_at, d.folder_id,
           f.name AS folder_name, f.mpath,
           t.name AS type_name,
           s.name AS sensitivity_name
      FROM (
            SELECT document_id, version_number, CAST(NULL AS int) AS sort_order,
                   CAST('version' AS varchar(11)) AS kind,
                   storage_path, original_filename, file_size_bytes, sha256,
                   mime_type, uploaded_at, uploaded_by
              FROM dbo.document_versions
             UNION ALL
            SELECT document_id, 0 AS version_number, sort_order,
                   CAST('constituent' AS varchar(11)) AS kind,
                   storage_path, original_filename, file_size_bytes, sha256,
                   mime_type, uploaded_at, uploaded_by
              FROM dbo.document_files
           ) c
      JOIN dbo.documents d ON d.document_id = c.document_id
      JOIN dbo.folders   f ON f.folder_id  = d.folder_id
      JOIN dbo.principals uploader ON uploader.principal_id = c.uploaded_by
      LEFT JOIN dbo.document_types     t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels s ON s.label_id = d.sensitivity_label_id
     WHERE c.storage_path LIKE ${prefix}
     ORDER BY c.document_id, c.version_number, c.sort_order
  `.execute(db);

  if (result.rows.length === 0) return null;

  // Folder names for every ancestor, so the manifest can carry a readable path
  // rather than a chain of ids that mean nothing without the database.
  const folderIds = new Set();
  for (const row of result.rows) {
    for (const part of String(row.mpath).split('/').filter(Boolean)) folderIds.add(part);
  }

  const names = new Map();
  if (folderIds.size > 0) {
    const folders = await sql`
      SELECT folder_id, name FROM dbo.folders
       WHERE folder_id IN (${sql.join([...folderIds].map((value) => sql`${value}`))})
    `.execute(db);
    for (const row of folders.rows) names.set(String(row.folder_id), row.name);
  }

  // Field values, fetched in one query rather than per document.
  const documentIds = [...new Set(result.rows.map((row) => String(row.document_id)))];
  const fieldValues = new Map();

  const values = await sql`
    SELECT v.document_id, f.name, v.value_text, v.value_number, v.value_date,
           v.value_bool, c.label AS choice_label, f.data_type
      FROM dbo.document_field_values v
      JOIN dbo.custom_field_defs f ON f.field_id = v.field_id
      LEFT JOIN dbo.custom_field_choices c ON c.choice_id = v.value_choice_id
     WHERE v.document_id IN (${sql.join(documentIds.map((value) => sql`${value}`))})
  `.execute(db);

  for (const row of values.rows) {
    const key = String(row.document_id);
    const bag = fieldValues.get(key) ?? {};
    bag[row.name] =
      row.choice_label ??
      row.value_text ??
      (row.value_number === null ? null : Number(row.value_number)) ??
      row.value_date ??
      (row.value_bool === null ? null : Number(row.value_bool) === 1);
    fieldValues.set(key, bag);
  }

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    version: Number(row.version_number),
    // 'version' — one file, revised over time; 'constituent' — one of N files
    // that together are the document. Without this a restorer looking at five
    // blobs for one document id could not tell revisions from pages.
    kind: row.kind,
    // Reading order, and null for a version. It is the only structure a
    // multi-file document has that the bytes themselves do not carry.
    sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    title: row.title,
    file: path.basename(row.storage_path),
    originalFilename: row.original_filename,
    // The whole reason the manifest exists: the disk layout does not encode this.
    folderPath: `/${String(row.mpath)
      .split('/')
      .filter(Boolean)
      .map((partId) => names.get(partId) ?? `#${partId}`)
      .join('/')}`,
    type: row.type_name,
    sensitivity: row.sensitivity_name,
    fields: fieldValues.get(String(row.document_id)) ?? {},
    sha256: row.sha256,
    bytes: Number(row.file_size_bytes),
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    isDeleted: Number(row.is_deleted) === 1,
  }));
}

/** Writes one month's manifest. Returns how many entries it holds, or null if empty. */
export async function writeManifest(year, month) {
  const entries = await collect(year, month);
  if (!entries) return null;

  const relativeDirectory = `${year}/${String(month).padStart(2, '0')}`;
  const directory = storage.absolute(relativeDirectory);
  const finalPath = path.join(directory, MANIFEST_NAME);
  const tempPath = `${finalPath}.tmp`;

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    period: relativeDirectory,
    documentCount: new Set(entries.map((entry) => entry.documentId)).size,
    versionCount: entries.length,
    note:
      'Written by the DMS so this directory can be understood without the database. ' +
      'Each entry names the file on disk, the folder path it belonged to, its metadata and its SHA-256.',
    entries,
  };

  // Temp then rename, so a crash never leaves a truncated manifest that looks
  // complete until the missing part is needed.
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tempPath, finalPath);

  return entries.length;
}

/**
 * Regenerates manifests for every month that has documents.
 *
 * Cheap enough to do wholesale: the query is one pass per month directory and
 * the output is a few hundred kilobytes at most.
 */
export async function writeAllManifests() {
  // Both axes, or a month directory holding only multi-file documents would get
  // no manifest at all.
  const periods = await sql`
    SELECT DISTINCT period FROM (
      SELECT LEFT(storage_path, 7) AS period FROM dbo.document_versions
       WHERE LEN(storage_path) > 7
       UNION ALL
      SELECT LEFT(storage_path, 7) AS period FROM dbo.document_files
       WHERE LEN(storage_path) > 7
    ) p
     ORDER BY period
  `.execute(db);

  let written = 0;
  let entries = 0;

  for (const row of periods.rows) {
    const [year, month] = String(row.period).split('/');
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) continue;

    try {
      const count = await writeManifest(Number(year), Number(month));
      if (count !== null) {
        written += 1;
        entries += count;
      }
    } catch (error) {
      log.error({ err: error, period: row.period }, 'could not write a manifest');
    }
  }

  if (written > 0) log.info({ manifests: written, entries }, 'manifests written');
  return { manifests: written, entries };
}

/** Reads a manifest back, for verification and for tests. */
export async function readManifest(year, month) {
  const file = storage.absolute(`${year}/${String(month).padStart(2, '0')}/${MANIFEST_NAME}`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether manifest generation is switched on. */
export const manifestsEnabled = () => config.storage.manifestsEnabled;
