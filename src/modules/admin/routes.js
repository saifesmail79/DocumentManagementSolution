/**
 * Administration routes.
 *
 * Two different gates, deliberately:
 *
 *   • Identity (users, groups, roles) is super-admin only. Creating accounts and
 *     handing out group membership is system-wide authority.
 *
 *   • Folder permissions are gated on MANAGE_PERMS for that folder, checked
 *     inside the service. A department head can run their own branch without an
 *     administrator in the loop, which is the entire reason that verb exists.
 */

import {
  listUsers,
  createUser,
  updateUser,
  setUserActive,
  setSuperAdmin,
  resetPassword,
  unlockUser,
  listGroups,
  createGroup,
  updateGroup,
  setGroupActive,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  listPrincipals,
} from './identity.js';
import {
  getFolderAcl,
  setFolderAce,
  removeFolderAce,
  setInheritance,
  explainPermission,
} from './acl.js';
import { queueStats, extractionStats } from '../extraction/worker.js';
import { ocrStatus } from '../extraction/ocr.js';
import { listUnsearchable, listWaiting, workerHealth } from '../extraction/worker.js';
import { getSetting } from '../settings/service.js';
import { verifyMail } from '../../lib/mailer.js';
import { listAudit, auditActions, record, ACTION } from '../audit/service.js';
import {
  purgeDeletedDocuments,
  purgeOrphanedUploads,
  findMissingBlobs,
  recycleBinState,
} from '../storage-maintenance/purge.js';
import { writeAllManifests } from '../storage-maintenance/manifest.js';
import {
  validateRoot,
  applyRoot,
  reconcile,
  reconciliationReport,
} from '../storage-maintenance/relocation.js';

const STATUS = {
  invalid_username: 400,
  invalid_name: 400,
  invalid_email: 400,
  invalid_bits: 400,
  weak_password: 400,
  empty_entry: 400,
  cycle: 400,
  username_taken: 409,
  name_taken: 409,
  system_role: 409,
  last_super_admin: 409,
  cannot_demote_self: 409,
  forbidden: 403,
  not_found: 404,
  principal_not_found: 404,
};

const send = (reply, result) =>
  result.ok
    ? result
    : reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason, problems: result.problems, details: result.details });

export async function adminRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // ── Identity: super-admin only ─────────────────────────────────────────
  //
  // Identity and permission changes are exactly what an audit gets asked about
  // — "who made that account an administrator", "who added the contractor to that
  // group" — and every one of these routes was previously silent. The pattern
  // below records on success after every mutation so the trail answers those
  // questions without manual database archaeology.

  app.register(async (identity) => {
    identity.addHook('preHandler', identity.requireSuperAdmin);

    identity.get('/users', async (request) =>
      listUsers({ search: request.query.q, includeInactive: request.query.inactive !== 'false' }),
    );

    identity.post('/users', async (request, reply) => {
      const result = await createUser(request.body ?? {});
      if (result.ok) {
        // The generated password is never logged; the username and super-admin
        // flag are what an auditor needs to understand what was set up.
        const detail = result.username + (request.body?.isSuperAdmin ? ', super admin' : '');
        await record({
          actor: request.user,
          action: ACTION.USER_CREATED,
          targetType: 'user',
          targetId: result.userId,
          detail,
          request,
        });
        return reply.code(201).send(result);
      }
      return send(reply, result);
    });

    identity.patch('/users/:userId', async (request, reply) => {
      const userId = parseId(request.params.userId);
      const { displayName, email } = request.body ?? {};
      const result = await updateUser({ userId, displayName, email });
      if (result.ok) {
        // Only record the fields that were actually supplied; an empty PATCH
        // (no-op) does not deserve an audit entry.
        const changed = [];
        if (displayName !== undefined) changed.push('display name');
        if (email !== undefined) changed.push('email');
        if (changed.length > 0) {
          await record({
            actor: request.user,
            action: ACTION.USER_UPDATED,
            targetType: 'user',
            targetId: String(userId),
            detail: changed.join(', ') + ' updated',
            request,
          });
        }
      }
      return send(reply, result);
    });

    identity.post('/users/:userId/active', async (request, reply) => {
      const userId = parseId(request.params.userId);
      const active = request.body?.active !== false;
      const result = await setUserActive({ userId, active, actorId: request.user.userId });
      if (result.ok) {
        await record({
          actor: request.user,
          action: active ? ACTION.USER_ACTIVATED : ACTION.USER_DEACTIVATED,
          targetType: 'user',
          targetId: String(userId),
          request,
        });
      }
      return send(reply, result);
    });

    identity.post('/users/:userId/super-admin', async (request, reply) => {
      const userId = parseId(request.params.userId);
      const isSuperAdmin = request.body?.isSuperAdmin === true;
      const result = await setSuperAdmin({ userId, isSuperAdmin, actorId: request.user.userId });
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.USER_SUPER_ADMIN_CHANGED,
          targetType: 'user',
          targetId: String(userId),
          detail: isSuperAdmin ? 'granted' : 'revoked',
          request,
        });
      }
      return send(reply, result);
    });

    identity.post('/users/:userId/reset-password', async (request, reply) => {
      const userId = parseId(request.params.userId);
      const result = await resetPassword({ userId });
      if (result.ok) {
        // Passwords and hashes are never put in the detail; the session count
        // is what the security team needs to know to assess the incident scope.
        await record({
          actor: request.user,
          action: ACTION.PASSWORD_RESET_BY_ADMIN,
          targetType: 'user',
          targetId: String(userId),
          detail: `${result.revokedSessions} session(s) revoked`,
          request,
        });
      }
      return send(reply, result);
    });

    identity.post('/users/:userId/unlock', async (request, reply) => {
      const userId = parseId(request.params.userId);
      const result = await unlockUser({ userId });
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.USER_UNLOCKED,
          targetType: 'user',
          targetId: String(userId),
          request,
        });
      }
      return send(reply, result);
    });

    identity.get('/groups', async () => ({ groups: await listGroups() }));

    identity.post('/groups', async (request, reply) => {
      const result = await createGroup(request.body ?? {});
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.GROUP_CREATED,
          targetType: 'group',
          targetId: result.groupId,
          detail: request.body?.name,
          request,
        });
        return reply.code(201).send(result);
      }
      return send(reply, result);
    });

    identity.patch('/groups/:groupId', async (request, reply) => {
      const groupId = parseId(request.params.groupId);
      // Spreading the whole body would let a client-supplied groupId retarget
      // the update and falsify the audit targetId — destructure only what the
      // service expects.
      const { name, description } = request.body ?? {};
      const result = await updateGroup({ groupId, name, description });
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.GROUP_UPDATED,
          targetType: 'group',
          targetId: String(groupId),
          detail: request.body?.name ?? null,
          request,
        });
      }
      return send(reply, result);
    });

    identity.post('/groups/:groupId/active', async (request, reply) => {
      const groupId = parseId(request.params.groupId);
      const active = request.body?.active !== false;
      const result = await setGroupActive({ groupId, active });
      if (result.ok) {
        await record({
          actor: request.user,
          action: active ? ACTION.GROUP_ACTIVATED : ACTION.GROUP_DEACTIVATED,
          targetType: 'group',
          targetId: String(groupId),
          request,
        });
      }
      return send(reply, result);
    });

    identity.get('/groups/:groupId/members', async (request) => ({
      members: await listGroupMembers(parseId(request.params.groupId)),
    }));

    identity.post('/groups/:groupId/members', async (request, reply) => {
      const groupId = parseId(request.params.groupId);
      const principalId = parseId(request.body?.principalId);
      const result = await addGroupMember({ groupId, principalId });
      if (result.ok && !result.alreadyMember) {
        await record({
          actor: request.user,
          action: ACTION.GROUP_MEMBER_ADDED,
          targetType: 'group',
          targetId: String(groupId),
          detail: `principal ${principalId}`,
          request,
        });
      }
      return send(reply, result);
    });

    identity.delete('/groups/:groupId/members/:principalId', async (request, reply) => {
      const groupId = parseId(request.params.groupId);
      const principalId = parseId(request.params.principalId);
      const result = await removeGroupMember({ groupId, principalId });
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.GROUP_MEMBER_REMOVED,
          targetType: 'group',
          targetId: String(groupId),
          detail: `principal ${principalId}`,
          request,
        });
      }
      return send(reply, result);
    });

    identity.get('/roles', async () => ({ roles: await listRoles() }));

    identity.post('/roles', async (request, reply) => {
      const result = await createRole(request.body ?? {});
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.ROLE_CREATED,
          targetType: 'role',
          targetId: String(result.roleId),
          detail: request.body?.name,
          request,
        });
        return reply.code(201).send(result);
      }
      return send(reply, result);
    });

    identity.patch('/roles/:roleId', async (request, reply) => {
      const roleId = Number(request.params.roleId);
      const result = await updateRole({ roleId, ...(request.body ?? {}) });
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.ROLE_UPDATED,
          targetType: 'role',
          targetId: String(roleId),
          detail: request.body?.name ?? null,
          request,
        });
      }
      return send(reply, result);
    });

    identity.delete('/roles/:roleId', async (request, reply) => {
      const roleId = Number(request.params.roleId);
      const result = await deleteRole({ roleId });
      if (result.ok) {
        await record({
          actor: request.user,
          action: ACTION.ROLE_DELETED,
          targetType: 'role',
          targetId: String(roleId),
          request,
        });
      }
      return send(reply, result);
    });

    /** Extraction health, so "why can search not find this" has an answer. */
    identity.get('/extraction/stats', async () => ({
      queue: await queueStats(),
      documents: await extractionStats(),
      // "Why can search not find my scans" almost always has this answer.
      // The stored setting, not the environment variable: reporting the value
      // the operator did not set is how a diagnostics screen becomes a liar.
      ocr: await ocrStatus({ enabled: await getSetting('ocr.enabled') }),
      // Whether the worker is actually running, which a queue count alone cannot
      // say: "nothing pending" and "nothing being processed" look identical.
      worker: await workerHealth(),
    }));

    /**
     * The documents that are not searchable, and why each one is not.
     *
     * A count says something is wrong. This says which documents and for what
     * reason, which is what turns a red number into something an administrator
     * can act on.
     */
    identity.get('/extraction/failures', async (request) => {
      const limit = Number(request.query?.limit) || 50;

      // Both halves in one response, because they are one question. "Not
      // searchable" splits into "it failed" and "it has not run yet", and an
      // operator looking at a document that is missing from search cannot tell
      // which without being shown both lists.
      return {
        failures: await listUnsearchable({ limit }),
        waiting: await listWaiting({ limit }),
      };
    });

    /** Renditions: tool availability AND what the queue actually did with it. */
    identity.get('/renditions/status', async () => {
      const { renditionStatus } = await import('../renditions/service.js');
      return renditionStatus();
    });

    /**
     * Puts every unsearchable document back on the queue.
     *
     * The remedy after fixing a server-side cause — an OCR engine installed
     * later, a broken parser corrected. Without it the only way to index those
     * documents again is to delete and re-upload each one, losing its version
     * history and metadata.
     */
    identity.post('/extraction/reindex', async (request) => {
      const { requeueUnsearchable } = await import('../extraction/worker.js');
      const result = await requeueUnsearchable();

      await record({
        actor: request.user,
        action: ACTION.SETTING_CHANGED,
        targetType: 'extraction',
        targetId: 'reindex',
        detail: `requeued ${result.requeued} document(s) for extraction`,
        request,
      });

      return result;
    });

    /** The audit trail. */
    identity.get('/audit', async (request, reply) => {
      const { actor, action, targetType, targetId, folderId, from, to, limit, cursor } =
        request.query ?? {};

      // A present-but-non-numeric actor id cannot match any user; silently
      // dropping the filter would return an unfiltered page the caller did not
      // ask for and would hide the typo from whoever is reading the audit screen.
      if (actor !== undefined && parseId(actor) === null) {
        return reply.code(400).send({ error: 'invalid_actor' });
      }

      const page = await listAudit({
        actorUserId: parseId(actor),
        action: action || null,
        targetType: targetType || null,
        targetId: targetId || null,
        folderId: parseId(folderId),
        from: from ? new Date(from).toISOString() : null,
        to: to ? new Date(to).toISOString() : null,
        limit: Number(limit) || 50,
        cursor: decodeCursor(cursor),
      });

      return { ...page, nextCursor: encodeCursor(page.nextCursor) };
    });

    identity.get('/audit/actions', async () => ({ actions: await auditActions() }));

    /** Integrity check: rows whose file is not on disk. */
    identity.get('/storage/missing', async (request) =>
      findMissingBlobs({ max: Number(request.query?.max) || 1000 }),
    );

    /** Runs the purge sweep now. dryRun reports without deleting. */
    identity.post('/storage/purge', async (request) => {
      const dryRun = request.body?.dryRun === true;
      const documents = await purgeDeletedDocuments({ dryRun });
      const uploads = dryRun ? { temp: 0, staging: 0 } : await purgeOrphanedUploads();
      // Read after the sweep, so a zero can be explained by what is left rather
      // than reported bare.
      const bin = await recycleBinState();

      if (!dryRun) {
        await record({
          actor: request.user,
          action: ACTION.BLOB_PURGED,
          detail: `manual sweep: ${documents.purged} blob(s)`,
          request,
        });
      }

      return { documents, uploads, bin };
    });

    /** Regenerates the per-month manifests that make the disk self-describing. */
    identity.post('/storage/manifests', async () => writeAllManifests());

    /**
     * Rebuilds stored previews under the current rendering rules.
     *
     * Needed whenever those rules change: a rendition records what the renderer
     * believed when it last ran, and nothing ages one out on its own.
     */
    identity.post('/renditions/rebuild', async (request) => {
      const { rebuildRenditions } = await import('../renditions/service.js');
      const result = await rebuildRenditions({ kind: 'preview' });

      await record({
        actor: request.user,
        action: ACTION.SETTING_CHANGED,
        detail: `queued ${result.queued} preview(s) for rebuild`,
        request,
      });

      return result;
    });

    // ── Where the documents live ─────────────────────────────────────────

    /** Checks a candidate root without changing anything. */
    identity.post('/storage/root/validate', async (request) =>
      validateRoot(request.body?.path));

    /**
     * Repoints the system at a new root.
     *
     * Returns the reconciliation straight away, because the only question worth
     * asking in the minutes after a move is which files are not there yet.
     */
    identity.post('/storage/root', async (request, reply) => {
      const result = await applyRoot(request.body?.path, { actorId: request.user.userId });

      if (!result.ok) {
        // Every refusal here is about the destination, so it is the caller's
        // input that is wrong rather than the server that is broken.
        return reply.code(400).send(result);
      }

      await record({
        actor: request.user,
        action: ACTION.SETTING_CHANGED,
        targetType: 'setting',
        detail: `storage.root: ${result.from} → ${result.to}`,
        request,
      });

      return result;
    });

    /** Re-checks every referenced file against the live root. */
    identity.post('/storage/reconcile', async () => reconcile());

    /** What is still outstanding, so a copy can be finished in sessions. */
    identity.get('/storage/reconcile', async (request) =>
      reconciliationReport({ limit: Number(request.query?.limit) || 500 }));

    /** Checks SMTP without sending, so a broken relay is found before a user needs it. */
    identity.get('/mail/status', async () => verifyMail());
  });

  // ── Folder permissions: MANAGE_PERMS, checked per folder ───────────────

  /** A picker needs to search people and groups; it reveals only names. */
  app.get('/principals', async (request) => ({
    principals: await listPrincipals({ search: request.query.q }),
  }));

  app.get('/folders/:folderId/acl', async (request, reply) =>
    send(reply, await getFolderAcl(request.user.userId, parseId(request.params.folderId))),
  );

  app.put('/folders/:folderId/acl/:principalId', async (request, reply) => {
    const folderId = parseId(request.params.folderId);
    const principalId = parseId(request.params.principalId);
    const result = await setFolderAce({
      userId: request.user.userId,
      folderId,
      principalId,
      allowBits: request.body?.allowBits,
      denyBits: request.body?.denyBits,
      roleId: request.body?.roleId ?? null,
    });
    if (result.ok) {
      await record({
        actor: request.user,
        action: ACTION.ACE_SET,
        targetType: 'folder',
        targetId: String(folderId),
        folderId: String(folderId),
        detail: `principal ${principalId} allow=${request.body?.allowBits ?? 0} deny=${request.body?.denyBits ?? 0}`,
        request,
      });
    }
    return send(reply, result);
  });

  app.delete('/folders/:folderId/acl/:principalId', async (request, reply) => {
    const folderId = parseId(request.params.folderId);
    const principalId = parseId(request.params.principalId);
    const result = await removeFolderAce({
      userId: request.user.userId,
      folderId,
      principalId,
    });
    if (result.ok) {
      await record({
        actor: request.user,
        action: ACTION.ACE_REMOVED,
        targetType: 'folder',
        targetId: String(folderId),
        folderId: String(folderId),
        detail: `principal ${principalId}`,
        request,
      });
    }
    return send(reply, result);
  });

  app.post('/folders/:folderId/inheritance', async (request, reply) => {
    const folderId = parseId(request.params.folderId);
    const inherits = request.body?.inherits === true;
    const result = await setInheritance({
      userId: request.user.userId,
      folderId,
      inherits,
      copyInherited: request.body?.copyInherited !== false,
    });
    if (result.ok) {
      await record({
        actor: request.user,
        action: ACTION.INHERITANCE_CHANGED,
        targetType: 'folder',
        targetId: String(folderId),
        folderId: String(folderId),
        detail: `inherits ${inherits}`,
        request,
      });
    }
    return send(reply, result);
  });

  /** "What can this person do here, and which grants say so." */
  app.get('/folders/:folderId/acl/explain/:subjectId', async (request, reply) =>
    send(
      reply,
      await explainPermission({
        userId: request.user.userId,
        folderId: parseId(request.params.folderId),
        subjectId: parseId(request.params.subjectId),
      }),
    ),
  );
}

/** Audit cursors travel opaque, so a client cannot craft one that reorders a page. */
function encodeCursor(cursor) {
  return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : null;
}

function decodeCursor(raw) {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return decoded?.occurredAt && decoded?.auditId ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** bigint ids stay strings — Number() loses precision past 2^53. */
function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}
