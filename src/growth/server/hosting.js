// Growth listening rules. Local development: loopback only, the port from GROWTH_PORT. Hosted (Railway): every interface on the platform
// PORT, with the exact public host names required (GROWTH_ALLOWED_HOSTS) and the Core gateway's proxy secret required (NORDLA_PROXY_SECRET).
// A request with any other Host is refused before anything is read; a request without the proxy secret is refused by the app itself.
import http from 'node:http';
import { requiredProxySecret } from '../../shared/proxy-secret.js';

export class GrowthHostingError extends Error {}

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase());
export const isHosted = (env = process.env) => truthy(env.GROWTH_HOSTED) || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);

/** Exact, lower-case host names, comma-separated. No scheme, path, wildcard or space. */
export function parseAllowedHosts(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const h = part.trim().toLowerCase();
    if (!h) continue;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(h)) throw new GrowthHostingError(`GROWTH_ALLOWED_HOSTS: "${part.trim()}" is not a plain host name (no scheme, path, wildcard or spaces).`);
    out.push(h);
  }
  return out;
}

/** The listening plan for this environment. Throws GrowthHostingError (naming the variable, never its value) when hosted settings are missing. */
export function resolveGrowthListen(env = process.env) {
  if (!isHosted(env)) {
    const port = Number(env.GROWTH_PORT || 4413);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new GrowthHostingError('GROWTH_PORT must be a port number.');
    return { hosted: false, host: '127.0.0.1', port, allowedHosts: ['127.0.0.1', 'localhost'], proxySecret: env.NORDLA_PROXY_SECRET ? String(env.NORDLA_PROXY_SECRET) : null };
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GrowthHostingError('Hosted mode needs the platform PORT variable (a port number). Railway sets it.');
  const allowedHosts = parseAllowedHosts(env.GROWTH_ALLOWED_HOSTS);
  if (!allowedHosts.length) throw new GrowthHostingError('Hosted mode needs GROWTH_ALLOWED_HOSTS: the exact public host name(s), comma-separated.');
  let proxySecret;
  try { proxySecret = requiredProxySecret(env); } catch { throw new GrowthHostingError('Hosted mode needs NORDLA_PROXY_SECRET (at least 24 characters), the same value as on the Core.'); }
  return { hosted: true, host: '0.0.0.0', port, allowedHosts, proxySecret };
}

/** Refuses, before the app sees it, any request whose Host is not one of the allowed host names. */
export function withHostCheck(allowedHosts, handler) {
  return (req, res) => {
    const host = String(req.headers.host ?? '').trim().toLowerCase();
    const name = host.replace(/:\d+$/, '');
    if (!allowedHosts.includes(host) && !allowedHosts.includes(name)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'HOST_NOT_ALLOWED' } }));
      return undefined;
    }
    return handler(req, res);
  };
}

/** Starts the Growth server according to the plan. Returns the listening server. */
export function listenGrowth({ env = process.env, createHandler, log = () => {} } = {}) {
  const plan = resolveGrowthListen(env);
  const handler = withHostCheck(plan.allowedHosts, createHandler(plan));
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(plan.port, plan.host, () => { log(`Nordla Growth listening on ${plan.host}:${server.address().port} (${plan.hosted ? 'hosted' : 'local'}; hosts: ${plan.allowedHosts.join(', ')})`); resolve({ server, plan }); });
  });
}
