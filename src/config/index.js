/**
 * Central configuration.
 *
 * Every value is read from the environment exactly once, validated here, and frozen.
 * Nothing else in the app reads process.env directly — so a missing or malformed
 * setting fails loudly at boot rather than at 2am inside a request.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv();

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const problems = [];
const warnings = [];

function required(key, { hint } = {}) {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    problems.push(`${key} is required${hint ? ` — ${hint}` : ''}`);
    return '';
  }
  return value.trim();
}

function optional(key, fallback) {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function integer(key, fallback, { min, max } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(`${key} must be an integer, got "${raw}"`);
    return fallback;
  }
  if (min !== undefined && value < min) problems.push(`${key} must be >= ${min}`);
  if (max !== undefined && value > max) problems.push(`${key} must be <= ${max}`);
  return value;
}

/** As `integer`, but for a value that is legitimately fractional. */
function number(key, fallback, { min, max } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${key} must be a number, got "${raw}"`);
    return fallback;
  }
  if (min !== undefined && value < min) problems.push(`${key} must be >= ${min}`);
  if (max !== undefined && value > max) problems.push(`${key} must be <= ${max}`);
  return value;
}

function boolean(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  problems.push(`${key} must be a boolean, got "${raw}"`);
  return fallback;
}

/**
 * Storage root. Accepts a local path (D:\dms\storage) or a UNC path
 * (\\nas\dms\storage). Deliberately NOT a mapped drive letter — a Windows
 * service runs in its own logon session and cannot see mapped drives.
 * See docs/ARCHITECTURE.md.
 */
function storageRoot() {
  const raw = required('STORAGE_ROOT', { hint: 'absolute local path or UNC path, e.g. \\\\nas\\dms\\storage' });
  if (!raw) return '';

  const normalized = path.win32.normalize(raw);
  const isUnc = normalized.startsWith('\\\\');
  const isAbsolute = path.win32.isAbsolute(normalized);

  if (!isAbsolute && !isUnc) {
    problems.push(`STORAGE_ROOT must be an absolute or UNC path, got "${raw}"`);
  }

  // A drive letter that turns out to be a *mapped network drive* is invisible to a
  // Windows service — it runs in its own logon session. We cannot tell mapped from
  // local by inspecting the string, so warn rather than fail; startup then probes
  // the path for real (see storage/verifyRoot).
  if (/^[A-Za-z]:/.test(normalized)) {
    warnings.push(
      `STORAGE_ROOT "${normalized}" uses a drive letter. If it points at a network location, ` +
        'use the UNC path instead — mapped drives are invisible to a Windows service.',
    );
  }

  return normalized;
}

export const config = Object.freeze({
  env: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',

  server: Object.freeze({
    host: optional('HOST', '0.0.0.0'),
    port: integer('PORT', 3040, { min: 1, max: 65535 }),
    /** Origins allowed to call this API. The Scan Bridge has its own separate allowlist. */
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  }),

  db: Object.freeze({
    server: required('DB_SERVER', { hint: 'SQL Server hostname or host\\instance' }),
    port: integer('DB_PORT', 1433, { min: 1, max: 65535 }),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    /** Self-signed certs are the norm on-prem; set false only with a real cert. */
    trustServerCertificate: boolean('DB_TRUST_SERVER_CERTIFICATE', true),
    encrypt: boolean('DB_ENCRYPT', true),
    poolMin: integer('DB_POOL_MIN', 2, { min: 0 }),
    poolMax: integer('DB_POOL_MAX', 20, { min: 1 }),
    requestTimeoutMs: integer('DB_REQUEST_TIMEOUT_MS', 30_000, { min: 1000 }),
  }),

  storage: Object.freeze({
    /** Configurable per deployment — local disk or NAS/UNC. */
    root: storageRoot(),
    /** Subfolder under root where in-progress writes land. Must be on the same volume as the final path. */
    tempDirName: optional('STORAGE_TEMP_DIR', '.tmp'),
    /** Longest sanitized title kept in a filename, in characters. Keeps paths well under MAX_PATH. */
    maxTitleLength: integer('STORAGE_MAX_TITLE_LENGTH', 120, { min: 20, max: 200 }),
    /** Largest accepted upload. 200MB covers a long colour scan batch. */
    maxUploadBytes: integer('STORAGE_MAX_UPLOAD_BYTES', 200 * 1024 * 1024, { min: 1024 }),
    /**
     * Most files one batch upload may carry.
     *
     * This is the cap for both batch modes — N separate documents and one
     * document of N constituent files. It is enforced twice: @fastify/multipart
     * refuses to yield more parts than this, and the handler counts as it goes,
     * because the plugin's limit produces a truncated request rather than an
     * error the user can read.
     */
    maxFilesPerUpload: integer('STORAGE_MAX_FILES_PER_UPLOAD', 50, { min: 1, max: 500 }),
    /** Verify SHA-256 on read for files at or below this size; larger files stream-verify. */
    verifyOnReadMaxBytes: integer('STORAGE_VERIFY_ON_READ_MAX_BYTES', 4 * 1024 * 1024, { min: 0 }),
    /** Days a soft-deleted file survives before the sweep removes it from disk. */
    purgeGraceDays: integer('STORAGE_PURGE_GRACE_DAYS', 30, { min: 1 }),
    /** The sweep that reclaims purged blobs and abandoned uploads. */
    purgeEnabled: boolean('STORAGE_PURGE_ENABLED', true),
    /** Nothing here is time-sensitive; hourly keeps it off the disk's back. */
    purgeIntervalMs: integer('STORAGE_PURGE_INTERVAL_MS', 3_600_000, { min: 60_000 }),
    /**
     * Per-month JSON manifests describing what each storage directory holds.
     * The disk layout is keyed on date, not the filing tree, so without these
     * losing the database means losing the structure and metadata.
     */
    manifestsEnabled: boolean('STORAGE_MANIFESTS_ENABLED', true),
  }),

  auth: Object.freeze({
    /** How long a session stays valid without re-authenticating. */
    sessionTtlHours: integer('AUTH_SESSION_TTL_HOURS', 12, { min: 1, max: 24 * 30 }),
    /**
     * Sliding window: a session in active use has its expiry pushed out, but no
     * further than absoluteTtlHours from creation. Without an absolute ceiling a
     * session that is polled forever never expires at all.
     */
    absoluteTtlHours: integer('AUTH_SESSION_ABSOLUTE_TTL_HOURS', 24 * 7, { min: 1 }),
    /** Failed attempts before the account locks. */
    maxFailedLogins: integer('AUTH_MAX_FAILED_LOGINS', 5, { min: 3, max: 50 }),
    /** How long the lock lasts. Temporary by design: a permanent lock is a denial-of-service against a real user. */
    lockoutMinutes: integer('AUTH_LOCKOUT_MINUTES', 15, { min: 1, max: 24 * 60 }),
    /**
     * Minimum password length. NIST 800-63B: length beats composition rules, and
     * forced rotation makes passwords worse, so neither is imposed here.
     *
     * 12 is the default and the recommendation. It is not a floor: the bound
     * below matches the one on the corresponding setting, because a limit
     * enforced here and not there — or the reverse — means the same policy is
     * accepted from one direction and refused from the other.
     *
     * The ceiling of 200 is the longest password `validatePassword` accepts. A
     * minimum above it is unsatisfiable rather than merely lax.
     */
    minPasswordLength: integer('AUTH_MIN_PASSWORD_LENGTH', 12, { min: 1, max: 200 }),
    /** Cookie name for the session token. */
    cookieName: optional('AUTH_COOKIE_NAME', 'dms_session'),
    /**
     * Secure cookies require HTTPS. On by default in production; a developer on
     * plain http://localhost would otherwise never receive the cookie at all.
     */
    cookieSecure: boolean('AUTH_COOKIE_SECURE', optional('NODE_ENV', 'development') === 'production'),
    /** How long a self-service reset link stays valid. Short by design. */
    resetTokenMinutes: integer('AUTH_RESET_TOKEN_MINUTES', 30, { min: 5, max: 24 * 60 }),
    /**
     * How a reset link reaches the user. Only 'log' is implemented -- it writes
     * the link to the application log, which suits a small on-prem install where
     * an administrator can read it. A reset flow that silently drops its email
     * is worse than none, so nothing pretends to send until a real transport
     * exists here.
     */
    resetDelivery: optional('AUTH_RESET_DELIVERY', 'log'),
    /** Base URL the reset link points at, i.e. where the browser reaches this app. */
    resetLinkBase: optional('AUTH_RESET_LINK_BASE', 'http://localhost:5173'),
  }),

  extraction: Object.freeze({
    /** The worker runs in the API process. Turn off to run it separately, or not at all. */
    enabled: boolean('EXTRACTION_ENABLED', true),
    pollMs: integer('EXTRACTION_POLL_MS', 15_000, { min: 1000 }),
    /** Jobs per polling pass. Bounds how long one tick can hold the process busy. */
    batchSize: integer('EXTRACTION_BATCH_SIZE', 25, { min: 1, max: 500 }),
    /** Attempts before a document is marked permanently failed rather than retried forever. */
    maxAttempts: integer('EXTRACTION_MAX_ATTEMPTS', 3, { min: 1, max: 20 }),
    /** Files above this are skipped: parsing a 200MB PDF for a search index is not worth the memory. */
    maxBytes: integer('EXTRACTION_MAX_BYTES', 64 * 1024 * 1024, { min: 1024 }),
    /** Characters kept per document. Beyond this, more text adds nothing findable. */
    maxChars: integer('EXTRACTION_MAX_CHARS', 2_000_000, { min: 1000 }),
  }),

  ocr: Object.freeze({
    /**
     * OFF by default, deliberately. OCR needs Tesseract (and OCRmyPDF for PDFs)
     * installed on the server, and a system that silently does nothing is worse
     * than one that says it is switched off.
     */
    enabled: boolean('OCR_ENABLED', false),
    /**
     * Tesseract language packs, '+'-joined. 'ara' must be installed separately
     * from the engine -- present engine, absent Arabic data is the specific
     * failure that produces silently empty results.
     */
    languages: optional('OCR_LANGUAGES', 'ara+eng'),
    tesseractPath: optional('OCR_TESSERACT_PATH', 'tesseract'),
    /**
     * Where the .traineddata files live, when they are not beside the engine.
     * Installing language data into Program Files needs administrator rights,
     * so a user-owned directory is the normal arrangement on Windows.
     */
    tessdataDir: optional('OCR_TESSDATA_DIR', ''),
    ocrmypdfPath: optional('OCR_OCRMYPDF_PATH', 'ocrmypdf'),
    /**
     * How sure OCRmyPDF must be before it rotates a page it believes is upside
     * down. Lower means readier to rotate.
     *
     * Its own default is 14, which is too strict for real scans. Two upside-down
     * pages measured here, both identified correctly and both left alone:
     *
     *   a dense English page   facing down, confidence 11.28
     *   a sparse Arabic page   facing down, confidence  5.68
     *
     * Confidence tracks how much text the page carries, not how sure the
     * direction is — the direction was right in both. The recognised text came
     * back as mirrored nonsense ("physical" as "jeaisAyd") while every status in
     * the system reported a successful OCR, because plenty of characters were
     * produced.
     *
     * The harm is symmetric: a rotation missed and a rotation wrongly applied
     * both yield an unreadable document, silently. So this is set to catch both
     * observed cases while still ignoring near-zero guesses, which is where a
     * near-blank page would land. Two data points is thin evidence, hence the
     * environment override.
     */
    rotateThreshold: number('OCR_ROTATE_THRESHOLD', 3, { min: 0, max: 100 }),
    /** Hard kill after this. A wedged OCR run would otherwise hold a worker slot forever. */
    timeoutMs: integer('OCR_TIMEOUT_MS', 300_000, { min: 10_000 }),
    /** Below this many characters, OCR is treated as having found nothing. */
    minCharacters: integer('OCR_MIN_CHARACTERS', 24, { min: 1 }),
    maxChars: integer('OCR_MAX_CHARS', 2_000_000, { min: 1000 }),
  }),

  classification: Object.freeze({
    /**
     * The document-recognition pilot. OFF by default: it costs a Ghostscript
     * and a Tesseract pass per document and exists to be measured before
     * anything routes on it. The stored setting `classification.enabled`
     * overrides this at runtime, so a pilot machine switches it on from the
     * administration screen and a production install never notices it.
     */
    enabled: boolean('CLASSIFICATION_ENABLED', false),
    pollMs: integer('CLASSIFICATION_POLL_MS', 15_000, { min: 1000 }),
    /** Jobs per polling pass. Each is an OCR pass, so this bounds how long a tick can run. */
    batchSize: integer('CLASSIFICATION_BATCH_SIZE', 10, { min: 1, max: 500 }),
    maxAttempts: integer('CLASSIFICATION_MAX_ATTEMPTS', 3, { min: 1, max: 20 }),
    /** Hard kill for one rasterise-and-recognise run of a single page. */
    timeoutMs: integer('CLASSIFICATION_TIMEOUT_MS', 180_000, { min: 10_000 }),
    /** Resolution page one is rasterised at. 300 is what Tesseract's documentation asks for. */
    dpi: integer('CLASSIFICATION_DPI', 300, { min: 72, max: 600 }),
  }),

  mail: Object.freeze({
    /** Empty means no SMTP. The reset flow then falls back to the log transport. */
    host: optional('MAIL_HOST', ''),
    port: integer('MAIL_PORT', 587, { min: 1, max: 65535 }),
    /** Implicit TLS. True for port 465; false elsewhere, where STARTTLS is used. */
    secure: boolean('MAIL_SECURE', false),
    /**
     * Makes the STARTTLS upgrade mandatory. An on-prem relay that quietly
     * declines it would otherwise receive credentials in the clear.
     */
    requireTls: boolean('MAIL_REQUIRE_TLS', true),
    /** Set false only for a relay with a self-signed certificate you control. */
    rejectUnauthorized: boolean('MAIL_REJECT_UNAUTHORIZED', true),
    user: optional('MAIL_USER', ''),
    password: optional('MAIL_PASSWORD', ''),
    from: optional('MAIL_FROM', 'DMS <no-reply@localhost>'),
  }),

  renditions: Object.freeze({
    /** Thumbnails and Office previews. Images work with no external tools. */
    enabled: boolean('RENDITIONS_ENABLED', true),
    pollMs: integer('RENDITIONS_POLL_MS', 20_000, { min: 1000 }),
    /** LibreOffice headless converts Office files to PDF for preview. */
    libreOfficePath: optional('RENDITIONS_LIBREOFFICE_PATH', 'soffice'),
    /** Ghostscript rasterises the first PDF page for a thumbnail. */
    ghostscriptPath: optional('RENDITIONS_GHOSTSCRIPT_PATH', 'gs'),
    timeoutMs: integer('RENDITIONS_TIMEOUT_MS', 120_000, { min: 5000 }),
  }),

  logging: Object.freeze({
    level: optional('LOG_LEVEL', 'info'),
    pretty: boolean('LOG_PRETTY', optional('NODE_ENV', 'development') !== 'production'),
  }),
});

export const configWarnings = Object.freeze([...warnings]);

if (problems.length > 0) {
  throw new ConfigError(
    `Invalid configuration — the application cannot start:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\n` +
      'Copy .env.example to .env and fill it in.',
  );
}
