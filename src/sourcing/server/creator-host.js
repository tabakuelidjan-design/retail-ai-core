// The Creator screen on the hosted Nordla server (staging), behind the SAME Nordla session as everything else: no second sign-in, no second cookie.
//
// ISOLATION. This file is the only place the sourcing server knows the Creator. It is built only when NORDLA_CREATOR_MODULE=1 (see server/index.js); without it no route
// below exists. It touches nothing else: the Creator page lives at /creator, its files at /creator-assets/*, its API at /api/creator/*. A failure here answers 5xx on those
// paths only; sourcing, procurement, the Core panel and the checkout of nothing else depend on it.
//
// RIGHTS. Every /api/creator/* call goes through the session gate (cookie + CSRF for any change) and createHostedCreator, which refuses a session of another merchant
// (TENANT_MISMATCH), refuses changes to read-only roles, and gives each person their own creations. The produced files are read only from this merchant's own folder.
// EXECUTION. The Creator asks a hub for the visual; on this server the hub is the archived-run replay (creator/staging-world.js): no provider, no paid call.
import { readFile } from 'node:fs/promises';
import { createHostedCreator } from '../../creative-autonomy/creator/hosted.js';
import { createStagingCreatorWorld } from '../../creative-autonomy/creator/staging-world.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../creative-autonomy/creator/ui/', import.meta.url);
const PREMIUM_UI = new URL('../../analytics-premium/ui/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({
  'creator.js': [UI, 'creator.js', JS], 'creator.css': [UI, 'creator.css', CSS],
  'nordla-ds.css': [UI, 'ds/nordla-ds.css', CSS], 'nordla-tokens.css': [UI, 'ds/nordla-tokens.css', CSS],
  'style.css': [PREMIUM_UI, 'style.css', CSS],
});
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
const send = (res, status, type, body) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type }); res.end(body); };

/** The page of the Creator with its files re-pointed at /creator-assets/ (the sourcing server owns the root paths). */
export async function creatorPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|style\.css|creator\.css|creator\.js|nordla-icon\.js)"/g, '$1="/creator-assets/$2"');
}

/**
 * @param {{ gate: object, merchantId: string, dataDir: string, tenantName?: string|null, delayMs?: number }} o
 * @returns {{ handle(req, res, url: URL): Promise<boolean> }} handle answers (and returns true) only for the Creator's own paths
 */
export function createCreatorHost({ gate, merchantId, dataDir, tenantName = null, delayMs }) {
  const world = createStagingCreatorWorld({ dataDir, ...(delayMs != null ? { delayMs } : {}) });
  const hosted = createHostedCreator({ gate, merchantId, tenantName, integrationFor: world.integrationFor, catalogFor: world.catalogFor, persistDirFor: world.persistDirFor, readImageFor: world.readImageFor });
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname;
      try {
        if (p.startsWith('/api/creator/')) { await hosted(req, res); return true; }
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        if (p === '/creator' || p === '/creator/') { send(res, 200, 'text/html; charset=utf-8', await creatorPage()); return true; }
        const m = /^\/creator-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const a = ASSETS[m[1]]; if (!a) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, a[2], await readFile(new URL(a[1], a[0]))); return true;
        }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; } // fonts + brand marks of the design system (static, no data)
        return false;
      } catch { if (!res.headersSent) send(res, 500, 'application/json', '{"error":"CREATOR_UNAVAILABLE"}'); return true; }
    },
  });
}
