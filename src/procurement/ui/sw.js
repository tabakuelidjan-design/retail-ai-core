// Service worker: keeps the SCREENS (the app shell) so the app opens even with a bad connection. It caches nothing from /api: data always comes from the server,
// and the app itself keeps a send queue for what the phone captured while the connection was down. Bump VERSION when a shell file changes.
const VERSION = 'nordla-achats-shell-v2';
const BASE = new URL('./', self.location).pathname; // '/' on the standalone server, '/procurement/' when mounted on the Nordla server
const SHELL = [BASE, `${BASE}app.js`, `${BASE}app.css`, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // data is never served from the cache
  // network first (so an updated shell is picked up), cache as the fallback when the network fails
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? caches.match(BASE))));
});
