/**
 * What an upload is allowed to be, according to the administrator.
 *
 * ─── Why this module exists ─────────────────────────────────────────────────
 *
 * Both rules had settings before they had enforcement. `upload.max_bytes` was
 * checked against the boot-time config in three separate places, so lowering it
 * in the interface changed nothing; `upload.allowed_extensions` was checked
 * nowhere at all — a filter offered on screen, stored on save, and honoured by
 * no line of code in the system. Every upload entrance now asks here, and there
 * is exactly one here to ask.
 *
 * ─── The extension rule ─────────────────────────────────────────────────────
 *
 * An empty list means no restriction; that is the shipped default and the
 * common case. Once a list is set, a file with *no* extension is refused too:
 * the rule exists to keep certain kinds of file out, and a file that declines
 * to say what kind it is cannot be passed by a rule about kinds.
 */

import path from 'node:path';

import { config } from '../../config/index.js';
import { getSetting } from '../settings/service.js';

/** The most bytes one upload may carry, as currently configured. */
export async function effectiveMaxBytes() {
  try {
    return await getSetting('upload.max_bytes');
  } catch {
    // The database being briefly unreachable must not turn the limit off.
    return config.storage.maxUploadBytes;
  }
}

/**
 * The refusal for a filename the extension policy does not admit, or null.
 *
 * Returns the allowed list with the refusal so the message can say what would
 * have been accepted — "refused" alone sends the person off to guess.
 */
export async function extensionRefusal(filename) {
  let allowed;
  try {
    allowed = await getSetting('upload.allowed_extensions');
  } catch {
    // No policy readable means no restriction, matching the shipped default.
    return null;
  }

  if (!Array.isArray(allowed) || allowed.length === 0) return null;

  const extension = path.extname(String(filename ?? '')).slice(1).toLowerCase();
  if (extension && allowed.includes(extension)) return null;

  return { reason: 'blocked_extension', extension: extension || null, allowed };
}
