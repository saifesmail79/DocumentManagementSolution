/**
 * Shared filing-tree state.
 *
 * The tree is fetched once and lives above the routes, so navigating between
 * folders does not refetch it and the panel does not flicker on every click.
 * Creating a folder or uploading calls reload() to bring it back in step.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const TreeContext = createContext(null);

export function TreeProvider({ children }) {
  const [state, setState] = useState({ folders: [], truncated: false, loading: true, error: null });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await api.tree();
      setState({ folders: data.folders, truncated: data.truncated, loading: false, error: null });
    } catch (error) {
      // Keep whatever was already loaded: a stale tree is more useful than an
      // empty panel while the user is in the middle of something.
      setState((current) => ({ ...current, loading: false, error }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return <TreeContext.Provider value={{ ...state, reload }}>{children}</TreeContext.Provider>;
}

export function useTree() {
  const context = useContext(TreeContext);
  if (!context) throw new Error('useTree must be used inside TreeProvider');
  return context;
}
