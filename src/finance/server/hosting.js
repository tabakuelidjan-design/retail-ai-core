// Hosting configuration for the Finance dashboard. Pure functions (no I/O), so they are unit-tested without a server.
//
// LOCAL (default): loopback only (127.0.0.1), port FINANCE_PORT or 4310, localhost Host allowlist, cookie over plain HTTP,
//   the token may be read from / generated into .env - exactly the historical behaviour.
// HOSTED (Railway staging): switched on explicitly by FINANCE_HOSTED=true, or automatically when Railway sets RAILWAY_ENVIRONMENT*.
//   - listens on 0.0.0.0 on process.env.PORT (never a hardcoded public port);
//   - FINANCE_ALLOWED_HOSTS is mandatory: only those exact hostnames are served (Host validation is never disabled);
//   - the session cookie carries Secure (the platform terminates HTTPS) and HSTS is sent;
//   - the client IP for rate limiting comes from the proxy's X-Forwarded-For entry, counted from the RIGHT (see clientIpOf);
//   - FINANCE_DASHBOARD_TOKEN is mandatory and no .env file is ever generated or written.

import { isIP } from 'node:net';

export class HostingConfigError extends Error {}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/** Hosted mode = explicit FINANCE_HOSTED, or a Railway-injected environment marker. PORT alone does not switch it on. */
export const isHosted = (env = process.env) => truthy(env.FINANCE_HOSTED) || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);

/** "a.up.railway.app, B.example.com" -> ['a.up.railway.app', 'b.example.com']. Hostnames only (optionally host:port); no scheme, path or wildcard. */
export function parseAllowedHosts(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const h = part.trim().toLowerCase();
    if (!h) continue;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(h)) throw new HostingConfigError(`FINANCE_ALLOWED_HOSTS: "${part.trim()}" is not a plain hostname (no scheme, path, wildcard or spaces).`);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** Resolve the whole hosting configuration from the environment. Throws HostingConfigError with an actionable message. */
export function resolveHosting(env = process.env) {
  if (!isHosted(env)) {
    return { hosted: false, host: '127.0.0.1', port: Number(env.FINANCE_PORT || 4310), allowedHosts: null, secureCookie: false, trustProxyHops: 0, tokenRequired: false };
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostingConfigError('Hosted mode needs the platform PORT environment variable (a port number). Railway sets it automatically.');
  const allowedHosts = parseAllowedHosts(env.FINANCE_ALLOWED_HOSTS);
  if (!allowedHosts.length) throw new HostingConfigError('Hosted mode needs FINANCE_ALLOWED_HOSTS: the exact public hostname(s), comma-separated (for example your-service.up.railway.app).');
  const hopsRaw = env.FINANCE_TRUST_PROXY_HOPS;
  const trustProxyHops = hopsRaw === undefined || hopsRaw === '' ? 1 : Number(hopsRaw);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new HostingConfigError('FINANCE_TRUST_PROXY_HOPS must be an integer between 0 and 5 (default 1: one trusted reverse proxy).');
  if (!env.FINANCE_DASHBOARD_TOKEN || String(env.FINANCE_DASHBOARD_TOKEN).length < 24) throw new HostingConfigError('Hosted mode needs FINANCE_DASHBOARD_TOKEN (at least 24 characters) set in the platform variables. No .env file is generated on a host.');
  return { hosted: true, host: '0.0.0.0', port, allowedHosts, secureCookie: true, trustProxyHops, tokenRequired: true };
}

/**
 * Client IP used by the login rate limiter. With no trusted proxy it is the socket address. Behind N trusted proxies the real peer is
 * the entry N-from-the-right of X-Forwarded-For (each trusted proxy appends the address it saw): entries to its left can be forged by
 * the client and are never used. An unusable header falls back to the socket address, so a client cannot dodge the limiter by
 * sending garbage.
 */
export function clientIpOf(req, trustProxyHops = 0) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  if (!trustProxyHops) return socketIp;
  const parts = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = parts.length >= trustProxyHops ? parts[parts.length - trustProxyHops] : undefined;
  return candidate && isIP(candidate) ? candidate : socketIp;
}
