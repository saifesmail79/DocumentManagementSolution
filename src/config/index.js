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
    /** Verify SHA-256 on read for files at or below this size; larger files stream-verify. */
    verifyOnReadMaxBytes: integer('STORAGE_VERIFY_ON_READ_MAX_BYTES', 4 * 1024 * 1024, { min: 0 }),
    /** Days a soft-deleted file survives before the sweep removes it from disk. */
    purgeGraceDays: integer('STORAGE_PURGE_GRACE_DAYS', 30, { min: 1 }),
    /** The sweep that reclaims purged blobs and abandoned uploads. */
    purgeEnabled: boolean('STORAGE_PURGE_ENABLED', true),
    /** Nothing here is time-sensitive; hourly keeps it off the disk's back. */
    purgeIntervalMs: integer('STORAGE_PURGE_INTERVAL_MS', 3_600_000, { min: 60_000 }),
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
     */
    minPasswordLength: integer('AUTH_MIN_PASSWORD_LENGTH', 12, { min: 8, max: 128 }),
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
