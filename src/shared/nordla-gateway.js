import { MODULE_REGISTRY } from './module-registry.js';
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
// The public prefixes come from the module registry (one source). Only the cookie policy stays here: it is a server-side transport rule.
// Growth reads its own module cookies (__Host-nordla_growth_*), forwarded as they are, never renamed.
const COOKIE_POLICY = Object.freeze({
  finance: FINANCE_COOKIE,
  analytics: null,
  growth: /^__Host-nordla_growth_(?:sid|csrf)=/,
});
export const MODULES = Object.freeze(Object.fromEntries(MODULE_REGISTRY.map((m) => [m.key, Object.freeze({ prefix: m.prefix, cookies: COOKIE_POLICY[m.key] ?? null })])));

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
// A __Host- cookie must keep Path=/ (the browser refuses any other path): it is never rewritten.
export function rewriteSetCookie(c, prefix = '/finance') { if (/^__Host-/.test(c)) return c; return c.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${prefix}`); }

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
export function createGateway({ publicOrigin, services, authorize, modules = MODULES, upstreamRequest = null, publicRoutes = [] }) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  return async function handle(req, res, url) {
    const route = routeFor(url.pathname, modules);
    if (!route) return false;
    const svc = services[route.key];
    if (!svc?.enabled) { json(res, 403, { error: 'MODULE_CLOSED', message: 'Ce module n’est pas encore ouvert depuis Nordla.' }); return true; }
    // a read-only module (services[key].readOnly): any change is refused here, before any session or upstream work
    if (svc.readOnly && !['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
    if (url.pathname === route.prefix) { res.writeHead(301, { location: route.prefix + '/' + url.search, 'cache-control': 'no-store' }); res.end(); return true; }
    // A module's own sign-in form posts BEFORE any session exists: that one route is let through (the module checks the credentials itself,
    // with its own rate limit). Every other module route still needs the Core session.
    const isPublic = publicRoutes.some((p) => p.method === req.method && (p.path === url.pathname || (p.pattern && p.pattern.test(url.pathname))));
    const decision = isPublic ? { ok: true } : await authorize(req, route.key);
    if (!decision?.ok) { json(res, decision?.status ?? 401, { error: decision?.code ?? 'SESSION_REQUIRED' }); return true; }
    if (route.prefix && url.pathname === route.prefix + PREFIX_SHIM_PATH) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); res.end(PREFIX_SHIM_JS); return true; }
    const od = originDecision(req.headers.origin, publicOrigin, new URL(svc.upstream).origin);
    if (!od.ok) { json(res, od.status, { error: od.code }); return true; }

    const up = new URL(svc.upstream);
    const headers = { ...req.headers };
    for (const h of STRIP_REQUEST) delete headers[h];
    for (const h of Object.keys(headers)) if (h.startsWith('x-nordla-')) delete headers[h];
    const cookie = filterCookies(req.headers.cookie, modules[route.key].cookies);
    if (cookie) headers.cookie = cookie;
    // The module checks the Origin of its own writes against the Nordla address it is served under (Growth). Finance keeps its own origin rule.
    if (od.origin) headers.origin = route.key === 'growth' ? publicOrigin : od.origin;
    headers.host = up.host;
    headers['x-forwarded-host'] = new URL(publicOrigin).host;
    // Railway overwrites x-forwarded-host on the hop to a module service: the Nordla host travels in its own header, read only after the module proxy-secret check.
    headers['x-nordla-public-host'] = new URL(publicOrigin).host;
    headers['x-forwarded-proto'] = 'https';
    headers[PROXY_SECRET_HEADER] = svc.secret;
    // The module's proxy check (Railway) needs the real client address: the one Railway gave THIS Core request, passed on as is.
    const realIp = String(req.headers['x-real-ip'] ?? '').trim();
    if (realIp) { headers['x-real-ip'] = realIp; headers['x-forwarded-for'] = realIp; }
    headers['x-nordla-prefix'] = route.prefix; // the module renders its <base> for this prefix (standalone: no header, root)
    if (svc.token) headers.authorization = `Basic ${Buffer.from(`nordla:${svc.token}`).toString('base64')}`;

    const request = upstreamRequest ?? (up.protocol === 'https:' ? https.request : http.request); // a hosted module is https (Railway)
    // connections to a module are kept open and reused: each new one costs TCP and TLS round trips (the module is in another region)
    const agent = up.protocol === 'https:' ? keepAliveHttps : keepAliveHttp;
    const gwStart = performance.now();
    const upReq = request({ host: up.hostname, port: up.port, method: req.method, path: route.upstreamPath + url.search, headers, agent }, (ur) => {
      const out = { ...ur.headers };
      for (const h of STRIP_RESPONSE) delete out[h];
      if (out.location) out.location = rewriteLocation(String(out.location), up.origin, route.prefix);
      if (out['set-cookie']) out['set-cookie'] = modules[route.key].cookies ? [].concat(out['set-cookie']).map((c) => rewriteSetCookie(c, route.prefix)) : undefined;
      // Growth's sign-in form sets the Core session cookies (a new value). A CLEARING Set-Cookie (empty value or Max-Age=0, e.g. on a refused
      // session) must never reach the browser: it would sign the person out of Core. Only real sign-in cookies pass.
      if (route.key === 'growth' && out['set-cookie']) {
        const kept = [].concat(out['set-cookie']).filter((c) => /^__Host-nordla_growth_(?:sid|csrf)=[^;]+/.test(c) && !/max-age=0/i.test(c));
        out['set-cookie'] = kept.length ? kept : undefined;
      }
      if (out['set-cookie'] === undefined) delete out['set-cookie'];
      // Server-Timing: the module's own timing is kept, and the gateway adds the time it waited for the module to answer (network + module)
      out['server-timing'] = [out['server-timing'], `gw;dur=${(performance.now() - gwStart).toFixed(1)}`].filter(Boolean).join(', ');
      if (route.prefix && String(out['content-type'] ?? '').startsWith('text/html')) { // module page: root paths move under the prefix
        const chunks = []; ur.on('data', (c) => chunks.push(c)); ur.on('end', () => { const html = rewriteHtmlForPrefix(Buffer.concat(chunks).toString('utf8'), route.prefix); delete out['content-length']; res.writeHead(ur.statusCode, out); res.end(html); }); return;
      }
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
    });
    upReq.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'UPSTREAM_UNAVAILABLE' }); else res.end(); });
    req.pipe(upReq);
    return true;
  };
}

// ---- module pages under the Core address: root paths move under the prefix; the browser shim sends root-path fetches under it too.
export const PREFIX_SHIM_PATH = '/__nordla/prefix.js';
export const PREFIX_SHIM_JS = `(function () {
  var m = /^\\/(finance|analyses|growth)(\\/|$)/.exec(location.pathname);
  if (!m) return;
  var P = '/' + m[1];
  var f = window.fetch;
  window.fetch = function (input, init) {
    // Core's own endpoints (/api/core/..., the shared rail's registry) stay on the Nordla origin: they are never sent under the module.
    if (typeof input === 'string' && input.charAt(0) === '/' && input.charAt(1) !== '/' && input.indexOf(P + '/') !== 0 && input.indexOf('/api/core/') !== 0 && input.indexOf('/nordla-') !== 0) input = P + input;
    return f.call(this, input, init);
  };
})();`;
export function rewriteHtmlForPrefix(html, prefix) {
  // a path already under the prefix (e.g. the module's own <base href="/finance/">) is left as it is: no double prefix
  const already = `${prefix.slice(1)}/`;
  // Core's shared frame files (/nordla-core-rail.*) are served by Core at the root, never by the module: they are not prefixed.
  const withPaths = html.replace(new RegExp(`(\\s(?:href|src|action)=["'])\\/(?!\\/|${already}|nordla-core-rail\\.)`, 'g'), `$1${prefix}/`);
  const tag = `<script src="${prefix}${PREFIX_SHIM_PATH}"></script>`;
  return /<head[^>]*>/i.test(withPaths) ? withPaths.replace(/<head[^>]*>/i, (h) => h + tag) : tag + withPaths;
}
