/**
 * Search routes.
 *
 * One endpoint covers titles and content because a user does not think of them
 * as two searches. `contentSearched` in the response tells the UI whether the
 * extracted text was actually consulted, so it can say "titles only" rather than
 * implying the search was exhaustive when extraction has not run yet.
 */

import { search, advancedSearch, searchByField, contentSearchAvailable } from './service.js';

export async function searchRoutes(app) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (request, reply) => {
    const { q, folderId, typeId, content, limit, offset } = request.query ?? {};

    if (!String(q ?? '').trim()) {
      return reply.code(400).send({ error: 'query_required' });
    }

    return search({
      userId: request.user.userId,
      query: q,
      folderId: parseId(folderId),
      typeId: toNullableInt(typeId),
      // Content search is on unless explicitly disabled — the common case is
      // "find this thing", not "find this thing in titles only".
      includeContent: content !== 'false' && content !== '0',
      limit: toNullableInt(limit) ?? 25,
      offset: toNullableInt(offset) ?? 0,
    });
  });

  /**
   * Multi-criteria search — the blueprint's mandatory attribute search.
   *
   * POST rather than GET because the criteria are a structured object, not a
   * handful of query-string values, and a saved search is something a client
   * will want to round-trip as JSON.
   */
  app.post('/advanced', async (request) => {
    const body = request.body ?? {};

    return advancedSearch({
      userId: request.user.userId,
      query: body.q ?? null,
      folderId: parseId(body.folderId),
      typeId: toNullableInt(body.typeId),
      labelId: toNullableInt(body.labelId),
      createdFrom: body.createdFrom ? new Date(body.createdFrom).toISOString() : null,
      createdTo: body.createdTo ? new Date(body.createdTo).toISOString() : null,
      tags: Array.isArray(body.tags) ? body.tags : null,
      fields: Array.isArray(body.fields) ? body.fields : [],
      includeContent: body.content !== false,
      limit: toNullableInt(body.limit) ?? 25,
      offset: toNullableInt(body.offset) ?? 0,
    });
  });

  /** Metadata-field search, where typed columns give correct range semantics. */
  app.get('/fields/:fieldId', async (request, reply) => {
    const fieldId = toNullableInt(request.params.fieldId);
    if (fieldId === null) return reply.code(400).send({ error: 'invalid_field_id' });

    const { equals, min, max, limit } = request.query ?? {};
    return searchByField({
      userId: request.user.userId,
      fieldId,
      equals,
      min,
      max,
      limit: toNullableInt(limit) ?? 25,
    });
  });

  /** Lets the UI explain why content search is unavailable rather than guessing. */
  app.get('/capabilities', async () => ({
    contentSearch: await contentSearchAvailable(),
  }));
}

function parseId(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return /^[0-9]{1,19}$/.test(text) ? text : null;
}

function toNullableInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
