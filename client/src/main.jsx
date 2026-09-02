import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import './index.css';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';
import { DialogProvider } from './components/DialogProvider.jsx';

/**
 * Registers the service worker, which is what makes the app installable.
 *
 * Only in a production build: under Vite's dev server a worker intercepting
 * navigations serves a stale shell and hot reload stops working, which is a
 * confusing hour to spend.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installability is a convenience; the app works identically without it.
    });
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {/* Outermost so every screen — including the login and forced
            password-change screens, which render outside the shell — asks its
            questions in the product's own dialog rather than the browser's. */}
        <DialogProvider>
          <App />
        </DialogProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
