/**
 * `confirm()` and `prompt()` as promises, drawn in the product's own chrome.
 *
 * ─── Why a provider rather than a dialog per caller ─────────────────────────
 *
 * Fourteen call sites used `window.confirm` or `window.prompt`. Giving each one
 * its own state and its own `<ConfirmDialog>` would have been fourteen chances
 * to word the buttons differently, forget the destructive styling, or leave the
 * dialog mounted after the row it referred to had gone.
 *
 * Awaiting a promise keeps the replacement a single line at each site:
 *
 *     if (!window.confirm(`حذف ${name}؟`)) return;          // before
 *     if (!(await confirm({ title: 'حذف الدور', ... }))) return;   // after
 *
 * so the control flow the original code was written around survives intact, and
 * every question in the app is the same dialog.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { RequestDialog } from './Modal.jsx';

const DialogContext = createContext(null);

export function DialogProvider({ children }) {
  const [request, setRequest] = useState(null);
  // The resolver for the question currently on screen.
  const pending = useRef(null);

  const ask = useCallback(
    (options) =>
      new Promise((resolve) => {
        // A second question while one is open would strand the first caller
        // awaiting a promise that can never settle. Answering it as a
        // cancellation keeps that path finite.
        pending.current?.(options.kind === 'prompt' ? null : false);
        pending.current = resolve;
        setRequest(options);
      }),
    [],
  );

  const settle = useCallback((result) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(result);
  }, []);

  const value = useMemo(
    () => ({
      /**
       * @param {object} options title, message, detail, variant
       *   ('danger' | 'warning' | 'info'), confirmLabel, cancelLabel
       * @returns {Promise<boolean>}
       */
      confirm: (options) => ask({ ...options, kind: 'confirm' }),

      /**
       * @param {object} options title, message, label, placeholder, defaultValue,
       *   hint, required, dir
       * @returns {Promise<string|null>} null when dismissed. A required prompt
       *   cannot resolve to an empty string, so callers need only the null check.
       */
      prompt: (options) => ask({ ...options, kind: 'prompt' }),
    }),
    [ask],
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      <RequestDialog request={request} onSettle={settle} />
    </DialogContext.Provider>
  );
}

export function useDialogs() {
  const context = useContext(DialogContext);
  if (!context) throw new Error('useDialogs must be used inside DialogProvider');
  return context;
}
