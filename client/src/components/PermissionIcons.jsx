/**
 * Permission bits as a row of icons, in place of a comma-joined sentence.
 *
 * ─── Why icons, and why always all six ──────────────────────────────────────
 *
 * As text, every row was a different-length sentence — "استعراض، قراءة، رفع،
 * تعديل البيانات، حذف، إدارة الصلاحيات" at its longest — and comparing two
 * grants meant reading both and diffing them in your head. Icons in a fixed
 * order turn the column into a matrix: the same verb is always in the same
 * place, a granted one is lit and an absent one is a faint placeholder, so the
 * difference between two rows is visible before it is read.
 *
 * The faint placeholders are the point, not decoration. Showing only the
 * granted icons would bring back the original problem in smaller type — rows
 * of differing length with the reader left to work out what is missing.
 *
 * ─── The tooltip is fixed-position, like HelpTip and for HelpTip's reason ────
 *
 * These rows live in table cells inside `Card`'s `overflow-hidden`; an
 * absolutely-positioned bubble would clip to a sliver at the card's edge.
 * `position: fixed` escapes without a portal. Scrolling clears it, because a
 * fixed bubble drifts away from an icon that moves.
 */

import { useEffect, useState } from 'react';
import { BookOpen, Eye, PenLine, ShieldCheck, Trash2, Upload } from 'lucide-react';

/**
 * The six verbs, in grant order, with everything each render site needs.
 * Exported so the editing checkboxes and this display cannot disagree.
 */
export const VERBS = [
  { key: 'browse', bit: 1, label: 'استعراض', hint: 'رؤية المجلد وعناوين وثائقه', icon: Eye },
  { key: 'read', bit: 2, label: 'قراءة', hint: 'فتح الوثائق وتنزيلها', icon: BookOpen },
  { key: 'upload', bit: 4, label: 'رفع', hint: 'إضافة وثائق وإصدارات جديدة', icon: Upload },
  { key: 'editMeta', bit: 8, label: 'تعديل البيانات', hint: 'تغيير العناوين والحقول', icon: PenLine },
  { key: 'delete', bit: 16, label: 'حذف', hint: 'حذف الوثائق والمجلدات', icon: Trash2 },
  { key: 'managePerms', bit: 32, label: 'إدارة الصلاحيات', hint: 'تعديل هذه القائمة', icon: ShieldCheck },
];

/** The old sentence, kept for the places a sentence belongs: accessible names. */
export const bitsToLabels = (bits) =>
  VERBS.filter((verb) => (bits & verb.bit) !== 0)
    .map((verb) => verb.label)
    .join('، ') || '—';

/**
 * @param {object} props
 * @param {number} props.bits          The granted (or denied) mask.
 * @param {'allow'|'deny'} [props.tone]
 *   'allow' shows all six positions with the granted ones lit. 'deny' shows
 *   only the denied verbs, in red — denies are rare, and six placeholder
 *   positions for a list that is almost always empty would double every row's
 *   weight to say nothing.
 */
export default function PermissionIcons({ bits, tone = 'allow' }) {
  const [tip, setTip] = useState(null);

  // A fixed bubble over a scrolled-away icon points at nothing; close it.
  useEffect(() => {
    if (!tip) return undefined;
    const clear = () => setTip(null);
    window.addEventListener('scroll', clear, true);
    return () => window.removeEventListener('scroll', clear, true);
  }, [tip]);

  const shown = tone === 'deny' ? VERBS.filter((verb) => (bits & verb.bit) !== 0) : VERBS;
  if (shown.length === 0) return null;

  const show = (event, verb, granted) => {
    const box = event.currentTarget.getBoundingClientRect();
    setTip({
      left: Math.min(Math.max(box.left + box.width / 2, 90), window.innerWidth - 90),
      top: box.top - 8,
      title: tone === 'deny' ? `منع: ${verb.label}` : verb.label,
      hint: granted || tone === 'deny' ? verb.hint : 'غير ممنوحة',
      muted: !granted && tone !== 'deny',
    });
  };

  return (
    <span
      className="inline-flex items-center gap-1"
      role="img"
      aria-label={(tone === 'deny' ? 'منع: ' : 'الصلاحيات: ') + bitsToLabels(bits)}
    >
      {shown.map((verb) => {
        const granted = (bits & verb.bit) !== 0;
        const Icon = verb.icon;

        return (
          <span
            key={verb.key}
            aria-hidden="true"
            onMouseEnter={(event) => show(event, verb, granted)}
            onMouseLeave={() => setTip(null)}
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              tone === 'deny'
                ? 'bg-red-50 text-red-600'
                : granted
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-muted/30 hover:text-text-muted/60'
            }`}
          >
            <Icon size={13} />
          </span>
        );
      })}

      {tip ? (
        <span
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full
            whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1.5
            text-center shadow-md"
          style={{ left: tip.left, top: tip.top }}
        >
          <span className={`block text-[11px] font-medium ${tip.muted ? 'text-text-muted' : 'text-text'}`}>
            {tip.title}
          </span>
          <span className="block text-[10px] text-text-muted">{tip.hint}</span>
        </span>
      ) : null}
    </span>
  );
}
