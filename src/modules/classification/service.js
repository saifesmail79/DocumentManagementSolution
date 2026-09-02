/**
 * The recognition pilot: queueing, the training set, predictions and the
 * measurements.
 *
 * ─── What this does and does not do ─────────────────────────────────────────
 *
 * It fingerprints page one of every document, treats the type a person gave a
 * document as that document's label, predicts a type for any document from
 * its nearest labelled neighbours, reads four header fields, and measures all
 * of it against the labels people already entered. It never sets a type,
 * never writes a field, never starts a workflow. The numbers it produces are
 * the pilot's deliverable; anything that acts on them is a later phase with
 * its own decision.
 *
 * ─── Off by default, switchable while running ───────────────────────────────
 *
 * The stored setting `classification.enabled` (falling back to the
 * environment) gates every part: uploads are only queued while it is on, the
 * worker idles while it is off, and the routes answer "disabled" rather than
 * computing. A production install ships with it off and nothing here runs; a
 * pilot machine switches it on from the administration screen.
 *
 * ─── The training set is the documents themselves ───────────────────────────
 *
 * There is no separate labelling step. A document whose type someone chose at
 * upload is a labelled sample; leave-one-out evaluation predicts each from all
 * the others, so accuracy is measured from what people were going to type
 * anyway. Thirty to fifty typed scans per type is the pilot's ask.
 */

import { db, sql } from '../../db/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { normalizeArabic } from '../../lib/arabic.js';
import { getSetting, listSettings } from '../settings/service.js';
import { PERM, has } from '../tree/service.js';
import { documentPermission } from '../collaboration/service.js';
import { ocrStatus } from '../extraction/ocr.js';
import { detectTools as detectRenditionTools } from '../renditions/service.js';
import {
  buildIndex,
  nearest,
  decide,
  evaluateIndex,
  automationCurve,
  THRESHOLDS,
  WEIGHTS,
  round,
} from './features.js';
import { parseDate, ROLES } from './extract.js';

const log = moduleLogger('classification');

/** classification_queue.status — the same states as the other queues. */
export const QUEUE = Object.freeze({
  PENDING: 0,
  RUNNING: 1,
  DONE: 2,
  RETRYABLE: 3,
  FAILED: 4,
  SKIPPED: 5,
});

const QUEUE_NAMES = ['pending', 'running', 'done', 'retryable', 'failed', 'skipped'];

/** The stored switch, environment as fallback. */
export async function isEnabled() {
  return Boolean(await getSetting('classification.enabled'));
}

// ── Queueing ─────────────────────────────────────────────────────────────

/** Queues one document. MERGE so a repeat resets the row rather than duplicating it. */
export async function enqueueClassification(executor, documentId) {
  await sql`
    MERGE dbo.classification_queue WITH (HOLDLOCK) AS target
    USING (SELECT ${documentId} AS document_id) AS source
       ON target.document_id = source.document_id
    WHEN MATCHED THEN
      UPDATE SET status = ${QUEUE.PENDING}, attempts = 0, last_error = NULL,
                 queued_at = SYSUTCDATETIME(), started_at = NULL, finished_at = NULL
    WHEN NOT MATCHED THEN
      INSERT (document_id) VALUES (source.document_id);
  `.execute(executor);
}

/**
 * Queues a document only while the pilot is on.
 *
 * Called from the upload transaction. With the pilot off this is one cached
 * setting read and nothing else, so a production install accumulates no rows.
 *
 * @returns {Promise<boolean>} whether it was queued
 */
export async function enqueueClassificationIfEnabled(executor, documentId) {
  if (!(await isEnabled())) return false;
  await enqueueClassification(executor, documentId);
  return true;
}

/**
 * Queues every live document without a current fingerprint — or every live
 * document, when `all` is set (after a change to how fingerprints are made).
 *
 * Rows already pending or running are left alone.
 */
export async function rebuild({ all = false } = {}) {
  const result = await sql`
    MERGE dbo.classification_queue WITH (HOLDLOCK) AS target
    USING (
      SELECT d.document_id
        FROM dbo.documents d
        LEFT JOIN dbo.classification_pages p ON p.document_id = d.document_id
       WHERE d.is_deleted = 0
         AND (${all ? 1 : 0} = 1
              OR p.document_id IS NULL
              OR p.version_number <> d.current_version)
    ) AS source
       ON target.document_id = source.document_id
    WHEN MATCHED AND target.status NOT IN (${QUEUE.PENDING}, ${QUEUE.RUNNING}) THEN
      UPDATE SET status = ${QUEUE.PENDING}, attempts = 0, last_error = NULL,
                 queued_at = SYSUTCDATETIME(), started_at = NULL, finished_at = NULL
    WHEN NOT MATCHED THEN
      INSERT (document_id) VALUES (source.document_id);
  `.execute(db);

  const queued = Number(result.numAffectedRows ?? 0);
  log.info({ queued, all }, 'documents queued for fingerprinting');
  return { queued };
}

// ── The training set ─────────────────────────────────────────────────────

/*
 * Every fingerprint, loaded once and kept until something changes.
 *
 * Rebuilt when a fingerprint is added, a document is typed or retyped, or a
 * document is deleted — detected by a cheap aggregate over the join rather
 * than by invalidation calls scattered through other modules. Loading parses
 * every stored text fingerprint at once, which is fine at pilot scale (a few
 * thousand pages) and would want streaming beyond it.
 */
let cache = { key: null, samples: [], byId: new Map(), index: null, entryById: new Map(), typeNames: new Map() };
let metricsCache = { key: null, value: null };

const parseJson = (text) => {
  try {
    return JSON.parse(text ?? '{}') ?? {};
  } catch {
    return {};
  }
};

async function samplesKey() {
  const result = await sql`
    SELECT COUNT(*) AS n, MAX(p.computed_at) AS latest, MAX(d.updated_at) AS touched
      FROM dbo.classification_pages p
      JOIN dbo.documents d ON d.document_id = p.document_id AND d.is_deleted = 0
  `.execute(db);
  const row = result.rows[0];
  return `${row.n}|${row.latest ? new Date(row.latest).toISOString() : ''}|${row.touched ? new Date(row.touched).toISOString() : ''}`;
}

async function loadIndex() {
  const key = await samplesKey();
  if (cache.key === key) return cache;

  const result = await sql`
    SELECT p.document_id, p.features, p.extracted, p.computed_at, p.word_count, p.char_count,
           p.ocr_psm, p.version_number,
           d.type_id, d.title, d.current_version, t.name AS type_name
      FROM dbo.classification_pages p
      JOIN dbo.documents d ON d.document_id = p.document_id AND d.is_deleted = 0
      LEFT JOIN dbo.document_types t ON t.type_id = d.type_id
  `.execute(db);

  const typeNames = new Map();
  const samples = result.rows.map((row) => {
    const features = parseJson(row.features);
    const typeId = row.type_id === null ? null : Number(row.type_id);
    if (typeId !== null) typeNames.set(typeId, row.type_name);
    return {
      id: String(row.document_id),
      typeId,
      typeName: row.type_name,
      title: row.title,
      text: features.text ?? {},
      headerThumb: features.layout?.header,
      pageThumb: features.layout?.page,
      extracted: parseJson(row.extracted),
      computedAt: row.computed_at,
      stale: Number(row.version_number) !== Number(row.current_version),
      words: Number(row.word_count),
      chars: Number(row.char_count),
      psm: row.ocr_psm,
    };
  });

  const index = buildIndex(samples);

  // The parsed fingerprints are the bulk of the memory and the index holds
  // their vectors now, so they are dropped from the samples that stay cached.
  for (const sample of samples) {
    delete sample.text;
    delete sample.headerThumb;
    delete sample.pageThumb;
  }

  cache = {
    key,
    samples,
    byId: new Map(samples.map((sample) => [sample.id, sample])),
    index,
    entryById: new Map(index.entries.map((entry) => [entry.id, entry])),
    typeNames,
  };
  return cache;
}

/** Test seam. */
export function resetClassificationCache() {
  cache = { key: null, samples: [], byId: new Map(), index: null, entryById: new Map(), typeNames: new Map() };
  metricsCache = { key: null, value: null };
}

// ── Predictions ──────────────────────────────────────────────────────────

/**
 * Predicts a document's type from its fingerprint and the labelled set,
 * excluding the document itself so a labelled document is not its own proof.
 *
 * @returns {Promise<object|null>} null when the document has no fingerprint yet
 */
export async function classifyDocument(documentId) {
  const { index, entryById, byId, typeNames } = await loadIndex();
  const entry = entryById.get(String(documentId));
  if (!entry) return null;

  const neighbours = nearest(index, entry, { excludeId: String(documentId) });
  const verdict = decide(neighbours);

  return {
    typeId: verdict.typeId,
    typeName: verdict.typeId === null ? null : typeNames.get(verdict.typeId) ?? null,
    confidence: verdict.confidence,
    nearest: verdict.nearest,
    decision: verdict.decision,
    votes: verdict.votes.map((vote) => ({ ...vote, typeName: typeNames.get(vote.typeId) ?? null })),
    neighbours: neighbours.map((neighbour) => ({
      documentId: neighbour.entry.id,
      title: byId.get(neighbour.entry.id)?.title ?? null,
      typeId: neighbour.entry.typeId,
      typeName: typeNames.get(neighbour.entry.typeId) ?? null,
      similarity: round(neighbour.combined),
      text: round(neighbour.text),
      header: round(neighbour.header),
      page: round(neighbour.page),
    })),
    labelled: index.entries.filter((candidate) => candidate.typeId !== null && candidate.id !== String(documentId)).length,
  };
}

async function queueRow(documentId) {
  const result = await sql`
    SELECT status, attempts, last_error, queued_at, started_at, finished_at
      FROM dbo.classification_queue WHERE document_id = ${documentId}
  `.execute(db);
  const row = result.rows[0];
  if (!row) return null;
  return {
    status: QUEUE_NAMES[Number(row.status)] ?? 'unknown',
    attempts: Number(row.attempts),
    error: row.last_error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Everything the document panel shows: the prediction, the neighbours, the
 * header fields as read, and what a person actually typed.
 *
 * Requires READ on the document — the neighbours' titles and the recognised
 * header are content, not metadata.
 */
export async function documentClassification({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  if (!(await isEnabled())) return { ok: true, enabled: false };

  const truthRow = await sql`
    SELECT d.type_id, t.name AS type_name
      FROM dbo.documents d
      LEFT JOIN dbo.document_types t ON t.type_id = d.type_id
     WHERE d.document_id = ${documentId} AND d.is_deleted = 0
  `.execute(db);
  const truth = truthRow.rows[0]
    ? {
        typeId: truthRow.rows[0].type_id === null ? null : Number(truthRow.rows[0].type_id),
        typeName: truthRow.rows[0].type_name,
      }
    : null;

  const queue = await queueRow(documentId);
  const { byId } = await loadIndex();
  const sample = byId.get(String(documentId));

  if (!sample) {
    return { ok: true, enabled: true, status: queue?.status ?? 'none', queue, truth, prediction: null, fields: null };
  }

  const prediction = await classifyDocument(documentId);
  return {
    ok: true,
    enabled: true,
    status: 'done',
    computedAt: sample.computedAt,
    stale: sample.stale,
    ocr: { psm: sample.psm, words: sample.words, chars: sample.chars },
    queue,
    truth,
    prediction,
    fields: sample.extracted,
  };
}

/** Queues one document on request. Requires READ, like reading the result. */
export async function requestClassification({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };
  if (!(await isEnabled())) return { ok: false, reason: 'classification_disabled' };
  await enqueueClassification(db, documentId);
  return { ok: true };
}

// ── Status ───────────────────────────────────────────────────────────────

/** Counts by queue status, plus how many claims look abandoned. */
export async function queueStats() {
  const result = await sql`
    SELECT status, COUNT(*) AS total FROM dbo.classification_queue GROUP BY status
  `.execute(db);

  const stats = { pending: 0, running: 0, done: 0, retryable: 0, failed: 0, skipped: 0 };
  for (const row of result.rows) {
    const name = QUEUE_NAMES[Number(row.status)];
    if (name) stats[name] = Number(row.total);
  }
  return stats;
}

/** The jobs that did not finish, with their reasons. */
export async function listFailures({ limit = 50 } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const result = await sql`
    SELECT TOP (${pageSize}) q.document_id, q.status, q.attempts, q.last_error, q.finished_at, d.title
      FROM dbo.classification_queue q
      JOIN dbo.documents d ON d.document_id = q.document_id
     WHERE d.is_deleted = 0
       AND (q.status IN (${QUEUE.FAILED}, ${QUEUE.SKIPPED})
            OR (q.status = ${QUEUE.RETRYABLE} AND q.attempts >= ${config.classification.maxAttempts}))
     ORDER BY q.finished_at DESC, q.queue_id DESC
  `.execute(db);

  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    title: row.title,
    status: QUEUE_NAMES[Number(row.status)],
    attempts: Number(row.attempts),
    reason: row.last_error,
    finishedAt: row.finished_at,
  }));
}

/**
 * Where the pilot stands: whether it is on and from where, whether its tools
 * are present, what the queue is doing, and how big the training set is.
 */
export async function classificationStatus() {
  const enabled = await isEnabled();
  const setting = (await listSettings()).find((entry) => entry.key === 'classification.enabled');

  const [ocr, render, queue, failures] = await Promise.all([
    ocrStatus({ enabled: true }),
    detectRenditionTools({ force: true }),
    queueStats(),
    listFailures({ limit: 20 }),
  ]);

  const stuck = await sql`
    SELECT COUNT(*) AS n FROM dbo.classification_queue
     WHERE status = ${QUEUE.RUNNING} AND started_at IS NOT NULL
       AND DATEDIFF(second, started_at, SYSUTCDATETIME()) > ${Math.floor(STALE_CLAIM_MS / 1000)}
  `.execute(db);

  const byType = await sql`
    SELECT d.type_id, t.name, COUNT(*) AS n
      FROM dbo.classification_pages p
      JOIN dbo.documents d ON d.document_id = p.document_id AND d.is_deleted = 0
      LEFT JOIN dbo.document_types t ON t.type_id = d.type_id
     GROUP BY d.type_id, t.name
     ORDER BY COUNT(*) DESC
  `.execute(db);

  const live = await sql`SELECT COUNT(*) AS n FROM dbo.documents WHERE is_deleted = 0`.execute(db);

  let total = 0;
  let labelled = 0;
  const types = [];
  for (const row of byType.rows) {
    const n = Number(row.n);
    total += n;
    if (row.type_id === null) continue;
    labelled += n;
    types.push({ typeId: Number(row.type_id), name: row.name, count: n });
  }

  return {
    enabled,
    source: setting?.source ?? 'environment',
    tools: {
      tesseract: ocr.tesseract,
      arabic: ocr.arabicAvailable,
      ghostscript: render.ghostscript,
    },
    queue,
    failures,
    worker: {
      pollMs: config.classification.pollMs,
      batchSize: config.classification.batchSize,
      stuckJobs: Number(stuck.rows[0].n),
    },
    samples: {
      total,
      labelled,
      unlabelled: total - labelled,
      documents: Number(live.rows[0].n),
      byType: types,
    },
    thresholds: THRESHOLDS,
    weights: WEIGHTS,
  };
}

/** How long a claim may sit before it is considered abandoned. Shared with the worker. */
export const STALE_CLAIM_MS = 20 * 60 * 1000;

// ── Metrics ──────────────────────────────────────────────────────────────

/**
 * The pilot's measurement: leave-one-out over every typed document, the
 * automation curve, and how often each header field agreed with what a
 * person typed into the matching custom field.
 */
export async function classificationMetrics() {
  const state = await loadIndex();
  if (metricsCache.key === state.key) return metricsCache.value;

  const { index, byId, typeNames } = state;
  const evaluation = evaluateIndex(index);
  const results = evaluation.results;

  const perType = new Map();
  for (const typeId of typeNames.keys()) {
    perType.set(typeId, { typeId, name: typeNames.get(typeId), support: 0, correct: 0, predicted: 0, unknown: 0 });
  }
  for (const r of results) {
    const truth = perType.get(r.truth);
    if (truth) {
      truth.support += 1;
      if (r.correct) truth.correct += 1;
      if (r.decision === 'unknown') truth.unknown += 1;
    }
    if (r.predicted !== null) {
      const predicted = perType.get(r.predicted);
      if (predicted) predicted.predicted += 1;
    }
  }

  const confusion = new Map();
  for (const r of results) {
    const key = `${r.truth}>${r.predicted}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }

  const correct = results.filter((r) => r.correct).length;

  const value = {
    computedAt: new Date().toISOString(),
    samples: { typed: evaluation.typed, evaluated: evaluation.evaluated, sampled: evaluation.sampled },
    accuracy: results.length > 0 ? round(correct / results.length) : null,
    unknown: results.filter((r) => r.decision === 'unknown').length,
    perType: [...perType.values()]
      .map((row) => ({
        ...row,
        recall: row.support > 0 ? round(row.correct / row.support) : null,
        precision: row.predicted > 0 ? round(row.correct / row.predicted) : null,
      }))
      .sort((a, b) => b.support - a.support),
    confusion: [...confusion.entries()]
      .map(([key, count]) => {
        const [truth, predicted] = key.split('>');
        return {
          truthId: Number(truth),
          truth: typeNames.get(Number(truth)) ?? null,
          predictedId: predicted === 'null' ? null : Number(predicted),
          predicted: predicted === 'null' ? null : typeNames.get(Number(predicted)) ?? null,
          count,
        };
      })
      .sort((a, b) => b.count - a.count),
    curve: automationCurve(results),
    mismatches: results
      .filter((r) => !r.correct)
      .slice(0, 50)
      .map((r) => ({
        documentId: r.id,
        title: byId.get(r.id)?.title ?? null,
        truth: typeNames.get(r.truth) ?? null,
        predicted: r.predicted === null ? null : typeNames.get(r.predicted) ?? null,
        confidence: r.confidence,
        nearest: r.nearest,
        decision: r.decision,
      })),
    fields: await evaluateFields(state.samples),
  };

  metricsCache = { key: state.key, value };
  return value;
}

// ── Header fields against what people typed ──────────────────────────────

/**
 * Which custom fields hold each header value, found by name.
 *
 * A deployment defines its own fields, so the pilot cannot know that field 7
 * is the document number. It guesses from the name — anything with رقم or
 * العدد in it is a number field — and says on screen which fields it matched,
 * so a wrong guess is visible rather than silently scored.
 */
const ROLE_PATTERNS = {
  number: [/رقم/, /العدد/, /المرجع/, /الاشاره/, /\bref/i, /\bnumber/i, /\bno\b/i],
  date: [/تاريخ/, /\bdate\b/i],
  subject: [/موضوع/, /\bsubject\b/i],
  addressee: [/(^|\s)الي(\s|$)/, /الجهه/, /القسم/, /الدايره/, /المديريه/, /موجه/, /\baddressee\b/i, /\bto\b/i],
};

export async function fieldRoles() {
  const result = await sql`
    SELECT field_id, name, data_type, type_id FROM dbo.custom_field_defs WHERE is_active = 1
  `.execute(db);

  const roles = Object.fromEntries(ROLES.map((role) => [role, []]));
  for (const row of result.rows) {
    const name = normalizeArabic(row.name);
    for (const role of ROLES) {
      if (ROLE_PATTERNS[role].some((pattern) => pattern.test(name))) {
        roles[role].push({
          fieldId: Number(row.field_id),
          name: row.name,
          dataType: row.data_type,
          typeId: row.type_id === null ? null : Number(row.type_id),
        });
        break;
      }
    }
  }
  return roles;
}

const digitsOnly = (text) => normalizeArabic(text).replace(/[^0-9]/g, '');

/** Levenshtein similarity, 0–1, on normalised text. */
function ratio(a, b) {
  const left = normalizeArabic(a);
  const right = normalizeArabic(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const cols = right.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[cols - 1] / Math.max(left.length, right.length);
}

function compareField(role, extracted, truth) {
  if (role === 'number') {
    const a = digitsOnly(extracted.value);
    const b = digitsOnly(truth.text ?? '');
    if (!a || !b) return 'miss';
    if (a === b) return 'match';
    return (a.length >= 3 && (a.includes(b) || b.includes(a))) ? 'close' : 'miss';
  }

  if (role === 'date') {
    if (extracted.calendar === 'hijri') return 'unverifiable';
    const truthIso = truth.date
      ? new Date(truth.date).toISOString().slice(0, 10)
      : parseDate(truth.text ?? '')?.iso ?? null;
    if (!truthIso || !extracted.iso) return 'miss';
    if (truthIso === extracted.iso) return 'match';
    return truthIso.slice(0, 7) === extracted.iso.slice(0, 7) ? 'close' : 'miss';
  }

  const score = ratio(extracted.value, truth.text ?? '');
  if (score >= 0.85) return 'match';
  return score >= 0.6 ? 'close' : 'miss';
}

async function evaluateFields(samples) {
  const roles = await fieldRoles();
  const fieldIds = ROLES.flatMap((role) => roles[role].map((field) => field.fieldId));

  const report = {};
  for (const role of ROLES) {
    report[role] = {
      fields: roles[role].map((field) => field.name),
      extracted: samples.filter((sample) => sample.extracted?.[role]?.value).length,
      compared: 0,
      match: 0,
      close: 0,
      miss: 0,
      unverifiable: 0,
      examples: [],
    };
  }

  if (fieldIds.length === 0 || samples.length === 0) return report;

  const values = await sql`
    SELECT v.document_id, v.field_id, v.value_text, v.value_number, v.value_date
      FROM dbo.document_field_values v
     WHERE v.field_id IN (${sql.join(fieldIds.map((id) => sql`${id}`))})
  `.execute(db);

  const byDocument = new Map();
  for (const row of values.rows) {
    const key = String(row.document_id);
    if (!byDocument.has(key)) byDocument.set(key, new Map());
    byDocument.get(key).set(Number(row.field_id), {
      text: row.value_text ?? (row.value_number === null ? null : String(row.value_number)),
      date: row.value_date,
    });
  }

  const rank = { match: 3, close: 2, unverifiable: 1, miss: 0 };

  for (const role of ROLES) {
    const fields = roles[role];
    if (fields.length === 0) continue;

    for (const sample of samples) {
      const extracted = sample.extracted?.[role];
      if (!extracted?.value) continue;

      const typed = byDocument.get(sample.id);
      if (!typed) continue;

      // Against every matching field the document has a value for; the best
      // outcome counts, so a second "date" field never turns a match into a miss.
      let best = null;
      let bestTruth = null;
      for (const field of fields) {
        const truth = typed.get(field.fieldId);
        if (!truth || (truth.text === null && truth.date === null)) continue;
        const outcome = compareField(role, extracted, truth);
        if (best === null || rank[outcome] > rank[best]) {
          best = outcome;
          bestTruth = truth;
        }
      }
      if (best === null) continue;

      const entry = report[role];
      entry.compared += 1;
      entry[best] += 1;
      if (best !== 'match' && entry.examples.length < 10) {
        entry.examples.push({
          documentId: sample.id,
          title: sample.title,
          read: extracted.value,
          typed: bestTruth.text ?? (bestTruth.date ? new Date(bestTruth.date).toISOString().slice(0, 10) : null),
          outcome: best,
        });
      }
    }
  }

  return report;
}
