// Only the precached public Stock/Achats shell is available offline; no document, API response or ticket is cached.
const VERSION='nordla-achats-shell-v7-security';
const PREFIX='nordla-achats-shell-';
const BASE=new URL('./',self.location).pathname;
const SHELL=[BASE,BASE+'app.js',BASE+'app.css',BASE+'manifest.webmanifest',BASE+'icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith(PREFIX)&&k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.search||u.hash||!SHELL.includes(u.pathname))return;
 e.respondWith((async()=>{const c=await caches.open(VERSION);try{const r=await fetch(e.request);if(r.ok&&!r.redirected&&!/private|no-store/i.test(r.headers.get('cache-control')??''))await c.put(e.request,r.clone());return r;}catch{return(await c.match(e.request))??Response.error();}})());
});
