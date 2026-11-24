// Paramètres -> Général on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_GENERAL_MODULE=1 (see server/index.js); without it no route below exists. Page /settings/general[/<rubrique>], files /general-assets/*, API /api/general*.
// A failure here answers 5xx on those paths only: Connexions, Finance, Growth and the others never depend on this file.
// RIGHTS. Reading: any session of this merchant (the legal rubric: OWNER or ADMIN). Writing: OWNER or ADMIN. The merchant is always the SESSION's merchant. Unsafe methods need the CSRF header (the gate checks it).
import { readFile } from 'node:fs/promises';
import { GeneralError, SECTION_META } from '../../settings-general/service.js';
import * as M from '../../settings-general/model.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../settings-general/ui/', import.meta.url);
const CX = new URL('../../connections/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'general.js': [UI, 'general.js', JS], 'general.css': [UI, 'general.css', CSS], 'shell.js': [UI, 'shell.js', JS], 'connections.css': [CX, 'connections.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const EMBEDDED_SETTINGS_HEADERS = { 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"), 'X-Frame-Options': 'SAMEORIGIN', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUGS = new Set(Object.values(SECTION_META).map((m) => m.slug));
const SECTION_OF = Object.fromEntries(Object.entries(SECTION_META).map(([id, m]) => [m.slug, id]));
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 200_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid json'), { code: 'BODY_INVALID' }); } };
const STATUS = Object.freeze({ MODULE_UNKNOWN: 404, LOCATION_UNKNOWN: 422, LOCATION_ALREADY_LINKED: 409, FORBIDDEN_ROLE: 403, VALIDATION: 422, CONFLICT: 409, NOT_FOUND: 404, SECTION_UNKNOWN: 404, PRIMARY_REQUIRED: 409, ARCHIVED: 409, TENANT_REQUIRED: 403 });

/** The option lists the forms need, so the page never carries a business list of its own. */
export const OPTIONS = Object.freeze({
  mainActivities: M.MAIN_ACTIVITIES, sideActivities: M.SIDE_ACTIVITIES, channels: M.CHANNELS, clientele: M.CLIENTELE, placeFunctions: M.PLACE_FUNCTIONS, sellingModes: M.SELLING_MODES, priorities: M.PRIORITIES, budgetPeriods: M.BUDGET_PERIODS, vatStatus: M.VAT_STATUS,
  days: M.DAYS.map((d) => ({ id: d, label: M.DAY_LABEL[d] })), countries: M.COUNTRIES, legalForms: M.LEGAL_FORMS,
  currencies: Intl.supportedValuesOf('currency'), timezones: Intl.supportedValuesOf('timeZone'),
});

export async function generalPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|general\.css|shell\.js|general\.js|nordla-icon\.js)"/g, '$1="/general-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, service: object, shellOf?: (o: {tenant, role}) => Promise<object> }} o shellOf = the Nordla menu + merchant name + environment (the Connexions service `settings`), optional */
export async function createGeneralHost({ gate, merchantId, service, shellOf = null }) {
  const tenantOf = () => ({ merchantId, source: 'session' });
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname;
      try {
        if (p.startsWith('/api/general')) {
          const a = await gate.authorize(req);
          if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const method = String(req.method ?? '').toUpperCase(); const role = access.role; const actor = access.userId; const tenant = tenantOf();
          try {
            if (method === 'GET' && p === '/api/general') {
              let shell = null; if (shellOf) { try { const s = await shellOf({ tenant, role }); shell = { nav: s.nav, merchant: s.merchant, environment: s.environment }; } catch { shell = null; } }
              json(res, 200, { ...(await service.overview({ tenant, role })), shell, options: OPTIONS }); return true;
            }
            if (method === 'GET' && p === '/api/general/context') { json(res, 200, await service.contextFor({ tenant, module: url.searchParams.get('module') ?? '' })); return true; } // what a module may read (allowlisted fields)
            if (method === 'GET' && p === '/api/general/legal-check') { json(res, 200, await service.legalCheck({ tenant, role })); return true; } // read only: Général vs Finance's seller profile
            if (method === 'GET' && p === '/api/general/supplier-locations') { json(res, 200, await service.supplierLocations({ tenant, role })); return true; }
            const lk = /^\/api\/general\/establishments\/([0-9a-f-]{36})\/links$/i.exec(p);
            if (lk && method === 'POST') { const body = await readJson(req); const prov = String(body.provider ?? ''); const ext = String(body.external_id ?? ''); if (!UUID.test(lk[1]) || !/^[a-z_]{2,40}$/.test(prov) || !ext || ext.length > 200) { json(res, 400, { error: { code: 'INVALID_REQUEST' } }); return true; } json(res, 200, await service.linkSupplierLocation({ tenant, role, actor, establishmentId: lk[1], provider: prov, externalId: ext, unlink: body.action === 'unlink' })); return true; }
            const rs = /^\/api\/general\/(profile|activity|establishments|selling_modes|regional|legal|objectives)$/.exec(p);
            if (rs && method === 'GET') { json(res, 200, await service.read({ tenant, role, section: rs[1] })); return true; }
            if (rs && (method === 'POST' || method === 'PUT') && rs[1] !== 'establishments') {
              const body = await readJson(req);
              json(res, 200, await service.save({ tenant, role, actor, section: rs[1], data: body.data, expectedVersion: body.expectedVersion ?? null })); return true;
            }
            if (method === 'POST' && p === '/api/general/establishments') { const body = await readJson(req); json(res, 200, await service.saveEstablishment({ tenant, role, actor, establishment: body.establishment, expectedVersion: body.expectedVersion ?? null })); return true; }
            const one = /^\/api\/general\/establishments\/([0-9a-f-]{36})\/(archive|restore|primary)$/i.exec(p);
            if (one && method === 'POST') {
              if (!UUID.test(one[1])) { json(res, 400, { error: { code: 'INVALID_REQUEST' } }); return true; }
              const base = { tenant, role, actor, establishmentId: one[1] };
              json(res, 200, one[2] === 'primary' ? await service.makePrimary(base) : await service.archiveEstablishment({ ...base, restore: one[2] === 'restore' })); return true;
            }
          } catch (e) {
            if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
            if (e instanceof GeneralError) { json(res, STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message }, ...(e.errors ? { errors: e.errors } : {}), ...(e.current ? { current: e.current } : {}) }); return true; }
            throw e;
          }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        const page = /^\/settings\/general(?:\/([a-z-]+))?\/?$/.exec(p);
        if (page && (!page[1] || SLUGS.has(page[1]))) { send(res, 200, 'text/html; charset=utf-8', await generalPage(), EMBEDDED_SETTINGS_HEADERS); return true; }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) return false; send(res, 200, f.type, f.body); return true; } // fonts shared with the other modules
        const m = /^\/general-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const asset = ASSETS[m[1]]; if (!asset) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, asset[2], await readFile(new URL(asset[1], asset[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'GENERAL_UNAVAILABLE' } }); return true; }
    },
  });
}
export { SECTION_OF };
