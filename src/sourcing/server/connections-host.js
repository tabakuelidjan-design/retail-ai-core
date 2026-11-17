// Paramètres -> Connexions on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_CONNECTIONS_MODULE=1 (see server/index.js); without it no route below exists. Page /settings/connections, files /connections-assets/*, API /api/connections*.
// A failure here answers 5xx on those paths only. The provider flows are READ-ONLY: the runtime is built in NORDLA_PROVIDER_SCOPE_MODE=read, so Instagram and TikTok are asked for read scopes only.
// RIGHTS. Reading: any session of this merchant. Connecting, choosing the account, verifying, reconnecting, disconnecting: OWNER or ADMIN only. The merchant is always the SESSION's merchant.
// NO SECRET reaches the browser: the page is built from the service's allowlisted view; the only provider URL sent is the public authorization address (its `state` is single use).
import { readFile } from 'node:fs/promises';
import { PC_ERROR } from '../../provider-connections/constants.js';
import { WRITER_ROLES } from '../../connections/service.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../connections/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'connections.js': [UI, 'connections.js', JS], 'connections.css': [UI, 'connections.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
const redirect = (res, to) => { res.writeHead(303, { ...HEADERS, Location: to, 'Cache-Control': 'no-store' }); res.end(); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE = '/settings/connections'; const HOME = '/settings';
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 10_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { code: 'BODY_INVALID' }); } };

// Provisioning error -> HTTP. Only a code (and a few non-secret hints) is ever returned, never a provider body.
const STATUS_OF = Object.freeze({
  [PC_ERROR.APP_MISCONFIGURED]: 409, [PC_ERROR.SESSION_NOT_FOUND]: 404, [PC_ERROR.SESSION_STATE_CONFLICT]: 409, [PC_ERROR.TARGET_REQUIRED]: 400, [PC_ERROR.TARGET_NOT_FOUND]: 404, [PC_ERROR.TARGET_INELIGIBLE]: 422,
  [PC_ERROR.CONNECTOR_NOT_FOUND]: 404, [PC_ERROR.PROVIDER_UNSUPPORTED]: 400, [PC_ERROR.REAUTH_REQUIRED]: 409, [PC_ERROR.VAULT_UNAVAILABLE]: 503, [PC_ERROR.OAUTH]: 502,
});
// Reading Instagram: what a whole-read failure looks like to the page (the failed attempt is already recorded).
const READ_ERRORS = Object.freeze({ TOKEN_REJECTED: [409, 'REAUTH_REQUIRED'], RATE_LIMITED: [429, 'RATE_LIMITED'], SOURCE_UNREACHABLE: [502, 'SOURCE_UNREACHABLE'], NOT_CONNECTED: [409, 'NOT_CONNECTED'] });
function problem(error) {
  const code = error?.code ?? 'UNKNOWN';
  const status = STATUS_OF[code]; if (!status) return null;
  const detail = error.detail ?? {};
  const body = { error: { code: code === PC_ERROR.APP_MISCONFIGURED ? 'APP_NOT_CONFIGURED' : code } };
  if (Array.isArray(detail.missing)) body.missing = detail.missing.filter((n) => /^[A-Z][A-Z0-9_]{2,60}$/.test(n)); // variable NAMES only
  if (Array.isArray(detail.reasons)) body.reasons = detail.reasons.filter((r) => /^[A-Z_]{3,40}$/.test(r));
  if (detail.oauth && /^[A-Z_]{3,40}$/.test(detail.oauth)) body.oauth = detail.oauth;
  return { status, body };
}

export async function connectionsPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|connections\.js|nordla-icon\.js)"/g, '$1="/connections-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, runtime: object, service: object, registry: object }} o runtime = createProviderConnectionsRuntime(...) (real, or the test fakes) */
export async function createConnectionsHost({ gate, merchantId, runtime, service, registry, reads = null }) {
  const center = runtime.connectionCenter; const tenantOf = () => ({ merchantId, source: 'session' });
  const providerFor = (key) => { const p = registry.byProviderKey(key); return p && p.source === 'oauth' && p.status === 'AVAILABLE' ? p : null; };
  const overview = (role) => service.overview({ tenant: tenantOf(), role });
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname;
      try {
        if (p.startsWith('/api/connections') || p === '/api/settings') {
          const a = await gate.authorize(req);
          const cb = /^\/api\/connections\/([a-z_]{2,40})\/callback$/.exec(p);
          if (!a.ok) { if (cb) { redirect(res, `${PAGE}?connect_error=SESSION_INVALID`); return true; } json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { if (cb) { redirect(res, `${PAGE}?connect_error=TENANT_MISMATCH`); return true; } json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const method = String(req.method ?? '').toUpperCase(); const writer = WRITER_ROLES.has(access.role); const actorRef = access.userId;
          if (method === 'GET' && p === '/api/connections') { json(res, 200, await overview(access.role)); return true; }
          if (method === 'GET' && p === '/api/settings') { json(res, 200, await service.settings({ tenant: tenantOf(), role: access.role })); return true; }
          // The provider sends the browser back here after the consent: GET, with the Nordla session cookie. Nothing from the query is echoed back.
          if (method === 'GET' && cb) {
            const provider = providerFor(cb[1]); if (!provider) { redirect(res, `${PAGE}?connect_error=PROVIDER_UNSUPPORTED`); return true; }
            if (!writer) { redirect(res, `${PAGE}?connect_error=FORBIDDEN_ROLE`); return true; }
            try {
              const q = Object.fromEntries(['code', 'state', 'error', 'error_description'].map((k) => [k, url.searchParams.get(k) ?? undefined]).filter(([, v]) => v !== undefined));
              const done = await runtime.provisioning.handleCallback({ tenant: tenantOf(), provider: provider.providerKey, query: q });
              redirect(res, `${PAGE}?connect=${encodeURIComponent(done.session_ref)}&provider=${encodeURIComponent(provider.providerKey)}`); return true;
            } catch (e) { const pr = problem(e); redirect(res, `${PAGE}?connect_error=${encodeURIComponent(pr?.body?.oauth ?? pr?.body?.error?.code ?? 'CALLBACK_FAILED')}`); return true; }
          }
          try {
            if (method === 'GET' && p === '/api/connections/targets') {
              if (!writer) { json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } }); return true; }
              const ref = url.searchParams.get('session') ?? ''; if (!UUID.test(ref)) { json(res, 400, { error: { code: 'SESSION_INVALID' } }); return true; }
              const found = await center.listTargets({ tenant: tenantOf(), sessionRef: ref });
              json(res, 200, { selectionRequired: true, targets: found.targets.map((t) => ({ externalId: t.external_id, displayName: t.display_name ?? null, accountType: t.account_type ?? null, locationName: t.location_name ?? null, eligible: Boolean(t.eligibility?.eligible), reasons: [...(t.eligibility?.reasons ?? [])] })) }); return true;
            }
            if (method === 'POST' && p.startsWith('/api/connections/')) {
              if (!writer) { json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } }); return true; }
              const body = await readJson(req);
              if (p === '/api/connections/connect') {
                const provider = registry.get(String(body.provider ?? '')); const ok = provider && providerFor(provider.providerKey);
                if (!ok) { json(res, 400, { error: { code: 'PROVIDER_UNSUPPORTED' } }); return true; }
                const started = await center.startConnect({ tenant: tenantOf(), provider: provider.providerKey, actorRef });
                json(res, 200, { authorizationUrl: started.authorization_url, sessionRef: started.session_ref, expiresAt: started.expires_at }); return true;
              }
              if (p === '/api/connections/select') {
                if (!UUID.test(String(body.session_ref ?? '')) || typeof body.external_id !== 'string') { json(res, 400, { error: { code: 'INVALID_REQUEST' } }); return true; }
                const bound = await center.selectTarget({ tenant: tenantOf(), sessionRef: body.session_ref, externalId: body.external_id, actorRef });
                json(res, 200, { state: bound.verification?.state ?? null, ...(await overview(access.role)) }); return true;
              }
              const one = /^\/api\/connections\/([0-9a-f-]{36})\/(verify|reconnect|disconnect|read)$/i.exec(p);
              if (one) {
                const [, connectorId, action] = one;
                if (action === 'read') { if (!reads) { json(res, 404, { error: { code: 'NOT_FOUND' } }); return true; } const snapshot = await reads.read({ tenant: tenantOf(), connectorId }); json(res, 200, { read: snapshot, ...(await overview(access.role)) }); return true; }
                if (action === 'verify') { await center.verify({ tenant: tenantOf(), connectorId }); json(res, 200, await overview(access.role)); return true; }
                if (action === 'disconnect') { await center.disconnect({ tenant: tenantOf(), connectorId }); json(res, 200, await overview(access.role)); return true; }
                const started = await center.reconnect({ tenant: tenantOf(), connectorId, actorRef });
                json(res, 200, { authorizationUrl: started.authorization_url, sessionRef: started.session_ref, expiresAt: started.expires_at }); return true;
              }
            }
          } catch (e) {
            if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
            const known = READ_ERRORS[e?.code]; if (known) { json(res, known[0], { error: { code: known[1] } }); return true; }
            const pr = problem(e); if (pr) { json(res, pr.status, pr.body); return true; } throw e;
          }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        if (p === PAGE || p === `${PAGE}/` || p === HOME || p === `${HOME}/`) { send(res, 200, 'text/html; charset=utf-8', await connectionsPage()); return true; }
        const m = /^\/connections-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const a = ASSETS[m[1]]; if (!a) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, a[2], await readFile(new URL(a[1], a[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'CONNECTIONS_UNAVAILABLE' } }); return true; }
    },
  });
}
