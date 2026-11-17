// Paramètres -> Préférences on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_PREFERENCES_MODULE=1 (see server/index.js); without it no route below exists. Page /settings/preferences[/<rubrique>], files /preferences-assets/*,
// API /api/preferences*. A failure here answers 5xx on those paths only: Stock / Achats, Général, Équipe, Sécurité, Connexions and the others never depend on this file
// (a screen that follows the preferences asks /api/preferences/effective and falls back to its own defaults when it fails).
// IDENTITY. The merchant, the person and the role are always the SESSION's: no id of a person is ever read from the address or the body, so one account can neither read nor change another's
// preferences. EVERY role (Lecture seule included) may change its own preferences; a preference changes no permission. Unsafe methods need the CSRF header (the gate checks it).
import { readFile } from 'node:fs/promises';
import { PreferencesError } from '../../settings-preferences/model.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../settings-preferences/ui/', import.meta.url);
const LIB = new URL('../../settings-preferences/', import.meta.url);
const CX = new URL('../../connections/ui/', import.meta.url);
const GN = new URL('../../settings-general/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'preferences.js': [UI, 'preferences.js', JS], 'preferences.css': [UI, 'preferences.css', CSS], 'shell.js': [GN, 'shell.js', JS], 'connections.css': [CX, 'connections.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS], 'format.js': [LIB, 'format.js', JS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUGS = Object.freeze({ langue: 'language', 'format-regional': 'region', vues: 'views' });
const STATUS = Object.freeze({ VALIDATION: 422, NOT_FOUND: 404, NAME_TAKEN: 409, TOO_MANY: 409, CONFLICT: 409, FORBIDDEN_MODULE: 403, TENANT_REQUIRED: 403 });
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 20_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape'); return v; } catch { throw Object.assign(new Error('invalid json'), { code: 'BODY_INVALID' }); } };

export async function preferencesPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|preferences\.css|shell\.js|preferences\.js|nordla-icon\.js)"/g, '$1="/preferences-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, service: object, shellOf?: (o: {tenant, role, lang}) => Promise<object> }} o */
export async function createPreferencesHost({ gate, merchantId, service, shellOf = null }) {
  const tenantOf = () => ({ merchantId, source: 'session' });
  const answer = (res, e) => {
    if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
    if (e instanceof PreferencesError) { json(res, STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message }, ...(e.errors ? { errors: e.errors } : {}) }); return true; }
    return false;
  };
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname; const method = String(req.method ?? '').toUpperCase();
      try {
        if (p.startsWith('/api/preferences')) {
          const a = await gate.authorize(req);
          if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const base = { tenant: tenantOf(), userId: access.userId, role: access.role }; // the SESSION's identity, nothing else
          try {
            if (method === 'GET' && p === '/api/preferences') {
              const overview = await service.overview(base);
              let shell = null; if (shellOf) { try { const s = await shellOf({ tenant: base.tenant, role: base.role, lang: overview.language.value }); shell = { nav: s.nav, merchant: s.merchant, environment: s.environment, cards: s.cards }; } catch { shell = null; } }
              json(res, 200, { ...overview, shell, role: base.role }); return true;
            }
            if (method === 'GET' && p === '/api/preferences/effective') { json(res, 200, await service.effective(base)); return true; }
            if ((method === 'PUT' || method === 'POST') && p === '/api/preferences') { json(res, 200, await service.save({ ...base, input: await readJson(req) })); return true; }
            if (method === 'GET' && p === '/api/preferences/views') { json(res, 200, await service.listViews({ ...base, module: url.searchParams.get('module') || null })); return true; }
            if (method === 'GET' && p === '/api/preferences/views/default') { json(res, 200, await service.resolveDefault({ ...base, module: url.searchParams.get('module') ?? '' })); return true; }
            if (method === 'POST' && p === '/api/preferences/views') { const b = await readJson(req); json(res, 200, await service.createView({ ...base, input: { module: b.module, name: b.name, filters: b.filters }, makeDefault: b.makeDefault === true })); return true; }
            const one = /^\/api\/preferences\/views\/([0-9a-f-]{36})$/i.exec(p);
            if (one && !UUID.test(one[1])) { json(res, 400, { error: { code: 'INVALID_REQUEST' } }); return true; }
            if (one && (method === 'PATCH' || method === 'POST')) { json(res, 200, await service.updateView({ ...base, id: one[1], patch: await readJson(req) })); return true; }
            if (one && method === 'DELETE') { json(res, 200, await service.removeView({ ...base, id: one[1] })); return true; }
          } catch (e) { if (answer(res, e)) return true; throw e; }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (method !== 'GET' && method !== 'HEAD') return false;
        const page = /^\/settings\/preferences(?:\/([a-z-]+))?\/?$/.exec(p);
        if (page && (!page[1] || SLUGS[page[1]])) { send(res, 200, 'text/html; charset=utf-8', await preferencesPage()); return true; }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) return false; send(res, 200, f.type, f.body); return true; }
        const m = /^\/preferences-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const asset = ASSETS[m[1]]; if (!asset) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, asset[2], await readFile(new URL(asset[1], asset[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'PREFERENCES_UNAVAILABLE' } }); return true; }
    },
  });
}
