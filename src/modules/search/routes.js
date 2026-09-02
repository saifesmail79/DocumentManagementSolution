/**
 * Search routes.
 *
 * One endpoint covers titles and content because a user does not think of them
 * as two searches. `contentSearched` in the response tells the UI whether the
 * extracted text was actually consulted, so it can say "titles only" rather than
 * implying the search was exhaustive when extraction has not run yet.
 */

import { search, advancedSearch, searchByField, contentSearchAvailable } from './service.js';
import { facetsFor, snippetsFor, filterOptions } from './facets.js';
import { normaliseFilters } from './filters.js';

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
  app.post('/advanced', async (request, reply) => {
    const body = request.body ?? {};

    // Every parameter filter goes through the shared normaliser, which is also
    // what rejects a malformed date. Previously a bad date string reached
    // `new Date(...).toISOString()` and threw a RangeError, so a mistyped filter
    // came back as a 500 with no indication which field was wrong.
    const { filters, problems } = normaliseFilters(body);
    if (problems.length > 0) {
      return reply.code(400).send({ error: 'invalid_filter', detail: problems.join(', ') });
    }

    return advancedSearch({
      userId: request.user.userId,
      // Null is a legitimate query here: this endpoint's whole purpose is that
      // documents can be found by their parameters with no keyword at all.
      query: body.q ?? null,
      folderId: parseId(body.folderId),
      fields: Array.isArray(body.fields) ? body.fields : [],
      filters,
      // Content is never consulted for a parameter search: the request is about
      // what a document IS, not what it says.
      includeContent: body.content !== false && Boolean(String(body.q ?? '').trim()),
      sortBy: body.sortBy ?? 'updated',
      sortDir: body.sortDir ?? 'desc',
      limit: toNullableInt(body.limit) ?? 25,
      offset: toNullableInt(body.offset) ?? 0,
    });
  });

  /**
   * The vocabulary a filter bar needs to render its controls.
   *
   * One request rather than four: a filter panel cannot show anything until it
   * has all of these, so four round trips would only stagger its appearance.
   * Scoped to what the caller can actually browse — offering a filter for a
   * document type that exists only in a folder they cannot see both leaks the
   * type list and returns nothing when chosen.
   */
  app.get('/filter-options', async (request) =>
    filterOptions({ userId: request.user.userId, folderId: parseId(request.query?.folderId) }),
  );

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

  /**
   * Facet counts for the current query.
   *
   * Separate from the results so a client can render them independently and
   * cache them across pages of the same search.
   */
  app.get('/facets', async (request) =>
    facetsFor({
      userId: request.user.userId,
      query: request.query?.q ?? null,
      folderId: parseId(request.query?.folderId),
    }),
  );

  /** Highlighted excerpts for a page of results. */
  app.post('/snippets', async (request) => ({
    snippets: await snippetsFor({
      userId: request.user.userId,
      documentIds: request.body?.documentIds,
      query: request.body?.q,
    }),
  }));

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
