// Nordla gateway: the modules that run as their own services are served under the Core origin (https://<nordla>/finance, /analytics, /growth).
// One route table, one set of rules, used by Core for every module:
//   * the module prefix is removed before the request reaches the service, and every redirect / session cookie is rewritten back under it;
//   * the browser's own cookies never reach a service except the ones that module owns (filter per route);
//   * the browser's Authorization header is never forwarded, a module's server-side token (if any) is added here and never sent to the browser;
//   * a route is closed (403) unless the module is enabled, and every request needs a Core session (authorize) before it is proxied;
//   * a service refuses any request without the shared proxy secret (see the module's own server), so a direct call to it fails.
// Pure rules are exported on their own so they can be tested without a network.

import http from 'node:http';
import https from 'node:https';

export const PROXY_SECRET_HEADER = 'x-nordla-proxy-secret';
const FINANCE_COOKIE = /^fin_(?:demo_)?sid=/;

/** The module table. `cookies` = the only cookies a module may receive (null: none). `upstreamToken` is only ever sent upstream. */
export const MODULES = Object.freeze({
  finance: { prefix: '/finance', cookies: FINANCE_COOKIE },
  analytics: { prefix: '/analytics', cookies: null },
  growth: { prefix: '/growth', cookies: null },
});

/** Which module (and which upstream path) a request on the Nordla origin belongs to, or null (Core's own paths). */
export function routeFor(pathname, modules = MODULES) {
  for (const [key, m] of Object.entries(modules)) {
    if (pathname === m.prefix || pathname.startsWith(m.prefix + '/')) return { key, prefix: m.prefix, upstreamPath: pathname.slice(m.prefix.length) || '/' };
  }
  return null;
}

/** A Location from a service becomes an address under the module prefix on the Nordla origin. Foreign addresses are untouched. */
export function rewriteLocation(loc, upstreamOrigin, prefix = '/finance') {
  if (loc.startsWith('/') && !loc.startsWith('//')) return prefix + loc;
  try { const u = new URL(loc); if (u.origin === upstreamOrigin) return prefix + u.pathname + u.search + u.hash; } catch { /* relative or foreign: unchanged */ }
  return loc;
}

/** A module's cookie is scoped to its prefix on the Nordla origin (Path=/ becomes Path=<prefix>). */
export function rewriteSetCookie(c, prefix = '/finance') { return c.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${prefix}`); }

/** Only the cookies a module owns go to it. `pattern` null: none. */
export function filterCookies(cookieHeader, pattern = FINANCE_COOKIE) {
  if (!cookieHeader || !pattern) return undefined;
  return cookieHeader.split(';').map((c) => c.trim()).filter((c) => pattern.test(c)).join('; ') || undefined;
}

/** Same-origin mutations only: the browser's Origin must be the public origin (rewritten to the upstream), anything else is refused. */
export function originDecision(origin, publicOrigin, upstreamOrigin) {
  if (!origin) return { ok: true, origin: undefined };
  if (origin === publicOrigin) return { ok: true, origin: upstreamOrigin };
  return { ok: false, status: 403, code: 'ORIGIN_NOT_ALLOWED' };
}

const STRIP_REQUEST = ['authorization', 'cookie', 'origin', 'host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip'];
const STRIP_RESPONSE = ['www-authenticate']; // a service's Basic prompt must never open a browser dialog on the Nordla origin

/**
 * @param {object} o
 * @param {string} o.publicOrigin  the Nordla origin, e.g. https://staging.nordla.app
 * @param {Record<string, {upstream: string, enabled: boolean, token?: string, secret: string}>} o.services  per module key (MODULES)
 * @param {(req: http.IncomingMessage, key: string) => Promise<{ok: true} | {ok: false, status: number, code: string}>} o.authorize  the Core session check (required)
 * @returns {(req, res, url: URL) => Promise<boolean>} true when the request was handled here (proxied or refused); false for Core's own paths
 */
// upstreamRequest: the transport to a module (tests inject one to reach a local service); production uses http or https by the module address.
export function createGateway({ publicOrigin, services, authorize, modules = MODULES, upstreamRequest = null }) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  return async function handle(req, res, url) {
    const route = routeFor(url.pathname, modules);
    if (!route) return false;
    const svc = services[route.key];
    if (!svc?.enabled) { json(res, 403, { error: 'MODULE_CLOSED', message: 'Ce module n’est pas encore ouvert depuis Nordla.' }); return true; }
    // a read-only module (services[key].readOnly): any change is refused here, before any session or upstream work
    if (svc.readOnly && !['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
    if (url.pathname === route.prefix) { res.writeHead(301, { location: route.prefix + '/' + url.search, 'cache-control': 'no-store' }); res.end(); return true; }
    const decision = await authorize(req, route.key);
    if (!decision?.ok) { json(res, decision?.status ?? 401, { error: decision?.code ?? 'SESSION_REQUIRED' }); return true; }
    const od = originDecision(req.headers.origin, publicOrigin, new URL(svc.upstream).origin);
    if (!od.ok) { json(res, od.status, { error: od.code }); return true; }

    const up = new URL(svc.upstream);
    const headers = { ...req.headers };
    for (const h of STRIP_REQUEST) delete headers[h];
    for (const h of Object.keys(headers)) if (h.startsWith('x-nordla-')) delete headers[h];
    const cookie = filterCookies(req.headers.cookie, modules[route.key].cookies);
    if (cookie) headers.cookie = cookie;
    if (od.origin) headers.origin = od.origin;
    headers.host = up.host;
    headers['x-forwarded-host'] = new URL(publicOrigin).host;
    headers['x-forwarded-proto'] = 'https';
    headers[PROXY_SECRET_HEADER] = svc.secret;
    headers['x-nordla-prefix'] = route.prefix; // the module renders its <base> for this prefix (standalone: no header, root)
    if (svc.token) headers.authorization = `Basic ${Buffer.from(`nordla:${svc.token}`).toString('base64')}`;

    const request = upstreamRequest ?? (up.protocol === 'https:' ? https.request : http.request); // a hosted module is https (Railway)
    const upReq = request({ host: up.hostname, port: up.port, method: req.method, path: route.upstreamPath + url.search, headers }, (ur) => {
      const out = { ...ur.headers };
      for (const h of STRIP_RESPONSE) delete out[h];
      if (out.location) out.location = rewriteLocation(String(out.location), up.origin, route.prefix);
      if (out['set-cookie']) out['set-cookie'] = modules[route.key].cookies ? [].concat(out['set-cookie']).map((c) => rewriteSetCookie(c, route.prefix)) : undefined;
      if (out['set-cookie'] === undefined) delete out['set-cookie'];
      // Finance is rendered inside Core's central page. The upstream still denies embedding directly; only this authenticated Core route permits its own origin.
      if (route.key === 'finance') {
        const policy = String(out['content-security-policy'] ?? '');
        const withoutAncestors = policy.replace(/(?:^|;)\s*frame-ancestors\s+[^;]*/i, '').replace(/;\s*$/, '');
        out['content-security-policy'] = `${withoutAncestors ? withoutAncestors + '; ' : ''}frame-ancestors 'self'`;
        out['x-frame-options'] = 'SAMEORIGIN';
      }
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
    });
    upReq.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'UPSTREAM_UNAVAILABLE' }); else res.end(); });
    req.pipe(upReq);
    return true;
  };
}
