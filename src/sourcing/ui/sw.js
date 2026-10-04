// Offline shell: on install the WHOLE app (page, script, style, every decision-engine module) is cached from /shell-manifest.json, so a case can be opened and worked with no
// connection even if the first visit loaded modules before this worker took control. /api is never cached: live data stays live (the phone keeps its own Safety Gate copy).
const CACHE = 'nordla-sourcing-v0-3';
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const manifest = await (await fetch('/shell-manifest.json', { cache: 'no-store' })).json();
    await c.addAll([...new Set(['/', ...manifest.files])]); // a duplicate URL in addAll() rejects the whole install
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/shell-manifest.json') return;
  // network first, but never wait more than 3 s (a slow connection is as good as none): then the cached copy
  e.respondWith((async () => {
    try {
      const r = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))]);
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    } catch { return (await caches.match(e.request, { ignoreSearch: true })) || (await caches.match('/')) || Response.error(); }
  })());
});
