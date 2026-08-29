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
 * @param {{username?: string}} [context] used to reject the username as password
 * @returns {{ok: true} | {ok: false, problems: string[]}}
 */
export function validatePassword(password, context = {}) {
  const problems = [];

  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, problems: ['Password is required.'] };
  }

  const min = config.auth.minPasswordLength;
  if (password.length < min) {
    problems.push(`Password must be at least ${min} characters.`);
  }

  // argon2 has no practical input limit, but an unbounded password is a cheap
  // way to make the server spend 64 MiB and 100ms per request.
  if (password.length > 200) {
    problems.push('Password must be at most 200 characters.');
  }

  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(password))) {
    problems.push('Password is too predictable — avoid repeated characters, sequences and common words.');
  }

  if (context.username && password.toLowerCase().includes(context.username.toLowerCase())) {
    problems.push('Password must not contain the username.');
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true };
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
