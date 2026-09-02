/**
 * Dialogs, per docs/UI_UX_AGENT_STANDARDS.md sections 10 and 22.
 *
 * ─── Why this replaced inline forms and window.confirm ──────────────────────
 *
 * Two habits had spread through the app, wrong in the same way.
 *
 * An edit form that unfolds inside the page pushes everything below it down, so
 * the row being edited moves the moment you start editing it — and on a long
 * table the form can open off-screen with nothing to say it opened at all.
 *
 * `window.confirm` and `window.prompt` are worse. The browser draws them in its
 * own chrome, left-to-right, in the OS language, titled with the origin —
 * "localhost:5175 says". An Arabic system asking to delete a role in a
 * Latin-aligned box titled by a hostname does not look like part of the
 * product, because it is not part of the product.
 *
 * ─── Rendered through a portal ──────────────────────────────────────────────
 *
 * Into `document.body`, so a dialog opened from inside a table cell is not
 * clipped by that table's overflow, and does not depend on where it sits in the
 * tree to stack above the page.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info, Loader2, Trash2, X } from 'lucide-react';

import { Button } from './ui.jsx';

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
};

/**
 * Escape closes, Tab stays inside, focus returns whence it came.
 *
 * `aria-modal` tells a screen reader the rest of the document is inert. Letting
 * Tab wander out into content the user has just been told is not there is worse
 * than never claiming it, so the claim is made true here.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]),'
  + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useModalBehaviour(open, panelRef, bodyRef, onClose) {
  const restoreTo = useRef(null);

  /*
   * `onClose` behind a ref, deliberately.
   *
   * Callers write `onClose={() => setDraft(null)}`, which is a new function on
   * every render. As a dependency it made this effect tear down and re-run on
   * every keystroke — and since the effect ends by focusing something, every
   * letter typed threw focus out of the field and onto the close button. The
   * handler has to stay current without being able to retrigger the effect, and
   * a ref is what does that.
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;

    restoreTo.current = document.activeElement;

    const focusable = () => panelRef.current?.querySelectorAll(FOCUSABLE) ?? [];

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (!items.length) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    /*
     * The first control in the BODY, and the panel itself when there is none.
     *
     * Not `items[0]`: the close button is in the header and therefore first in
     * document order, so that opened every dialog on its own dismiss control.
     *
     * And not the footer either, when the body has no field — a confirmation's
     * first footer button is the confirming one, so focusing it would arm a
     * destructive action to fire on Enter. Falling back to the panel gives a
     * screen reader the dialog to announce and leaves Escape working, without
     * putting anything irreversible one keystroke away.
     */
    const target = bodyRef.current?.querySelector(FOCUSABLE) ?? panelRef.current;
    target?.focus?.();

    window.addEventListener('keydown', onKeyDown, true);

    // The page behind must not scroll under an open dialog.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (restoreTo.current?.isConnected) restoreTo.current.focus();
    };
    // Runs on open and close only. Anything else here re-steals focus mid-typing.
  }, [open, panelRef, bodyRef]);
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {Function} props.onClose
 * @param {string} props.title
 * @param {string} [props.subtitle]
 * @param {Function} [props.icon] A lucide component.
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {'primary'|'danger'} [props.tone]
 * @param {React.ReactNode} [props.footer]
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon = Info,
  size = 'md',
  tone = 'primary',
  footer,
  children,
}) {
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  useModalBehaviour(open, panelRef, bodyRef, onClose);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        // Dismisses only when the press both starts and ends on the backdrop, so
        // a text selection that happens to finish outside the panel does not
        // throw away a half-filled form.
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        // Focusable programmatically only, for the fallback above.
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className={`flex max-h-[90vh] w-full ${SIZES[size]} flex-col rounded-xl border border-border
          bg-surface shadow-2xl`}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`shrink-0 rounded-lg p-2 ${tone === 'danger' ? 'bg-red-50' : 'bg-primary/10'}`}>
              <Icon size={20} className={tone === 'danger' ? 'text-red-600' : 'text-primary'} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-text">{title}</h2>
              {subtitle ? <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="إغلاق"
            aria-label="إغلاق"
            className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-muted
              hover:text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <X size={18} />
          </button>
        </header>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-5">
          {children}
        </div>

        {footer ? (
          // RTL flex-row: the confirming action is first in source order, so it
          // lands on the screen's right, where the reader's eye starts.
          <div className="flex shrink-0 flex-row items-center gap-2 border-t border-border p-5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// ── The dialog behind useDialogs() ───────────────────────────────────────

const VARIANTS = {
  danger: { icon: Trash2, tone: 'danger', confirm: 'danger' },
  warning: { icon: AlertTriangle, tone: 'primary', confirm: 'primary' },
  info: { icon: Info, tone: 'primary', confirm: 'primary' },
};

/**
 * Renders one pending confirm or prompt.
 *
 * Kept private to this module: callers reach it through `useDialogs`, and that
 * indirection is exactly what stops fourteen call sites growing fourteen
 * slightly different confirmation dialogs.
 */
export function RequestDialog({ request, onSettle }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seeded per request, because the provider reuses one dialog instance for
  // every question the app asks.
  useEffect(() => {
    setValue(request?.defaultValue ?? '');
    setBusy(false);
  }, [request]);

  if (!request) return null;

  const style = VARIANTS[request.variant ?? 'info'] ?? VARIANTS.info;
  const isPrompt = request.kind === 'prompt';
  const canSubmit = !isPrompt || !request.required || value.trim().length > 0;

  function settle(result) {
    if (busy) return;
    setBusy(true);
    onSettle(result);
  }

  return (
    <Modal
      open
      onClose={() => settle(isPrompt ? null : false)}
      title={request.title}
      subtitle={request.subtitle}
      icon={request.icon ?? style.icon}
      tone={style.tone}
      size="sm"
      footer={
        <>
          <Button
            variant={style.confirm}
            disabled={busy || !canSubmit}
            onClick={() => settle(isPrompt ? value.trim() : true)}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {request.confirmLabel ?? (isPrompt ? 'حفظ' : 'متابعة')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => settle(isPrompt ? null : false)}>
            {request.cancelLabel ?? 'إلغاء'}
          </Button>
        </>
      }
    >
      {request.message ? (
        <p className="whitespace-pre-line text-sm leading-relaxed text-text">{request.message}</p>
      ) : null}

      {isPrompt ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) settle(value.trim());
          }}
          className={request.message ? 'mt-3' : undefined}
        >
          <label className="block">
            {request.label ? (
              <span className="mb-1.5 block text-sm font-medium text-text">{request.label}</span>
            ) : null}
            <input
              dir={request.dir ?? 'rtl'}
              value={value}
              placeholder={request.placeholder}
              onChange={(event) => setValue(event.target.value)}
              className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          {request.hint ? <span className="mt-1 block text-xs text-text-muted">{request.hint}</span> : null}
        </form>
      ) : null}

      {/* The consequence, set apart from the question — this is the line that
          stops someone confirming a permanent deletion by reflex. */}
      {request.detail ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-600">
          {request.detail}
        </p>
      ) : null}
    </Modal>
  );
}
