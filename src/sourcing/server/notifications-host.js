// Paramètres -> Notifications on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_NOTIFICATIONS_MODULE=1 (see server/index.js); without it no route below exists. Page /settings/notifications[/<rubrique>], files /notifications-assets/*,
// API /api/notifications*. A failure here answers 5xx on those paths only: Connexions, Général, Équipe, Finance, Growth and the others never depend on this file.
// RIGHTS. Every signed-in member (read-only included) reads and changes ONLY their own alerts and choices. The merchant, the user and the role are always the SESSION's;
// a removed or suspended member has no session and is refused by the gate before reaching this file. Unsafe methods need the CSRF header (the gate checks it).
import { readFile } from 'node:fs/promises';
import { NotificationsError } from '../../settings-notifications/service.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../settings-notifications/ui/', import.meta.url);
const GN = new URL('../../settings-general/ui/', import.meta.url);
const CX = new URL('../../connections/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'notifications.js': [UI, 'notifications.js', JS], 'notifications.css': [UI, 'notifications.css', CSS], 'shell.js': [GN, 'shell.js', JS], 'connections.css': [CX, 'connections.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const EMBEDDED_SETTINGS_HEADERS = { 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"), 'X-Frame-Options': 'SAMEORIGIN' };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
export const SLUGS = Object.freeze({ alertes: 'alerts', recues: 'inbox', canaux: 'channels', droits: 'rights' });
const STATUS = Object.freeze({ TENANT_REQUIRED: 403, ACTOR_REQUIRED: 403, FORBIDDEN: 403, TYPE_UNKNOWN: 404, CHANNEL_UNKNOWN: 422, CHANNEL_UNAVAILABLE: 409, NOT_WIRED: 409, VALIDATION: 422, NOT_FOUND: 404 });
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 20_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape'); return v; } catch { throw Object.assign(new Error('invalid json'), { code: 'BODY_INVALID' }); } };

export async function notificationsPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|notifications\.css|shell\.js|notifications\.js|nordla-icon\.js)"/g, '$1="/notifications-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, service: object, emitter?: { run: () => Promise<any> }|null, shellOf?: Function|null, now?: () => number, sweepEveryMs?: number }} o */
export async function createNotificationsHost({ gate, merchantId, service, emitter = null, shellOf = null, now = () => Date.now(), sweepEveryMs = 60_000 }) {
  const tenantOf = () => ({ merchantId, source: 'session' });
  let lastSweep = 0;
  const maybeSweep = async () => { if (!emitter || now() - lastSweep < sweepEveryMs) return; lastSweep = now(); await emitter.run(); }; // never throws (the emitter logs and swallows)
  const answer = (res, e) => {
    if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
    if (e instanceof NotificationsError) { json(res, STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message } }); return true; }
    return false;
  };
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname; const method = String(req.method ?? '').toUpperCase();
      try {
        if (p.startsWith('/api/notifications')) {
          const a = await gate.authorize(req);
          if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const base = { tenant: tenantOf(), role: access.role, actor: access.userId };
          try {
            if (method === 'GET' && p === '/api/notifications') {
              await maybeSweep();
              let shell = null; if (shellOf) { try { const s = await shellOf({ tenant: base.tenant, role: base.role }); shell = { nav: s.nav, merchant: s.merchant, environment: s.environment }; } catch { shell = null; } }
              json(res, 200, { ...(await service.overview(base)), shell }); return true;
            }
            if (method === 'GET' && p === '/api/notifications/inbox') { await maybeSweep(); json(res, 200, await service.inbox({ ...base, unreadOnly: url.searchParams.get('unread') === '1' })); return true; }
            if (method === 'POST' && p === '/api/notifications/preferences') { const b = await readJson(req); json(res, 200, await service.setPreference({ ...base, type: String(b.type ?? ''), channel: String(b.channel ?? ''), enabled: b.enabled })); return true; }
            if (method === 'POST' && p === '/api/notifications/open') { const b = await readJson(req); json(res, 200, await service.open({ ...base, id: String(b.id ?? '') })); return true; }
            if (method === 'POST' && p === '/api/notifications/read') { const b = await readJson(req); json(res, 200, await service.markRead({ ...base, ids: b.ids })); return true; }
            if (method === 'POST' && p === '/api/notifications/read-all') { await readJson(req).catch(() => ({})); json(res, 200, await service.markAllRead(base)); return true; }
          } catch (e) { if (answer(res, e)) return true; throw e; }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (method !== 'GET' && method !== 'HEAD') return false;
        const page = /^\/settings\/notifications(?:\/([a-z-]+))?\/?$/.exec(p);
        if (page && (!page[1] || SLUGS[page[1]])) { send(res, 200, 'text/html; charset=utf-8', await notificationsPage(), EMBEDDED_SETTINGS_HEADERS); return true; }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) return false; send(res, 200, f.type, f.body); return true; }
        const m = /^\/notifications-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const asset = ASSETS[m[1]]; if (!asset) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, asset[2], await readFile(new URL(asset[1], asset[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'NOTIFICATIONS_UNAVAILABLE' } }); return true; }
    },
  });
}
