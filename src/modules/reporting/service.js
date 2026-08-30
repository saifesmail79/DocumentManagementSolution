/**
 * Admin reporting, and metadata export.
 *
 * ─── Counts are unfiltered; lists are not ───────────────────────────────────
 *
 * The dashboard is super-admin only, so its totals are system-wide by design —
 * "how many documents exist" is an administrative question, not a permission
 * one. The metadata export is different: it produces rows a person walks away
 * with, so it is permission-filtered like any other listing.
 */

import { db, sql } from '../../db/index.js';
import { PERM } from '../tree/service.js';

/** Headline numbers for the admin dashboard. */
export async function overview() {
  const result = await sql`
    SELECT
      (SELECT COUNT(*) FROM dbo.documents WHERE is_deleted = 0)                      AS documents,
      (SELECT COUNT(*) FROM dbo.documents WHERE is_deleted = 1)                      AS deleted,
      (SELECT COUNT(*) FROM dbo.document_versions)                                   AS versions,
      (SELECT ISNULL(SUM(file_size_bytes), 0) FROM dbo.document_versions)            AS bytes,
      (SELECT COUNT(*) FROM dbo.folders WHERE is_deleted = 0)                        AS folders,
      (SELECT COUNT(*) FROM dbo.users u JOIN dbo.principals p ON p.principal_id = u.user_id
        WHERE p.is_active = 1)                                                       AS active_users,
      (SELECT COUNT(*) FROM dbo.user_sessions
        WHERE revoked_at IS NULL AND expires_at > SYSUTCDATETIME())                  AS live_sessions,
      (SELECT COUNT(*) FROM dbo.approval_requests WHERE status = 'pending')          AS pending_approvals,
      (SELECT COUNT(*) FROM dbo.documents WHERE is_deleted = 0 AND legal_hold = 1)   AS on_hold,
      (SELECT COUNT(*) FROM dbo.documents
        WHERE is_deleted = 0 AND expires_at IS NOT NULL
          AND expires_at <= DATEADD(day, 30, SYSUTCDATETIME()))                      AS expiring_soon
  `.execute(db);

  const row = result.rows[0];
  return {
    documents: Number(row.documents),
    deleted: Number(row.deleted),
    versions: Number(row.versions),
    bytes: Number(row.bytes),
    folders: Number(row.folders),
    activeUsers: Number(row.active_users),
    liveSessions: Number(row.live_sessions),
    pendingApprovals: Number(row.pending_approvals),
    onLegalHold: Number(row.on_hold),
    expiringSoon: Number(row.expiring_soon),
  };
}

/** Uploads per day, for a simple activity chart. */
export async function uploadTrend({ days = 30 } = {}) {
  const window = Math.min(Math.max(Number(days) || 30, 1), 365);

  const result = await sql`
    SELECT CAST(created_at AS date) AS day, COUNT(*) AS total
      FROM dbo.documents
     WHERE created_at >= DATEADD(day, ${-window}, SYSUTCDATETIME())
     GROUP BY CAST(created_at AS date)
     ORDER BY day
  `.execute(db);

  return result.rows.map((row) => ({
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
    count: Number(row.total),
  }));
}

/** Which folders hold the most, and how much space each accounts for. */
export async function storageByFolder({ limit = 20 } = {}) {
  const top = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await sql`
    SELECT TOP (${top})
           f.folder_id, f.name,
           COUNT(DISTINCT d.document_id) AS documents,
           ISNULL(SUM(v.file_size_bytes), 0) AS bytes
      FROM dbo.folders f
      LEFT JOIN dbo.documents d ON d.folder_id = f.folder_id AND d.is_deleted = 0
      LEFT JOIN dbo.document_versions v ON v.document_id = d.document_id
     WHERE f.is_deleted = 0
     GROUP BY f.folder_id, f.name
     ORDER BY bytes DESC
  `.execute(db);

  return result.rows.map((row) => ({
    folderId: String(row.folder_id),
    name: row.name,
    documents: Number(row.documents),
    bytes: Number(row.bytes),
  }));
}

/** Who has been most active, from the audit trail. */
export async function topContributors({ days = 30, limit = 10 } = {}) {
  const window = Math.min(Math.max(Number(days) || 30, 1), 365);
  const top = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const result = await sql`
    SELECT TOP (${top})
           a.actor_username AS actor,
           SUM(CASE WHEN a.action = 'document.created' THEN 1 ELSE 0 END) AS uploads,
           SUM(CASE WHEN a.action = 'document.downloaded' THEN 1 ELSE 0 END) AS downloads,
           COUNT(*) AS actions
      FROM dbo.audit_log a
     WHERE a.actor_username IS NOT NULL
       AND a.occurred_at >= DATEADD(day, ${-window}, SYSUTCDATETIME())
     GROUP BY a.actor_username
     ORDER BY actions DESC
  `.execute(db);

  return result.rows.map((row) => ({
    actor: row.actor,
    uploads: Number(row.uploads),
    downloads: Number(row.downloads),
    actions: Number(row.actions),
  }));
}

/** Documents by type, and by lifecycle state. */
export async function distribution() {
  const byType = await sql`
    SELECT ISNULL(t.name, N'بدون نوع') AS name, COUNT(*) AS total
      FROM dbo.documents d
      LEFT JOIN dbo.document_types t ON t.type_id = d.type_id
     WHERE d.is_deleted = 0
     GROUP BY t.name
     ORDER BY total DESC
  `.execute(db);

  const byState = await sql`
    SELECT lifecycle_state AS name, COUNT(*) AS total
      FROM dbo.documents WHERE is_deleted = 0
     GROUP BY lifecycle_state
  `.execute(db);

  return {
    byType: byType.rows.map((row) => ({ name: row.name, count: Number(row.total) })),
    byState: byState.rows.map((row) => ({ name: row.name, count: Number(row.total) })),
  };
}

/**
 * Exports document metadata as CSV.
 *
 * Permission-filtered, unlike the dashboard: this produces a file someone walks
 * away with, so it must contain only what that person could already see.
 *
 * Emitted with a UTF-8 BOM. Excel on Windows assumes the system codepage for a
 * .csv without one and renders Arabic as mojibake — the single most common
 * complaint about CSV export in an Arabic deployment.
 */
export async function exportMetadataCsv({ userId, folderId = null }) {
  let mpathPrefix = null;
  if (folderId != null) {
    const scope = await sql`
      SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
    `.execute(db);
    if (!scope.rows[0]) return { ok: false, reason: 'not_found' };
    mpathPrefix = `${scope.rows[0].mpath}%`;
  }

  const documents = await sql`
    SELECT d.document_id, d.title, d.current_version, d.created_at, d.updated_at,
           d.lifecycle_state, d.expires_at,
           f.name AS folder_name, f.mpath,
           t.name AS type_name, s.name AS sensitivity,
           creator.display_name AS created_by,
           v.file_size_bytes, v.sha256, v.mime_type
      FROM dbo.documents d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_types     t ON t.type_id  = d.type_id
      LEFT JOIN dbo.sensitivity_labels s ON s.label_id = d.sensitivity_label_id
      LEFT JOIN dbo.principals   creator ON creator.principal_id = d.created_by
      LEFT JOIN dbo.document_versions v
        ON v.document_id = d.document_id AND v.version_number = d.current_version
     WHERE d.is_deleted = 0
       AND (p.perm_bits & ${PERM.BROWSE}) <> 0
       AND (${mpathPrefix} IS NULL OR f.mpath LIKE ${mpathPrefix})
     ORDER BY d.created_at DESC
  `.execute(db);

  const values = await sql`
    SELECT v.document_id, f.name AS field_name,
           COALESCE(c.label, v.value_text, CONVERT(nvarchar(50), v.value_number),
                    CONVERT(nvarchar(30), v.value_date, 126),
                    CASE WHEN v.value_bool = 1 THEN N'نعم' WHEN v.value_bool = 0 THEN N'لا' END,
                    pr.display_name) AS value
      FROM dbo.document_field_values v
      JOIN dbo.custom_field_defs f ON f.field_id = v.field_id
      LEFT JOIN dbo.custom_field_choices c ON c.choice_id = v.value_choice_id
      LEFT JOIN dbo.principals pr ON pr.principal_id = v.value_principal_id
  `.execute(db);

  const fieldNames = [...new Set(values.rows.map((row) => row.field_name))].sort();
  const byDocument = new Map();
  for (const row of values.rows) {
    const bag = byDocument.get(String(row.document_id)) ?? {};
    bag[row.field_name] = row.value;
    byDocument.set(String(row.document_id), bag);
  }

  const header = [
    'المعرف', 'العنوان', 'المجلد', 'النوع', 'السرية', 'الحالة',
    'الإصدار', 'الحجم', 'النوع التقني', 'البصمة', 'أنشأها',
    'تاريخ الإنشاء', 'آخر تعديل', 'تاريخ الانتهاء',
    ...fieldNames,
  ];

  const lines = [header.map(csvCell).join(',')];

  for (const row of documents.rows) {
    const extra = byDocument.get(String(row.document_id)) ?? {};
    lines.push(
      [
        row.document_id,
        row.title,
        row.folder_name,
        row.type_name ?? '',
        row.sensitivity ?? '',
        row.lifecycle_state,
        row.current_version,
        row.file_size_bytes ?? '',
        row.mime_type ?? '',
        row.sha256 ?? '',
        row.created_by ?? '',
        iso(row.created_at),
        iso(row.updated_at),
        iso(row.expires_at),
        ...fieldNames.map((name) => extra[name] ?? ''),
      ]
        .map(csvCell)
        .join(','),
    );
  }

  // ﻿ is the BOM; \r\n because Excel expects CRLF.
  return { ok: true, csv: `﻿${lines.join('\r\n')}\r\n`, rows: documents.rows.length };
}

function iso(value) {
  return value ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') : '';
}

/**
 * Quotes a CSV cell.
 *
 * A leading =, +, - or @ is prefixed with a quote: Excel treats such a cell as a
 * formula, and a document titled "=cmd|..." becomes a code-execution vector on
 * whoever opens the export. This is CSV injection and it is the reason exports
 * from document systems get flagged in security reviews.
 */
function csvCell(value) {
  const text = String(value ?? '');
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
