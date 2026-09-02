/**
 * Help for one control, next to that control.
 *
 * The page panel explains what a screen is for; this explains what a single
 * field does and what it will accept. They are separate on purpose — the ranges
 * a settings field enforces are useless in a panel you have to open, remember,
 * and close before typing, and they are the whole difference between choosing a
 * value and discovering "القيمة خارج النطاق المسموح" after saving.
 *
 * ─── Why the bubble is fixed ────────────────────────────────────────────────
 *
 * Its first home is a table cell inside `Card`'s `overflow-hidden`, which clips
 * an absolutely positioned bubble to the row it grew from — so the text would be
 * a sliver. `position: fixed` is not clipped by an ancestor's overflow, so it
 * escapes without a portal and stays a descendant, which is what keeps the
 * outside-click and focus handling straightforward.
 *
 * It costs a measurement and a flip when the anchor is near an edge, and a fixed
 * bubble drifts away from a control that moves, which is why scrolling closes it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';

/** Bubble width, and the margin kept from the viewport edge when clamping. */
const WIDTH = 288;
const EDGE = 12;

/**
 * @param {object} props
 * @param {string} props.text  What this control does. Plain sentences.
 * @param {string} [props.label] Accessible name; defaults to a generic one.
 */
export default function HelpTip({ text, label = 'شرح هذا الإعداد' }) {
  const [at, setAt] = useState(null);
  const containerRef = useRef(null);
  const buttonRef = useRef(null);

  const close = useCallback(() => setAt(null), []);

  function toggle() {
    if (at) {
      close();
      return;
    }

    const box = buttonRef.current?.getBoundingClientRect();
    if (!box) return;

    // Clamped to the viewport, then flipped above the control when there is no
    // room below it — a bubble that opens off-screen is the same as no bubble.
    const half = WIDTH / 2;
    const centre = box.left + box.width / 2;
    const left = Math.min(Math.max(centre - half, EDGE), window.innerWidth - WIDTH - EDGE);
    const below = window.innerHeight - box.bottom > 200;

    setAt({
      left,
      top: below ? box.bottom + 8 : undefined,
      bottom: below ? undefined : window.innerHeight - box.top + 8,
    });
  }

  useEffect(() => {
    if (!at) return undefined;

    function onPointerDown(event) {
      if (!containerRef.current?.contains(event.target)) close();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') close();
    }

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    // Capture phase: the settings table has its own scroller, and a scroll
    // there never reaches the window.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at, close]);

  if (!text) return null;

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        title={label}
        aria-label={label}
        aria-expanded={Boolean(at)}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full align-middle
          transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40
          ${at ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-primary/10 hover:text-primary'}`}
      >
        <HelpCircle size={14} />
      </button>

      {at ? (
        <div
          role="tooltip"
          style={{ left: at.left, top: at.top, bottom: at.bottom, width: WIDTH }}
          // z-50 matches the ceiling used elsewhere; it is opened by a click, so
          // it cannot be competing with another overlay the user is mid-way through.
          className="fixed z-50 rounded-xl border border-border bg-surface p-3 shadow-lg"
        >
          <div className="flex items-start gap-2">
            <p className="flex-1 text-xs leading-relaxed text-text">{text}</p>
            <button
              type="button"
              onClick={close}
              title="إغلاق"
              aria-label="إغلاق"
              className="shrink-0 rounded p-0.5 text-text-muted transition-colors
                hover:bg-surface-muted hover:text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
