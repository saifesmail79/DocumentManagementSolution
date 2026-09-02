/**
 * What a user has arranged for themselves.
 *
 * ─── Every key is declared here ─────────────────────────────────────────────
 *
 * The store is generic, so without an allowlist any authenticated caller could
 * write unbounded rows under keys of their own invention — a table that grows
 * without limit and that nothing reads. `PREFERENCES` is therefore the whole set
 * of preferences that exist, and each entry brings its own validator, because
 * "user-supplied JSON stored verbatim" is only safe if something has decided
 * what shape it is allowed to be.
 *
 * ─── Why the validation is loose about names it does not know ───────────────
 *
 * The tile order is a list of module keys, and the obvious validation is to
 * refuse any key the server does not recognise. The server has no business
 * knowing the client's module list, though, and hard-coding a copy of it here
 * would mean a module added to the interface is rejected by the API until
 * someone remembers to update a second list.
 *
 * So the shape is enforced — short strings, no duplicates, a sane count — and
 * the meaning is reconciled at the point of use: the client orders the modules
 * it actually has by this list and ignores the rest. A stored name that no
 * longer exists is not an error; it is simply a module that has since been
 * removed, and it should not stop the others from being ordered.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('preferences');

/** A defensive ceiling. The tile menu has five entries; this is not a list. */
const MAX_ORDER_ENTRIES = 64;
const MAX_KEY_LENGTH = 40;

/**
 * The order the module tiles are shown in.
 *
 * @param {unknown} value
 * @returns {{ok: true, value: string[]} | {ok: false, reason: string}}
 */
function validateTileOrder(value) {
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid_value' };
  if (value.length > MAX_ORDER_ENTRIES) return { ok: false, reason: 'too_many_entries' };

  const keys = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, reason: 'invalid_value' };

    const key = entry.trim();
    // The client's own module keys are lower-case identifiers. Anything else is
    // not a module name, whatever else it might be.
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || key.length > MAX_KEY_LENGTH) {
      return { ok: false, reason: 'invalid_value' };
    }
    // Duplicates would make the order ambiguous, and are only ever a bug.
    if (keys.includes(key)) return { ok: false, reason: 'duplicate_entry' };

    keys.push(key);
  }

  return { ok: true, value: keys };
}

/** Every preference that exists, and the shape each one may hold. */
export const PREFERENCES = Object.freeze({
  'home.tileOrder': { validate: validateTileOrder, fallback: () => [] },
});

/** All of this user's preferences, with defaults for the ones never set. */
export async function listPreferences(userId) {
  const rows = await sql`
    SELECT pref_key, value FROM dbo.user_preferences WHERE user_id = ${userId}
  `.execute(db);

  const stored = new Map(rows.rows.map((row) => [row.pref_key, row.value]));
  const result = {};

  for (const [key, definition] of Object.entries(PREFERENCES)) {
    const raw = stored.get(key);
    if (raw === undefined) {
      result[key] = definition.fallback();
      continue;
    }

    /*
     * A stored value that no longer parses or no longer validates is replaced by
     * the default rather than returned or thrown on.
     *
     * The row can outlive the rule that wrote it — a preference whose shape
     * changed between releases is the ordinary case — and neither a 500 nor a
     * malformed value reaching the interface is an acceptable outcome for
     * something as inconsequential as a remembered arrangement.
     */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn({ userId: String(userId), key }, 'stored preference is not valid JSON; using the default');
      result[key] = definition.fallback();
      continue;
    }

    const checked = definition.validate(parsed);
    if (!checked.ok) {
      log.warn({ userId: String(userId), key, reason: checked.reason }, 'stored preference no longer validates');
      result[key] = definition.fallback();
      continue;
    }

    result[key] = checked.value;
  }

  return result;
}

/**
 * Records one preference.
 *
 * @returns {Promise<{ok: true, key: string, value: unknown} | {ok: false, reason: string}>}
 */
export async function setPreference({ userId, key, value }) {
  const definition = PREFERENCES[key];
  if (!definition) return { ok: false, reason: 'unknown_preference' };

  const checked = definition.validate(value);
  if (!checked.ok) return checked;

  const encoded = JSON.stringify(checked.value);

  await sql`
    MERGE dbo.user_preferences WITH (HOLDLOCK) AS target
    USING (SELECT ${userId} AS user_id, ${key} AS pref_key) AS source
       ON target.user_id = source.user_id AND target.pref_key = source.pref_key
    WHEN MATCHED THEN
      UPDATE SET value = ${encoded}, updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN
      INSERT (user_id, pref_key, value) VALUES (source.user_id, source.pref_key, ${encoded});
  `.execute(db);

  return { ok: true, key, value: checked.value };
}

/** Forgets one preference, so the default applies again. */
export async function clearPreference({ userId, key }) {
  if (!PREFERENCES[key]) return { ok: false, reason: 'unknown_preference' };

  await sql`
    DELETE FROM dbo.user_preferences WHERE user_id = ${userId} AND pref_key = ${key}
  `.execute(db);

  return { ok: true, key, value: PREFERENCES[key].fallback() };
}
