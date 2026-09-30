/**
 * Who this person is to the «الوارد والصادر» area, asked once for the shell.
 *
 * ─── Why one provider rather than a request per screen ──────────────────────
 *
 * The area now shows on more than one surface: the home page decides whether to
 * draw the mail block at all, the header and breadcrumb say which area a screen
 * belongs to, the folder tree marks the letters folder, the folder page explains
 * it, and the mail screens draw one shared tab bar. Each asking the server on
 * its own would mean five requests that can disagree for a moment — a badge on
 * the home page that the tab bar does not show — so the answer lives here.
 *
 * ─── Failing closed ─────────────────────────────────────────────────────────
 *
 * A request that fails resolves to `{ enabled: false, failed: true }`: every
 * consumer then hides the mail area, which is the direction the menu has always
 * failed in, while the correspondence page can still tell a network hiccup from
 * a module that is switched off.
 *
 * ─── When it asks again ─────────────────────────────────────────────────────
 *
 * On first mount, and whenever the reader arrives at the menu or a mail screen —
 * the places where the waiting count and the list of screens are read. Moving
 * between folders or documents does not refetch. Screens that change the count
 * (receiving or finishing a letter) call `refresh()` themselves.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { api } from './api.js';

const MailContext = createContext(null);

/** True for the paths whose screens read the mail status. */
function readsMailStatus(pathname) {
  return pathname === '/' || pathname.startsWith('/correspondence') || pathname.startsWith('/forms');
}

export function MailProvider({ children }) {
  // null until the first answer, so a consumer can tell "not yet" from "no".
  const [status, setStatus] = useState(null);
  const [formsUsable, setFormsUsable] = useState(false);
  const { pathname } = useLocation();

  // Only the newest request may write: a slow answer from an earlier visit must
  // not overwrite a newer one.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    const [mail, forms] = await Promise.allSettled([
      api.correspondence.status(),
      api.forms.status(),
    ]);
    if (ticket !== latest.current) return;

    setStatus(mail.status === 'fulfilled' && mail.value ? mail.value : { enabled: false, failed: true });
    // A template this person can fill, in a module that is switched on. Failing
    // to answer means no «إنشاء كتاب», which is the safe direction: the entry
    // would open on an empty screen.
    setFormsUsable(
      forms.status === 'fulfilled'
        && forms.value?.enabled === true
        && Number(forms.value.templates) > 0,
    );
  }, []);

  // The key changes on arriving at a screen that reads the status, and stays
  // put while the reader moves around the archive.
  const key = readsMailStatus(pathname) ? pathname : 'elsewhere';

  useEffect(() => {
    refresh();
  }, [refresh, key]);

  return (
    <MailContext.Provider value={{ status, formsUsable, loaded: status !== null, refresh }}>
      {children}
    </MailContext.Provider>
  );
}

/**
 * `{ status, formsUsable, loaded, refresh }`.
 *
 * `status` is the correspondence status reply — `{ enabled, registrar, member,
 * units, queueCount, intakeFolderId }` — or null before the first answer.
 */
export function useMail() {
  const context = useContext(MailContext);
  if (!context) throw new Error('useMail must be used inside MailProvider');
  return context;
}
