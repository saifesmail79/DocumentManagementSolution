/**
 * The audit trail.
 *
 * ─── Recording must never break the thing being recorded ────────────────────
 *
 * record() swallows its own errors. That is a deliberate, and slightly
 * uncomfortable, decision: if the audit insert fails, the alternative is that a
 * user's upload or permission change fails too. For a document system the right
 * trade is to complete the operation and log loudly that the trail has a hole,
 * rather than to take the system down protecting its own history.
 *
 * Where that trade would be wrong — a regulated deployment that must not act
 * without an audit entry — the call becomes part of the caller's transaction
 * instead. The seam is here, in one function.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('audit');

/**
 * The actions worth recording. A closed list rather than free strings, so the
 * trail can be filtered and a typo cannot invent a category nobody queries.
 */
export const ACTION = Object.freeze({
  LOGIN_SUCCEEDED: 'login.succeeded',
  LOGIN_FAILED: 'login.failed',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'password.changed',
  PASSWORD_RESET_REQUESTED: 'password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'password.reset_completed',
  PASSWORD_RESET_BY_ADMIN: 'password.reset_by_admin',

  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_ACTIVATED: 'user.activated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_SUPER_ADMIN_CHANGED: 'user.super_admin_changed',
  USER_UNLOCKED: 'user.unlocked',

  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_ACTIVATED: 'group.activated',
  GROUP_DEACTIVATED: 'group.deactivated',
  GROUP_MEMBER_ADDED: 'group.member_added',
  GROUP_MEMBER_REMOVED: 'group.member_removed',

  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',

  ACE_SET: 'acl.entry_set',
  ACE_REMOVED: 'acl.entry_removed',
  INHERITANCE_CHANGED: 'acl.inheritance_changed',

  // Administration of the system's own vocabulary and integrations. These were
  // silent: the constants for identity changes above existed for a long time
  // without a single call recording them, and the definitions, keys, webhooks
  // and templates had no constants at all. An audit trail that answers "who
  // downloaded this" but not "who made that person an administrator" or "who
  // pointed a webhook at that address" is answering the easier question.
  METADATA_DEFINITION_CHANGED: 'metadata.definition_changed',
  API_KEY_ISSUED: 'api_key.issued',
  API_KEY_REVOKED: 'api_key.revoked',
  WEBHOOK_CHANGED: 'webhook.changed',
  APPROVAL_TEMPLATE_CHANGED: 'approval.template_changed',

  FOLDER_CREATED: 'folder.created',
  FOLDER_DELETED: 'folder.deleted',

  DOCUMENT_CREATED: 'document.created',
  DOCUMENT_VERSION_ADDED: 'document.version_added',
  DOCUMENT_DOWNLOADED: 'document.downloaded',
  DOCUMENT_DELETED: 'document.deleted',
  DOCUMENT_RESTORED: 'document.restored',
  DOCUMENT_PURGE_REQUESTED: 'document.purge_requested',
  DOCUMENT_METADATA_CHANGED: 'document.metadata_changed',

  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided',
  VERSION_RESTORED: 'document.version_restored',
  LEGAL_HOLD_CHANGED: 'document.legal_hold_changed',
  SHARE_LINK_CREATED: 'share.link_created',

  BLOB_PURGED: 'storage.blob_purged',
  SETTING_CHANGED: 'settings.changed',

  // The correspondence register. Registration and annulment are the acts a
  // paper وارد/صادر book exists to witness, so they must be in the trail;
  // routing answers "who sent this to that department".
  MAIL_REGISTERED: 'mail.registered',
  MAIL_ROUTED: 'mail.routed',
  MAIL_ANNULLED: 'mail.annulled',
  MAIL_UNIT_CHANGED: 'mail.unit_changed',
  MAIL_COUNTER_SET: 'mail.counter_set',
  // Letter formats (النماذج): configuring templates, and producing a letter.
  FORM_TEMPLATE_CREATED: 'form_template.created',
  FORM_TEMPLATE_UPDATED: 'form_template.updated',
  FORM_TEMPLATE_FILE_REPLACED: 'form_template.file_replaced',
  FORM_TEMPLATE_ACCESS_CHANGED: 'form_template.access_changed',
  FORM_TEMPLATE_FIELDS_CHANGED: 'form_template.fields_changed',
  FORM_LETTER_CREATED: 'form_letter.created',
  // Ink signing (التوقيع): a new version carrying drawn strokes.
  DOCUMENT_SIGNED: 'document.signed',
});

/**
 * The trail carved into the three questions it actually gets asked.
 *
 * "Who signed in, who was given power, who could suddenly see what" is a
 * security review; "what happened to this document" is a filing question; "who
 * changed how the system behaves" is change management. One flat list answers
 * all three badly, so the viewer offers each as a category and the membership
 * lives HERE, next to the constants — a new action added above without a home
 * below fails the categorisation test rather than silently vanishing from
 * every category view.
 */
export const CATEGORY = Object.freeze({
  security: [
    ACTION.LOGIN_SUCCEEDED,
    ACTION.LOGIN_FAILED,
    ACTION.LOGOUT,
    ACTION.PASSWORD_CHANGED,
    ACTION.PASSWORD_RESET_REQUESTED,
    ACTION.PASSWORD_RESET_COMPLETED,
    ACTION.PASSWORD_RESET_BY_ADMIN,
    ACTION.USER_CREATED,
    ACTION.USER_UPDATED,
    ACTION.USER_ACTIVATED,
    ACTION.USER_DEACTIVATED,
    ACTION.USER_SUPER_ADMIN_CHANGED,
    ACTION.USER_UNLOCKED,
    ACTION.GROUP_CREATED,
    ACTION.GROUP_UPDATED,
    ACTION.GROUP_ACTIVATED,
    ACTION.GROUP_DEACTIVATED,
    ACTION.GROUP_MEMBER_ADDED,
    ACTION.GROUP_MEMBER_REMOVED,
    ACTION.ROLE_CREATED,
    ACTION.ROLE_UPDATED,
    ACTION.ROLE_DELETED,
    ACTION.ACE_SET,
    ACTION.ACE_REMOVED,
    ACTION.INHERITANCE_CHANGED,
    ACTION.API_KEY_ISSUED,
    ACTION.API_KEY_REVOKED,
    // A share link hands document access to whoever holds the URL, which makes
    // creating one a security event, not a filing one.
    ACTION.SHARE_LINK_CREATED,
  ],
  documents: [
    ACTION.FOLDER_CREATED,
    ACTION.FOLDER_DELETED,
    ACTION.DOCUMENT_CREATED,
    ACTION.DOCUMENT_VERSION_ADDED,
    ACTION.DOCUMENT_DOWNLOADED,
    ACTION.DOCUMENT_DELETED,
    ACTION.DOCUMENT_RESTORED,
    ACTION.DOCUMENT_PURGE_REQUESTED,
    ACTION.DOCUMENT_METADATA_CHANGED,
    ACTION.APPROVAL_REQUESTED,
    ACTION.APPROVAL_DECIDED,
    ACTION.VERSION_RESTORED,
    ACTION.LEGAL_HOLD_CHANGED,
    // The completion of DOCUMENT_PURGE_REQUESTED: the moment the content is
    // actually destroyed. It belongs with the document's lifecycle — a
    // documents view that shows the request but hides the destruction would
    // give an incomplete account of exactly the event that matters most.
    ACTION.BLOB_PURGED,
    // Register events belong with the document's story: what happened to
    // letter 483/2026 is a filing question, not a configuration one.
    ACTION.MAIL_REGISTERED,
    ACTION.MAIL_ROUTED,
    ACTION.MAIL_ANNULLED,
    ACTION.FORM_LETTER_CREATED,
    ACTION.DOCUMENT_SIGNED,
  ],
  configuration: [
    ACTION.SETTING_CHANGED,
    ACTION.METADATA_DEFINITION_CHANGED,
    ACTION.WEBHOOK_CHANGED,
    ACTION.APPROVAL_TEMPLATE_CHANGED,
    ACTION.MAIL_UNIT_CHANGED,
    ACTION.MAIL_COUNTER_SET,
    ACTION.FORM_TEMPLATE_CREATED,
    ACTION.FORM_TEMPLATE_UPDATED,
    ACTION.FORM_TEMPLATE_FILE_REPLACED,
    ACTION.FORM_TEMPLATE_ACCESS_CHANGED,
    ACTION.FORM_TEMPLATE_FIELDS_CHANGED,
  ],
});

/**
 * Writes one entry.
 *
 * @param {object} entry
 * @param {object} [entry.actor]  request.user, or omitted for system actions
 * @param {string} entry.action   one of ACTION
 * @param {string} [entry.targetType]
 * @param {string|number} [entry.targetId]
 * @param {string|number} [entry.folderId]
 * @param {string} [entry.detail]
 * @param {object} [entry.request] the Fastify request, for ip and user agent
 */
export async function record({ actor, action, targetType, targetId, folderId, detail, request }) {
  try {
    await sql`
      INSERT INTO dbo.audit_log
        (actor_user_id, actor_username, action, target_type, target_id, folder_id,
         detail, ip_address, user_agent)
      VALUES (
        ${actor?.userId ?? null},
        ${actor?.username ?? null},
        ${action},
        ${targetType ?? null},
        ${targetId === undefined || targetId === null ? null : String(targetId)},
        ${folderId ?? null},
        ${detail ? String(detail).slice(0, 2000) : null},
        ${request?.ip ?? null},
        ${request?.headers?.['user-agent']?.slice(0, 400) ?? null}
      )
    `.execute(db);
  } catch (error) {
    // See the header: the operation being audited has already happened, and
    // failing it now would be worse than a gap in the trail. Logged at error so
    // it is not invisible.
    log.error({ err: error, action }, 'could not write an audit entry');
  }
}

/**
 * Reads the trail, newest first.
 *
 * Keyset pagination on (occurred_at, audit_id): an audit log is append-heavy and
 * queried at its head, and OFFSET would make each page cost more than the last.
 * The cursor timestamp travels as ISO text and converts server-side — a bound JS
 * Date binds as `datetime` (3.33ms) and will not match a datetime2(3) value.
 */
export async function listAudit({
  actorUserId = null,
  action = null,
  actions = null,
  targetType = null,
  targetId = null,
  folderId = null,
  from = null,
  to = null,
  limit = 50,
  cursor,
} = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const cursorIso = cursor?.occurredAt ? new Date(cursor.occurredAt).toISOString() : null;
  const cursorId = cursor?.auditId ?? null;

  // A category's member list, from CATEGORY above. Null means no restriction;
  // an empty list would render as `IN ()`, which SQL Server refuses, so it is
  // treated the same as null — the route validates the category name anyway.
  const inList = Array.isArray(actions) && actions.length > 0 ? actions : null;

  const result = await sql`
    SELECT TOP (${pageSize + 1})
           a.audit_id, a.occurred_at, a.actor_user_id, a.actor_username, a.action,
           a.target_type, a.target_id, a.folder_id, a.detail, a.ip_address,
           f.name AS folder_name
      FROM dbo.audit_log a
      LEFT JOIN dbo.folders f ON f.folder_id = a.folder_id
     WHERE (${actorUserId} IS NULL OR a.actor_user_id = ${actorUserId})
       AND (${action} IS NULL OR a.action = ${action})
       AND (${inList === null ? sql`1 = 1` : sql`a.action IN (${sql.join(inList.map((value) => sql`${value}`))})`})
       AND (${targetType} IS NULL OR a.target_type = ${targetType})
       AND (${targetId} IS NULL OR a.target_id = ${targetId})
       AND (${folderId} IS NULL OR a.folder_id = ${folderId})
       AND (${from} IS NULL OR a.occurred_at >= CONVERT(datetime2(3), ${from}, 126))
       AND (${to} IS NULL OR a.occurred_at <= CONVERT(datetime2(3), ${to}, 126))
       AND (${cursorIso} IS NULL
            OR a.occurred_at < CONVERT(datetime2(3), ${cursorIso}, 126)
            OR (a.occurred_at = CONVERT(datetime2(3), ${cursorIso}, 126)
                AND a.audit_id < CONVERT(bigint, ${cursorId})))
     ORDER BY a.occurred_at DESC, a.audit_id DESC
  `.execute(db);

  const hasMore = result.rows.length > pageSize;
  const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
  const last = rows[rows.length - 1];

  return {
    entries: rows.map((row) => ({
      auditId: String(row.audit_id),
      occurredAt: row.occurred_at,
      // The stored copy, not a join: the account may since have been renamed or
      // deactivated, and the trail must still read correctly.
      actor: row.actor_username ?? 'النظام',
      actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      folderId: row.folder_id === null ? null : String(row.folder_id),
      folderName: row.folder_name,
      detail: row.detail,
      ipAddress: row.ip_address,
    })),
    nextCursor: hasMore && last ? { occurredAt: last.occurred_at, auditId: String(last.audit_id) } : null,
  };
}

/** Distinct actions present, so a filter can offer only what exists. */
export async function auditActions() {
  const result = await sql`SELECT DISTINCT action FROM dbo.audit_log ORDER BY action`.execute(db);
  return result.rows.map((row) => row.action);
}
