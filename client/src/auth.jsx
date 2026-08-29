/**
 * Session state.
 *
 * The session lives in an httpOnly cookie, so the client cannot inspect it — it
 * asks the server who it is on mount. That is one request at startup in exchange
 * for never having a token in JavaScript, which is the trade the whole auth
 * design is built on.
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, ApiError } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // `loading` starts true so nothing renders a login form before we know whether
  // there is already a session — otherwise a returning user sees a flash of the
  // login page on every refresh.
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.me();
      setUser(result.user);
      return result.user;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setUser(null);
        return null;
      }
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  const signIn = useCallback(async (username, password) => {
    const result = await api.login(username, password);
    setUser(result.user);
    return result.user;
  }, []);

  const signOut = useCallback(async () => {
    // Clear locally even if the request fails: leaving the UI signed in after
    // the user pressed logout is the worse failure.
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
