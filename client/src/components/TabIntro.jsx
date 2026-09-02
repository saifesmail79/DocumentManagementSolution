/**
 * The one-line answer to "what is this screen for", shown on the screen itself.
 *
 * ─── Why this exists next to the help button ────────────────────────────────
 *
 * A help button answers the question only for someone who already suspects they
 * have one. Landing on a tab called "الأدوار" with a table and a form and no
 * sentence anywhere is the state this fixes: the description is on screen
 * unasked, and the button is there for the rest.
 *
 * ─── Why it reads from the help registry ────────────────────────────────────
 *
 * The text is the topic's own `summary`, not a second copy. Two descriptions of
 * one screen drift, and the one nobody edits is the one people read.
 */

import { BookOpen, ChevronLeft, HelpCircle } from 'lucide-react';

import { useHelp } from '../help/HelpContext.jsx';
import { HELP_TOPICS } from '../help/content.js';

/**
 * @param {object} props
 * @param {string} props.topic A key of `HELP_TOPICS`.
 */
export default function TabIntro({ topic }) {
  const { openHelp } = useHelp();
  const entry = HELP_TOPICS[topic];

  if (!entry) return null;

  const hasMore = Boolean(entry.sections?.length || entry.notes?.length);

  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="shrink-0 rounded-lg bg-primary/10 p-1.5">
        <HelpCircle size={15} className="text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{entry.title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{entry.summary}</p>
      </div>
      {/* Offered only when the panel actually holds more than this line, so the
          link never opens onto a repeat of what was just read. */}
      {hasMore ? (
        /*
          A button that looks like one. As a bare text link it read as part of
          the sentence beside it and was pressed accordingly — rarely. The pill
          gives it a shape, the icon says what kind of thing opens, and the
          chevron leans into the reading direction on hover: a small promise of
          motion from the control that is about to cause some.
        */
        <button
          type="button"
          onClick={openHelp}
          className="group flex shrink-0 items-center gap-1.5 self-center rounded-full
            border border-primary/25 bg-primary/5 py-1.5 ps-3 pe-2 text-xs font-medium
            text-primary shadow-sm transition-all duration-200
            hover:bg-primary hover:text-on-primary hover:shadow-md
            focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-1"
        >
          <BookOpen size={13} className="shrink-0" />
          الشرح الكامل
          {/* RTL: ChevronLeft points onward; the hover nudge travels the same way. */}
          <ChevronLeft
            size={13}
            className="shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5"
          />
        </button>
      ) : null}
    </div>
  );
}
