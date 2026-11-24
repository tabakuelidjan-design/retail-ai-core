// Paramètres -> Équipe et accès on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_TEAM_MODULE=1 (see server/index.js); without it no route below exists. Page /settings/team[/<rubrique>], files /team-assets/*,
// API /api/team*, and the PUBLIC invitation page /invitation/<token> with /api/invitations/{info,accept}. A failure here answers 5xx on those paths only:
// Connexions, Général, Finance, Growth and the others never depend on this file.
// RIGHTS. The rights grid is readable by every member; members, invitations and history only by OWNER / ADMIN; every change is decided again by the database
// functions (the screen hiding a button protects nothing). The merchant, the actor and the role are always the SESSION's. Unsafe methods need the CSRF header.
// PUBLIC SIDE. The invitation endpoints have no session: they need the exact same-origin Origin header, a JSON body, and are rate limited per address and per link.
// The token travels in a POST body (never in an API URL) and is stored only as a SHA-256 hash.
import { readFile } from 'node:fs/promises';
import { TeamError } from '../../settings-team/service.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../settings-team/ui/', import.meta.url);
const GN = new URL('../../settings-general/ui/', import.meta.url);
const CX = new URL('../../connections/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'team.js': [UI, 'team.js', JS], 'team.css': [UI, 'team.css', CSS], 'invitation.js': [UI, 'invitation.js', JS], 'recovery.js': [UI, 'recovery.js', JS], 'shell.js': [GN, 'shell.js', JS], 'connections.css': [CX, 'connections.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const EMBEDDED_SETTINGS_HEADERS = { 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"), 'X-Frame-Options': 'SAMEORIGIN', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUGS = Object.freeze({ membres: 'members', invitations: 'invitations', roles: 'roles', historique: 'history' });
const STATUS = Object.freeze({ FORBIDDEN_ROLE: 403, FORBIDDEN: 403, TENANT_REQUIRED: 403, NOT_FOUND: 404, ROLE_INVALID: 422, EMAIL_INVALID: 422, LAST_OWNER: 409, SELF_PROMOTION: 403, ALREADY_SUSPENDED: 409, ALREADY_ACTIVE: 409, ALREADY_REMOVED: 409, NO_CHANGE: 409, MEMBER_REMOVED: 409, ALREADY_MEMBER: 409, DUPLICATE_PENDING: 409, NOT_RESENDABLE: 409, NOT_CANCELLABLE: 409, TARGET_NOT_MEMBER: 404, MERCHANT_UNKNOWN: 404,
  PASSWORD_INVALID: 422, CREDENTIALS_INVALID: 403, ACCOUNT_FAILED: 502, ACCEPT_UNAVAILABLE: 503, INVITATION_INVALID: 410, INVITATION_EXPIRED: 410, INVITATION_ACCEPTED: 410, INVITATION_CANCELLED: 410, INVITATION_PENDING: 410, EMAIL_MISMATCH: 403, SELF_RECOVERY: 409, TARGET_NOT_ACTIVE: 409, RECOVERY_INVALID: 410, RECOVERY_EXPIRED: 410, RECOVERY_USED: 410, RECOVERY_CANCELLED: 410, RECOVERY_PENDING: 410 });
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 20_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape'); return v; } catch { throw Object.assign(new Error('invalid json'), { code: 'BODY_INVALID' }); } };

/** Fixed-window limiter in memory (one server): `max` hits per `windowMs` per key. */
function limiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return (key) => { const t = now(); const e = hits.get(key); if (!e || t - e.start >= windowMs) { hits.set(key, { start: t, n: 1 }); if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k); return true; } e.n += 1; return e.n <= max; };
}
export async function teamPage(name) {
  const html = await readFile(new URL(name, UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|team\.css|shell\.js|team\.js|invitation\.js|recovery\.js|nordla-icon\.js)"/g, '$1="/team-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, service: object, origin?: string, shellOf?: Function, now?: () => number }} o */
export async function createTeamHost({ gate, merchantId, service, origin = '', shellOf = null, now = () => Date.now() }) {
  const tenantOf = () => ({ merchantId, source: 'session' });
  const perIp = limiter({ max: 30, windowMs: 600_000, now }); const perToken = limiter({ max: 12, windowMs: 600_000, now });
  const ipOf = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() || req.socket?.remoteAddress || 'unknown';
  const answer = (res, e) => {
    if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
    if (e instanceof TeamError) { json(res, STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message, ...(e.invitationId ? { invitationId: e.invitationId } : {}), ...(e.state ? { state: e.state } : {}) } }); return true; }
    return false;
  };
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname; const method = String(req.method ?? '').toUpperCase();
      try {
        // ---- public: the person who received the link
        if (['/api/invitations/info', '/api/invitations/accept', '/api/recovery/info', '/api/recovery/apply'].includes(p)) {
          if (method !== 'POST') { json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } }); return true; }
          if (origin && req.headers.origin !== origin) { json(res, 403, { error: { code: 'ORIGIN_REFUSED' } }); return true; }
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 415, { error: { code: 'JSON_REQUIRED' } }); return true; }
          if (!perIp(ipOf(req))) { json(res, 429, { error: { code: 'RATE_LIMITED', message: 'Trop de tentatives. Réessayez dans quelques minutes.' } }); return true; }
          try {
            const body = await readJson(req); const token = typeof body.token === 'string' ? body.token : '';
            if (!perToken(token.slice(0, 64))) { json(res, 429, { error: { code: 'RATE_LIMITED', message: 'Trop de tentatives. Réessayez dans quelques minutes.' } }); return true; }
            if (p === '/api/invitations/info') { json(res, 200, await service.inviteInfo(token)); return true; }
            if (p === '/api/recovery/info') { json(res, 200, await service.recoveryInfo(token)); return true; }
            if (p === '/api/recovery/apply') { json(res, 200, await service.applyRecovery({ token, password: body.password })); return true; }
            json(res, 200, await service.acceptInvite({ token, password: body.password, name: body.name })); return true;
          } catch (e) { if (answer(res, e)) return true; throw e; }
        }
        if (p.startsWith('/api/team')) {
          const a = await gate.authorize(req);
          if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const role = access.role; const actor = access.userId; const tenant = tenantOf(); const base = { tenant, role, actor };
          try {
            if (method === 'GET' && p === '/api/team') {
              let shell = null; if (shellOf) { try { const s = await shellOf({ tenant, role }); shell = { nav: s.nav, merchant: s.merchant, environment: s.environment }; } catch { shell = null; } }
              json(res, 200, { ...(await service.overview(base)), shell }); return true;
            }
            if (method === 'GET' && p === '/api/team/rights') { json(res, 200, service.rights()); return true; }
            const rr = /^\/api\/team\/rights\/([A-Z_]{4,20})$/.exec(p); if (rr && method === 'GET') { json(res, 200, service.rightsOfRole(rr[1])); return true; }
            if (method === 'GET' && p === '/api/team/members') { json(res, 200, await service.members({ ...base, q: url.searchParams.get('q') ?? '', roleFilter: url.searchParams.get('role') ?? '', status: url.searchParams.get('status') ?? '' })); return true; }
            const mem = /^\/api\/team\/members\/([0-9a-f-]{36})(?:\/(role|suspend|reactivate|remove|recovery))?$/i.exec(p);
            if (mem && method === 'GET' && !mem[2]) { json(res, 200, await service.member({ ...base, userId: mem[1] })); return true; }
            if (mem && method === 'POST' && mem[2]) {
              if (mem[2] === 'role') { const body = await readJson(req); json(res, 200, await service.changeRole({ ...base, userId: mem[1], newRole: String(body.role ?? '') })); return true; }
              await readJson(req).catch(() => ({})); if (mem[2] === 'recovery') { json(res, 200, await service.issueRecovery({ ...base, userId: mem[1] })); return true; } json(res, 200, await service.setStatus({ ...base, userId: mem[1], action: mem[2].toUpperCase() })); return true;
            }
            if (method === 'GET' && p === '/api/team/invitations') { json(res, 200, await service.invitations(base)); return true; }
            if (method === 'POST' && p === '/api/team/invitations') { const body = await readJson(req); json(res, 200, await service.invite({ ...base, email: String(body.email ?? ''), newRole: String(body.role ?? '') })); return true; }
            const inv = /^\/api\/team\/invitations\/([0-9a-f-]{36})\/(resend|cancel)$/i.exec(p);
            if (inv && method === 'POST') { await readJson(req).catch(() => ({})); json(res, 200, inv[2] === 'resend' ? await service.resend({ ...base, invitationId: inv[1] }) : await service.cancel({ ...base, invitationId: inv[1] })); return true; }
            if (method === 'GET' && p === '/api/team/history') { json(res, 200, await service.history({ ...base, limit: url.searchParams.get('limit') ?? 50, before: url.searchParams.get('before') })); return true; }
          } catch (e) { if (answer(res, e)) return true; throw e; }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (method !== 'GET' && method !== 'HEAD') return false;
        const page = /^\/settings\/team(?:\/([a-z-]+))?\/?$/.exec(p);
        if (page && (!page[1] || SLUGS[page[1]])) { send(res, 200, 'text/html; charset=utf-8', await teamPage('index.html'), EMBEDDED_SETTINGS_HEADERS); return true; }
        if (/^\/recuperation\/[A-Za-z0-9_-]{1,64}\/?$/.test(p)) { send(res, 200, 'text/html; charset=utf-8', await teamPage('recovery.html'), { 'Cache-Control': 'no-store' }); return true; }
        if (/^\/invitation\/[A-Za-z0-9_-]{1,64}\/?$/.test(p)) { send(res, 200, 'text/html; charset=utf-8', await teamPage('invitation.html'), { 'Cache-Control': 'no-store' }); return true; }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) return false; send(res, 200, f.type, f.body); return true; }
        const m = /^\/team-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const asset = ASSETS[m[1]]; if (!asset) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, asset[2], await readFile(new URL(asset[1], asset[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'TEAM_UNAVAILABLE' } }); return true; }
    },
  });
}
