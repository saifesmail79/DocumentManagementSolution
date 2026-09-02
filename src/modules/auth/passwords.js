/**
 * Password hashing and policy.
 *
 * argon2id, which is what the Password Hashing Competition and OWASP both land
 * on: it resists GPU cracking (memory-hard) and side-channel attacks (the "id"
 * hybrid), where bcrypt resists only the first and has a 72-byte input ceiling
 * that silently truncates long passphrases.
 *
 * The policy is length-first and deliberately has no composition rules. NIST
 * 800-63B withdrew the "one uppercase, one digit, one symbol" advice because it
 * produces predictable substitutions (Password1!) and pushes people to write
 * passwords down, while adding little entropy. Length and a blocklist of the
 * obvious choices do more.
 */

import argon2 from 'argon2';
import { config } from '../../config/index.js';

/**
 * Tuned per OWASP's argon2id guidance (19 MiB, t=2, p=1 as the floor). 64 MiB
 * with t=3 is comfortably above it and still ~100ms on this class of hardware,
 * which is the right trade for a login that happens once per session.
 */
const HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
});

/**
 * Passwords that meet the length rule and are still worthless. Kept short and
 * pattern-based rather than importing a million-entry list: the length minimum
 * already excludes most of a leaked-password corpus.
 */
/**
 * The longest password this system will hash.
 *
 * Exported because the minimum-length setting is bounded by it: a minimum above
 * the maximum is a rule no password can satisfy, which locks every account out
 * of its own password change.
 */
export const MAX_PASSWORD_LENGTH = 200;

const BLOCKED_PATTERNS = [
  /^(.)\1+$/, //                     aaaaaaaaaaaa
  /^(012|123|234|345|456|567|678|789|890)+/, // sequential digits
  /^(qwerty|asdf|zxcv|password|passw0rd|letmein|welcome|admin)/i,
  /^(dms|document|management)/i, //   named after this system
];

/**
 * Validates a candidate password.
 *
 * @param {string} password
 * @param {{username?: string, minLength?: number, blockPredictable?: boolean,
 *          blockUsername?: boolean}} [context]
 *   `username` is rejected as a password; `minLength` overrides the compiled-in
 *   default and is what `checkPassword` supplies from the administrator's setting.
 * @returns {{ok: true} | {ok: false, problems: string[]}}
 */
/**
 * Validates a password against the policy an administrator has actually set.
 *
 * ─── Why this exists at all ─────────────────────────────────────────────────
 *
 * `validatePassword` read the minimum length from `config`, which is built once
 * from the environment. The administration screen writes the same policy to
 * `dbo.app_settings`. Nothing joined the two, so changing "أقل طول لكلمة المرور"
 * stored a number, displayed it back as the current value, marked its source as
 * the database — and changed nothing. Passwords went on being measured against
 * whatever `AUTH_MIN_PASSWORD_LENGTH` had been at boot.
 *
 * That is the worst shape a setting can have: it is not broken in a way anyone
 * can see. It accepts input, reports success, and is ignored.
 *
 * The import is dynamic because the settings module imports this one for
 * `MAX_PASSWORD_LENGTH`, and a static import both ways is a cycle. The same
 * pattern is used in the storage relocation module for the same reason.
 */
export async function checkPassword(password, context = {}) {
  let policy = {};
  try {
    const { getSetting } = await import('../settings/service.js');
    policy = {
      minLength: await getSetting('auth.min_password_length'),
      blockPredictable: await getSetting('auth.password_block_predictable'),
      blockUsername: await getSetting('auth.password_block_username'),
      requireLowercase: await getSetting('auth.password_require_lowercase'),
      requireUppercase: await getSetting('auth.password_require_uppercase'),
      requireDigit: await getSetting('auth.password_require_digit'),
      requireSymbol: await getSetting('auth.password_require_symbol'),
    };
  } catch {
    // Unreachable database, or a settings table not yet migrated. The compiled
    // defaults still apply — a password check must not fail open.
    policy = {};
  }

  return validatePassword(password, { ...policy, ...context });
}

export function validatePassword(password, context = {}) {
  const problems = [];
  /*
   * `details` mirrors `problems` entry for entry, as codes with parameters.
   *
   * The strings are English and always were — fine for a log, wrong on a
   * screen whose every other word is Arabic, and the screens were showing them
   * raw. Translating server strings by matching them is a trap (edit the
   * sentence, lose the translation), so the code is the contract and the
   * string is the fallback for a code the client has never heard of.
   */
  const details = [];
  const refuse = (message, code, params = {}) => {
    problems.push(message);
    details.push({ code, ...params });
  };

  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, problems: ['Password is required.'], details: [{ code: 'required' }] };
  }

  const min = context.minLength ?? config.auth.minPasswordLength;
  if (password.length < min) {
    refuse(`Password must be at least ${min} characters.`, 'too_short', { min });
  }

  // argon2 has no practical input limit, but an unbounded password is a cheap
  // way to make the server spend 64 MiB and 100ms per request.
  if (password.length > MAX_PASSWORD_LENGTH) {
    refuse(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`, 'too_long', { max: MAX_PASSWORD_LENGTH });
  }

  /*
   * Composition rules, each behind its own setting and all off by default.
   *
   * Off, unlike the two rules above, because they are a different kind of
   * judgement. NIST 800-63B measured this: composition requirements push people
   * toward Password1! and its cousins, and length does more than any of them.
   * The defaults follow the evidence; the switches exist because a policy is
   * still the administrator's to set — many installations answer to an external
   * security directive that simply requires these, whatever the research says.
   *
   * ─── The Arabic problem, decided explicitly ────────────────────────────
   *
   * Arabic script has no letter case. The case rules therefore test for Latin
   * letters specifically, and turning either on forces every password to
   * contain Latin script — there is no way around that which does not quietly
   * make the rule meaningless. The help text says so out loud.
   *
   * Digits and symbols have no such problem and are checked script-blind: the
   * digit rule accepts ٣ as readily as 3 (both arrive from real keyboards
   * here), and a symbol is anything that is not a letter, digit or space in
   * any script.
   */
  if (context.requireLowercase && !/[a-z]/.test(password)) {
    refuse('Password must contain a lowercase letter (a-z).', 'needs_lowercase');
  }

  if (context.requireUppercase && !/[A-Z]/.test(password)) {
    refuse('Password must contain an uppercase letter (A-Z).', 'needs_uppercase');
  }

  // ASCII, Arabic-Indic and extended Arabic-Indic digits all count.
  if (context.requireDigit && !/[0-9\u0660-\u0669\u06F0-\u06F9]/.test(password)) {
    refuse('Password must contain a digit.', 'needs_digit');
  }

  // Combining marks are excluded alongside letters: tashkeel is part of the
  // writing, and a rule that counted ً as a "symbol" would be satisfied by
  // ordinary vocalised Arabic while the help promises punctuation. Format and
  // control characters (\p{C}) are excluded too — ZWJ and ZWNJ ride along in
  // Arabic text to steer ligatures, are invisible in a password field, and a
  // rule satisfied by a character nobody can see is a rule that lies twice:
  // once to the user who typed no symbol, and once to the administrator who
  // believes one is being required.
  if (context.requireSymbol && !/[^\p{L}\p{M}\p{N}\p{C}\s]/u.test(password)) {
    refuse('Password must contain a symbol (e.g. ! @ # %).', 'needs_symbol');
  }

  // Each rule answers to its own setting, defaulting to on: an administrator
  // who has said nothing has not opted out of anything.
  if (
    (context.blockPredictable ?? true)
    && BLOCKED_PATTERNS.some((pattern) => pattern.test(password))
  ) {
    refuse('Password is too predictable — avoid repeated characters, sequences and common words.', 'predictable');
  }

  if (
    (context.blockUsername ?? true)
    && context.username
    && password.toLowerCase().includes(context.username.toLowerCase())
  ) {
    refuse('Password must not contain the username.', 'contains_username');
  }

  return problems.length > 0 ? { ok: false, problems, details } : { ok: true };
}

/** @returns {Promise<string>} an encoded argon2id hash, parameters included */
export function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Never throws for a bad password — argon2.verify raises on a malformed or
 * unrecognised hash, and letting that propagate would turn a corrupted row into
 * a 500 that leaks which accounts have broken hashes. A hash we cannot read is
 * simply a failed login.
 */
export async function verifyPassword(hash, password) {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash was made with weaker parameters than we now use. */
export function needsRehash(hash) {
  try {
    return argon2.needsRehash(hash, HASH_OPTIONS);
  } catch {
    return true;
  }
}
