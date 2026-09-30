/**
 * The one tab bar of the «الوارد والصادر» area.
 *
 * ─── Why the bar is shared rather than per page ──────────────────────────────
 *
 * The area is two routes — /correspondence with its screens and /forms — and
 * each drew its own header. So «إنشاء كتاب» was reachable only from the tile
 * menu: a clerk who had just registered an incoming letter and now had to issue
 * a reply had to go back home to find the screen for it, and nothing on either
 * page said the two belonged to the same job. One bar over both makes the area
 * a place you are in rather than two pages you arrive at.
 *
 * ─── Buttons here, links there ──────────────────────────────────────────────
 *
 * An entry that stays on this page switches a tab, so it is a button: the page
 * owns the tab state and a navigation would throw the component tree away to
 * rebuild the same screen. An entry that leaves for the other route is a real
 * <Link>, so the browser's own gestures — middle click, ctrl-click, "open in
 * new tab" — work, which is how a person keeps the register open beside the
 * letter they are writing.
 *
 * ─── What it does not decide ────────────────────────────────────────────────
 *
 * Which entry is current, and which screen is drawn. Both belong to the page:
 * it reads the URL, falls back when the requested tab is not the reader's, and
 * tells this bar the answer. A bar that decided for itself would be a second
 * copy of that rule, which is the bug `mailActions` exists to prevent.
 */

import { Link, useLocation } from 'react-router-dom';

import { CORRESPONDENCE_TABS, MODULES, mailActions } from '../navigation.js';
import { useMail } from '../MailContext.jsx';

/**
 * The screen being read, as a bar entry, for when the viewer's own list does
 * not hold it — «إنشاء كتاب» opened by someone with no usable template, whose
 * page then explains that. A bar that leaves out the screen it sits on marks
 * nothing as current and reads as if the reader were somewhere else.
 */
function currentScreen(active) {
  const forms = MODULES.find((module) => module.key === 'forms');
  if (active === forms.key) {
    return { key: forms.key, label: forms.label, icon: forms.icon, to: forms.to };
  }
  const tab = CORRESPONDENCE_TABS.find((entry) => entry.key === active);
  return tab ? { key: tab.key, label: tab.label, icon: tab.icon, to: `/correspondence?tab=${tab.key}` } : null;
}

export default function MailAreaNav({ active, onSelect }) {
  const { status, formsUsable } = useMail();
  const { pathname } = useLocation();

  const actions = mailActions(status, formsUsable);
  if (active && !actions.some((action) => action.key === active)) {
    const current = currentScreen(active);
    if (current) actions.push(current);
  }

  /*
   * One entry is not a choice, it is a label — and the heading underneath
   * already says it. Drawing a single-tab bar over «إنشاء كتاب» would suggest
   * there is somewhere else to go when there is not.
   */
  if (actions.length < 2) return null;

  const waiting = Number(status?.queueCount) || 0;

  return (
    <div className="flex flex-row flex-wrap gap-1 border-b border-border">
      {actions.map((action) => {
        const classes = `flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors ${
          active === action.key
            ? 'border-primary font-medium text-primary'
            : 'border-transparent text-text-muted hover:text-text'
        }`;

        // The badge rides on «الوارد إليّ» only: it counts what is waiting in
        // that one screen, and the same number is on the tile menu.
        const badge = action.key === 'queue' && waiting > 0 ? (
          <span
            className="num flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600
              px-1 text-[11px] font-bold text-white"
            aria-label={`${waiting} بانتظارك`}
          >
            {waiting > 99 ? '99+' : waiting}
          </span>
        ) : null;

        const body = (
          <>
            <action.icon size={15} />
            {action.label}
            {badge}
          </>
        );

        // `to` carries the query («/correspondence?tab=register»); the route is
        // what decides whether this entry is a tab of the page being read.
        const [route] = action.to.split('?');

        return route === pathname ? (
          <button
            key={action.key}
            onClick={() => onSelect?.(action.key)}
            aria-current={active === action.key ? 'page' : undefined}
            className={classes}
          >
            {body}
          </button>
        ) : (
          <Link
            key={action.key}
            to={action.to}
            aria-current={active === action.key ? 'page' : undefined}
            className={classes}
          >
            {body}
          </Link>
        );
      })}
    </div>
  );
}
