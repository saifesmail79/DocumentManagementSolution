/**
 * Filing tree routes.
 *
 * Every handler here is thin on purpose: the permission decision belongs in the
 * SQL that fetches the rows (see service.js), not in a check the handler runs
 * first and then forgets to apply to a second query in the same request.
 */

import {
  getFolder,
  listSubfolders,
  listDocuments,
  createFolder,
  listTree,
  getAncestors,
} from './service.js';

export async function treeRoutes(app) {
  // Nothing in this module is reachable without a session.
  app.addHook('preHandler', app.requireAuth);

  /**
   * The whole browsable tree, flat, for the navigation panel.
   *
   * Registered before /:folderId so the literal path wins the match.
   */
  app.get('/tree', async (request) => listTree(request.user.userId, { limit: request.query.limit }));

  /** Top-level folders this user can see. */
  app.get('/', async (request) => ({
    folders: await listSubfolders(request.user.userId, null),
  }));

  /**
   * One folder with its children.
   *
   * A folder the user cannot browse returns 404, not 403 — a 403 confirms the id
   * is real, which turns id enumeration into a map of the filing structure.
   */
  app.get('/:folderId', async (request, reply) => {
    const folderId = parseId(request.params.folderId);
    if (folderId === null) return reply.code(400).send({ error: 'invalid_folder_id' });

    const folder = await getFolder(request.user.userId, folderId);
    if (!folder) return reply.code(404).send({ error: 'not_found' });

    const [folders, documents, ancestors] = await Promise.all([
      listSubfolders(request.user.userId, folderId),
      listDocuments(request.user.userId, folderId, {
        limit: request.query.limit,
        cursor: parseCursor(request.query.cursor),
      }),
      // Shipped with the folder so the breadcrumb needs no second round trip.
      getAncestors(request.user.userId, folderId),
    ]);

    return {
      folder,
      ancestors,
      folders,
      documents: documents.documents,
      // Encoded so a client treats it as opaque and cannot craft one that
      // reorders the page or skips the permission predicate.
      nextCursor: encodeCursor(documents.nextCursor),
    };
  });

  app.post('/', async (request, reply) => {
    const { parentId, name } = request.body ?? {};

    const result = await createFolder(request.user.userId, {
      parentId: parentId == null ? null : parseId(parentId),
      name,
    });

    if (!result.ok) {
      const status = { invalid_name: 400, too_deep: 400, forbidden: 403, not_found: 404 }[result.reason] ?? 400;
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(201).send({ folderId: String(result.folderId) });
  });
}

/**
 * Folder ids are bigint, so they arrive as strings and must stay strings.
 * Number() would silently lose precision past 2^53, and the id that comes back
 * would address a different folder — or none.
 */
function parseId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

/** @returns {string|null} the cursor as opaque base64url, or null at the last page */
function encodeCursor(cursor) {
  return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : null;
}

/** Cursor arrives as base64 JSON so a client never hand-assembles one. */
function parseCursor(raw) {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return decoded?.createdAt && decoded?.documentId ? decoded : undefined;
  } catch {
    return undefined;
  }
}
