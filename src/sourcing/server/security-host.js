// Paramètres -> Sécurité on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_SECURITY_MODULE=1 (see server/index.js); without it no route below exists. Page /settings/security[/<rubrique>], files /security-assets/*, API /api/security*.
// A failure here answers 5xx on those paths only: sign-in, Connexions, Général and the other modules never depend on this file.
// SCOPE. Every route works on the SESSION's own person (never an id from the request): nobody can read or revoke another account's sessions. Team rules are readable by any member of
// this merchant (the merchant is the session's), their management is reserved to OWNER / ADMIN. Unsafe methods need the CSRF header (the gate checks it).
import { readFile } from 'node:fs/promises';
import { SecurityError } from '../../settings-security/service.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../settings-security/ui/', import.meta.url);
const GN = new URL('../../settings-general/ui/', import.meta.url);
const CX = new URL('../../connections/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'security.js': [UI, 'security.js', JS], 'security.css': [UI, 'security.css', CSS], 'reset.js': [UI, 'reset.js', JS], 'shell.js': [GN, 'shell.js', JS], 'general.css': [GN, 'general.css', CSS], 'connections.css': [CX, 'connections.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const EMBEDDED_SETTINGS_HEADERS = { 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"), 'X-Frame-Options': 'SAMEORIGIN' };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
export const SLUGS = Object.freeze({ connexion: 'sign_in', sessions: 'sessions', activite: 'activity', equipe: 'team' });
const STATUS = Object.freeze({ REAUTHENTICATION_REQUIRED:403, LINK_INVALID: 410, MFA_REQUIRED: 422, MFA_INVALID: 403, FORBIDDEN_ROLE: 403, FEATURE_UNAVAILABLE: 409, VALIDATION: 422, BAD_CURRENT_PASSWORD: 403, RATE_LIMITED: 429, UNAVAILABLE: 503, PROVIDER_REFUSED: 422, CURRENT_SESSION_UNKNOWN: 409, SESSION_REQUIRED: 401 });
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 20_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid json'), { code: 'BODY_INVALID' }); } };
const cookieOf = (req, name) => { for (const part of String(req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return null; };

export async function securityPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|general\.css|security\.css|shell\.js|security\.js|nordla-icon\.js)"/g, '$1="/security-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, service: object, sessionCookie?: string, shellOf?: Function }} o */
export async function createSecurityHost({ gate, merchantId, service, sessionCookie = '__Host-nordla_sourcing_sid', shellOf = null, features = {} }) {
  const clientIpOf = (g) => String(g?.ctx?.clientIp ?? 'unknown');
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname;
      try {
        // PUBLIC recovery routes (no session): only when the recovery feature is on, same-origin POST only, one fixed answer for the request.
        if (features.recovery && (p === '/api/auth/forgot' || p === '/api/auth/reset')) {
          const g = gate.guardPublicPost?.(req); if (!g || !g.ok) { json(res, g?.response?.status ?? 403, g?.response ?? { error: 'FORBIDDEN' }); return true; }
          try {
            const b = await readJson(req);
            if (p === '/api/auth/forgot') { json(res, 200, await service.forgotPassword({ email: b.email, ip: clientIpOf(g) })); return true; }
            json(res, 200, await service.resetPassword({ token: b.token, password: b.password, code: b.code })); return true;
          } catch (e) {
            if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
            if (e instanceof SecurityError) { json(res, STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message } }); return true; }
            throw e;
          }
        }
        if (features.recovery && req.method === 'GET' && /^\/reset-password\/?$/.test(p)) { send(res, 200, 'text/html; charset=utf-8', (await readFile(new URL('reset.html', UI), 'utf8')).replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|connections\.css|general\.css|security\.css|reset\.js)"/g, '$1="/security-assets/$2"'), { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return true; }
        if (p.startsWith('/api/security')) {
          const a = await gate.authorize(req);
          if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const me = { userId: access.userId, merchantId: access.merchantId, role: access.role, module: access.module, sessionId:access.sessionId }; // ALWAYS the session's own identity
          const token = cookieOf(req, sessionCookie); const method = String(req.method ?? '').toUpperCase();
          try {
            if (method === 'GET' && p === '/api/security') {
              let shell = null; if (shellOf) { try { const s = await shellOf({ tenant: { merchantId, source: 'session' }, role: me.role }); shell = { nav: s.nav, merchant: s.merchant, environment: s.environment }; } catch { shell = null; } }
              json(res, 200, { role: me.role, shell, account: await service.account(me), team: await service.teamRules(me) }); return true;
            }
            if (method === 'GET' && p === '/api/security/sessions') { json(res, 200, await service.listSessions(me, token)); return true; }
            if (method === 'GET' && p === '/api/security/activity') { json(res, 200, await service.activity(me)); return true; }
            if (method === 'GET' && p === '/api/security/team') { json(res, 200, await service.teamRules(me)); return true; }
            if (method === 'POST' && p === '/api/security/sessions/revoke-current') { json(res, 200, await service.revokeCurrent(me, token)); return true; }
            if (method === 'POST' && p === '/api/security/sessions/revoke-others') { json(res, 200, await service.revokeOthers(me, token)); return true; }
            if (method === 'POST' && p === '/api/security/password') { const b = await readJson(req); json(res, 200, await service.changePassword(me, token, { current: b.current, next: b.next, code: b.code })); return true; }
            if (method === 'POST' && p === '/api/security/mfa/enroll') { const b = await readJson(req); json(res, 200, await service.mfaEnroll(me, { password: b.password })); return true; }
            if (method === 'POST' && p === '/api/security/mfa/confirm') { const b = await readJson(req); json(res, 200, await service.mfaConfirm(me, token, { password: b.password, factorId: b.factorId, code: b.code })); return true; }
            if (method === 'POST' && p === '/api/security/mfa/disable') { const b = await readJson(req); json(res, 200, await service.mfaDisable(me, token, { password: b.password, code: b.code })); return true; }
            if (method === 'POST' && p === '/api/security/mfa/recovery-codes') { const b = await readJson(req); json(res, 200, await service.mfaRenewCodes(me, { password: b.password, code: b.code })); return true; }
            if ((method === 'PUT' || method === 'POST') && p === '/api/security/team') { const b = await readJson(req); json(res, 200, await service.saveTeamRules(me, { requireMfa: b.requireMfa })); return true; }
          } catch (e) {
            if (e?.code === 'BODY_TOO_LARGE' || e?.code === 'BODY_INVALID') { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code } }); return true; }
            if (e instanceof SecurityError) { json(res, STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message } }); return true; }
            throw e;
          }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        const page = /^\/settings\/security(?:\/([a-z-]+))?\/?$/.exec(p);
        if (page && (!page[1] || SLUGS[page[1]])) { send(res, 200, 'text/html; charset=utf-8', await securityPage(), EMBEDDED_SETTINGS_HEADERS); return true; }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) return false; send(res, 200, f.type, f.body); return true; }
        const m = /^\/security-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const asset = ASSETS[m[1]]; if (!asset) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, asset[2], await readFile(new URL(asset[1], asset[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'SECURITY_UNAVAILABLE' } }); return true; }
    },
  });
}
