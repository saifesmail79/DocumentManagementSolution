/** Display helpers. Arabic-Indic digits are deliberately NOT used — the target
 *  users read Western digits for reference numbers and amounts. */

const dateFormatter = new Intl.DateTimeFormat('ar-IQ-u-ca-gregory-nu-latn', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
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
