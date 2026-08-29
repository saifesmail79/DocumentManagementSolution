import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import './index.css';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';

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
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
