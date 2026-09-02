/** Display helpers. Arabic-Indic digits are deliberately NOT used — the target
 *  users read Western digits for reference numbers and amounts. */

const LOCALE = 'ar-IQ-u-ca-gregory-nu-latn';

/**
 * ICU's Arabic date patterns wrap the separators in U+200F RIGHT-TO-LEFT MARK:
 * `ar-IQ` formats 30 August 2026 as "30<RLM>/08<RLM>/2026", not "30/08/2026".
 *
 * Inside ordinary Arabic prose those marks are what keeps a date upright. Inside
 * `.num` — which already pins `direction: ltr` — they do the opposite: each mark
 * opens a right-to-left run, so the bidi algorithm reorders the fields and the
 * cell renders as "302026/08/". That was the bug, and the marks are redundant
 * here precisely because `.num` has already settled the direction, so they are
 * dropped rather than fought with.
 *
 * Tested by code point rather than matched by a character class, because every
 * character involved is invisible: a literal one in the source is unreviewable,
 * and tooling that normalises escapes turns an escaped one back into it.
 *
 * Covers LRM, ALM, RLM, the LRE…RLO embedding controls and the LRI…PDI isolates.
 */
function isBidiControl(codePoint) {
  return codePoint === 0x200e // LEFT-TO-RIGHT MARK
    || codePoint === 0x200f // RIGHT-TO-LEFT MARK
    || codePoint === 0x061c // ARABIC LETTER MARK
    || (codePoint >= 0x202a && codePoint <= 0x202e) // LRE, RLE, PDF, LRO, RLO
    || (codePoint >= 0x2066 && codePoint <= 0x2069); // LRI, RLI, FSI, PDI
}

/** Removes the direction controls only — digits and separators pass through. */
function stripBidiControls(text) {
  return [...text].filter((character) => !isBidiControl(character.codePointAt(0))).join('');
}

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  // h23 rather than the locale default: a 12-hour clock in Arabic appends ص/م,
  // a right-to-left word glued to an LTR number, which is the same fight again.
  hourCycle: 'h23',
});

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `30/08/2026`, or an em dash when there is nothing to show. */
export function formatDate(value) {
  const date = toDate(value);
  return date ? stripBidiControls(dateFormatter.format(date)) : '—';
}

/** `30/08/2026، 10:39` — for the tooltip, where the time matters but the column is narrow. */
export function formatDateTime(value) {
  const date = toDate(value);
  return date ? stripBidiControls(dateTimeFormatter.format(date)) : '—';
}

/**
 * How long something took, as a person would say it.
 *
 * Two units at most, largest first: "3 أيام و4 ساعات" rather than a count of
 * minutes nobody will divide in their head. Written for elapsed time on an
 * approval step, where the useful question is "is this stuck?" and the answer
 * lives in the leading unit.
 */
export function formatDuration(fromValue, toValue) {
  const from = toDate(fromValue);
  const to = toDate(toValue) ?? new Date();
  if (!from) return '—';

  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return 'أقل من دقيقة';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} دقيقة`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} ساعة و${rest} دقيقة` : `${hours} ساعة`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} يوم و${rest} ساعة` : `${days} يوم`;
}

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
