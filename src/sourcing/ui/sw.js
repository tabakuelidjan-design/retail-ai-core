// Cache only the explicitly precached public shell. Private pages, tickets, documents and arbitrary URLs never enter this cache.
const CACHE = 'nordla-sourcing-terrain-v4-core-startup';
const PREFIX = 'nordla-sourcing-terrain-';
const publicAsset = (raw) => {const u=new URL(raw,self.location.origin);return u.origin===self.location.origin&&!u.search&&!u.hash&&!u.pathname.startsWith('/api/')&&!u.pathname.startsWith('/voice/')&&(u.pathname==='/'||/\.(js|css|svg|png|ico|webmanifest|woff2?)$/.test(u.pathname));};
self.addEventListener('install',e=>e.waitUntil((async()=>{const manifest=await(await fetch('/shell-manifest.json',{cache:'no-store'})).json();const paths=[...new Set(['/',...manifest.files.filter(publicAsset)])];const c=await caches.open(CACHE);await c.addAll(paths);await self.skipWaiting();})()));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||!publicAsset(u.href))return;
 e.respondWith((async()=>{const c=await caches.open(CACHE);const cached=await c.match(e.request);if(!cached)return fetch(e.request);let timer;try{const r=await Promise.race([fetch(e.request),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('slow')),3000);})]);if(r.ok&&!r.redirected&&!/private|no-store/i.test(r.headers.get('cache-control')??''))await c.put(e.request,r.clone());return r;}catch{return cached;}finally{clearTimeout(timer);}})());
});
