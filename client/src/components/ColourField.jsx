/**
 * Picking a colour, without having to know hex.
 *
 * ─── What this replaced ─────────────────────────────────────────────────────
 *
 * A bare text box with `#RRGGBB` for a placeholder. It told you the shape of the
 * answer and nothing else: no way to see a colour before saving it, no way to
 * choose one without already knowing its code, and the only feedback on a typo
 * was `invalid_colour` from the server after submitting.
 *
 * ─── Three ways in, one value out ───────────────────────────────────────────
 *
 * A palette for the common case, the browser's own picker for anything else,
 * and the hex field for someone matching a brand exactly. All three write the
 * same value, and the preview shows the swatch exactly as the list below will
 * draw it.
 *
 * The text field stays the source of truth rather than the native input,
 * because `<input type="color">` cannot represent "no colour" — it reports
 * black when empty — and here the colour is optional.
 */

import { Check, Pipette, X } from 'lucide-react';

/**
 * A severity ramp, cool through hot, plus a neutral.
 *
 * Chosen to stay distinguishable side by side and to carry the right suggestion
 * on a sensitivity label: green reads as unrestricted, red as the opposite. Each
 * is dark enough for white text, in case a future badge fills rather than dots.
 */
const PRESETS = [
  { hex: '#16A34A', name: 'أخضر' },
  { hex: '#0891B2', name: 'سماوي' },
  { hex: '#2563EB', name: 'أزرق' },
  { hex: '#7C3AED', name: 'بنفسجي' },
  { hex: '#CA8A04', name: 'ذهبي' },
  { hex: '#EA580C', name: 'برتقالي' },
  { hex: '#DC2626', name: 'أحمر' },
  { hex: '#475569', name: 'رمادي' },
];

/**
 * `#RRGGBB` in upper case, or null when the text is not a colour.
 *
 * Accepts a missing `#` and the three-digit shorthand, because both are what
 * people actually type. The server accepts neither, so normalising here is the
 * difference between a working entry and `invalid_colour`.
 */
export function normaliseHex(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const body = text.startsWith('#') ? text.slice(1) : text;
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;

  return /^[0-9a-fA-F]{6}$/.test(full) ? `#${full.toUpperCase()}` : null;
}

/**
 * @param {object} props
 * @param {string} props.value    Raw text, so a half-typed hex is not discarded.
 * @param {Function} props.onChange Called with the raw string.
 * @param {string} [props.label]
 * @param {string} [props.preview] Text to show beside the swatch in the preview.
 */
export default function ColourField({ value, onChange, label = 'اللون', preview }) {
  const hex = normaliseHex(value);
  const typed = String(value ?? '').trim();
  // Only complain once there is something that was clearly meant to be a colour.
  const invalid = typed.length > 0 && !hex;

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-text">{label}</span>

      <div className="flex items-center gap-2">
        {/*
          The browser's own picker, wearing the current colour.

          Wrapped in a label with the input visually hidden rather than styled
          directly: `input[type=color]` renders its own swatch with its own
          padding and border in every engine, and none of them can be made to
          match the rest of these controls.
        */}
        <label
          title="اختر لوناً"
          className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center
            rounded-lg border border-border transition-colors hover:border-border-strong"
          style={hex ? { backgroundColor: hex } : undefined}
        >
          {hex ? null : <Pipette size={14} className="text-text-muted" />}
          <input
            type="color"
            aria-label="اختر لوناً"
            value={hex ?? '#2563EB'}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>

        <input
          dir="ltr"
          value={value ?? ''}
          placeholder="#RRGGBB"
          onChange={(event) => onChange(event.target.value)}
          // Tidied on the way out, not while typing: rewriting the field under
          // the cursor moves it and makes a correction impossible to finish.
          onBlur={() => {
            const settled = normaliseHex(value);
            if (settled && settled !== value) onChange(settled);
          }}
          className={`w-32 rounded-lg border bg-control px-3 py-2 text-sm text-text
            placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40
            ${invalid ? 'border-red-300' : 'border-border'}`}
        />

        {typed ? (
          <button
            type="button"
            onClick={() => onChange('')}
            title="بلا لون"
            aria-label="إزالة اللون"
            className="shrink-0 rounded-lg border border-border p-2 text-text-muted
              transition-colors hover:bg-surface-muted hover:text-text"
          >
            <X size={14} />
          </button>
        ) : null}

        {/* Exactly the swatch-and-name the list draws, so what is chosen here is
            what will be seen there. */}
        {hex ? (
          <span className="flex min-w-0 items-center gap-2 ps-1">
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: hex }}
            />
            <span className="truncate text-sm text-text-muted">{preview || 'معاينة'}</span>
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => {
          const active = hex === preset.hex;

          return (
            <button
              key={preset.hex}
              type="button"
              onClick={() => onChange(preset.hex)}
              title={preset.name}
              aria-label={preset.name}
              aria-pressed={active}
              className={`flex h-6 w-6 items-center justify-center rounded-full transition
                hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary/40
                ${active ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: preset.hex }}
            >
              {active ? <Check size={12} className="text-white" /> : null}
            </button>
          );
        })}
      </div>

      <span className={`mt-1 block text-xs ${invalid ? 'text-red-600' : 'text-text-muted'}`}>
        {invalid ? 'صيغة غير صالحة — استخدم ‎#RRGGBB.' : 'اختياري. اتركه فارغاً لدرجة بلا لون.'}
      </span>
    </div>
  );
}
