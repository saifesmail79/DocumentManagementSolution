/**
 * Service worker.
 *
 * ─── What it deliberately does NOT cache ────────────────────────────────────
 *
 * Nothing under /api, and no document content. This is a permissioned document
 * system on machines that are frequently shared: a cached response served to
 * whoever opens the browser next is a permission bypass that no amount of
 * server-side ACL work can catch, because the request never reaches the server.
 *
 * So the cache holds the application shell only — the hashed JS, CSS and icons
 * that Vite emits, which are identical for every user and immutable by
 * filename. That is enough for installability and a fast repeat load, and it
 * cannot leak anything.
 *
 * ─── Why cache at all, then ─────────────────────────────────────────────────
 *
 * An installable app that shows a browser error page when the network hiccups
 * is worse than a bookmark. Caching the shell means the app opens and can say
 * "no connection" in its own voice.
 */

const VERSION = 'dms-shell-v1';

/** Only these are ever stored. Everything else goes to the network, every time. */
const CACHEABLE = /^\/(assets\/|icon-\d+\.png$|manifest\.webmanifest$)/;

self.addEventListener('install', (event) => {
  // The shell is cached lazily on first fetch rather than pre-listed: Vite's
  // filenames are content-hashed at build time and a hardcoded list would go
  // stale on every deploy.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions so a deploy cannot leave a mixed shell.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ordinary GETs, and only from this origin. A cross-origin request — the
  // Scan Bridge on loopback, for instance — is none of this worker's business.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The hard rule. Never touch the API or document content.
  if (url.pathname.startsWith('/api/')) return;

  if (CACHEABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Navigations fall back to the cached shell when offline, so the app itself
  // renders and reports the problem rather than the browser's error page.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Only opaque-free, successful responses are worth storing.
  if (response.ok && response.type === 'basic') cache.put(request, response.clone());
  return response;
}

async function networkFirstShell(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put('/', response.clone());
    return response;
  } catch (error) {
    const shell = await cache.match('/');
    if (shell) return shell;
    throw error;
  }
}
