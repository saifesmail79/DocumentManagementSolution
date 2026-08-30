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
  setUserActive,
  setSuperAdmin,
  resetPassword,
  unlockUser,
  listGroups,
  createGroup,
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
import { listUnsearchable, workerHealth } from '../extraction/worker.js';
import { getSetting } from '../settings/service.js';
import { verifyMail } from '../../lib/mailer.js';
import { listAudit, auditActions, record, ACTION } from '../audit/service.js';
import { purgeDeletedDocuments, purgeOrphanedUploads, findMissingBlobs } from '../storage-maintenance/purge.js';
import { writeAllManifests } from '../storage-maintenance/manifest.js';

const STATUS = {
  invalid_username: 400,
  invalid_name: 400,
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
    : reply.code(STATUS[result.reason] ?? 400).send({ error: result.reason, problems: result.problems });

export async function adminRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  // ── Identity: super-admin only ─────────────────────────────────────────

  app.register(async (identity) => {
    identity.addHook('preHandler', identity.requireSuperAdmin);

    identity.get('/users', async (request) =>
      listUsers({ search: request.query.q, includeInactive: request.query.inactive !== 'false' }),
    );

    identity.post('/users', async (request, reply) => {
      const result = await createUser(request.body ?? {});
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    identity.post('/users/:userId/active', async (request, reply) =>
      send(
        reply,
        await setUserActive({
          userId: parseId(request.params.userId),
          active: request.body?.active !== false,
          actorId: request.user.userId,
        }),
      ),
    );

    identity.post('/users/:userId/super-admin', async (request, reply) =>
      send(
        reply,
        await setSuperAdmin({
          userId: parseId(request.params.userId),
          isSuperAdmin: request.body?.isSuperAdmin === true,
          actorId: request.user.userId,
        }),
      ),
    );

    identity.post('/users/:userId/reset-password', async (request, reply) =>
      send(reply, await resetPassword({ userId: parseId(request.params.userId) })),
    );

    identity.post('/users/:userId/unlock', async (request, reply) =>
      send(reply, await unlockUser({ userId: parseId(request.params.userId) })),
    );

    identity.get('/groups', async () => ({ groups: await listGroups() }));

    identity.post('/groups', async (request, reply) => {
      const result = await createGroup(request.body ?? {});
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    identity.get('/groups/:groupId/members', async (request) => ({
      members: await listGroupMembers(parseId(request.params.groupId)),
    }));

    identity.post('/groups/:groupId/members', async (request, reply) =>
      send(
        reply,
        await addGroupMember({
          groupId: parseId(request.params.groupId),
          principalId: parseId(request.body?.principalId),
        }),
      ),
    );

    identity.delete('/groups/:groupId/members/:principalId', async (request, reply) =>
      send(
        reply,
        await removeGroupMember({
          groupId: parseId(request.params.groupId),
          principalId: parseId(request.params.principalId),
        }),
      ),
    );

    identity.get('/roles', async () => ({ roles: await listRoles() }));

    identity.post('/roles', async (request, reply) => {
      const result = await createRole(request.body ?? {});
      return result.ok ? reply.code(201).send(result) : send(reply, result);
    });

    identity.patch('/roles/:roleId', async (request, reply) =>
      send(reply, await updateRole({ roleId: Number(request.params.roleId), ...(request.body ?? {}) })),
    );

    identity.delete('/roles/:roleId', async (request, reply) =>
      send(reply, await deleteRole({ roleId: Number(request.params.roleId) })),
    );

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
    identity.get('/extraction/failures', async (request) => ({
      failures: await listUnsearchable({ limit: Number(request.query?.limit) || 50 }),
    }));

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
    identity.get('/audit', async (request) => {
      const { actor, action, targetType, targetId, folderId, from, to, limit, cursor } =
        request.query ?? {};

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

      if (!dryRun) {
        await record({
          actor: request.user,
          action: ACTION.BLOB_PURGED,
          detail: `manual sweep: ${documents.purged} blob(s)`,
          request,
        });
      }

      return { documents, uploads };
    });

    /** Regenerates the per-month manifests that make the disk self-describing. */
    identity.post('/storage/manifests', async () => writeAllManifests());

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

  app.put('/folders/:folderId/acl/:principalId', async (request, reply) =>
    send(
      reply,
      await setFolderAce({
        userId: request.user.userId,
        folderId: parseId(request.params.folderId),
        principalId: parseId(request.params.principalId),
        allowBits: request.body?.allowBits,
        denyBits: request.body?.denyBits,
        roleId: request.body?.roleId ?? null,
      }),
    ),
  );

  app.delete('/folders/:folderId/acl/:principalId', async (request, reply) =>
    send(
      reply,
      await removeFolderAce({
        userId: request.user.userId,
        folderId: parseId(request.params.folderId),
        principalId: parseId(request.params.principalId),
      }),
    ),
  );

  app.post('/folders/:folderId/inheritance', async (request, reply) =>
    send(
      reply,
      await setInheritance({
        userId: request.user.userId,
        folderId: parseId(request.params.folderId),
        inherits: request.body?.inherits === true,
        copyInherited: request.body?.copyInherited !== false,
      }),
    ),
  );

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
