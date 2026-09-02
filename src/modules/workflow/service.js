/**
 * Approval workflow.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────
 *
 * A template belongs to a document type and is an ordered list of steps. Each
 * step names a principal — usually a group, so any member can act — and the
 * request walks the steps in order. No branching, no visual designer: the
 * blueprint scopes v1 to a linear chain, and a designer is a project of its own.
 *
 * Two Tier 3 variants ride on the same structure rather than a second engine:
 *
 *   • require_all turns a step into "every member of this group must approve",
 *     which is the parallel all-must-approve case.
 *   • sla_hours makes a step escalate if nobody acts in time.
 *
 * ─── Rejection ends it ──────────────────────────────────────────────────────
 *
 * One rejection terminates the whole request rather than sending it back a
 * step. A chain that bounces between steps has no defined end state, and
 * "rejected, start again with a fixed document" is what people actually mean.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, has } from '../tree/service.js';
import { notify, notifyMany, KIND } from '../notifications/service.js';
import { documentPermission } from '../collaboration/service.js';

const log = moduleLogger('workflow');

// ── Templates ────────────────────────────────────────────────────────────

export async function listTemplates() {
  const templates = await sql`
    SELECT t.template_id, t.name, t.type_id, t.is_active, dt.name AS type_name,
           (SELECT COUNT(*) FROM dbo.approval_requests ar
             WHERE ar.template_id = t.template_id AND ar.status = 'pending') AS pending_count
      FROM dbo.approval_templates t
      LEFT JOIN dbo.document_types dt ON dt.type_id = t.type_id
     ORDER BY t.name
  `.execute(db);

  const steps = await sql`
    SELECT s.template_id, s.step_id, s.step_order, s.approver_id, s.require_all, s.sla_hours,
           p.display_name AS approver, p.principal_type
      FROM dbo.approval_steps s
      JOIN dbo.principals p ON p.principal_id = s.approver_id
     ORDER BY s.template_id, s.step_order
  `.execute(db);

  const byTemplate = new Map();
  for (const row of steps.rows) {
    const list = byTemplate.get(Number(row.template_id)) ?? [];
    list.push({
      stepId: Number(row.step_id),
      order: Number(row.step_order),
      approverId: String(row.approver_id),
      approver: row.approver,
      approverType: row.principal_type,
      requireAll: Number(row.require_all) === 1,
      slaHours: row.sla_hours === null ? null : Number(row.sla_hours),
    });
    byTemplate.set(Number(row.template_id), list);
  }

  return templates.rows.map((row) => ({
    templateId: Number(row.template_id),
    name: row.name,
    typeId: row.type_id === null ? null : Number(row.type_id),
    typeName: row.type_name,
    isActive: Number(row.is_active) === 1,
    pendingRequests: Number(row.pending_count),
    steps: byTemplate.get(Number(row.template_id)) ?? [],
  }));
}

export async function createTemplate({ name, typeId = null, steps = [] }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 200) return { ok: false, reason: 'invalid_name' };
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'steps_required' };

  try {
    const templateId = await db.transaction().execute(async (trx) => {
      const inserted = await sql`
        INSERT INTO dbo.approval_templates (name, type_id)
        OUTPUT INSERTED.template_id AS tid
        VALUES (${clean}, ${typeId})
      `.execute(trx);

      const id = inserted.rows[0].tid;

      // Order is assigned here rather than taken from the caller: a template
      // with duplicate or gapped step numbers has no well-defined "next step".
      let order = 1;
      for (const step of steps) {
        await sql`
          INSERT INTO dbo.approval_steps (template_id, step_order, approver_id, require_all, sla_hours)
          VALUES (${id}, ${order}, ${step.approverId}, ${step.requireAll ? 1 : 0},
                  ${step.slaHours ? Number(step.slaHours) : null})
        `.execute(trx);
        order += 1;
      }

      return id;
    });

    return { ok: true, templateId: Number(templateId) };
  } catch (error) {
    if (/UQ_approval_templates_name|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    if (/FK_approval_steps_approver/i.test(error.message)) {
      return { ok: false, reason: 'unknown_approver' };
    }
    throw error;
  }
}

export async function deleteTemplate({ templateId }) {
  const live = await sql`
    SELECT COUNT(*) AS n FROM dbo.approval_requests
     WHERE template_id = ${templateId} AND status = 'pending'
  `.execute(db);

  // Deleting a template mid-flight would leave running requests with no steps
  // to advance through.
  if (Number(live.rows[0].n) > 0) return { ok: false, reason: 'template_in_use' };

  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM dbo.approval_steps WHERE template_id = ${templateId}`.execute(trx);
    await sql`
      UPDATE dbo.approval_requests SET template_id = NULL WHERE template_id = ${templateId}
    `.execute(trx);
    await sql`DELETE FROM dbo.approval_templates WHERE template_id = ${templateId}`.execute(trx);
  });

  return { ok: true };
}

/**
 * Updates the name, linked type, and/or steps of an existing template.
 *
 * Steps are refused while any request is pending because a running request
 * walks steps by order — replacing the list under it leaves the current_step
 * pointing at whatever happened to land at that position, not the step the
 * approver was invited to act on. Renaming the template (name only) is safe
 * at any time because nothing in the decision chain references the name.
 */
export async function updateTemplate({ templateId, name, typeId, steps }) {
  const existing = await sql`
    SELECT template_id FROM dbo.approval_templates WHERE template_id = ${templateId}
  `.execute(db);
  if (!existing.rows[0]) return { ok: false, reason: 'not_found' };

  let cleanName;
  if (name !== undefined) {
    cleanName = String(name).trim();
    if (!cleanName || cleanName.length > 200) return { ok: false, reason: 'invalid_name' };
  }

  if (steps !== undefined) {
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'steps_required' };
  }

  try {
    // Follows the same outcome-marker pattern as decide(): return a sentinel
    // string from inside the transaction so the caller can turn it into a
    // typed result without the try/catch needing to know about it.
    const outcome = await db.transaction().execute(async (trx) => {
      if (steps !== undefined) {
        // UPDLOCK+HOLDLOCK takes a serializable range lock: a concurrent
        // approval_request INSERT for this template waits until the step
        // replacement commits, so current_step can never point into a list
        // that no longer exists. Template edits are rare and short, so the
        // cost is acceptable.
        const live = await sql`
          SELECT COUNT(*) AS n FROM dbo.approval_requests WITH (UPDLOCK, HOLDLOCK)
           WHERE template_id = ${templateId} AND status = 'pending'
        `.execute(trx);
        if (Number(live.rows[0].n) > 0) return 'template_in_use';
      }

      if (cleanName !== undefined) {
        await sql`
          UPDATE dbo.approval_templates SET name = ${cleanName} WHERE template_id = ${templateId}
        `.execute(trx);
      }
      // typeId: undefined → unchanged; null → clear the link; number → set it.
      if (typeId !== undefined) {
        await sql`
          UPDATE dbo.approval_templates SET type_id = ${typeId} WHERE template_id = ${templateId}
        `.execute(trx);
      }
      if (steps !== undefined) {
        // approval_decisions reference step_order, not step_id, so completed
        // requests keep their history even after the steps are replaced.
        await sql`DELETE FROM dbo.approval_steps WHERE template_id = ${templateId}`.execute(trx);
        let order = 1;
        for (const step of steps) {
          await sql`
            INSERT INTO dbo.approval_steps (template_id, step_order, approver_id, require_all, sla_hours)
            VALUES (${templateId}, ${order}, ${step.approverId}, ${step.requireAll ? 1 : 0},
                    ${step.slaHours ? Number(step.slaHours) : null})
          `.execute(trx);
          order += 1;
        }
      }

      return 'ok';
    });

    if (outcome === 'template_in_use') return { ok: false, reason: 'template_in_use' };
    return { ok: true };
  } catch (error) {
    if (/UQ_approval_templates_name|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    if (/FK_approval_steps_approver/i.test(error.message)) {
      return { ok: false, reason: 'unknown_approver' };
    }
    throw error;
  }
}

/**
 * Activates or deactivates a template without deleting it.
 *
 * templateForType() already ignores inactive templates, so deactivating is the
 * right answer for a template that cannot be deleted while requests are open:
 * new approvals stop being routed to it, existing ones finish normally.
 */
export async function setTemplateActive({ templateId, active }) {
  const existing = await sql`
    SELECT template_id FROM dbo.approval_templates WHERE template_id = ${templateId}
  `.execute(db);
  if (!existing.rows[0]) return { ok: false, reason: 'not_found' };

  await sql`
    UPDATE dbo.approval_templates SET is_active = ${active ? 1 : 0}
     WHERE template_id = ${templateId}
  `.execute(db);

  return { ok: true };
}

// ── Requests ─────────────────────────────────────────────────────────────

/** Starts an approval on a document. */
export async function requestApproval({ userId, documentId, templateId = null, note = null }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const document = await sql`
    SELECT d.document_id, d.title, d.type_id, d.folder_id FROM dbo.documents d
     WHERE d.document_id = ${documentId} AND d.is_deleted = 0
  `.execute(db);
  if (!document.rows[0]) return { ok: false, reason: 'not_found' };

  // A template can be named explicitly, or inferred from the document's type —
  // which is the point of attaching templates to types.
  const resolved = templateId
    ? Number(templateId)
    : await templateForType(document.rows[0].type_id);

  if (!resolved) return { ok: false, reason: 'no_template' };

  const steps = await stepsOf(resolved);
  if (steps.length === 0) return { ok: false, reason: 'no_template' };

  try {
    const requestId = await db.transaction().execute(async (trx) => {
      const inserted = await sql`
        INSERT INTO dbo.approval_requests (document_id, template_id, requested_by, note)
        OUTPUT INSERTED.request_id AS rid
        VALUES (${documentId}, ${resolved}, ${userId}, ${note})
      `.execute(trx);
      return inserted.rows[0].rid;
    });

    await notifyStep({
      requestId,
      step: steps[0],
      document: document.rows[0],
      kind: KIND.APPROVAL_REQUESTED,
      title: `طلب موافقة: ${document.rows[0].title}`,
    });

    log.info({ requestId: String(requestId), documentId: String(documentId) }, 'approval requested');
    return { ok: true, requestId: String(requestId) };
  } catch (error) {
    // The filtered unique index allows only one live request per document.
    if (/UX_approval_requests_live|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'already_pending' };
    }
    throw error;
  }
}

/**
 * Records one approver's decision and advances or ends the request.
 *
 * The whole transition happens in one transaction: two approvers acting at the
 * same moment must not both advance the request, which would skip a step.
 */
export async function decide({ userId, requestId, decision, note = null }) {
  if (!['approved', 'rejected'].includes(decision)) return { ok: false, reason: 'invalid_decision' };

  const found = await sql`
    SELECT r.request_id, r.document_id, r.template_id, r.current_step, r.status,
           d.title, d.folder_id, r.requested_by
      FROM dbo.approval_requests r
      JOIN dbo.documents d ON d.document_id = r.document_id
     WHERE r.request_id = ${requestId}
  `.execute(db);

  const request = found.rows[0];
  if (!request) return { ok: false, reason: 'not_found' };
  if (request.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const steps = await stepsOf(request.template_id);
  const step = steps.find((s) => s.order === Number(request.current_step));
  if (!step) return { ok: false, reason: 'not_pending' };

  // Membership is resolved through fn_expand_principals, so a step assigned to a
  // group is actionable by any member — including through a nested group.
  const eligible = await sql`
    SELECT COUNT(*) AS n FROM dbo.fn_expand_principals(${userId})
     WHERE principal_id = ${step.approverId}
  `.execute(db);

  if (Number(eligible.rows[0].n) === 0) return { ok: false, reason: 'not_your_step' };

  const outcome = await db.transaction().execute(async (trx) => {
    try {
      await sql`
        INSERT INTO dbo.approval_decisions (request_id, step_order, actor_id, decision, note)
        VALUES (${requestId}, ${step.order}, ${userId}, ${decision}, ${note})
      `.execute(trx);
    } catch (error) {
      if (/UQ_approval_decisions|duplicate key/i.test(error.message)) return 'already_decided';
      throw error;
    }

    if (decision === 'rejected') {
      await sql`
        UPDATE dbo.approval_requests
           SET status = 'rejected', completed_at = SYSUTCDATETIME()
         WHERE request_id = ${requestId} AND status = 'pending'
      `.execute(trx);
      return 'rejected';
    }

    // require_all: the step is only satisfied once every member of the group has
    // approved it, which is the parallel all-must-approve case.
    if (step.requireAll) {
      const outstanding = await sql`
        SELECT COUNT(*) AS n
          FROM dbo.fn_expand_group_members(${step.approverId}) m
         WHERE NOT EXISTS (
                 SELECT 1 FROM dbo.approval_decisions ad
                  WHERE ad.request_id = ${requestId}
                    AND ad.step_order = ${step.order}
                    AND ad.actor_id = m.principal_id)
      `.execute(trx);

      if (Number(outstanding.rows[0].n) > 0) return 'awaiting_others';
    }

    const next = steps.find((s) => s.order > step.order);

    if (!next) {
      await sql`
        UPDATE dbo.approval_requests
           SET status = 'approved', completed_at = SYSUTCDATETIME()
         WHERE request_id = ${requestId} AND status = 'pending'
      `.execute(trx);
      return 'approved';
    }

    await sql`
      UPDATE dbo.approval_requests SET current_step = ${next.order} WHERE request_id = ${requestId}
    `.execute(trx);
    return 'advanced';
  });

  if (outcome === 'already_decided') return { ok: false, reason: 'already_decided' };

  await announce({ outcome, request, steps, step, actorId: userId });

  log.info({ requestId: String(requestId), decision, outcome }, 'approval decision recorded');
  return { ok: true, outcome };
}

export async function cancelRequest({ userId, requestId, isSuperAdmin = false }) {
  const found = await sql`
    SELECT requested_by, status FROM dbo.approval_requests WHERE request_id = ${requestId}
  `.execute(db);

  const request = found.rows[0];
  if (!request) return { ok: false, reason: 'not_found' };
  if (request.status !== 'pending') return { ok: false, reason: 'not_pending' };
  if (String(request.requested_by) !== String(userId) && !isSuperAdmin) {
    return { ok: false, reason: 'forbidden' };
  }

  await sql`
    UPDATE dbo.approval_requests
       SET status = 'cancelled', completed_at = SYSUTCDATETIME()
     WHERE request_id = ${requestId}
  `.execute(db);

  return { ok: true };
}

/** Requests waiting on this user, for a task list. */
export async function myPendingApprovals({ userId }) {
  const result = await sql`
    SELECT r.request_id, r.document_id, r.current_step, r.requested_at, r.note,
           d.title, d.folder_id, f.name AS folder_name,
           requester.display_name AS requested_by,
           s.sla_hours,
           DATEDIFF(hour, r.requested_at, SYSUTCDATETIME()) AS hours_waiting
      FROM dbo.approval_requests r
      JOIN dbo.documents d ON d.document_id = r.document_id
      JOIN dbo.folders   f ON f.folder_id  = d.folder_id
      JOIN dbo.principals requester ON requester.principal_id = r.requested_by
      JOIN dbo.approval_steps s
        ON s.template_id = r.template_id AND s.step_order = r.current_step
     WHERE r.status = 'pending'
       AND s.approver_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
       -- Someone who has already acted on this step should not see it again.
       AND NOT EXISTS (
             SELECT 1 FROM dbo.approval_decisions ad
              WHERE ad.request_id = r.request_id
                AND ad.step_order = r.current_step
                AND ad.actor_id = ${userId})
     ORDER BY r.requested_at
  `.execute(db);

  return result.rows.map((row) => ({
    requestId: String(row.request_id),
    documentId: String(row.document_id),
    title: row.title,
    folderId: String(row.folder_id),
    folderName: row.folder_name,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    note: row.note,
    step: Number(row.current_step),
    hoursWaiting: Number(row.hours_waiting),
    overdue: row.sla_hours !== null && Number(row.hours_waiting) > Number(row.sla_hours),
  }));
}

/** The approval history of one document. */
export async function documentApprovals({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.BROWSE)) return { ok: false, reason: 'not_found' };

  const requests = await sql`
    SELECT r.request_id, r.template_id, r.status, r.current_step, r.requested_at,
           r.completed_at, r.note,
           p.display_name AS requested_by, t.name AS template_name
      FROM dbo.approval_requests r
      JOIN dbo.principals p ON p.principal_id = r.requested_by
      LEFT JOIN dbo.approval_templates t ON t.template_id = r.template_id
     WHERE r.document_id = ${documentId}
     ORDER BY r.requested_at DESC
  `.execute(db);

  const decisions = await sql`
    SELECT d.request_id, d.step_order, d.decision, d.note, d.decided_at, p.display_name AS actor
      FROM dbo.approval_decisions d
      JOIN dbo.principals p ON p.principal_id = d.actor_id
      JOIN dbo.approval_requests r ON r.request_id = d.request_id
     WHERE r.document_id = ${documentId}
     ORDER BY d.decided_at
  `.execute(db);

  const byRequest = new Map();
  for (const row of decisions.rows) {
    const list = byRequest.get(String(row.request_id)) ?? [];
    list.push({
      step: Number(row.step_order),
      decision: row.decision,
      note: row.note,
      actor: row.actor,
      decidedAt: row.decided_at,
    });
    byRequest.set(String(row.request_id), list);
  }

  return {
    ok: true,
    requests: requests.rows.map((row) => ({
      requestId: String(row.request_id),
      status: row.status,
      currentStep: Number(row.current_step),
      // The id as well as the name, so a viewer can line the decisions up
      // against the template's steps and show what is still to come.
      templateId: row.template_id === null ? null : Number(row.template_id),
      templateName: row.template_name,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      note: row.note,
      decisions: byRequest.get(String(row.request_id)) ?? [],
    })),
  };
}

/**
 * Escalates steps that have blown their SLA.
 *
 * Escalation here means notifying the requester and every super admin, not
 * reassigning the step: silently moving an approval to someone else produces a
 * decision made by a person nobody expected to be involved.
 */
export async function escalateOverdue() {
  const overdue = await sql`
    SELECT r.request_id, r.document_id, r.requested_by, r.requested_at, d.title,
           s.sla_hours, s.step_order
      FROM dbo.approval_requests r
      JOIN dbo.documents d ON d.document_id = r.document_id
      JOIN dbo.approval_steps s
        ON s.template_id = r.template_id AND s.step_order = r.current_step
     WHERE r.status = 'pending'
       AND s.sla_hours IS NOT NULL
       AND DATEADD(hour, s.sla_hours, r.requested_at) < SYSUTCDATETIME()
  `.execute(db);

  if (overdue.rows.length === 0) return { escalated: 0 };

  const admins = await sql`
    SELECT u.user_id FROM dbo.users u
      JOIN dbo.principals p ON p.principal_id = u.user_id
     WHERE u.is_super_admin = 1 AND p.is_active = 1
  `.execute(db);

  let escalated = 0;
  for (const row of overdue.rows) {
    await notifyMany({
      userIds: [String(row.requested_by), ...admins.rows.map((a) => String(a.user_id))],
      kind: KIND.APPROVAL_ESCALATED,
      title: `تأخّرت موافقة: ${row.title}`,
      body: `تجاوزت الخطوة ${row.step_order} المهلة المحددة (${row.sla_hours} ساعة).`,
      documentId: row.document_id,
    });
    escalated += 1;
  }

  log.warn({ escalated }, 'overdue approvals escalated');
  return { escalated };
}

// ── Internals ────────────────────────────────────────────────────────────

async function templateForType(typeId) {
  if (typeId === null || typeId === undefined) return null;
  const result = await sql`
    SELECT TOP (1) template_id FROM dbo.approval_templates
     WHERE type_id = ${typeId} AND is_active = 1 ORDER BY template_id
  `.execute(db);
  return result.rows[0] ? Number(result.rows[0].template_id) : null;
}

async function stepsOf(templateId) {
  if (!templateId) return [];
  const result = await sql`
    SELECT step_order, approver_id, require_all, sla_hours
      FROM dbo.approval_steps WHERE template_id = ${templateId} ORDER BY step_order
  `.execute(db);

  return result.rows.map((row) => ({
    order: Number(row.step_order),
    approverId: String(row.approver_id),
    requireAll: Number(row.require_all) === 1,
    slaHours: row.sla_hours === null ? null : Number(row.sla_hours),
  }));
}

/** Notifies everyone who can act on a step. */
async function notifyStep({ step, document, kind, title, body = null }) {
  const members = await sql`
    SELECT principal_id FROM dbo.fn_expand_group_members(${step.approverId})
  `.execute(db);

  await notifyMany({
    userIds: members.rows.map((row) => String(row.principal_id)),
    kind,
    title,
    body,
    documentId: document.document_id,
    folderId: document.folder_id,
  });
}

async function announce({ outcome, request, steps, step, actorId }) {
  const document = {
    document_id: request.document_id,
    folder_id: request.folder_id,
    title: request.title,
  };

  if (outcome === 'advanced') {
    const next = steps.find((s) => s.order > step.order);
    if (next) {
      await notifyStep({
        step: next,
        document,
        kind: KIND.APPROVAL_REQUESTED,
        title: `طلب موافقة: ${request.title}`,
      });
    }
  }

  if (outcome === 'approved' || outcome === 'rejected') {
    await notify({
      userId: String(request.requested_by),
      kind: KIND.APPROVAL_DECIDED,
      title: outcome === 'approved' ? `اعتُمدت: ${request.title}` : `رُفضت: ${request.title}`,
      documentId: request.document_id,
      folderId: request.folder_id,
    });
  }
}
