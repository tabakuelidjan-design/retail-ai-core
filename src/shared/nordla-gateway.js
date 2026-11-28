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
const ANALYTICS_COOKIE = /^an_sid=/;
// Growth: its own __Host- session and CSRF cookies; Path=/ is required by the __Host- prefix, so they are passed unchanged.
const GROWTH_COOKIE = /^__Host-nordla_growth_(?:sid|csrf)=/;

/** The module table. `cookies` = the only cookies a module may receive (null: none). `upstreamToken` is only ever sent upstream. */
// Growth's sign-in shell: the page, its scripts and stylesheets, the shared Nordla design-system files it loads, the hosted sign-in
// script (/session.js, served by Growth only in hosted mode), and its icons. They carry no data, and the sign-in form must load before
// any session exists. Exact names only (no pattern on the page scripts), GET and HEAD only. Same lists as Growth's own server
// (src/growth/server/app.js STATIC, src/shared/nordla-static.js), checked by test/nordla-gateway.test.js.
const GROWTH_SHELL_FILES = new Set(['/', '/app.js', '/persist.js', '/guide.js', '/pipeline.js', '/agents.js', '/lang-agents.js', '/inbox.js', '/opportunities.js', '/potential.js', '/audience.js', '/content.js', '/store.js', '/dropoff.js', '/growth.css', '/lang-fr.js', '/lang-nl.js', '/lang-en.js', '/style.css', '/i18n.js', '/session.js']);
const SHARED_FILES = new Set(['/nordla-ds.css', '/nordla-tokens.css', '/nordla-charts.css', '/nordla-fonts.css', '/nordla-icon.js', '/nordla-charts.js']);
const SHARED_ASSET = /^\/nordla-assets\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(svg|png|webp|woff2))$/;
const GROWTH_ICON = /^\/growth-assets\/(?:icons|channels)\/[a-z0-9-]+\.(?:svg|png|webp)$/;

/**
 * The only Growth routes that pass the gateway without a Core session: the shell (GET/HEAD), the session-state read and the sign-in POST.
 * Growth's own server still answers them as it does today. Everything else under /growth/* (its data, its SSO hand-off, any other method
 * or path) keeps needing the Core session here, and then Growth checks its own session, role, CSRF and merchant scope.
 */
export function growthOpenRoute(method, upstreamPath) {
  if (method === 'GET' || method === 'HEAD') return GROWTH_SHELL_FILES.has(upstreamPath) || SHARED_FILES.has(upstreamPath) || SHARED_ASSET.test(upstreamPath) || GROWTH_ICON.test(upstreamPath) || upstreamPath === '/api/auth/session';
  return method === 'POST' && upstreamPath === '/api/auth/login';
}

export const MODULES = Object.freeze({
  finance: { prefix: '/finance', cookies: FINANCE_COOKIE },
  analytics: { prefix: '/analyses', cookies: ANALYTICS_COOKIE },
  growth: { prefix: '/growth', cookies: GROWTH_COOKIE, open: growthOpenRoute },
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
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 32 });
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 32 });
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
    // an open route (Growth's sign-in shell, see growthOpenRoute) needs no Core session here; the origin and proxy checks below still apply
    const decision = modules[route.key].open?.(req.method, route.upstreamPath) ? { ok: true } : await authorize(req, route.key);
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
    headers['x-nordla-public-host'] = new URL(publicOrigin).host; // Railway overwrites x-forwarded-host on the hop to a module: the module's guard takes the Nordla host from here (after the proxy secret check)
    headers['x-forwarded-proto'] = 'https';
    headers[PROXY_SECRET_HEADER] = svc.secret;
    headers['x-nordla-prefix'] = route.prefix; // the module renders its <base> for this prefix (standalone: no header, root)
    // Analytics authenticates each proxied request against the current Core session; the browser never carries a module ticket.
    if (route.key === 'analytics' && decision.identity) {
      const actor = decision.identity;
      if (/^[0-9a-f-]{36}$/i.test(String(actor.merchantId ?? '')) && /^[0-9a-f-]{36}$/i.test(String(actor.userId ?? '')) && /^[0-9a-f-]{36}$/i.test(String(actor.sessionId ?? '')) && ['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'].includes(actor.role)) {
        headers['x-nordla-identity-merchant'] = actor.merchantId;
        headers['x-nordla-identity-user'] = actor.userId;
        headers['x-nordla-identity-session'] = actor.sessionId;
        headers['x-nordla-identity-role'] = actor.role;
      }
    }
    if (svc.token) headers.authorization = `Basic ${Buffer.from(`nordla:${svc.token}`).toString('base64')}`;

    const request = upstreamRequest ?? (up.protocol === 'https:' ? https.request : http.request); // a hosted module is https (Railway)
    // connections to a module are kept open and reused: each new one costs TCP and TLS round trips (the module is in another region)
    const agent = up.protocol === 'https:' ? keepAliveHttps : keepAliveHttp;
    const gwStart = performance.now();
    const upReq = request({ host: up.hostname, port: up.port, method: req.method, path: route.upstreamPath + url.search, headers, agent }, (ur) => {
      const out = { ...ur.headers };
      for (const h of STRIP_RESPONSE) delete out[h];
      // These three trusted same-origin modules are displayed inside the authenticated Core page. Permit framing by Nordla itself only.
      // Growth is framed only when the browser itself loads it into the Core frame (same-origin iframe), so its sign-in redirect keeps working.
      if ((['analytics', 'sourcing', 'procurement'].includes(route.key) && url.searchParams.get('embedded') === '1') || (route.key === 'growth' && req.headers['sec-fetch-dest'] === 'iframe')) {
        // Core requires COEP: each embedded document must declare a compatible policy too.
        out['cross-origin-embedder-policy'] = 'require-corp';
        delete out['x-frame-options'];
        const policy = String(out['content-security-policy'] ?? '');
        out['content-security-policy'] = policy
          ? (/frame-ancestors\s+[^;]+/i.test(policy) ? policy.replace(/frame-ancestors\s+[^;]+/gi, "frame-ancestors 'self'") : `${policy}; frame-ancestors 'self'`)
          : "frame-ancestors 'self'";
      }
      if (out.location) out.location = rewriteLocation(String(out.location), up.origin, route.prefix);
      if (out['set-cookie']) {
        const cookiePattern = modules[route.key].cookies;
        const allowedCookies = cookiePattern
          ? [].concat(out['set-cookie'])
            .filter((cookie) => cookiePattern.test(String(cookie).split(';', 1)[0].trim()))
            .map((cookie) => (route.key === 'growth' ? cookie : rewriteSetCookie(cookie, route.prefix)))
          : [];
        if (allowedCookies.length) out['set-cookie'] = allowedCookies;
        else delete out['set-cookie'];
      }
      // Server-Timing: the module's own timing is kept, and the gateway adds the time it waited for the module to answer (network + module)
      out['server-timing'] = [out['server-timing'], `gw;dur=${(performance.now() - gwStart).toFixed(1)}`].filter(Boolean).join(', ');
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
    });
    upReq.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'UPSTREAM_UNAVAILABLE' }); else res.end(); });
    req.pipe(upReq);
    return true;
  };
}
