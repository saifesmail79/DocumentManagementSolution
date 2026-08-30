/**
 * The notification inbox, and the email that mirrors it.
 *
 * ─── In-app first, email second ─────────────────────────────────────────────
 *
 * Every notice is written to the inbox synchronously and emailed by a worker
 * afterwards. That ordering is deliberate: the inbox is the record, email is a
 * convenience, and a broken SMTP relay must not lose the notice or fail the
 * action that produced it. A deployment with no mail configured still has a
 * fully working notification centre.
 *
 * ─── Arabic RTL email ───────────────────────────────────────────────────────
 *
 * The blueprint asks for RTL HTML templates. The HTML here is deliberately
 * minimal — a dir="rtl" body, one heading, one paragraph, one link — because
 * mail clients strip most CSS and an elaborate template degrades into
 * unreadable left-to-right soup in exactly the clients that matter.
 */

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('notifications');

export const KIND = Object.freeze({
  DOCUMENT_ADDED: 'document.added',
  DOCUMENT_UPDATED: 'document.updated',
  COMMENT_ADDED: 'comment.added',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided',
  APPROVAL_ESCALATED: 'approval.escalated',
  DOCUMENT_EXPIRING: 'document.expiring',
  DOCUMENT_SHARED: 'document.shared',
});

/**
 * Queues one notice for one user.
 *
 * Never throws: a notification that cannot be written must not fail the upload,
 * comment or approval that triggered it.
 */
export async function notify({ userId, kind, title, body = null, documentId = null, folderId = null }) {
  try {
    await sql`
      INSERT INTO dbo.notifications (user_id, kind, title, body, document_id, folder_id)
      VALUES (${userId}, ${kind}, ${String(title).slice(0, 300)},
              ${body ? String(body).slice(0, 1000) : null}, ${documentId}, ${folderId})
    `.execute(db);
  } catch (error) {
    log.error({ err: error, kind, userId: String(userId) }, 'could not write a notification');
  }
}

/** Queues the same notice for several users, skipping duplicates. */
export async function notifyMany({ userIds, ...notice }) {
  const unique = [...new Set((userIds ?? []).map(String))];
  for (const userId of unique) await notify({ userId, ...notice });
  return unique.length;
}

export async function listInbox({ userId, unreadOnly = false, limit = 50 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const result = await sql`
    SELECT TOP (${pageSize})
           n.notification_id, n.kind, n.title, n.body, n.document_id, n.folder_id,
           n.created_at, n.read_at
      FROM dbo.notifications n
     WHERE n.user_id = ${userId}
       AND (${unreadOnly ? 1 : 0} = 0 OR n.read_at IS NULL)
     ORDER BY n.created_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    notificationId: String(row.notification_id),
    kind: row.kind,
    title: row.title,
    body: row.body,
    documentId: row.document_id === null ? null : String(row.document_id),
    folderId: row.folder_id === null ? null : String(row.folder_id),
    createdAt: row.created_at,
    read: row.read_at !== null,
  }));
}

export async function unreadCount({ userId }) {
  const result = await sql`
    SELECT COUNT(*) AS n FROM dbo.notifications WHERE user_id = ${userId} AND read_at IS NULL
  `.execute(db);
  return Number(result.rows[0].n);
}

export async function markRead({ userId, notificationId = null }) {
  await sql`
    UPDATE dbo.notifications
       SET read_at = SYSUTCDATETIME()
     WHERE user_id = ${userId}
       AND read_at IS NULL
       AND (${notificationId} IS NULL OR notification_id = ${notificationId})
  `.execute(db);
  return { ok: true };
}

// ── Email delivery ───────────────────────────────────────────────────────

/**
 * Emails notices that have not been sent yet.
 *
 * Marked as emailed before the send rather than after — on purpose. A crash
 * between the two loses one email; the other ordering re-sends every notice in
 * the batch on the next tick, and a user who receives forty duplicate emails
 * turns notifications off, which loses all of them permanently.
 */
export async function sendPendingEmails({ max = 50 } = {}) {
  if (!config.mail.host) return { sent: 0, skipped: 'smtp_not_configured' };

  const pending = await sql`
    SELECT TOP (${max})
           n.notification_id, n.kind, n.title, n.body, n.document_id,
           u.email, p.display_name
      FROM dbo.notifications n
      JOIN dbo.users u ON u.user_id = n.user_id
      JOIN dbo.principals p ON p.principal_id = n.user_id
     WHERE n.emailed_at IS NULL
       AND p.is_active = 1
       AND u.email IS NOT NULL
     ORDER BY n.created_at
  `.execute(db);

  if (pending.rows.length === 0) return { sent: 0 };

  const { sendMail } = await import('../../lib/mailer.js');
  let sent = 0;

  for (const row of pending.rows) {
    await sql`
      UPDATE dbo.notifications SET emailed_at = SYSUTCDATETIME() WHERE notification_id = ${row.notification_id}
    `.execute(db);

    try {
      await sendMail({
        to: row.email,
        subject: row.title,
        text: plainText(row),
        html: htmlBody(row),
      });
      sent += 1;
    } catch (error) {
      log.warn({ err: error, notificationId: String(row.notification_id) }, 'could not email a notification');
    }
  }

  if (sent > 0) log.info({ sent }, 'notification emails sent');
  return { sent };
}

function documentLink(documentId) {
  return documentId ? `${config.auth.resetLinkBase}/documents/${documentId}` : config.auth.resetLinkBase;
}

function plainText(row) {
  return [
    `مرحباً ${row.display_name}،`,
    '',
    row.title,
    row.body ?? '',
    '',
    documentLink(row.document_id),
    '',
  ].join('\n');
}

/**
 * Minimal RTL HTML.
 *
 * dir and lang go on the <html> element, and alignment is set inline on the
 * body: mail clients routinely strip <style> blocks, and a stylesheet-dependent
 * RTL layout renders left-to-right in exactly the clients this has to work in.
 */
function htmlBody(row) {
  return [
    '<!doctype html>',
    '<html lang="ar" dir="rtl">',
    '<body style="margin:0;padding:24px;background:#f1f5f9;',
    'font-family:\'Segoe UI\',Tahoma,sans-serif;direction:rtl;text-align:right;color:#0f172a">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #cbd5e1;',
    'border-radius:12px;padding:24px">',
    `<p style="margin:0 0 12px">مرحباً ${escapeHtml(row.display_name)}،</p>`,
    `<h1 style="margin:0 0 8px;font-size:16px">${escapeHtml(row.title)}</h1>`,
    row.body ? `<p style="margin:0 0 16px;color:#475569">${escapeHtml(row.body)}</p>` : '',
    `<p style="margin:0"><a href="${escapeHtml(documentLink(row.document_id))}"`,
    ' style="display:inline-block;background:#1c64f2;color:#fff;text-decoration:none;',
    'padding:10px 18px;border-radius:8px">فتح في النظام</a></p>',
    '<p style="margin:16px 0 0;font-size:12px;color:#64748b">',
    'هذه رسالة آلية من نظام إدارة الوثائق.</p>',
    '</div></body></html>',
  ].join('');
}

/** The notification text is user-supplied (titles, names), so it is escaped. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Starts the email loop.
 *
 * Separate from the extraction worker's timer because the cadences differ: a
 * notification should go out within a minute, and extraction can wait.
 */
export function startNotificationMailer() {
  if (!config.mail.host) {
    log.info('notification email disabled (MAIL_HOST is not set); the inbox still works');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await sendPendingEmails();
    } catch (error) {
      log.error({ err: error }, 'notification mail loop error');
    } finally {
      if (!stopped) timer = setTimeout(tick, 60_000);
    }
  };

  timer = setTimeout(tick, 60_000);
  log.info('notification mailer started');

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
