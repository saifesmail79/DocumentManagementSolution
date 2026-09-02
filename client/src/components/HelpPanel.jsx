/**
 * The page help: a button that is always in the same place, and the panel it opens.
 *
 * ─── Why one button in the header, not one per page ─────────────────────────
 *
 * Both give every screen a help button. Only this one cannot be forgotten: a
 * page added next year gets help without anybody remembering to wire it, and the
 * worst case is the route's own topic rather than no button at all. It also puts
 * help in a fixed place, which is the property that makes people look for it a
 * second time.
 *
 * What it explains comes from `useHelpTopic`, so a tab can claim the panel just
 * as a page does.
 *
 * ─── Why a side panel and not a modal ───────────────────────────────────────
 *
 * Help is read against the thing it describes. A centred modal covers exactly
 * that, and the guide's modal is built for forms you complete and dismiss. This
 * slides in beside the screen and leaves it visible.
 */

import { useEffect, useRef } from 'react';
import { HelpCircle, X } from 'lucide-react';

import { useHelp } from '../help/HelpContext.jsx';

/** The header control. Sits with the other session actions. */
export function HelpButton() {
  const { toggleHelp, open } = useHelp();

  return (
    <button
      type="button"
      onClick={toggleHelp}
      title="شرح هذه الصفحة (؟)"
      aria-label="شرح هذه الصفحة"
      aria-expanded={open}
      className={`rounded-lg border border-border bg-surface p-2 transition-colors
        hover:bg-primary/10 hover:text-primary
        ${open ? 'border-primary text-primary' : 'text-text-muted'}`}
    >
      <HelpCircle size={16} />
    </button>
  );
}

/** The panel itself. Rendered once, from the shell. */
export function HelpPanel() {
  const { open, topic, closeHelp } = useHelp();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // Where focus was before the panel took it, so it can be handed back.
  const restoreTo = useRef(null);

  /*
   * `closeHelp` behind a ref, for the reason the modal needs one too.
   *
   * It comes from a memoised context value, so its identity changes whenever
   * that memo recomputes — switching an administration tab does it. As a
   * dependency it would re-run the effect below, which ends by moving focus, and
   * quietly pull focus out of whatever the reader was using.
   */
  const closeHelpRef = useRef(closeHelp);
  useEffect(() => {
    closeHelpRef.current = closeHelp;
  });

  useEffect(() => {
    if (!open) return undefined;

    restoreTo.current = document.activeElement;

    /*
     * Escape closes, and Tab stays inside.
     *
     * The backdrop blocks the page, so this is modal in behaviour and says so
     * with `aria-modal` — which tells a screen reader the rest of the document
     * is inert. Letting Tab walk out into content the user has just been told
     * is not there is worse than not claiming it at all, so the claim is made
     * true here rather than dropped.
     */
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        closeHelpRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Focus moves in so the panel can be read and dismissed from the keyboard.
    closeRef.current?.focus();
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // Back to the help button, rather than dumping focus at the top of the
      // document and making the reader walk the whole header again.
      if (restoreTo.current?.isConnected) restoreTo.current.focus();
    };
    // Open and close only: any other dependency here re-steals focus.
  }, [open]);

  if (!open || !topic) return null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={topic.title}>
      {/* Dismisses on click, and dims the screen without hiding it — the panel
          is meant to be read against what it describes. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={closeHelp}
        className="flex-1 cursor-default bg-black/30"
      />

      {/* First in source order, so RTL puts the panel on the screen's left and
          the dimmed page stays on the right where the reader is. */}
      <aside
        ref={panelRef}
        className="flex h-full w-full max-w-md flex-col border-s border-border bg-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="shrink-0 rounded-lg bg-primary/10 p-2">
              <HelpCircle size={18} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-text">{topic.title}</h2>
              <p className="text-xs text-text-muted">شرح هذه الصفحة</p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={closeHelp}
            title="إغلاق"
            aria-label="إغلاق"
            className="shrink-0 rounded-lg p-2 text-text-muted transition-colors
              hover:bg-surface-muted hover:text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm leading-relaxed">
          <p className="text-text">{topic.summary}</p>

          {topic.sections?.map((section) => (
            <section key={section.heading}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
                {section.heading}
              </h3>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-2 text-text">
                    <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* Set apart because this is the part people come back for: the
              behaviour that is invisible until it surprises them. */}
          {topic.notes?.length ? (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
                انتبه إلى
              </h3>
              <ul className="space-y-2">
                {topic.notes.map((note) => (
                  <li
                    key={note}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-600"
                  >
                    {note}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
