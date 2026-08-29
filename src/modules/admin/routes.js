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
import { queueStats } from '../extraction/worker.js';

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
    identity.get('/extraction/stats', async () => queueStats());
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

/** bigint ids stay strings — Number() loses precision past 2^53. */
function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}
