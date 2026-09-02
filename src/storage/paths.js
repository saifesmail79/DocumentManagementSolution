/**
 * Storage path construction — the "Option C" layout.
 *
 *   {root}\{yyyy}\{MM}\{documentId}_v{version}_{sanitized-title}{ext}
 *   e.g.  \\nas\dms\2026\08\10432_v2_عقد_إيجار_مبنى_الإدارة.pdf
 *
 * Two deliberate properties:
 *
 *   1. The layout is keyed on the upload date, NOT on the filing tree. Moving a
 *      folder in the DMS is therefore a pure database operation — no files move,
 *      nothing can half-fail. This is the whole reason the tree is not mirrored.
 *
 *   2. The name carries the document id, the version, and a readable title. If the
 *      database is ever lost, the files are still identifiable, and versions of the
 *      same document share the `{id}_` prefix. Together with the per-month manifest
 *      (see manifest.js) the disk is self-describing.
 *
 * The title in the filename is a convenience for humans reading the disk. It is
 * never authoritative — the database holds the real title, and the file is always
 * located by the stored relative path, never by reconstructing it from a title.
 */

import path from 'node:path';

/** Characters Windows forbids in a filename, plus control characters. */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Device names Windows reserves. A file cannot be called these, with or without an
 * extension. Our names always start with digits so this cannot trigger, but the
 * sanitizer is also used by the export function where titles stand alone.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** Windows silently strips trailing dots and spaces, which desynchronises stored vs actual paths. */
const TRAILING_JUNK = /[. ]+$/;

/**
 * Makes an arbitrary document title safe to use as a Windows filename component,
 * while preserving Arabic characters (NTFS stores them fine).
 *
 * @param {string} title
 * @param {number} maxLength maximum characters to keep
 * @returns {string} always a non-empty, safe component
 */
export function sanitizeTitle(title, maxLength = 120) {
  const cleaned = String(title ?? '')
    // Compose to NFC so the bytes on disk match what we store in the database.
    // Windows does not normalise for us, and a decomposed name will not compare equal.
    .normalize('NFC')
    .replace(ILLEGAL_CHARS, '')
    // Spaces are legal but make UNC paths awkward to type and script against.
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.]+/, '')
    .replace(TRAILING_JUNK, '')
    .slice(0, maxLength)
    // Slicing can re-expose a trailing dot or space.
    .replace(TRAILING_JUNK, '')
    .replace(/_+$/, '');

  if (cleaned === '' || RESERVED_NAMES.test(cleaned)) return 'document';
  return cleaned;
}

/**
 * Normalises a file extension: lowercase, leading dot, alphanumeric only.
 * Returns '' when there is no usable extension rather than inventing one.
 */
export function sanitizeExtension(filenameOrExt) {
  if (!filenameOrExt) return '';
  const raw = String(filenameOrExt);
  const ext = raw.startsWith('.') && !raw.slice(1).includes('.') ? raw : path.extname(raw);
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (cleaned === '' || cleaned === '.') return '';
  return cleaned.startsWith('.') ? cleaned.slice(0, 16) : `.${cleaned}`.slice(0, 16);
}

/**
 * Builds the storage-root-relative path for one document version.
 *
 * Uses forward slashes internally; the driver joins them onto the root with the
 * platform separator. Storing a relative path (not an absolute one) means the
 * storage root can be moved or remounted without rewriting every row.
 *
 * @param {object} args
 * @param {number|string} args.documentId
 * @param {number} args.version 1-based version number
 * @param {string} args.title original document title
 * @param {string} [args.originalFilename] used to derive the extension
 * @param {Date} args.createdAt determines the yyyy/MM partition
 * @param {number} [args.maxTitleLength]
 * @returns {string} e.g. "2026/08/10432_v2_عقد_إيجار.pdf"
 */
export function buildRelativePath({
  documentId,
  version,
  title,
  originalFilename,
  createdAt,
  maxTitleLength = 120,
}) {
  if (documentId === undefined || documentId === null || `${documentId}`.trim() === '') {
    throw new TypeError('buildRelativePath: documentId is required');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(`buildRelativePath: version must be a positive integer, got ${version}`);
  }
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new TypeError('buildRelativePath: createdAt must be a valid Date');
  }

  const year = String(createdAt.getFullYear());
  const month = String(createdAt.getMonth() + 1).padStart(2, '0');
  const ext = sanitizeExtension(originalFilename);
  const safeTitle = sanitizeTitle(title, maxTitleLength);

  return `${year}/${month}/${documentId}_v${version}_${safeTitle}${ext}`;
}

/**
 * Builds the storage-root-relative path for one constituent file of a
 * multi-file document.
 *
 * `_f{n}_` rather than `_v{n}_` so the two axes cannot collide in the one
 * namespace they share. Both tables declare UNIQUE (storage_path), but those
 * are two separate constraints over two separate tables — nothing in the
 * database would stop a version row and a constituent row from naming the same
 * blob, and the first delete would take out both. The differing infix is what
 * actually makes that impossible.
 *
 * The index is the file's sort_order, so the path also reads in document order
 * to anyone looking at the directory during a restore.
 *
 * @param {object} args
 * @param {number|string} args.documentId
 * @param {number} args.index 0-based position within the document
 * @param {string} args.title the parent document's title
 * @param {string} [args.originalFilename] used to derive the extension
 * @param {Date} args.createdAt determines the yyyy/MM partition
 * @param {number} [args.maxTitleLength]
 * @returns {string} e.g. "2026/08/10432_f0_عقد_إيجار.pdf"
 */
export function buildConstituentPath({
  documentId,
  index,
  title,
  originalFilename,
  createdAt,
  maxTitleLength = 120,
}) {
  if (documentId === undefined || documentId === null || `${documentId}`.trim() === '') {
    throw new TypeError('buildConstituentPath: documentId is required');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`buildConstituentPath: index must be a non-negative integer, got ${index}`);
  }
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new TypeError('buildConstituentPath: createdAt must be a valid Date');
  }

  const year = String(createdAt.getFullYear());
  const month = String(createdAt.getMonth() + 1).padStart(2, '0');
  const ext = sanitizeExtension(originalFilename);
  const safeTitle = sanitizeTitle(title, maxTitleLength);

  return `${year}/${month}/${documentId}_f${index}_${safeTitle}${ext}`;
}

/**
 * Splits a relative path back into its parts. Returns null when it does not
 * match the layout.
 *
 * `kind` distinguishes the two axes: 'version' for a revision of a single-file
 * document, 'constituent' for one file of a multi-file document. A version path
 * still reports `version`, so existing callers read unchanged.
 */
export function parseRelativePath(relativePath) {
  const match = /^(\d{4})\/(\d{2})\/(\d+)_([vf])(\d+)_(.*?)(\.[a-z0-9]+)?$/.exec(
    String(relativePath ?? ''),
  );
  if (!match) return null;

  const isVersion = match[4] === 'v';
  const ordinal = Number(match[5]);

  return {
    year: match[1],
    month: match[2],
    documentId: Number(match[3]),
    kind: isVersion ? 'version' : 'constituent',
    version: isVersion ? ordinal : null,
    index: isVersion ? null : ordinal,
    title: match[6],
    extension: match[7] ?? '',
  };
}

/**
 * Rejects any relative path that would escape the storage root.
 *
 * Every path reaching the filesystem must pass through here. Document rows are
 * written by the application, but a corrupted row, a bad migration, or a future
 * import tool must not be able to turn `../../` into a read of an arbitrary file.
 *
 * @param {string} relativePath
 * @returns {string} the normalised, safe relative path
 */
export function assertSafeRelativePath(relativePath) {
  const value = String(relativePath ?? '');
  if (value === '') throw new Error('storage: empty relative path');
  if (value.includes('\u0000')) throw new Error('storage: relative path contains a null byte');
  if (path.win32.isAbsolute(value) || value.startsWith('\\\\') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`storage: relative path must not be absolute: ${value}`);
  }

  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`storage: relative path escapes the storage root: ${value}`);
  }
  return normalized;
}
