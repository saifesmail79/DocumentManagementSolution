/**
 * Roles as an icon and a short name, with the long text behind a tooltip.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Everywhere a role appeared, it appeared as a sentence. The grant editor's
 * dropdown read «مُساهم — المُطّلِع، مع رفع الوثائق والإصدارات الجديدة.» per
 * option, and the roles table restated every description under every name.
 * Choosing between five sentences is the problem the permission columns had
 * before PermissionIcons turned them into a matrix — so roles get the same
 * treatment: a fixed icon per role, the short name beside it, and the
 * description shown only when the pointer or focus asks for it.
 *
 * The icon is keyed by the role's STORED name, which for the seeded roles is
 * the stable English identifier. A custom role carries no known meaning, so it
 * gets the key icon the roles tab itself uses.
 *
 * The tooltip is fixed-position for PermissionIcons' reason: these badges live
 * in table cells and dialogs whose ancestors clip absolutely-positioned
 * children, and `position: fixed` escapes without a portal. Scrolling clears
 * it, because a fixed bubble drifts away from an anchor that moves.
 */

import { useEffect, useState } from 'react';
import { Crown, Eye, KeyRound, PenLine, SlidersHorizontal, Upload, UserCog } from 'lucide-react';

import { VERBS } from './PermissionIcons.jsx';
import { roleDisplay } from '../help/content.js';

/** One icon per seeded role, chosen to echo the verb that defines it. */
const ROLE_ICONS = {
  Viewer: Eye,
  Contributor: Upload,
  Editor: PenLine,
  Manager: UserCog,
  Owner: Crown,
};

/** roleDisplay's names, plus the icon everything here renders with. */
export function roleVisual(role) {
  const display = roleDisplay(role);
  return { ...display, icon: (role.isSystem && ROLE_ICONS[role.name]) || KeyRound };
}

/** Anchored hover state shared by the badge and the picker. */
function useTip() {
  const [tip, setTip] = useState(null);

  useEffect(() => {
    if (!tip) return undefined;
    const clear = () => setTip(null);
    window.addEventListener('scroll', clear, true);
    return () => window.removeEventListener('scroll', clear, true);
  }, [tip]);

  const show = (event, content) => {
    const box = event.currentTarget.getBoundingClientRect();
    setTip({
      left: Math.min(Math.max(box.left + box.width / 2, 120), window.innerWidth - 120),
      top: box.top - 8,
      ...content,
    });
  };

  return { tip, show, hide: () => setTip(null) };
}

/**
 * The bubble itself: name, description, the verbs as a static icon row, and an
 * optional extra line. The verb row reuses VERBS so it cannot disagree with the
 * matrix drawn in the permission columns; it is deliberately inert — a tooltip
 * with its own tooltips would be a fairground.
 */
function Tip({ tip }) {
  if (!tip) return null;

  return (
    <span
      className="pointer-events-none fixed z-50 w-56 -translate-x-1/2 -translate-y-full
        rounded-lg border border-border bg-surface px-3 py-2 text-center shadow-md"
      style={{ left: tip.left, top: tip.top }}
    >
      <span className="block text-[11px] font-medium text-text">{tip.title}</span>
      {tip.description ? (
        <span className="mt-0.5 block text-[10px] leading-relaxed text-text-muted">
          {tip.description}
        </span>
      ) : null}
      {typeof tip.bits === 'number' ? (
        <span className="mt-1.5 flex items-center justify-center gap-1">
          {VERBS.map((verb) => {
            const granted = (tip.bits & verb.bit) !== 0;
            const Icon = verb.icon;
            return (
              <span
                key={verb.key}
                className={`flex h-5 w-5 items-center justify-center rounded ${
                  granted ? 'bg-primary/10 text-primary' : 'text-text-muted/30'
                }`}
              >
                <Icon size={11} />
              </span>
            );
          })}
        </span>
      ) : null}
      {tip.meta ? (
        <span dir="ltr" className="mt-1 block text-[10px] text-text-muted/70">
          {tip.meta}
        </span>
      ) : null}
      {tip.hint ? (
        <span className="mt-1 block border-t border-border/60 pt-1 text-[10px] leading-relaxed text-text-muted">
          {tip.hint}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A role, shown small: icon + short name, details on hover or focus.
 *
 * @param {object}  props
 * @param {object}  [props.role]    The full role; supplies icon, description and bits.
 * @param {string}  [props.name]    Fallback label when the role itself is not at hand.
 * @param {string}  [props.hint]    Extra tooltip line — e.g. what provenance means.
 * @param {'chip'|'row'} [props.variant] 'chip' is a bordered pill for inline use;
 *   'row' is an icon tile + medium name for a table's naming column.
 */
export function RoleBadge({ role, name, hint, variant = 'chip' }) {
  const { tip, show, hide } = useTip();

  const visual = role ? roleVisual(role) : { name, description: null, identifier: null, icon: KeyRound };
  const Icon = visual.icon;
  const content = {
    title: visual.name,
    description: visual.description,
    bits: role ? role.permissionBits : null,
    meta: visual.identifier,
    hint,
  };
  const informative = Boolean(content.description || typeof content.bits === 'number' || hint);

  return (
    <span className="relative inline-flex">
      <span
        tabIndex={informative ? 0 : -1}
        onMouseEnter={(event) => show(event, content)}
        onMouseLeave={hide}
        onFocus={(event) => show(event, content)}
        onBlur={hide}
        className={
          variant === 'row'
            ? 'inline-flex items-center gap-2 font-medium text-text'
            : 'inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted/40 px-2 py-0.5 text-[11px] text-text-muted'
        }
      >
        {variant === 'row' ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon size={14} />
          </span>
        ) : (
          <Icon size={11} />
        )}
        {visual.name}
      </span>
      <Tip tip={tip} />
    </span>
  );
}

/**
 * Choosing a role, as a row of chips instead of a dropdown of sentences.
 *
 * The first chip is «يدوياً»: no template, tick the verbs yourself. Selecting a
 * role chip reports the role so the caller can copy its bits onto the form —
 * the same copy-at-grant semantics the dropdown had, in a control that shows
 * every option at once and explains each on hover.
 *
 * @param {object}   props
 * @param {Array}    props.roles     From api.admin.roles().
 * @param {number|''} props.value    The selected roleId, or '' for manual.
 * @param {Function} props.onChange  (roleIdOrEmpty, roleOrNull)
 * @param {boolean}  [props.disabled]
 * @param {string}   [props.fallbackName] Label for a selected roleId that is not
 *   in `roles` — see the synthetic chip below.
 */
export function RolePicker({ roles, value, onChange, disabled, fallbackName }) {
  const { tip, show, hide } = useTip();

  const chips = [
    {
      key: '',
      title: 'يدوياً',
      icon: SlidersHorizontal,
      description: 'بدون قالب — حدّد الصلاحيات بنفسك من المربعات أدناه.',
      bits: null,
      role: null,
    },
    ...roles.map((role) => {
      const visual = roleVisual(role);
      return {
        key: String(role.roleId),
        title: visual.name,
        icon: visual.icon,
        description: visual.description,
        meta: visual.identifier,
        bits: role.permissionBits,
        role,
      };
    }),
  ];

  /*
   * A selection the list cannot show would otherwise look like no selection.
   *
   * The server clears role references when a role is deleted, so a value with
   * no matching chip normally cannot happen — but this panel can be holding an
   * access list read moments before another administrator deleted the role.
   * Without this chip the picker would draw the blank-slate state while saving
   * quietly kept the stale reference, and a control must never disagree with
   * what its save button will do.
   */
  const selectedKey = String(value ?? '');
  if (selectedKey && !chips.some((chip) => chip.key === selectedKey)) {
    chips.push({
      key: selectedKey,
      title: fallbackName || 'دور غير معروف',
      icon: KeyRound,
      description: 'هذا الدور لم يعد في القائمة. الصلاحيات المنسوخة منه تبقى كما هي.',
      bits: null,
      role: null,
    });
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => {
          const selected = String(value ?? '') === chip.key;
          const Icon = chip.icon;

          return (
            <button
              key={chip.key || 'manual'}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() =>
                // The synthetic chip has no role object, so clicking it changes
                // nothing but keeps the recorded reference — which is the point.
                onChange(chip.key === '' ? '' : Number(chip.key), chip.role)}
              onMouseEnter={(event) => show(event, chip)}
              onMouseLeave={hide}
              onFocus={(event) => show(event, chip)}
              onBlur={hide}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs
                transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40
                disabled:cursor-not-allowed disabled:opacity-50 ${
                  selected
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border text-text-muted hover:bg-surface-muted hover:text-text'
                }`}
            >
              <Icon size={13} />
              {chip.title}
            </button>
          );
        })}
      </div>
      <Tip tip={tip} />
    </div>
  );
}
