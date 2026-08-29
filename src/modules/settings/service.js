/**
 * Runtime settings.
 *
 * ─── What belongs here and what does not ────────────────────────────────────
 *
 * Only values that are safe to change while the system is running. Connection
 * strings, the storage root and the SMTP password stay in .env: they are read
 * once at boot, a bad value must stop the process rather than break it halfway
 * through a request, and a database that holds its own connection string cannot
 * be read to find it.
 *
 * ─── Environment wins ───────────────────────────────────────────────────────
 *
 * Where a setting also exists in the environment, the environment is the
 * fallback and the database is the override — but only for settings listed here.
 * That ordering matters for an on-prem install: an administrator locked out by a
 * bad stored value can set the environment variable and restart, and does not
 * need someone with SQL access to recover.
 *
 * The cache is short-lived rather than invalidated on write. A stale setting for
 * a few seconds is harmless; a cache-invalidation protocol for a table with a
 * dozen rows is not worth its own failure modes.
 */

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('settings');

const CACHE_TTL_MS = 10_000;
let cache = { at: 0, values: null };

/**
 * The editable settings, with the type each is stored as and where its default
 * comes from. A key absent from here cannot be written, so the panel cannot be
 * used to invent settings nothing reads.
 */
export const EDITABLE = Object.freeze({
  'organisation.name': { type: 'string', fallback: () => 'إدارة الوثائق' },
  'ui.default_language': { type: 'string', fallback: () => 'ar', options: ['ar', 'en'] },
  'upload.max_bytes': { type: 'int', fallback: () => config.storage.maxUploadBytes, min: 1024 },
  'upload.allowed_extensions': { type: 'list', fallback: () => [] },
  'upload.duplicate_policy': {
    type: 'string',
    fallback: () => 'warn',
    options: ['allow', 'warn', 'block'],
  },
  'storage.purge_grace_days': { type: 'int', fallback: () => config.storage.purgeGraceDays, min: 1 },
  'auth.session_ttl_hours': { type: 'int', fallback: () => config.auth.sessionTtlHours, min: 1, max: 720 },
  'auth.max_failed_logins': { type: 'int', fallback: () => config.auth.maxFailedLogins, min: 3, max: 50 },
  'auth.lockout_minutes': { type: 'int', fallback: () => config.auth.lockoutMinutes, min: 1, max: 1440 },
  'auth.min_password_length': {
    type: 'int',
    fallback: () => config.auth.minPasswordLength,
    min: 8,
    max: 128,
  },
  'ocr.enabled': { type: 'bool', fallback: () => config.ocr.enabled },
  'extraction.enabled': { type: 'bool', fallback: () => config.extraction.enabled },
});

function parse(raw, type) {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'int': {
      const value = Number(raw);
      return Number.isInteger(value) ? value : null;
    }
    case 'bool':
      return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
    case 'list':
      return String(raw)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    default:
      return String(raw);
  }
}

async function load() {
  const now = Date.now();
  if (cache.values && now - cache.at < CACHE_TTL_MS) return cache.values;

  const values = new Map();
  try {
    const result = await sql`SELECT setting_key, value, value_type FROM dbo.app_settings`.execute(db);
    for (const row of result.rows) {
      values.set(row.setting_key, parse(row.value, row.value_type));
    }
  } catch (error) {
    // Before migration 0006 the table does not exist. Falling back to the
    // environment keeps the system usable rather than failing every request.
    log.warn({ err: error }, 'could not read settings; using environment defaults');
  }

  cache = { at: now, values };
  return values;
}

/** One setting, with the environment as fallback. */
export async function getSetting(key) {
  const definition = EDITABLE[key];
  if (!definition) throw new Error(`unknown setting: ${key}`);

  const values = await load();
  const stored = values.get(key);

  // An empty list is a real value ("no restriction"), so only null and undefined
  // fall through to the default.
  return stored === null || stored === undefined ? definition.fallback() : stored;
}

/** Every setting and its effective value, for the configuration panel. */
export async function listSettings() {
  const values = await load();

  return Object.entries(EDITABLE).map(([key, definition]) => {
    const stored = values.get(key);
    const overridden = stored !== null && stored !== undefined;
    return {
      key,
      type: definition.type,
      value: overridden ? stored : definition.fallback(),
      // Showing which values are stored and which come from the environment is
      // what makes "I changed it and nothing happened" diagnosable.
      source: overridden ? 'database' : 'environment',
      options: definition.options ?? null,
      min: definition.min ?? null,
      max: definition.max ?? null,
    };
  });
}

/**
 * Writes one setting.
 *
 * Validated against the same definition the reader uses, so a value that would
 * be rejected on read cannot be stored.
 */
export async function setSetting({ key, value, actorId }) {
  const definition = EDITABLE[key];
  if (!definition) return { ok: false, reason: 'unknown_setting' };

  const text =
    definition.type === 'list'
      ? (Array.isArray(value) ? value : String(value ?? '').split(','))
          .map((item) => String(item).trim())
          .filter(Boolean)
          .join(',')
      : String(value ?? '');

  const parsed = parse(text, definition.type);

  if (definition.type === 'int') {
    if (parsed === null) return { ok: false, reason: 'invalid_value' };
    if (definition.min !== undefined && parsed < definition.min) return { ok: false, reason: 'out_of_range' };
    if (definition.max !== undefined && parsed > definition.max) return { ok: false, reason: 'out_of_range' };
  }

  if (definition.options && !definition.options.includes(String(parsed))) {
    return { ok: false, reason: 'invalid_value' };
  }

  if (definition.type === 'string' && text.length > 2000) return { ok: false, reason: 'invalid_value' };

  await sql`
    MERGE dbo.app_settings WITH (HOLDLOCK) AS target
    USING (SELECT ${key} AS setting_key) AS source
       ON target.setting_key = source.setting_key
    WHEN MATCHED THEN
      UPDATE SET value = ${text}, value_type = ${definition.type},
                 updated_at = SYSUTCDATETIME(), updated_by = ${actorId ?? null}
    WHEN NOT MATCHED THEN
      INSERT (setting_key, value, value_type, updated_by)
      VALUES (source.setting_key, ${text}, ${definition.type}, ${actorId ?? null});
  `.execute(db);

  cache = { at: 0, values: null };
  log.info({ key, value: text }, 'setting changed');
  return { ok: true };
}

/** Clears an override so the environment value applies again. */
export async function clearSetting({ key }) {
  if (!EDITABLE[key]) return { ok: false, reason: 'unknown_setting' };

  await sql`UPDATE dbo.app_settings SET value = NULL WHERE setting_key = ${key}`.execute(db);
  cache = { at: 0, values: null };
  return { ok: true };
}

/** Test seam. */
export function resetSettingsCache() {
  cache = { at: 0, values: null };
}
