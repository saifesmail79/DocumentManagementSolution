/**
 * The row action menu required by docs/UI_UX_AGENT_STANDARDS.md section 8.
 *
 * At rest it is a single ellipsis. On hover — or on focus, or on click — the
 * dots turn a quarter and the actions orbit out into a ring around them, run
 * one, and fold back. The guide forbids the alternative outright: a row of bare
 * icon buttons in every action cell, which is what this replaces.
 *
 * ─── Why the ring is positioned, not laid out ───────────────────────────────
 *
 * The obvious build — a row of buttons that grows — changes the width of the
 * actions column the moment a pointer crosses any row, and a table whose columns
 * resize under the cursor is worse than the anti-pattern being fixed. So the
 * component reserves exactly the collapsed footprint in the layout and the ring
 * floats over the row instead. Nothing moves but the menu.
 *
 * ─── Why there is no direction-specific code ────────────────────────────────
 *
 * A ring centred on its trigger is symmetric, so RTL and LTR are the same
 * picture and there is no branch to write. The guide's "RTL-aware: button row
 * direction reverses automatically" costs nothing here.
 *
 * ─── Hover alone is not an affordance ───────────────────────────────────────
 *
 * A menu that only opens on hover is unreachable by keyboard and unusable on a
 * touch screen, so the trigger is a real button: it toggles the menu open, moves
 * focus to the first action, closes on Escape or on a click elsewhere, and keeps
 * the actions out of the tab order while they are collapsed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Eye, Edit, Power, Trash2, Loader2 } from 'lucide-react';

/**
 * Centre-to-centre distance from the trigger to each action.
 *
 * Both are 32px across, so anything under 32 overlaps the trigger. 42 leaves a
 * 10px gap — enough to read as a ring rather than as a clump, and close enough
 * that the throw from the trigger to any action stays short.
 */
const RADIUS = 42;

/** The square the ring is drawn in: the orbit, plus half a disc at each edge. */
const RING_BOX = (RADIUS + 18) * 2;

/** Section 8's colour table, verbatim. */
const BUILT_IN = {
  view: {
    icon: Eye,
    title: 'عرض',
    bgClass: 'bg-primary/10',
    textClass: 'text-primary',
    hoverClass: 'hover:bg-primary/20',
  },
  edit: {
    icon: Edit,
    title: 'تعديل',
    bgClass: 'bg-emerald-500/10',
    textClass: 'text-emerald-600',
    hoverClass: 'hover:bg-emerald-500/20',
  },
  activate: {
    icon: Power,
    title: 'تفعيل',
    bgClass: 'bg-green-500/10',
    textClass: 'text-green-600',
    hoverClass: 'hover:bg-green-500/20',
  },
  deactivate: {
    icon: Power,
    title: 'تعطيل',
    bgClass: 'bg-amber-500/10',
    textClass: 'text-amber-600',
    hoverClass: 'hover:bg-amber-500/20',
  },
  delete: {
    icon: Trash2,
    title: 'حذف',
    bgClass: 'bg-red-500/10',
    textClass: 'text-red-600',
    hoverClass: 'hover:bg-red-500/20',
  },
};

/**
 * @param {object}   props
 * @param {Function} [props.onView]
 * @param {Function} [props.onEdit]
 * @param {Function} [props.onToggleActive]
 * @param {Function} [props.onDelete]
 * @param {boolean}  [props.isActive]   Which of activate/deactivate to offer.
 * @param {boolean}  [props.canDelete]  False disables delete with a reason in the tooltip.
 * @param {string}   [props.deleteHint] Tooltip shown when `canDelete` is false.
 * @param {Array}    [props.customActions] `{key, icon, onClick, show, title, href,
 *                                          bgClass, textClass, hoverClass, disabled}`
 * @param {string}   [props.label]      Accessible name for the trigger.
 */
export default function ExpandableActions({
  onView,
  onEdit,
  onToggleActive,
  onDelete,
  isActive = true,
  canDelete = true,
  deleteHint,
  customActions = [],
  label = 'إجراءات',
}) {
  const [expanded, setExpanded] = useState(false);
  // Opened deliberately (click or keyboard) rather than by a passing pointer.
  // A pinned menu ignores mouse-leave, which is what makes it usable on touch.
  const [pinned, setPinned] = useState(false);
  const [busyKey, setBusyKey] = useState(null);

  // Where the trigger's centre is on screen. The ring is positioned against the
  // viewport rather than against the row, so it needs a measurement.
  const [anchor, setAnchor] = useState(null);

  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const ringRef = useRef(null);
  const mounted = useRef(true);
  // Whether the pointer or focus is still here, read a frame after it was set.
  const wanted = useRef(false);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  /** Re-reads the trigger's position. Called on every open, since rows move. */
  const measure = useCallback(() => {
    const box = triggerRef.current?.getBoundingClientRect();
    if (box) setAnchor({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  }, []);

  const actions = useMemo(() => {
    const list = [];

    if (onView) list.push({ key: 'view', ...BUILT_IN.view, onClick: onView });
    if (onEdit) list.push({ key: 'edit', ...BUILT_IN.edit, onClick: onEdit });

    // Domain actions sit between the generic ones and the destructive one, so
    // delete is always last and never lands where a neighbour used to be.
    for (const action of customActions) {
      if (action && action.show !== false) list.push({ ...action, title: action.title ?? '' });
    }

    if (onToggleActive) {
      const variant = isActive ? BUILT_IN.deactivate : BUILT_IN.activate;
      list.push({ key: 'toggle-active', ...variant, onClick: onToggleActive });
    }

    if (onDelete) {
      list.push({
        key: 'delete',
        ...BUILT_IN.delete,
        onClick: onDelete,
        disabled: !canDelete,
        title: canDelete ? BUILT_IN.delete.title : (deleteHint ?? BUILT_IN.delete.title),
      });
    }

    return list;
  }, [onView, onEdit, onToggleActive, onDelete, isActive, canDelete, deleteHint, customActions]);

  const close = useCallback(() => {
    wanted.current = false;
    setPinned(false);
    setExpanded(false);
  }, []);

  // A pinned menu has to close on a click anywhere else, or two rows end up open.
  useEffect(() => {
    if (!pinned) return undefined;

    function onPointerDown(event) {
      if (!containerRef.current?.contains(event.target)) close();
    }

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [pinned, close]);

  /*
   * A viewport-positioned ring drifts the moment the row underneath it moves,
   * so scrolling or resizing dismisses it rather than leaving it orbiting a
   * different document. Capture phase, because the table has its own horizontal
   * scroller and a scroll event there does not bubble to the window.
   */
  useEffect(() => {
    if (!expanded) return undefined;

    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [expanded, close]);

  /**
   * Opens on hover or focus, after refreshing where the ring should be drawn.
   *
   * The very first time, the ring is not in the DOM at all — it renders only
   * once there is an anchor to place it against — so expanding in the same
   * breath would mount it already open and skip the unfolding entirely, and only
   * on the first hover of each row, which reads as a glitch rather than a style.
   * One frame to mount it stacked at the centre gives the transition something
   * to travel from.
   */
  function open() {
    wanted.current = true;
    measure();

    if (anchor) {
      setExpanded(true);
      return;
    }

    requestAnimationFrame(() => {
      // The pointer may well have moved on during that frame.
      if (mounted.current && wanted.current) setExpanded(true);
    });
  }

  function toggle() {
    if (pinned) {
      close();
      triggerRef.current?.focus();
      return;
    }

    open();
    setPinned(true);
    // After the ring has laid out; a button still stacked at the centre with no
    // size is one some browsers decline to focus.
    requestAnimationFrame(() => {
      ringRef.current?.querySelector('button:not([disabled]), a')?.focus();
    });
  }

  /**
   * Runs one action, and shows progress on it if it is asynchronous.
   *
   * Only the button that was pressed spins; every other button in the row is
   * disabled meanwhile, because a second action fired against a row that is
   * mid-delete is a request the server will answer confusingly at best.
   */
  async function run(action) {
    if (busyKey || action.disabled) return;

    const result = action.onClick?.();
    if (!result || typeof result.then !== 'function') {
      close();
      return;
    }

    setBusyKey(action.key);
    try {
      await result;
    } finally {
      // The row is commonly gone by now — a delete removes it — so the guard is
      // load-bearing, not defensive habit.
      if (mounted.current) {
        setBusyKey(null);
        close();
      }
    }
  }

  if (actions.length === 0) return null;

  /*
   * Tab-reachable only once the menu was opened deliberately.
   *
   * Tying this to `expanded` would mean that merely resting the pointer over a
   * row inserts four tab stops into the page, so where the mouse happens to sit
   * would decide where Tab goes next. Hover still shows and still clicks; the
   * keyboard route in is the trigger, which opens the menu and focuses it.
   */
  const reachable = pinned ? 0 : -1;

  return (
    <div
      ref={containerRef}
      // The reserved footprint: exactly one trigger. The ring floats over the row.
      className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center"
      onMouseEnter={open}
      onMouseLeave={() => {
        wanted.current = false;
        if (!pinned) setExpanded(false);
      }}
      onFocusCapture={open}
      onBlurCapture={(event) => {
        if (pinned || containerRef.current?.contains(event.relatedTarget)) return;
        wanted.current = false;
        setExpanded(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={expanded}
        aria-haspopup="true"
        onClick={toggle}
        // The quarter turn is what tells you the dots are a control and not an
        // ornament, and it lands the ellipsis vertically, pointing at the ring.
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full
          text-text-muted transition duration-200 hover:bg-surface-muted hover:text-primary
          focus:outline-none focus:ring-2 focus:ring-primary/40
          ${expanded ? 'rotate-90 text-primary' : ''}`}
      >
        <MoreHorizontal size={18} strokeWidth={2.2} />
      </button>

      {/*
        The ring of actions, orbiting the trigger.

        ─── Why it is fixed rather than absolute ─────────────────────────────
        The ring is wider and much taller than the row it belongs to, and the row
        sits inside `overflow-hidden` on the card and `overflow-x-auto` on the
        table — either of which slices it. On the last row more than half the
        circle falls below the card and simply vanishes. `position: fixed` is not
        clipped by an ancestor's overflow, so it escapes both without a portal,
        and staying in the tree is what keeps the hover and focus handlers above
        working across the whole ring.

        It costs a measurement, and a fixed box drifts away from a row that
        moves, which is why scrolling dismisses it.

        ─── Why z-50 ────────────────────────────────────────────────────────
        Top of this application's ladder — above the inline dropdowns and drag
        overlay at z-10 and the notification panel at z-30. With no background of
        its own, anything painting over it does not merely cover it, it shows
        through and reads as a rendering fault. Nothing above needs to win
        instead: opening any of those takes a click, which the outside-pointerdown
        handler answers by closing this.

        `fixed` and z-50 both rely on no ancestor having a transform, a filter or
        `will-change` — any of those would become the containing block and put
        the clipping and the stacking back.
      */}
      {anchor ? (
        <div
          ref={ringRef}
          aria-hidden={!expanded}
          style={{ left: anchor.x, top: anchor.y, width: RING_BOX, height: RING_BOX }}
          // Collapsed, it must not swallow clicks meant for the rows beneath it.
          className={`fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full
            ${expanded ? '' : 'pointer-events-none'}`}
          onClick={(event) => {
            // The empty middle of the ring dismisses, the way a popover backdrop does.
            if (event.target === event.currentTarget) close();
          }}
        >
          {actions.map((action, index) => {
            const Icon = busyKey === action.key ? Loader2 : action.icon;
            const disabled = action.disabled || (busyKey !== null && busyKey !== action.key);

            // Clockwise from twelve o'clock, evenly spaced. Two actions sit top
            // and bottom, four make a cross — the arrangement reads as a ring at
            // any count without a special case.
            const angle = (index / actions.length) * 2 * Math.PI - Math.PI / 2;
            const x = (Math.cos(angle) * RADIUS).toFixed(2);
            const y = (Math.sin(angle) * RADIUS).toFixed(2);

            const classes = `inline-flex h-8 w-8 items-center justify-center rounded-full
              transition duration-200 focus:outline-none focus:ring-2 focus:ring-primary/40
              disabled:cursor-not-allowed disabled:opacity-40
              ${action.bgClass ?? 'bg-primary/10'} ${action.textClass ?? 'text-primary'}
              ${disabled ? '' : `${action.hoverClass ?? 'hover:bg-primary/20'} hover:scale-110`}`;

            const icon = (
              <Icon
                size={16}
                strokeWidth={2.2}
                className={busyKey === action.key ? 'animate-spin' : undefined}
              />
            );

            return (
              <div
                key={action.key}
                /*
                  Two jobs, hence two elements.

                  Placement lives here so the button keeps its own transform for
                  the hover lift — one element cannot hold both — and so does the
                  opaque disc. The action colours the guide specifies are 10%
                  tints, which over a table row means the title and date beneath
                  read straight through a floating button. A solid `bg-surface`
                  behind each one leaves the specified colour exactly as it is
                  and makes it opaque, whatever `bgClass` a caller passes.

                  36px against the button's 32px: the hover lift scales it to
                  35.2px, so it still lands entirely on the disc.
                */
                style={{
                  transform: expanded
                    ? `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(1)`
                    : 'translate(-50%, -50%) scale(0.35)',
                  opacity: expanded ? 1 : 0,
                  // Staggered outward, so the ring unfolds instead of appearing.
                  transitionDelay: expanded ? `${index * 30}ms` : '0ms',
                }}
                className="absolute left-1/2 top-1/2 flex h-9 w-9 items-center justify-center
                  rounded-full bg-surface shadow-sm transition-[transform,opacity] duration-200 ease-out"
              >
                {/* An action that is really a download or an external open stays
                    an anchor: middle-click, "save link as" and the status bar all
                    depend on it being one, and a button reimplements none of them. */}
                {action.href ? (
                  <a
                    href={action.href}
                    target={action.target ?? '_blank'}
                    rel="noreferrer"
                    title={action.title}
                    aria-label={action.title}
                    tabIndex={reachable}
                    onClick={close}
                    className={classes}
                  >
                    {icon}
                  </a>
                ) : (
                  <button
                    type="button"
                    title={action.title}
                    aria-label={action.title}
                    disabled={disabled}
                    tabIndex={reachable}
                    onClick={() => run(action)}
                    className={classes}
                  >
                    {icon}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
