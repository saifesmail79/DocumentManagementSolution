/**
 * A list of short values, entered as chips rather than as comma-separated text.
 *
 * ─── What this replaced ─────────────────────────────────────────────────────
 *
 * One text box holding `pdf, docx, tiff`. Everything about the format was
 * invisible: whether a dot belonged in front, whether spaces mattered, whether
 * case mattered, and whether the list was even parsed as a list. Removing one
 * entry from the middle meant editing around commas by hand, and a stray
 * trailing comma silently produced an empty entry.
 *
 * Chips make the parsed result the thing on screen — what you see is exactly
 * what the server will store — and the suggestions turn the common case into
 * clicking rather than recalling file extensions from memory.
 *
 * The value in and out stays a comma-joined string, because that is what the
 * settings row and the server already speak.
 */

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';

/** Splits the stored string, dropping the empties a stray comma leaves behind. */
function parse(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {object}   props
 * @param {string}   props.value       Comma-joined, as stored.
 * @param {Function} props.onChange    Called with the comma-joined string.
 * @param {string[]} [props.suggestions] Offered as one-click chips.
 * @param {Function} [props.normalise] Applied to anything typed or clicked.
 * @param {string}   [props.placeholder]
 * @param {string}   [props.emptyHint] Shown when the list is empty, where empty means something.
 */
export default function TagField({
  value,
  onChange,
  suggestions = [],
  normalise = (item) => item.trim().toLowerCase(),
  placeholder = 'أضف قيمة…',
  emptyHint,
}) {
  const [typed, setTyped] = useState('');
  const items = parse(value);

  /*
   * Everything this field has held, so removing a value offers it back.
   *
   * Without it, a value typed in by hand existed only while it was selected:
   * take it off and it vanished from the screen entirely, and putting it back
   * meant retyping it from memory — while the built-in suggestions, which
   * behave correctly, sat right underneath doing exactly what was wanted.
   *
   * Seeded from the value the field opened with, so extensions already saved
   * come back the same way. It lives for the life of the component: a value
   * added, removed and then saved is genuinely gone, and should be.
   */
  const [seen, setSeen] = useState(() => parse(value).map(normalise));

  useEffect(() => {
    // Learns from every source at once — typed, clicked, or re-seeded from the
    // server after a save — rather than only from the add path.
    setSeen((current) => {
      const merged = [...current];
      for (const item of parse(value).map(normalise)) {
        if (item && !merged.includes(item)) merged.push(item);
      }
      return merged.length === current.length ? current : merged;
    });
    // `normalise` is a prop but stable per call site; keying on it would rerun
    // this on every parent render for no gain.
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (list) => onChange(list.join(', '));

  function add(raw) {
    const clean = normalise(raw);
    // Silently ignored rather than rejected: a duplicate is a no-op, not a
    // mistake worth an error message.
    if (!clean || items.includes(clean)) {
      setTyped('');
      return;
    }
    commit([...items, clean]);
    setTyped('');
  }

  function onKeyDown(event) {
    // Comma and space are separators people type out of habit, so they commit
    // the entry rather than ending up inside it.
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
      event.preventDefault();
      add(typed);
      return;
    }
    // Backspace on an empty box removes the last chip, which is the behaviour
    // every other chip input has trained people to expect.
    if (event.key === 'Backspace' && typed === '' && items.length > 0) {
      event.preventDefault();
      commit(items.slice(0, -1));
    }
  }

  // The built-in suggestions keep their order, and anything this field has held
  // follows them, so the familiar list does not reshuffle as values are used.
  const offered = [...suggestions.map(normalise)];
  for (const item of seen) if (!offered.includes(item)) offered.push(item);

  const unused = offered.filter((item) => !items.includes(item));

  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-control p-1.5
          focus-within:ring-2 focus-within:ring-primary/40"
      >
        {items.map((item) => (
          <span
            key={item}
            dir="ltr"
            className="flex items-center gap-1 rounded-md bg-primary/10 py-0.5 pe-1 ps-2 text-xs text-primary"
          >
            {item}
            <button
              type="button"
              onClick={() => commit(items.filter((other) => other !== item))}
              title={`إزالة ${item}`}
              aria-label={`إزالة ${item}`}
              className="rounded p-0.5 transition-colors hover:bg-primary/20"
            >
              <X size={11} />
            </button>
          </span>
        ))}

        <input
          dir="ltr"
          value={typed}
          // Always shown, never only while the list is empty.
          //
          // Hiding it once a chip existed removed the only sign that the box
          // could be typed into at all: with three chips in place the field was
          // a blank gap with a cursor, and adding a value that was not among the
          // suggestions became a feature you had to already know about.
          placeholder={placeholder}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={onKeyDown}
          // Committed on the way out too, so a value typed and left behind is
          // not quietly dropped when the row loses focus.
          onBlur={() => add(typed)}
          className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-text
            placeholder:text-text-muted focus:outline-none"
        />

        {/* A button as well as the Enter key: a keyboard-only affordance is
            invisible, and on a touch screen there is no Enter key to press. */}
        {typed.trim() ? (
          <button
            type="button"
            // mousedown, not click: the input's onBlur fires first on a click and
            // would add the value, leaving this to add it a second time.
            onMouseDown={(event) => {
              event.preventDefault();
              add(typed);
            }}
            className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs
              text-on-primary transition-colors hover:bg-primary-dark"
          >
            <Plus size={11} />
            إضافة
          </button>
        ) : null}
      </div>

      <span className="mt-1 block text-[11px] text-text-muted">
        اكتب أي قيمة ثم اضغط Enter لإضافتها، أو اختر من المقترحات أدناه.
      </span>

      {items.length === 0 && emptyHint ? (
        <span className="mt-1 block text-[11px] text-amber-600">{emptyHint}</span>
      ) : null}

      {unused.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-text-muted">متاحة:</span>
          {unused.map((item) => (
            <button
              key={item}
              type="button"
              dir="ltr"
              onClick={() => add(item)}
              className="flex items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5
                text-[11px] text-text-muted transition-colors hover:border-primary hover:text-primary"
            >
              <Plus size={9} />
              {item}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
