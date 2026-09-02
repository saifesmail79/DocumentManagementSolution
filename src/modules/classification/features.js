/**
 * Fingerprints and similarity — the pure half of the recognition pilot.
 *
 * ─── The approach, and why it is this one ───────────────────────────────────
 *
 * A new page is compared with every page a person has already typed, and the
 * type of its nearest neighbours wins. Nearest-neighbour rather than a trained
 * model, for three reasons that matter in a pilot:
 *
 *   • It is the customer's own mental model — "compare the new scan to the
 *     ones it was trained on" — so what the screen shows (the neighbours and
 *     how alike they are) is the actual mechanism, not an explanation of one.
 *   • It can say "nothing I have seen looks like this", which a classifier
 *     with a fixed set of outputs cannot. An unknown format going to a person
 *     is the whole safety story.
 *   • It needs no training step, no Python, no model files. Adding a typed
 *     document adds a neighbour.
 *
 * ─── Two fingerprints ───────────────────────────────────────────────────────
 *
 * Text: the words Tesseract read, as unigrams plus character trigrams, with
 * words in the header band counted double. Trigrams are what make this survive
 * OCR: a letter misread in وزارة still leaves most of its trigrams intact, and
 * a whole-word match would have lost it. Pure numbers collapse to one token —
 * a document number varies per document and would otherwise be noise that
 * happens to look like signal.
 *
 * Layout: the page shrunk to a few hundred grey pixels, and the header band
 * shrunk separately. A letterhead, a form's ruled boxes, a memo's title block
 * — the "shape" the customer described — survive that shrink; the text inside
 * them does not, which is the point. Two documents of one type with different
 * words still share a shape.
 *
 * Both are compared by cosine similarity and blended with fixed weights. The
 * weights and thresholds are constants, reported by the status endpoint, so
 * the numbers on the screen can always be traced to a rule in this file.
 *
 * Nothing here touches the database or a binary. It is tested with synthetic
 * word lists, and it runs the same for a stored fingerprint as for a fresh one.
 */

import { normalizeArabic } from '../../lib/arabic.js';

/** The page thumbnail, in an A4-ish aspect. 1,408 grey values. */
export const PAGE_THUMB = Object.freeze({ width: 32, height: 44 });

/** The header band thumbnail. Wider than tall, because a letterhead is. */
export const HEADER_THUMB = Object.freeze({ width: 64, height: 24 });

/** How much of the page, from the top, counts as the header. */
export const HEADER_FRACTION = 0.33;

/** How the three similarities blend into one. Text carries most of the weight. */
export const WEIGHTS = Object.freeze({ text: 0.6, header: 0.25, page: 0.15 });

/**
 * The decision rules.
 *
 *   auto     the neighbours agree (vote share ≥ autoConfidence) AND the closest
 *            one is genuinely close (≥ autoSimilarity). This is the only state
 *            in which a later phase would route without a person.
 *   unknown  nothing in the training set resembles the page (< unknownSimilarity).
 *   review   everything else: a prediction exists, and a person confirms it.
 */
export const THRESHOLDS = Object.freeze({
  autoConfidence: 0.9,
  autoSimilarity: 0.5,
  unknownSimilarity: 0.3,
  neighbours: 5,
  /**
   * A neighbour less than this fraction as close as the closest one does not
   * vote. Measured on the fixtures: with three samples per type and five
   * neighbours, the two right answers at 0.63 were outvoted into "review" by
   * three wrong ones at 0.2 — the rest of the archive, not evidence.
   */
  relativeFloor: 0.5,
});

// ── Tesseract TSV ────────────────────────────────────────────────────────

/**
 * Parses Tesseract's TSV output into words with boxes.
 *
 * Level 1 is the page (its width and height are the only things read from it);
 * level 5 is a word. Everything between — blocks, paragraphs, lines — is kept
 * as the numbers on each word, which is enough to rebuild lines.
 *
 * @param {string} tsv
 * @returns {{page: {width: number, height: number}, words: Word[]}}
 *
 * @typedef {object} Word
 * @property {string} text
 * @property {number} conf   0–100, Tesseract's own confidence
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {number} block
 * @property {number} par
 * @property {number} line
 * @property {number} word   position within the line, in reading order
 */
export function parseTsv(tsv) {
  let page = { width: 0, height: 0 };
  const words = [];

  for (const row of String(tsv ?? '').split(/\r?\n/).slice(1)) {
    if (!row.trim()) continue;
    const cols = row.split('\t');
    if (cols.length < 12) continue;

    const level = Number(cols[0]);
    if (level === 1) {
      page = { width: Number(cols[8]), height: Number(cols[9]) };
      continue;
    }
    if (level !== 5) continue;

    const text = cols.slice(11).join('\t').trim();
    if (!text) continue;

    words.push({
      text,
      conf: Number(cols[10]),
      left: Number(cols[6]),
      top: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      block: Number(cols[2]),
      par: Number(cols[3]),
      line: Number(cols[4]),
      word: Number(cols[5]),
    });
  }

  return { page, words };
}

/** Letters and digits only, by Unicode class, so Arabic counts. */
export function meaningfulCharacters(words) {
  let total = 0;
  for (const word of words) total += (word.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return total;
}

// ── Text fingerprint ─────────────────────────────────────────────────────

const NUMERIC = /^[0-9]+$/;

/** Normalised tokens of two or more letters or digits. */
export function tokenize(text) {
  return normalizeArabic(text)
    .split(' ')
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token.length >= 2);
}

/**
 * The text fingerprint: a bag of unigrams and character trigrams.
 *
 * Returned as a plain object so it can be stored as JSON and rebuilt into a
 * vector against whatever training set exists at comparison time — the IDF
 * weighting depends on the set, so it is not baked in here.
 */
export function textFeatures(words, page) {
  const counts = new Map();
  const bump = (key, weight) => counts.set(key, (counts.get(key) ?? 0) + weight);
  const headerLimit = (page?.height ?? 0) * HEADER_FRACTION;

  for (const word of words) {
    const weight = word.top + word.height / 2 < headerLimit ? 2 : 1;

    for (const token of tokenize(word.text)) {
      if (NUMERIC.test(token)) {
        bump('#', weight);
        continue;
      }
      bump(`w:${token}`, weight);
      const padded = `_${token}_`;
      for (let i = 0; i + 3 <= padded.length; i += 1) bump(`c:${padded.slice(i, i + 3)}`, weight);
    }
  }

  return Object.fromEntries(counts);
}

// ── Layout fingerprint ───────────────────────────────────────────────────

/**
 * A thumbnail's grey values as a zero-mean, unit-length vector.
 *
 * Zero-mean so a darker scan of the same page is not a different page;
 * unit-length so the dot product is a cosine. A blank thumbnail has no
 * direction and yields null, which compares as "nothing alike".
 */
export function layoutVector(base64, expectedLength) {
  if (!base64) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== expectedLength) return null;

  const vector = new Float32Array(expectedLength);
  let mean = 0;
  for (let i = 0; i < expectedLength; i += 1) mean += bytes[i];
  mean /= expectedLength;

  let norm = 0;
  for (let i = 0; i < expectedLength; i += 1) {
    vector[i] = bytes[i] - mean;
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-6) return null;

  for (let i = 0; i < expectedLength; i += 1) vector[i] /= norm;
  return vector;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  // Negative correlation is "less alike than random", which for this purpose
  // is simply not alike.
  return Math.max(0, sum);
}

// ── The index ────────────────────────────────────────────────────────────

/**
 * @typedef {object} Sample
 * @property {string} id          document id
 * @property {number|null} typeId the type a person assigned, or null
 * @property {Record<string, number>} text   from textFeatures
 * @property {string} headerThumb base64 grey values, HEADER_THUMB sized
 * @property {string} pageThumb   base64 grey values, PAGE_THUMB sized
 */

/**
 * Builds the comparison index over a set of samples.
 *
 * IDF is computed here, over exactly this set: a token that appears on every
 * page (the organisation's own name on every letterhead) tells nothing about
 * type and is weighted down; a token peculiar to one type is what decides.
 */
export function buildIndex(samples) {
  const documentFrequency = new Map();
  for (const sample of samples) {
    for (const token of Object.keys(sample.text ?? {})) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const n = samples.length;
  const ids = new Map();
  const idf = new Map();
  let next = 0;
  for (const [token, count] of documentFrequency) {
    ids.set(token, next);
    next += 1;
    idf.set(token, Math.log((n + 1) / (count + 1)) + 1);
  }

  const vocabulary = { ids, idf };
  return {
    size: n,
    vocabulary,
    entries: samples.map((sample) => vectorize(sample, vocabulary)),
  };
}

/** A sample as a comparable entry under an index's vocabulary. */
export function vectorize(sample, vocabulary) {
  const pairs = [];
  for (const [token, count] of Object.entries(sample.text ?? {})) {
    const id = vocabulary.ids.get(token);
    // A token nothing in the training set has seen contributes nothing to any
    // comparison, so it is dropped rather than given a made-up weight.
    if (id === undefined) continue;
    pairs.push([id, (1 + Math.log(count)) * vocabulary.idf.get(token)]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  const tokenIds = new Int32Array(pairs.length);
  const weights = new Float32Array(pairs.length);
  let norm = 0;
  pairs.forEach(([id, weight], i) => {
    tokenIds[i] = id;
    weights[i] = weight;
    norm += weight * weight;
  });
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < weights.length; i += 1) weights[i] /= norm;

  return {
    id: String(sample.id),
    typeId: sample.typeId === null || sample.typeId === undefined ? null : Number(sample.typeId),
    tokenIds,
    weights,
    header: layoutVector(sample.headerThumb, HEADER_THUMB.width * HEADER_THUMB.height),
    page: layoutVector(sample.pageThumb, PAGE_THUMB.width * PAGE_THUMB.height),
  };
}

/** Dot product of two sorted sparse vectors, by merge. */
function sparseDot(a, b) {
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.tokenIds.length && j < b.tokenIds.length) {
    const left = a.tokenIds[i];
    const right = b.tokenIds[j];
    if (left === right) {
      sum += a.weights[i] * b.weights[j];
      i += 1;
      j += 1;
    } else if (left < right) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return sum;
}

/** The three similarities between two entries, and their blend. */
export function similarity(a, b) {
  const text = sparseDot(a, b);
  const header = cosine(a.header, b.header);
  const page = cosine(a.page, b.page);
  return {
    text,
    header,
    page,
    combined: WEIGHTS.text * text + WEIGHTS.header * header + WEIGHTS.page * page,
  };
}

/**
 * The k typed entries most like `target`, closest first.
 *
 * Untyped entries are never neighbours: they have no vote to cast. `excludeId`
 * keeps a document from being its own nearest neighbour when it is evaluated
 * against the set it belongs to.
 */
export function nearest(index, target, { k = THRESHOLDS.neighbours, excludeId = null } = {}) {
  const scored = [];
  for (const entry of index.entries) {
    if (entry.typeId === null) continue;
    if (excludeId !== null && entry.id === String(excludeId)) continue;
    scored.push({ entry, ...similarity(target, entry) });
  }
  scored.sort((a, b) => b.combined - a.combined);
  return scored.slice(0, k);
}

/**
 * Turns neighbours into a prediction and a decision.
 *
 * Each neighbour in the running votes for its type, weighted by the square of
 * its similarity, so a close match counts far more than a middling one.
 * "In the running" means at least `relativeFloor` as close as the closest:
 * a page's five nearest neighbours always include something, and when only
 * two of them actually resemble it the other three are noise that would
 * otherwise turn a clear answer into a split vote.
 *
 * Confidence is the winning type's share of that vote: 1.0 when every
 * neighbour in the running agrees, lower the more they split.
 */
export function decide(neighbours) {
  if (neighbours.length === 0) {
    return { typeId: null, confidence: 0, nearest: 0, decision: 'unknown', votes: [] };
  }

  const closest = neighbours[0].combined;
  const floor = closest * THRESHOLDS.relativeFloor;

  const votes = new Map();
  for (const neighbour of neighbours) {
    if (neighbour.combined < floor) continue;
    const typeId = neighbour.entry.typeId;
    const vote = votes.get(typeId) ?? { typeId, score: 0, count: 0 };
    vote.score += neighbour.combined * neighbour.combined;
    vote.count += 1;
    votes.set(typeId, vote);
  }

  const ranked = [...votes.values()].sort((a, b) => b.score - a.score);
  const total = ranked.reduce((sum, vote) => sum + vote.score, 0);
  const top = ranked[0];
  const confidence = total > 0 ? top.score / total : 0;

  let decision = 'review';
  if (closest < THRESHOLDS.unknownSimilarity) decision = 'unknown';
  else if (confidence >= THRESHOLDS.autoConfidence && closest >= THRESHOLDS.autoSimilarity) decision = 'auto';

  return {
    typeId: decision === 'unknown' ? null : top.typeId,
    confidence: round(confidence),
    nearest: round(closest),
    decision,
    votes: ranked.map((vote) => ({ ...vote, score: round(vote.score) })),
  };
}

/**
 * Leave-one-out evaluation: every typed sample predicted from all the others.
 *
 * This is the pilot's measurement, and it costs no extra labelling — the
 * types people already assigned are the answer key. Above `sampleLimit`
 * targets the evaluation runs on a random subset, because it is quadratic and
 * a number that arrives is worth more than an exact one that does not.
 */
export function evaluateIndex(index, { sampleLimit = 1500, random = Math.random } = {}) {
  const typed = index.entries.filter((entry) => entry.typeId !== null);
  const targets = typed.length > sampleLimit ? shuffle(typed, random).slice(0, sampleLimit) : typed;

  const results = targets.map((target) => {
    const neighbours = nearest(index, target, { excludeId: target.id });
    const verdict = decide(neighbours);
    return {
      id: target.id,
      truth: target.typeId,
      predicted: verdict.typeId,
      confidence: verdict.confidence,
      nearest: verdict.nearest,
      decision: verdict.decision,
      correct: verdict.typeId === target.typeId,
      closest: neighbours[0] ? { id: neighbours[0].entry.id, similarity: round(neighbours[0].combined) } : null,
    };
  });

  return { typed: typed.length, evaluated: results.length, sampled: targets.length < typed.length, results };
}

/**
 * The automation curve: at each confidence threshold, how much would have
 * been decided without a person, and how much of that would have been right.
 *
 * "Precision at automation" is the number to negotiate with the customer. It is
 * never 100%, and this table is what replaces that word.
 */
export function automationCurve(results, thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
  const total = results.length;
  const rows = thresholds.map((threshold) => {
    const automated = results.filter((r) => r.decision !== 'unknown' && r.confidence >= threshold);
    const correct = automated.filter((r) => r.correct).length;
    return {
      threshold,
      automated: automated.length,
      correct,
      rate: total > 0 ? round(automated.length / total) : 0,
      precision: automated.length > 0 ? round(correct / automated.length) : null,
    };
  });

  // The rule as actually configured, so the table also answers "and what would
  // the system do today".
  const policy = results.filter((r) => r.decision === 'auto');
  const policyCorrect = policy.filter((r) => r.correct).length;
  rows.push({
    threshold: null,
    policy: true,
    automated: policy.length,
    correct: policyCorrect,
    rate: total > 0 ? round(policy.length / total) : 0,
    precision: policy.length > 0 ? round(policyCorrect / policy.length) : null,
  });

  return rows;
}

function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function round(value) {
  return Math.round(value * 1000) / 1000;
}
