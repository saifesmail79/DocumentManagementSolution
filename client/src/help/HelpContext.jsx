/**
 * Which help topic is on screen, and whether the panel is open.
 *
 * ─── Why the route is not enough ────────────────────────────────────────────
 *
 * `/admin` is nine different screens behind one path, and `/my` is four. Help
 * that could only key off the URL would have to describe all nine at once, which
 * is the kind of help nobody reads. So the route gives a default and any screen
 * can override it for as long as it is mounted.
 *
 * ─── Why a stack rather than a single value ─────────────────────────────────
 *
 * React mounts the incoming screen before it unmounts the outgoing one. With a
 * single slot the departing screen's cleanup runs last and clears the topic the
 * arriving one just set, leaving the button pointing at nothing. Keeping the
 * claims in a list and reading the newest survives that ordering, and a claim is
 * removed by identity, so it does not matter what else registered meanwhile.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { HELP_TOPICS, topicForPath } from './content.js';

const HelpContext = createContext(null);

export function HelpProvider({ children }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [claims, setClaims] = useState([]);

  // Closed on navigation: the panel describes a screen, and keeping it open
  // across a move leaves it describing the one you just left.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  /*
   * `?` opens the help, which is the convention people already try.
   *
   * Ignored while typing, or the key would be unusable in a search box — and
   * `?` is a shifted character, so the guard has to cover every field rather
   * than assume a modifier tells them apart.
   */
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;

      const focused = document.activeElement;
      const tag = focused?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || focused?.isContentEditable) return;

      event.preventDefault();
      setOpen((previous) => !previous);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const claim = useCallback((token, topicId) => {
    setClaims((current) => [...current, { token, topicId }]);
    return () => setClaims((current) => current.filter((entry) => entry.token !== token));
  }, []);

  const value = useMemo(() => {
    const claimed = claims.length ? claims[claims.length - 1].topicId : null;
    const topicId = claimed ?? topicForPath(location.pathname);

    return {
      open,
      topicId,
      // Falling back to the route's topic rather than to null: a typo in a
      // `useHelpTopic` call should degrade to the page's help, not to a blank panel.
      topic: HELP_TOPICS[topicId] ?? HELP_TOPICS[topicForPath(location.pathname)] ?? null,
      openHelp: () => setOpen(true),
      closeHelp: () => setOpen(false),
      toggleHelp: () => setOpen((previous) => !previous),
      claim,
    };
  }, [claims, location.pathname, open, claim]);

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp() {
  const context = useContext(HelpContext);
  if (!context) throw new Error('useHelp must be used inside HelpProvider');
  return context;
}

/**
 * Declares what this screen is, so the help button explains it rather than the
 * route it happens to live under. Call it from a tab as readily as from a page.
 *
 * @param {string} topicId A key of `HELP_TOPICS`.
 */
export function useHelpTopic(topicId) {
  const { claim } = useHelp();
  // A stable identity for this component instance, so its own claim is the one
  // released on unmount even when several are registered at once.
  const token = useRef({});

  useEffect(() => claim(token.current, topicId), [claim, topicId]);
}
