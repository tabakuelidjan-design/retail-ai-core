// Hosting + staging access barrier for Analytics Premium. Pure functions and one guard factory; no I/O.
//
// LOCAL (default): loopback only, ANALYTICS_PREMIUM_PORT or 4411, no barrier (unchanged behaviour).
// HOSTED (Railway staging): ANALYTICS_HOSTED=true, or Railway's RAILWAY_ENVIRONMENT* markers.
//   - listens on 0.0.0.0 on the platform PORT;
//   - ANALYTICS_ALLOWED_HOSTS is mandatory: only those exact hostnames are served;
//   - ANALYTICS_ACCESS_TOKEN is mandatory (24+ chars): every request, pages AND api, needs HTTP Basic credentials whose password is
//     that token (any user name). The browser asks once and remembers it. There is no account system, no session, no cookie;
//   - failed attempts are rate limited per client IP (5 failures -> 5 minutes), the IP taken from the trusted proxy's
//     X-Forwarded-For entry counted from the right;
//   - HSTS and X-Robots-Tag: noindex are sent.
// HABB business figures are never served without the token.

import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { createTicketVerifier, ANALYTICS_SSO_AUDIENCE } from '../../finance/sso-ticket.js';
export { ANALYTICS_SSO_AUDIENCE };
import { isIP } from 'node:net';
import { proxySecretOk } from '../../shared/proxy-secret.js';

export class HostingConfigError extends Error {}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const sha = (s) => createHash('sha256').update(String(s)).digest();

export const isHosted = (env = process.env) => truthy(env.ANALYTICS_HOSTED) || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);

export function parseAllowedHosts(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const h = part.trim().toLowerCase();
    if (!h) continue;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(h)) throw new HostingConfigError(`ANALYTICS_ALLOWED_HOSTS: "${part.trim()}" is not a plain hostname (no scheme, path, wildcard or spaces).`);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export function resolveHosting(env = process.env) {
  if (!isHosted(env)) return { hosted: false, host: '127.0.0.1', port: Number(env.ANALYTICS_PREMIUM_PORT || 4411), allowedHosts: null, token: null, trustProxyHops: 0, refreshHours: 0, checkMinutes: 5 };
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostingConfigError('Hosted mode needs the platform PORT environment variable (a port number). Railway sets it automatically.');
  const allowedHosts = parseAllowedHosts(env.ANALYTICS_ALLOWED_HOSTS);
  if (!allowedHosts.length) throw new HostingConfigError('Hosted mode needs ANALYTICS_ALLOWED_HOSTS: the exact public hostname(s), comma-separated.');
  if (!env.ANALYTICS_ACCESS_TOKEN || String(env.ANALYTICS_ACCESS_TOKEN).length < 24) throw new HostingConfigError('Hosted mode needs ANALYTICS_ACCESS_TOKEN (at least 24 characters): Analytics shows business data and is never served without it.');
  const hopsRaw = env.ANALYTICS_TRUST_PROXY_HOPS;
  const trustProxyHops = hopsRaw === undefined || hopsRaw === '' ? 1 : Number(hopsRaw);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new HostingConfigError('ANALYTICS_TRUST_PROXY_HOPS must be an integer between 0 and 5 (default 1).');
  const refreshRaw = env.ANALYTICS_REPORT_REFRESH_HOURS;
  const refreshHours = refreshRaw === undefined || refreshRaw === '' ? 6 : Number(refreshRaw);
  if (!Number.isFinite(refreshHours) || refreshHours < 0 || refreshHours > 168) throw new HostingConfigError('ANALYTICS_REPORT_REFRESH_HOURS must be between 0 and 168 (0 = generate once at startup only; default 6).');
  const checkRaw = env.ANALYTICS_REPORT_CHECK_MINUTES;
  const checkMinutes = checkRaw === undefined || checkRaw === '' ? 5 : Number(checkRaw);
  if (!Number.isFinite(checkMinutes) || checkMinutes < 1 || checkMinutes > 1440) throw new HostingConfigError('ANALYTICS_REPORT_CHECK_MINUTES must be between 1 and 1440 (default 5).');
  return { hosted: true, host: '0.0.0.0', port, allowedHosts, token: String(env.ANALYTICS_ACCESS_TOKEN), trustProxyHops, refreshHours, checkMinutes };
}

/** Same rule as Finance: behind N trusted proxies the real peer is the entry N-from-the-right of X-Forwarded-For; the rest is forgeable. */
export function clientIpOf(req, trustProxyHops = 0) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  if (!trustProxyHops) return socketIp;
  const parts = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = parts.length >= trustProxyHops ? parts[parts.length - trustProxyHops] : undefined;
  return candidate && isIP(candidate) ? candidate : socketIp;
}

/** Password of an `Authorization: Basic` header, or '' (the user name is ignored). */
export function basicPassword(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header ?? '').trim());
  if (!m) return '';
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? '' : decoded.slice(i + 1);
}

/**
 * Request guard: returns true when the request may proceed; otherwise it has already answered (403 wrong host, 401 no/wrong token,
 * 429 locked out). Constant-time token comparison.
 */
/** The audience of the Nordla single-sign-on ticket for this dashboard (its own key: a Finance ticket never opens Analytics). */
const SSO_SESSION_MS = 8 * 3600_000; const SSO_COOKIE = 'an_sid';
const cookieOf = (req, name) => { for (const part of String(req.headers?.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return ''; };

/**
 * sso (optional, hosted): { secret, merchantId } - GET /sso?t=<ticket> issued by the Nordla server for a signed-in person with the right role: a valid, unused, unexpired ticket for THIS merchant opens an
 * 8 h session (HttpOnly, Secure, SameSite=Lax cookie (Lax: sent on the cross-site redirect from Core), kept in memory) and lands on the dashboard. The access token keeps working as before; nothing is served without one of the two.
 */
export function createGuard({ allowedHosts, token, trustProxyHops = 0, sso = null, ssoOnly = false, proxy = null, now = () => Date.now() }) {
  if (ssoOnly && (!sso?.secret || sso.requirePerson !== true || typeof sso.checkAccess !== 'function')) throw new HostingConfigError('SSO-only mode requires personal Nordla sessions with current access checks.');
  const verifier = sso ? createTicketVerifier({ secret: sso.secret, merchantId: sso.merchantId, audience: ANALYTICS_SSO_AUDIENCE, now, module: 'analytics', requirePerson: sso.requirePerson === true, checkAccess: sso.checkAccess ?? null }) : null;
  const sessions = new Map(); // sid -> expiry (ms)
  const ssoPeople = new Map(); // sid -> { userId, role } for sessions opened by Nordla single sign-on
  const tokenHash = sha(token);
  const failures = new Map();
  const base = { 'Cache-Control': 'no-store', 'Strict-Transport-Security': 'max-age=31536000', 'X-Robots-Tag': 'noindex, nofollow' };
  const deny = (res, status, code, extra = {}) => { res.writeHead(status, { ...base, 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify({ error: { code } })); return false; };
  return async function guard(req, res) {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.includes(host)) return deny(res, 403, 'HOST_NOT_ALLOWED');
    const ip = clientIpOf(req, trustProxyHops);
    const f = failures.get(ip) ?? { n: 0, until: 0 };
    if (f.until > now()) return deny(res, 429, 'TOO_MANY_ATTEMPTS');
    // Core-proxied requests use the live Nordla session. The proxy secret authenticates these server-only identity headers;
    // module access is rechecked against current membership, role, MFA assurance, and entitlement on every request.
    if (proxy?.secret && proxySecretOk(req, proxy.secret)) {
      const actor = {
        merchantId: String(req.headers['x-nordla-identity-merchant'] ?? ''),
        userId: String(req.headers['x-nordla-identity-user'] ?? ''),
        authSessionId: String(req.headers['x-nordla-identity-session'] ?? ''),
        role: String(req.headers['x-nordla-identity-role'] ?? ''),
        module: 'analytics',
      };
      const access = await proxy.checkAccess(actor).catch(() => null);
      if (!access?.ok) return deny(res, 403, 'CORE_ACCESS_REQUIRED');
      failures.delete(ip);
      for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
      return true;
    }
    if (verifier && req.method === 'GET' && String(req.url ?? '').split('?')[0] === '/sso') {
      const r = await verifier.verifyAsync(new URL(req.url, 'http://localhost').searchParams.get('t') ?? '');
      if (!r.ok) { f.n += 1; if (f.n >= 5) { f.until = now() + 5 * 60_000; f.n = 0; } failures.set(ip, f); return deny(res, 403, r.code); }
      failures.delete(ip);
      for (const [k, v] of sessions) if (v < now()) { sessions.delete(k); ssoPeople.delete(k); }
      const sid = randomBytes(32).toString('hex'); sessions.set(sid, now() + SSO_SESSION_MS);
      if (r.claims) ssoPeople.set(sid, { userId: r.claims.userId, role: r.access?.role ?? r.claims.role, ...(r.claims.authSessionId ? {authSessionId:r.claims.authSessionId} : {}) }); // re-checked before protected data reads below
      res.writeHead(302, { ...base, Location: '/', 'Set-Cookie': `${SSO_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SSO_SESSION_MS / 1000}` }); res.end();
      return false; // answered (redirect)
    }
    const sid = verifier ? cookieOf(req, SSO_COOKIE) : '';
    if (sid && (sessions.get(sid) ?? 0) > now()) {
      // The UI shell and its static assets contain no account data. Re-check current membership on every data API request;
      // this keeps revocations immediate for protected data without sending a remote access query for each CSS/JS file.
      const path = String(req.url ?? '').split('?')[0];
      const isDataRequest = path === '/api' || path.startsWith('/api/');
      const p = ssoPeople.get(sid);
      if (p && isDataRequest) {
        const a = sso?.checkAccess ? await sso.checkAccess({ merchantId: sso.merchantId, userId: p.userId, role: p.role, module: 'analytics', ...(p.authSessionId ? {authSessionId:p.authSessionId} : {}) }).catch(() => null) : null;
        if (!a?.ok) { sessions.delete(sid); ssoPeople.delete(sid); return deny(res, 401, 'SESSION_REVOKED'); }
      }
      failures.delete(ip); for (const [k, v] of Object.entries(base)) res.setHeader(k, v); return true;
    }
    if (ssoOnly) return deny(res, 401, 'NORDLA_SESSION_REQUIRED');
    const supplied = basicPassword(req.headers.authorization);
    if (!supplied || !timingSafeEqual(sha(supplied), tokenHash)) {
      if (supplied) { f.n += 1; if (f.n >= 5) { f.until = now() + 5 * 60_000; f.n = 0; } failures.set(ip, f); }
      return deny(res, 401, 'ACCESS_TOKEN_REQUIRED', { 'WWW-Authenticate': 'Basic realm="Nordla Analytics (staging)", charset="UTF-8"' });
    }
    failures.delete(ip);
    for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
    return true;
  };
}
