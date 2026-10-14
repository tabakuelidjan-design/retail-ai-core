// Probe service worker: caches ONLY the three probe files so the page reloads in airplane mode. It never caches /ping or /report. Separate origin from Nordla: no overlap.
const CACHE = 'nordla-phone-probe-v1';
const SHELL = ['/', '/probe.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !(SHELL.includes(u.pathname) || u.pathname === '/index.html')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(u.pathname === '/index.html' ? '/' : u.pathname, copy)); } return r; }).catch(() => caches.match(u.pathname === '/index.html' ? '/' : u.pathname)));
});
