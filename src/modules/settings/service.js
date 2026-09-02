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
import { MAX_PASSWORD_LENGTH } from '../auth/passwords.js';
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
  // ui.default_language used to be offered here. Nothing consumes it — the
  // interface has no second language to switch to — and a control wired to
  // no capability teaches people that this screen does not do what it says.
  // It returns when there is an interface language to choose.
  'upload.max_bytes': { type: 'int', fallback: () => config.storage.maxUploadBytes, min: 1024 },
  'upload.allowed_extensions': { type: 'list', fallback: () => [] },
  'upload.duplicate_policy': {
    type: 'string',
    fallback: () => 'warn',
    options: ['allow', 'warn', 'block'],
  },
  'storage.purge_grace_days': { type: 'int', fallback: () => config.storage.purgeGraceDays, min: 1 },
  /*
   * Where documents live.
   *
   * Editable here rather than only in the environment because a NAS gets
   * replaced, a share gets renamed and a volume fills up — and each of those
   * used to mean editing a file on the server and restarting. Every stored path
   * is relative to this, so changing it rewrites nothing.
   *
   * `guarded` marks it as a setting the plain text box must not write: it is
   * applied through the relocation flow, which validates the destination and
   * then reports which files are not there yet. A blind write would point a
   * running system at an empty directory and make every document unreachable
   * with no warning and nothing to work from.
   */
  'storage.root': { type: 'string', fallback: () => config.storage.root, guarded: true },
  'auth.session_ttl_hours': { type: 'int', fallback: () => config.auth.sessionTtlHours, min: 1, max: 720 },
  'auth.max_failed_logins': { type: 'int', fallback: () => config.auth.maxFailedLogins, min: 3, max: 50 },
  'auth.lockout_minutes': { type: 'int', fallback: () => config.auth.lockoutMinutes, min: 1, max: 1440 },
  /*
   * The minimum password length, with the floor removed at the owner's
   * direction.
   *
   * It used to refuse anything below 8. That is a defensible default and it was
   * a poor thing to enforce as a limit: the setting exists precisely so that an
   * administrator can decide the policy for their own installation, and a
   * control that refuses the decision it was built to record is not a setting
   * but an opinion with a text box in front of it.
   *
   * The remaining bound is not a policy judgement. `validatePassword` refuses
   * any password over 200 characters, so a *minimum* above 200 could never be
   * satisfied by anyone — it would lock every account out of changing its own
   * password, including the last administrator. That is the one value the
   * setting cannot usefully hold, so it is the one value it will not take.
   */
  'auth.min_password_length': {
    type: 'int',
    fallback: () => config.auth.minPasswordLength,
    min: 1,
    max: MAX_PASSWORD_LENGTH,
  },
  /*
   * The other two password rules, so the whole policy is in one visible place.
   *
   * On by default. Turning them off is legitimate — an air-gapped installation
   * with physical access control has different threats than a public one — but
   * it is a decision, and decisions live in settings where the audit log records
   * who made them and when.
   */
  'auth.password_block_predictable': { type: 'bool', fallback: () => true },
  'auth.password_block_username': { type: 'bool', fallback: () => true },
  /*
   * Composition rules. Off by default on the evidence (NIST 800-63B: length
   * beats composition, and composition pushes people to Password1!), on offer
   * because plenty of installations answer to a directive that requires them.
   */
  'auth.password_require_lowercase': { type: 'bool', fallback: () => false },
  'auth.password_require_uppercase': { type: 'bool', fallback: () => false },
  'auth.password_require_digit': { type: 'bool', fallback: () => false },
  'auth.password_require_symbol': { type: 'bool', fallback: () => false },
  'ocr.enabled': { type: 'bool', fallback: () => config.ocr.enabled },
  'extraction.enabled': { type: 'bool', fallback: () => config.extraction.enabled },
  /*
   * The document-recognition pilot.
   *
   * Off in the environment by default, and this stored switch is how a pilot
   * machine turns it on without touching .env — and how a production install
   * keeps it off while carrying the same code. Everything the pilot does reads
   * this: queueing at upload, the worker's ticks, and the routes.
   */
  'classification.enabled': { type: 'bool', fallback: () => config.classification.enabled },
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
export async function setSetting({ key, value, actorId, allowGuarded = false }) {
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

    /*
     * The bounds travel with the refusal.
     *
     * "Out of range" without the range is a guessing game played one save at a
     * time, and the caller has no other way to learn the answer — the limits are
     * in this file and nowhere the person typing can see. They are already
     * published by `listSettings`; there is no reason for the refusal to be more
     * secretive than the list.
     */
    const outOfRange =
      (definition.min !== undefined && parsed < definition.min)
      || (definition.max !== undefined && parsed > definition.max);

    if (outOfRange) {
      return {
        ok: false,
        reason: 'out_of_range',
        min: definition.min ?? null,
        max: definition.max ?? null,
      };
    }
  }

  if (definition.options && !definition.options.includes(String(parsed))) {
    return { ok: false, reason: 'invalid_value' };
  }

  if (definition.type === 'string' && text.length > 2000) return { ok: false, reason: 'invalid_value' };

  /*
   * A guarded setting has consequences the generic writer cannot carry out.
   *
   * `storage.root` is the case: accepting it needs the destination validated
   * and the live driver repointed, and skipping either leaves the row saying one
   * thing and the running process doing another. The relocation service calls
   * `setSetting` with `allowGuarded` once it has done that work.
   */
  if (definition.guarded && !allowGuarded) return { ok: false, reason: 'guarded_setting' };

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
