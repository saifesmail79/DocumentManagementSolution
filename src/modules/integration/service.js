/**
 * API keys, webhooks and expiring share links.
 *
 * ─── An API key acts as a user ──────────────────────────────────────────────
 *
 * A key does not carry its own permission set; it authenticates as an existing
 * account. That keeps one permission model instead of two, and makes "what can
 * this integration reach" answerable by looking at an ordinary user in the admin
 * screen rather than at a second, parallel grant system nobody maintains.
 *
 * ─── Share links are the sharpest edge in the system ────────────────────────
 *
 * A share link hands document content to whoever holds the URL, with no login
 * and no ACL check. So one is always bounded: it expires, it can carry a
 * password, it can cap downloads, it names its creator, and it grants exactly
 * one document — never a folder, never a subtree.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, has } from '../tree/service.js';
import { documentPermission } from '../collaboration/service.js';

const log = moduleLogger('integration');

const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

/** Events a webhook can subscribe to. A closed list, so a typo cannot subscribe to nothing. */
export const WEBHOOK_EVENTS = Object.freeze([
  'document.created',
  'document.updated',
  'document.deleted',
  'document.version_added',
  'approval.requested',
  'approval.decided',
]);

// ── API keys ─────────────────────────────────────────────────────────────

/**
 * Issues a key. The secret is returned exactly once and never stored readable —
 * the same rule as sessions and reset tokens, for the same reason: a database
 * backup that yields a working key is a standing back door.
 */
export async function createApiKey({ name, userId, createdBy, expiresAt = null }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };

  const target = await sql`
    SELECT u.user_id FROM dbo.users u
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE u.user_id = ${userId} AND p.is_active = 1
  `.execute(db);
  if (!target.rows[0]) return { ok: false, reason: 'unknown_user' };

  // A recognisable prefix so a key can be identified in a list without being
  // usable from it.
  const prefix = `dms_${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  const key = `${prefix}.${secret}`;

  let iso = null;
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    // An unparseable string yields NaN; a past date creates a key that is
    // already expired — both are caller errors, not server errors.
    if (isNaN(parsed.getTime()) || parsed <= new Date()) {
      return { ok: false, reason: 'invalid_expiry' };
    }
    iso = parsed.toISOString();
  }

  const result = await sql`
    INSERT INTO dbo.api_keys (name, key_hash, key_prefix, user_id, created_by, expires_at)
    OUTPUT INSERTED.key_id AS kid
    VALUES (${clean}, ${hash(key)}, ${prefix}, ${userId}, ${createdBy},
            ${iso === null ? sql`NULL` : sql`CONVERT(datetime2(3), ${iso}, 126)`})
  `.execute(db);

  log.info({ keyId: String(result.rows[0].kid), name: clean }, 'API key created');
  return { ok: true, keyId: String(result.rows[0].kid), key, prefix };
}

export async function listApiKeys() {
  const result = await sql`
    SELECT k.key_id, k.name, k.key_prefix, k.user_id, k.created_at, k.expires_at,
           k.last_used_at, k.revoked_at, p.display_name AS acts_as
      FROM dbo.api_keys k
      JOIN dbo.principals p ON p.principal_id = k.user_id
     ORDER BY k.created_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    keyId: String(row.key_id),
    name: row.name,
    prefix: row.key_prefix,
    actsAs: row.acts_as,
    userId: String(row.user_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked_at !== null,
  }));
}

export async function revokeApiKey({ keyId }) {
  const result = await sql`
    UPDATE dbo.api_keys SET revoked_at = SYSUTCDATETIME()
     WHERE key_id = ${keyId} AND revoked_at IS NULL
  `.execute(db);

  return Number(result.numAffectedRows ?? 0) === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * Resolves a presented key to the user it acts as.
 *
 * Every liveness condition is in the one query — key not revoked or expired,
 * account still active — for the same reason session resolution does it: a
 * caller cannot forget a check it never had to make.
 */
export async function resolveApiKey(presented) {
  if (typeof presented !== 'string' || presented.length < 20) return null;

  const result = await sql`
    SELECT k.key_id, k.user_id, u.username, u.is_super_admin, p.display_name
      FROM dbo.api_keys k
      JOIN dbo.users u ON u.user_id = k.user_id
      JOIN dbo.principals p ON p.principal_id = k.user_id
     WHERE k.key_hash = ${hash(presented)}
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > SYSUTCDATETIME())
       AND p.is_active = 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  // Best effort: failing to record usage must not fail the request.
  sql`UPDATE dbo.api_keys SET last_used_at = SYSUTCDATETIME() WHERE key_id = ${row.key_id}`
    .execute(db)
    .catch(() => {});

  return {
    userId: String(row.user_id),
    username: row.username,
    displayName: row.display_name,
    isSuperAdmin: Number(row.is_super_admin) === 1,
    // An API key must never satisfy a must-change-password gate, and it never
    // needs to: the account behind it is a service account.
    mustChangePassword: false,
    viaApiKey: true,
  };
}

// ── Webhooks ─────────────────────────────────────────────────────────────

/**
 * Validates the three mutable webhook fields so createWebhook and updateWebhook
 * cannot drift out of sync. Returns { ok: false, reason } on the first problem,
 * or { ok: true, clean, parsedUrl, selected } on success.
 */
function validateWebhook({ name, url, events }) {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, reason: 'invalid_name' };

  let parsedUrl;
  try {
    parsedUrl = new URL(String(url));
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return { ok: false, reason: 'invalid_url' };

  const selected = (Array.isArray(events) ? events : []).filter((e) => WEBHOOK_EVENTS.includes(e));
  if (selected.length === 0) return { ok: false, reason: 'no_events' };

  return { ok: true, clean, parsedUrl, selected };
}

export async function createWebhook({ name, url, events, createdBy }) {
  const v = validateWebhook({ name, url, events });
  if (!v.ok) return v;

  // Returned once. The receiver uses it to verify the HMAC on every delivery.
  const secret = randomBytes(24).toString('base64url');

  const result = await sql`
    INSERT INTO dbo.webhooks (name, url, events, secret_hash, created_by)
    OUTPUT INSERTED.webhook_id AS wid
    VALUES (${v.clean}, ${v.parsedUrl.toString()}, ${v.selected.join(',')}, ${hash(secret)}, ${createdBy})
  `.execute(db);

  return { ok: true, webhookId: String(result.rows[0].wid), secret };
}

/**
 * Updates the three mutable webhook fields (name, url, events). The secret_hash
 * is deliberately left untouched — the receiver keeps verifying with the secret
 * it already has, and rotating it would silently break every running consumer.
 */
export async function updateWebhook({ webhookId, name, url, events }) {
  const v = validateWebhook({ name, url, events });
  if (!v.ok) return v;

  const result = await sql`
    UPDATE dbo.webhooks
       SET name   = ${v.clean},
           url    = ${v.parsedUrl.toString()},
           events = ${v.selected.join(',')}
     WHERE webhook_id = ${webhookId}
  `.execute(db);

  return Number(result.numAffectedRows ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * Pauses or resumes a webhook. emitEvent and deliverPending already filter on
 * is_active, so pausing stops new deliveries from being queued and halts the
 * retry loop for ones already queued. Deleting would lose the secret, breaking
 * the receiver's signature verification on any reactivation.
 */
export async function setWebhookActive({ webhookId, active }) {
  const result = await sql`
    UPDATE dbo.webhooks SET is_active = ${active ? 1 : 0} WHERE webhook_id = ${webhookId}
  `.execute(db);

  return Number(result.numAffectedRows ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
}

export async function listWebhooks() {
  const result = await sql`
    SELECT w.webhook_id, w.name, w.url, w.events, w.is_active, w.created_at,
           (SELECT COUNT(*) FROM dbo.webhook_deliveries d
             WHERE d.webhook_id = w.webhook_id AND d.status = 2) AS delivered,
           (SELECT COUNT(*) FROM dbo.webhook_deliveries d
             WHERE d.webhook_id = w.webhook_id AND d.status = 4) AS failed
      FROM dbo.webhooks w
     ORDER BY w.created_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    webhookId: String(row.webhook_id),
    name: row.name,
    url: row.url,
    events: String(row.events).split(',').filter(Boolean),
    isActive: Number(row.is_active) === 1,
    createdAt: row.created_at,
    delivered: Number(row.delivered),
    failed: Number(row.failed),
  }));
}

export async function deleteWebhook({ webhookId }) {
  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM dbo.webhook_deliveries WHERE webhook_id = ${webhookId}`.execute(trx);
    await sql`DELETE FROM dbo.webhooks WHERE webhook_id = ${webhookId}`.execute(trx);
  });
  return { ok: true };
}

/**
 * Queues an event for every webhook subscribed to it.
 *
 * Queued, never sent inline. A receiver that is slow, wedged or gone must not
 * make the upload that triggered the event slow, wedged or failed.
 */
export async function emitEvent({ event, payload }) {
  if (!WEBHOOK_EVENTS.includes(event)) return { queued: 0 };

  try {
    const hooks = await sql`
      SELECT webhook_id FROM dbo.webhooks
       WHERE is_active = 1 AND ',' + events + ',' LIKE ${`%,${event},%`}
    `.execute(db);

    if (hooks.rows.length === 0) return { queued: 0 };

    const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });

    for (const row of hooks.rows) {
      await sql`
        INSERT INTO dbo.webhook_deliveries (webhook_id, event, payload)
        VALUES (${row.webhook_id}, ${event}, ${body})
      `.execute(db);
    }

    return { queued: hooks.rows.length };
  } catch (error) {
    // An event that cannot be queued must not fail the action it describes.
    log.error({ err: error, event }, 'could not queue a webhook delivery');
    return { queued: 0 };
  }
}

/**
 * Delivers queued events.
 *
 * Attempts are bounded and the response code is kept: a webhook that has been
 * pointing at a dead host for a week should be visibly failing in the admin
 * screen, not retrying forever in the background.
 */
export async function deliverPending({ max = 20, maxAttempts = 5 } = {}) {
  const pending = await sql`
    SELECT TOP (${max})
           d.delivery_id, d.webhook_id, d.event, d.payload, d.attempts, w.url
      FROM dbo.webhook_deliveries d
      JOIN dbo.webhooks w ON w.webhook_id = d.webhook_id
     WHERE d.status IN (0, 3)
       AND d.attempts < ${maxAttempts}
       AND w.is_active = 1
     ORDER BY d.queued_at
  `.execute(db);

  let delivered = 0;

  for (const row of pending.rows) {
    const attempts = Number(row.attempts) + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DMS-Event': row.event,
          'X-DMS-Delivery': String(row.delivery_id),
        },
        body: row.payload,
        signal: controller.signal,
      });

      const ok = response.ok;
      await sql`
        UPDATE dbo.webhook_deliveries
           SET status = ${ok ? 2 : 3},
               attempts = ${attempts},
               response_code = ${response.status},
               last_error = ${ok ? null : `HTTP ${response.status}`},
               delivered_at = ${ok ? sql`SYSUTCDATETIME()` : sql`NULL`}
         WHERE delivery_id = ${row.delivery_id}
      `.execute(db);

      if (ok) delivered += 1;
    } catch (error) {
      await sql`
        UPDATE dbo.webhook_deliveries
           SET status = ${attempts >= maxAttempts ? 4 : 3},
               attempts = ${attempts},
               last_error = ${String(error.message).slice(0, 1000)}
         WHERE delivery_id = ${row.delivery_id}
      `.execute(db);
    } finally {
      clearTimeout(timer);
    }
  }

  return { delivered, attempted: pending.rows.length };
}

// ── Share links ──────────────────────────────────────────────────────────

export async function createShareLink({
  userId,
  documentId,
  versionNumber = null,
  expiresInHours = 168,
  password = null,
  maxDownloads = null,
}) {
  // Sharing outward requires being able to read it yourself. Anything less would
  // let someone who can only see a title hand out its contents.
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  // A share link delivers one file by version number, and a multi-file document
  // has no version to point at. Left unchecked, the link would resolve to
  // version 0, find nothing, and hand the recipient a broken page — while the
  // sharer's own UI showed a link that looked fine. Refused at creation, where
  // the person can still be told why.
  const { isMultiFileDocument } = await import('../documents/service.js');
  if (await isMultiFileDocument(documentId)) {
    return { ok: false, reason: 'multi_file_document' };
  }

  const hours = Math.min(Math.max(Number(expiresInHours) || 168, 1), 24 * 90);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();

  const { hashPassword } = await import('../auth/passwords.js');
  const passwordHash = password ? await hashPassword(String(password)) : null;

  const result = await sql`
    INSERT INTO dbo.share_links
      (token_hash, document_id, version_number, created_by, expires_at, password_hash, max_downloads)
    OUTPUT INSERTED.share_id AS sid
    VALUES (${hash(token)}, ${documentId}, ${versionNumber}, ${userId},
            CONVERT(datetime2(3), ${expiresAt}, 126), ${passwordHash},
            ${maxDownloads ? Number(maxDownloads) : null})
  `.execute(db);

  log.info({ shareId: String(result.rows[0].sid), documentId: String(documentId) }, 'share link created');

  return {
    ok: true,
    shareId: String(result.rows[0].sid),
    url: `${config.auth.resetLinkBase}/share/${token}`,
    token,
    expiresAt,
  };
}

export async function listShareLinks({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const result = await sql`
    SELECT s.share_id, s.version_number, s.created_at, s.expires_at, s.revoked_at,
           s.download_count, s.max_downloads, p.display_name AS created_by,
           CAST(CASE WHEN s.password_hash IS NULL THEN 0 ELSE 1 END AS bit) AS has_password
      FROM dbo.share_links s
      JOIN dbo.principals p ON p.principal_id = s.created_by
     WHERE s.document_id = ${documentId}
     ORDER BY s.created_at DESC
  `.execute(db);

  return {
    ok: true,
    links: result.rows.map((row) => ({
      shareId: String(row.share_id),
      versionNumber: row.version_number === null ? null : Number(row.version_number),
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revoked: row.revoked_at !== null,
      hasPassword: Number(row.has_password) === 1,
      downloads: Number(row.download_count),
      maxDownloads: row.max_downloads === null ? null : Number(row.max_downloads),
      // The token is not recoverable. Whoever made the link has it; anyone else
      // must make a new one.
      expired: new Date(row.expires_at) < new Date(),
    })),
  };
}

export async function revokeShareLink({ userId, shareId }) {
  const found = await sql`
    SELECT document_id, created_by FROM dbo.share_links WHERE share_id = ${shareId}
  `.execute(db);

  const link = found.rows[0];
  if (!link) return { ok: false, reason: 'not_found' };

  // The creator, or anyone who can manage permissions on the folder — a link
  // someone left behind must be revocable by whoever owns the branch.
  const bits = await documentPermission(userId, link.document_id);
  const allowed = String(link.created_by) === String(userId) || (bits !== null && has(bits, PERM.MANAGE_PERMS));
  if (!allowed) return { ok: false, reason: 'forbidden' };

  await sql`UPDATE dbo.share_links SET revoked_at = SYSUTCDATETIME() WHERE share_id = ${shareId}`.execute(db);
  return { ok: true };
}

/**
 * Resolves a share token to the version it grants.
 *
 * Unauthenticated by definition, so every bound is enforced here: expiry,
 * revocation, the download cap, the password, and that the document has not
 * since been deleted.
 */
export async function resolveShare({ token, password = null }) {
  if (typeof token !== 'string' || token.length < 16) return { ok: false, reason: 'invalid_token' };

  const result = await sql`
    SELECT s.share_id, s.document_id, s.version_number, s.password_hash,
           s.download_count, s.max_downloads,
           d.title, d.current_version, d.is_deleted
      FROM dbo.share_links s
      JOIN dbo.documents d ON d.document_id = s.document_id
     WHERE s.token_hash = ${hash(token)}
       AND s.revoked_at IS NULL
       AND s.expires_at > SYSUTCDATETIME()
  `.execute(db);

  const link = result.rows[0];
  if (!link) return { ok: false, reason: 'invalid_token' };
  if (Number(link.is_deleted) === 1) return { ok: false, reason: 'invalid_token' };

  if (link.max_downloads !== null && Number(link.download_count) >= Number(link.max_downloads)) {
    return { ok: false, reason: 'download_limit_reached' };
  }

  if (link.password_hash) {
    if (!password) return { ok: false, reason: 'password_required' };
    const { verifyPassword } = await import('../auth/passwords.js');
    if (!(await verifyPassword(link.password_hash, String(password)))) {
      return { ok: false, reason: 'invalid_password' };
    }
  }

  const versionNumber = link.version_number === null ? Number(link.current_version) : Number(link.version_number);

  const version = await sql`
    SELECT storage_path, file_size_bytes, mime_type, original_filename
      FROM dbo.document_versions
     WHERE document_id = ${link.document_id} AND version_number = ${versionNumber}
  `.execute(db);

  if (!version.rows[0]) return { ok: false, reason: 'invalid_token' };

  return {
    ok: true,
    shareId: String(link.share_id),
    documentId: String(link.document_id),
    title: link.title,
    versionNumber,
    storagePath: version.rows[0].storage_path,
    bytes: Number(version.rows[0].file_size_bytes),
    mimeType: version.rows[0].mime_type,
    originalFilename: version.rows[0].original_filename,
  };
}

/** Counts one download against a link's cap. */
export async function countShareDownload({ shareId }) {
  await sql`
    UPDATE dbo.share_links SET download_count = download_count + 1 WHERE share_id = ${shareId}
  `.execute(db);
}

/** Constant-time compare, for any secret compared outside the database. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
