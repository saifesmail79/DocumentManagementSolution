/**
 * Header extraction: the number, date, subject and addressee of a page, read
 * from the words Tesseract placed on it.
 *
 * ─── The one place OCR text reaches a screen ────────────────────────────────
 *
 * The rule everywhere else is that recognised text feeds the search index and
 * is never shown as the document's contents, because ~85-93% accuracy read as
 * a transcription is a document the machine partly invented. This module is
 * the deliberate, bounded exception: it proposes four short values, each
 * carrying its own confidence and the anchor it was read next to, in a panel
 * whose whole purpose is that a person confirms or corrects them. Nothing here
 * writes a field. What is measured is how often the proposal was right.
 *
 * ─── Anchors, not positions ─────────────────────────────────────────────────
 *
 * Official Arabic correspondence labels its header: العدد, التاريخ, الموضوع,
 * إلى. The value is what follows the label on the same line, or — on a form
 * where label and value sit in separate boxes — the nearest text to the left
 * on the same row (reading direction), or the line beneath. Anchors survive a
 * letterhead moving or a scan being offset in a way fixed zones never would,
 * and they need no per-type template to be drawn first.
 *
 * ─── Validation is what makes a value trustworthy ───────────────────────────
 *
 * A ten-character number read at 90% per character is fully right well under
 * half the time. So a number must contain digits, a date must parse as a real
 * date in a plausible year, and Hijri dates are recognised but not converted.
 * A value that fails its check is kept — a person may still find it useful —
 * but marked unvalidated and halved in confidence.
 *
 * Pure: words in, fields out. Tested on synthetic word lists.
 */

import { normalizeArabic } from '../../lib/arabic.js';
import { HEADER_FRACTION, round } from './features.js';

export const ROLES = Object.freeze(['number', 'date', 'subject', 'addressee']);

/** A word's normalised text with punctuation removed — what anchors are matched against. */
const clean = (text) => normalizeArabic(text).replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The label phrases, in normalised form (so إلى is الي and المذكرة is المذكره).
 *
 * Order matters at a given position: the first phrase that matches wins, so
 * the two-word phrases sit above the one-word ones they contain — "رقم الكتاب"
 * is the document number, "رقم" alone might be a telephone.
 *
 *   lineStart  only counts at the start of a line. "إلى" appears constantly
 *              inside body text ("بالإشارة إلى كتابكم"); as the first word of a
 *              line it is the addressee.
 *   slash      the abbreviation "م/" for الموضوع. A bare "م" is not an anchor.
 */
const ANCHORS = [
  { role: 'number', words: ['رقم', 'الكتاب'] },
  { role: 'number', words: ['رقم', 'الصادر'] },
  { role: 'number', words: ['رقم', 'الوارد'] },
  { role: 'number', words: ['رقم', 'المذكره'] },
  { role: 'number', words: ['رقم', 'الاشاره'] },
  { role: 'number', words: ['رقم', 'المرجع'] },
  { role: 'number', words: ['العدد'] },
  { role: 'number', words: ['الرقم'] },
  { role: 'number', words: ['المرجع'] },
  { role: 'number', words: ['الاشاره'] },
  { role: 'number', words: ['رقم'] },
  { role: 'number', words: ['ref'] },
  { role: 'number', words: ['no'] },
  { role: 'number', words: ['number'] },
  { role: 'date', words: ['التاريخ'] },
  { role: 'date', words: ['تاريخ'] },
  { role: 'date', words: ['date'] },
  { role: 'subject', words: ['الموضوع'] },
  { role: 'subject', words: ['موضوع'] },
  { role: 'subject', words: ['م'], slash: true },
  { role: 'subject', words: ['subject'] },
  { role: 'addressee', words: ['الي'], lineStart: true },
  { role: 'addressee', words: ['السيد'], lineStart: true },
  { role: 'addressee', words: ['السيده'], lineStart: true },
  { role: 'addressee', words: ['الساده'], lineStart: true },
  { role: 'addressee', words: ['to'], lineStart: true },
];

/** Where an addressee ends: the honorific that follows the name. */
const HONORIFICS = new Set(
  ['المحترم', 'المحترمه', 'المحترمين', 'المحترمون', 'الموقر', 'الموقره', 'حفظه', 'حفظها', 'الله', 'المحترمان']
    .map(clean),
);

/** A word that ends in a colon is a label, wherever it sits on the line. */
const LABEL_COLON = /[:：]$/;

const NUMBER_PATTERN = /(?:\p{L}{1,3}\/)?[0-9]+(?:[/\-.][0-9]+)*/gu;
const NUMERIC_DATE = /(\d{1,4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,4})/;
const NAMED_DATE = /(\d{1,2})\s+(?:من\s+)?(?:شهر\s+)?(\p{L}+(?:\s+\p{L}+)?)\s+(?:سنه\s+|عام\s+|لعام\s+)?(\d{4})/u;

function normalizeKeys(months) {
  const map = new Map();
  for (const [name, month] of Object.entries(months)) map.set(normalizeArabic(name), month);
  return map;
}

/** Levantine and Iraqi names, Egyptian and Gulf names, and English. */
const GREGORIAN_MONTHS = normalizeKeys({
  'كانون الثاني': 1, 'شباط': 2, 'آذار': 3, 'نيسان': 4, 'أيار': 5, 'حزيران': 6,
  'تموز': 7, 'آب': 8, 'أيلول': 9, 'تشرين الأول': 10, 'تشرين الثاني': 11, 'كانون الأول': 12,
  'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'إبريل': 4, 'مايو': 5, 'يونيو': 6,
  'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

const HIJRI_MONTHS = normalizeKeys({
  'محرم': 1, 'صفر': 2, 'ربيع الأول': 3, 'ربيع الثاني': 4, 'ربيع الآخر': 4,
  'جمادى الأولى': 5, 'جمادى الأول': 5, 'جمادى الثانية': 6, 'جمادى الآخرة': 6,
  'رجب': 7, 'شعبان': 8, 'رمضان': 9, 'شوال': 10,
  'ذو القعدة': 11, 'ذي القعدة': 11, 'ذو الحجة': 12, 'ذي الحجة': 12,
});

// ── Parsers ──────────────────────────────────────────────────────────────

/**
 * The document number in a run of text: the longest digit run, with any
 * separators (١٢٣٤/٥/٧) and an optional short letter prefix (ص/1234).
 * Arabic-Indic digits arrive already converted by normalisation.
 */
export function parseNumber(text) {
  const normalized = normalizeArabic(text);
  let best = null;
  for (const match of normalized.matchAll(NUMBER_PATTERN)) {
    const value = match[0];
    if (!/[0-9]/.test(value)) continue;
    if (!best || value.length > best.length) best = value;
  }
  return best;
}

/**
 * A date in a run of text.
 *
 * Numeric forms (15/3/2026, 2026-03-15, ١٥/٣/١٤٤٧) and named-month forms
 * (15 آذار 2026, 15 شعبان 1447). The calendar is decided by a Hijri marker
 * (a trailing هـ), a Hijri month name, or the year's range — 1300–1500 is
 * Hijri, 1900–2100 is Gregorian, anything else is not a date this trusts.
 *
 * @returns {{valid: boolean, calendar: string, iso: string|null, hijri: string|null,
 *            year: number, month: number, day: number, raw: string} | null}
 */
export function parseDate(text) {
  const normalized = normalizeArabic(text);
  // The tatweel in هـ is stripped by normalisation, leaving a lone ه.
  const hijriMark = /(^|\s)ه($|\s)/.test(normalized);

  const numeric = normalized.match(NUMERIC_DATE);
  if (numeric) {
    const [raw, a, b, c] = numeric;
    let year;
    let month;
    let day;
    if (a.length === 4) {
      year = Number(a);
      month = Number(b);
      day = Number(c);
    } else {
      day = Number(a);
      month = Number(b);
      year = Number(c);
      if (c.length <= 2) year += 2000;
    }
    return finishDate({ year, month, day, raw, hijriMark });
  }

  const named = normalized.match(NAMED_DATE);
  if (named) {
    const [raw, dayText, name, yearText] = named;
    const first = name.split(' ')[0];
    let month = GREGORIAN_MONTHS.get(name) ?? GREGORIAN_MONTHS.get(first);
    let hijri = false;
    if (!month) {
      month = HIJRI_MONTHS.get(name) ?? HIJRI_MONTHS.get(first);
      hijri = Boolean(month);
    }
    if (!month) return null;
    return finishDate({ year: Number(yearText), month, day: Number(dayText), raw, hijriMark: hijriMark || hijri });
  }

  return null;
}

function finishDate({ year, month, day, raw, hijriMark }) {
  const inRange = month >= 1 && month <= 12 && day >= 1 && day <= 31;
  let calendar = 'unknown';
  if (inRange) {
    if (hijriMark || (year >= 1300 && year <= 1500)) calendar = 'hijri';
    else if (year >= 1900 && year <= 2100) calendar = 'gregorian';
  }

  const pad = (n) => String(n).padStart(2, '0');
  const text = `${year}-${pad(month)}-${pad(day)}`;

  // A Gregorian date must also exist: 31/02 is digits in the right places and
  // not a day anyone wrote.
  if (calendar === 'gregorian') {
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCDate() !== day || probe.getUTCMonth() !== month - 1) calendar = 'unknown';
  }

  return {
    valid: calendar !== 'unknown',
    calendar,
    iso: calendar === 'gregorian' ? text : null,
    hijri: calendar === 'hijri' ? text : null,
    year,
    month,
    day,
    raw,
  };
}

// ── Lines and anchors ────────────────────────────────────────────────────

function buildLines(words) {
  const groups = new Map();
  for (const word of words) {
    const key = `${word.block}/${word.par}/${word.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }

  const lines = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.word - b.word);
    const top = Math.min(...group.map((w) => w.top));
    const bottom = Math.max(...group.map((w) => w.top + w.height));
    const left = Math.min(...group.map((w) => w.left));
    const right = Math.max(...group.map((w) => w.left + w.width));
    lines.push({
      key,
      words: group.map((w) => ({ ...w, clean: clean(w.text), normalized: normalizeArabic(w.text) })),
      top,
      bottom,
      left,
      right,
      height: Math.max(1, bottom - top),
      anchors: [],
    });
  }

  // Top to bottom, then right to left: reading order for an Arabic page.
  lines.sort((a, b) => a.top - b.top || b.right - a.right);
  for (const line of lines) line.anchors = findAnchors(line);
  return lines;
}

function findAnchors(line) {
  const hits = [];
  const words = line.words;

  for (let i = 0; i < words.length; i += 1) {
    for (const anchor of ANCHORS) {
      // A trailing colon makes a word a label wherever it sits: a memo's
      // "من: قسم التدقيق إلى: قسم الحسابات" arrives as one line, and its "إلى:"
      // is the addressee even though it is not the first word.
      if (anchor.lineStart && i !== 0 && !LABEL_COLON.test(words[i].normalized)) continue;
      if (i + anchor.words.length > words.length) continue;

      let matches = true;
      for (let j = 0; j < anchor.words.length; j += 1) {
        if (words[i + j].clean !== anchor.words[j]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;

      if (anchor.slash) {
        const own = words[i].normalized.includes('/');
        const next = words[i + 1]?.normalized.startsWith('/');
        if (!own && !next) continue;
      }

      hits.push({
        role: anchor.role,
        start: i,
        end: i + anchor.words.length,
        specificity: anchor.words.length,
        anchorText: words.slice(i, i + anchor.words.length).map((w) => w.text).join(' '),
      });
      break;
    }
  }

  return hits;
}

const startsWithAnchor = (line) => line.anchors.some((hit) => hit.start === 0);
const overlapsX = (a, b) => a.left < b.right && b.left < a.right;
const centreY = (line) => (line.top + line.bottom) / 2;

/**
 * The value box on the same row, to the left of the label (reading direction).
 *
 * Forms put "العدد" in one ruled cell and the number in the next, which
 * Tesseract sees as two lines in two blocks. The nearest line on the same row
 * that is not itself a label is the value.
 */
function rowValue(lines, line, anchorWord, page) {
  const cy = centreY(line);
  const candidates = lines.filter(
    (other) =>
      other !== line
      && !startsWithAnchor(other)
      && Math.abs(centreY(other) - cy) <= line.height * 0.6
      && other.right <= anchorWord.left + anchorWord.width * 0.25
      && anchorWord.left - other.right <= page.width * 0.5,
  );
  candidates.sort((a, b) => b.right - a.right);
  return candidates[0]?.words.filter((w) => w.clean !== '') ?? [];
}

/**
 * The line(s) directly beneath a label whose own line holds nothing after it.
 * Continues onto a following line only while the gap stays small and the line
 * carries no label of its own — a subject may wrap; a body paragraph begins
 * after a visible gap.
 */
function belowValue(lines, line, { maxLines = 1 } = {}) {
  const below = lines
    .filter(
      (other) =>
        other !== line
        && !startsWithAnchor(other)
        && other.top >= line.bottom - line.height * 0.3
        && other.top <= line.bottom + line.height * 2.5
        && overlapsX(other, line),
    )
    .sort((a, b) => a.top - b.top);

  const taken = [];
  let previous = null;
  for (const candidate of below) {
    if (taken.length >= maxLines) break;
    if (previous && candidate.top > previous.bottom + previous.height * 1.6) break;
    if (previous && candidate.anchors.length > 0) break;
    taken.push(candidate);
    previous = candidate;
  }

  return taken.flatMap((l) => l.words.filter((w) => w.clean !== ''));
}

const trimPunctuation = (text) => text.replace(/^[\s:،,.\-–—/]+|[\s:،,.\-–—/]+$/g, '');

function interpret(hit, valueWords, source, line, page) {
  const raw = trimPunctuation(valueWords.map((w) => w.text).join(' '));
  if (!raw) return null;

  const confidences = valueWords.map((w) => Math.max(0, Number(w.conf) || 0));
  const confidence = round(confidences.reduce((sum, c) => sum + c, 0) / confidences.length / 100);

  const base = {
    role: hit.role,
    anchor: hit.anchorText,
    source,
    raw,
    confidence,
    inHeader: line.top < (page.height || Infinity) * HEADER_FRACTION,
    specificity: hit.specificity,
    top: line.top,
  };

  switch (hit.role) {
    case 'number': {
      const value = parseNumber(raw);
      if (!value) return null;
      return { ...base, value, validated: true };
    }
    case 'date': {
      const parsed = parseDate(raw);
      if (!parsed) return { ...base, value: raw, validated: false, calendar: 'unknown', confidence: round(confidence * 0.5) };
      return {
        ...base,
        value: parsed.iso ?? parsed.hijri ?? raw,
        validated: parsed.valid,
        calendar: parsed.calendar,
        iso: parsed.iso,
        hijri: parsed.hijri,
        confidence: parsed.valid ? confidence : round(confidence * 0.5),
      };
    }
    case 'subject': {
      const value = raw.slice(0, 300);
      return { ...base, value, validated: value.length >= 3 };
    }
    case 'addressee': {
      const kept = [];
      for (const word of valueWords) {
        if (HONORIFICS.has(word.clean)) break;
        kept.push(word);
      }
      const value = trimPunctuation(kept.map((w) => w.text).join(' ')).slice(0, 200);
      if (!value) return null;
      return { ...base, value, validated: value.length >= 3 };
    }
    default:
      return null;
  }
}

/**
 * Reads the four header fields from a page's words.
 *
 * When a label appears more than once, the validated one wins, then the one
 * in the header band, then the more specific label, then the higher one.
 *
 * @param {import('./features.js').Word[]} words
 * @param {{width: number, height: number}} page
 * @returns {Record<'number'|'date'|'subject'|'addressee', object|null>}
 */
export function extractFields(words, page) {
  const lines = buildLines(words ?? []);
  const dimensions = {
    width: page?.width || Math.max(0, ...lines.map((l) => l.right)),
    height: page?.height || Math.max(0, ...lines.map((l) => l.bottom)),
  };

  const candidates = Object.fromEntries(ROLES.map((role) => [role, []]));

  for (const line of lines) {
    line.anchors.forEach((hit, index) => {
      const nextStart = line.anchors[index + 1]?.start ?? line.words.length;
      let valueWords = line.words.slice(hit.end, nextStart).filter((w) => w.clean !== '');
      let source = 'line';

      if (valueWords.length === 0) {
        valueWords = rowValue(lines, line, line.words[hit.start], dimensions);
        source = 'row';
      }
      if (valueWords.length === 0) {
        valueWords = belowValue(lines, line, { maxLines: hit.role === 'subject' ? 2 : 1 });
        source = 'below';
      }
      if (valueWords.length === 0) return;

      const candidate = interpret(hit, valueWords, source, line, dimensions);
      if (candidate) candidates[hit.role].push(candidate);
    });
  }

  const result = {};
  for (const role of ROLES) {
    const ranked = candidates[role].sort(
      (a, b) =>
        Number(b.validated) - Number(a.validated)
        || Number(b.inHeader) - Number(a.inHeader)
        || b.specificity - a.specificity
        || a.top - b.top,
    );
    const best = ranked[0];
    if (!best) {
      result[role] = null;
      continue;
    }
    const { specificity, top, role: _role, ...kept } = best;
    result[role] = kept;
  }
  return result;
}
