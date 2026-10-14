// HOSTED mode of the China Sourcing server (a permanent server, no Windows PC, no temporary tunnel). Opt-in with SOURCING_HOSTED=1; without it the
// server behaves exactly as before (loopback by default, phone mode through a quick tunnel).
// In hosted mode the server listens on a non-loopback interface INSIDE a private network, behind a TLS reverse proxy that authenticates the person
// first (deploy/sourcing/: Caddy, owner password); the app token stays a second, independent check on every /api call. The configuration must be
// complete or nothing starts - each missing piece is refused with its own code:
//   SOURCING_TOKEN          >= 32 characters, from the environment (never generated into a file on the server, never printed)
//   SOURCING_ALLOWED_HOSTS  the public host name(s) the proxy serves (Host allow-list: blocks DNS rebinding; an empty list would accept any Host)
//   SOURCING_MERCHANT_ID    the merchant this server works for (or SOURCING_MERCHANT_PROFILE): a hosted server never runs without a named tenant
// Optional: SOURCING_HOST (default 0.0.0.0), SOURCING_DATA_DIR (default data/local/sourcing, a mounted volume in the container).
export class HostedConfigError extends Error { constructor(code, message) { super(message); this.name = 'HostedConfigError'; this.code = code; } }

export const HOSTED_TOKEN_MIN = 32;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const isHosted = (env = process.env) => String(env.SOURCING_HOSTED ?? '').trim() === '1';

/** @returns {{ host: string, allowedHosts: string[], dataDir: string }} or throws HostedConfigError. Pure: reads only `env`. */
export function hostedConfig(env = process.env) {
  const token = String(env.SOURCING_TOKEN ?? '');
  if (token.length < HOSTED_TOKEN_MIN) throw new HostedConfigError('HOSTED_TOKEN_REQUIRED', `hosted mode needs SOURCING_TOKEN of at least ${HOSTED_TOKEN_MIN} characters in the environment`);
  const allowedHosts = String(env.SOURCING_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowedHosts.length) throw new HostedConfigError('HOSTED_ALLOWED_HOSTS_REQUIRED', 'hosted mode needs SOURCING_ALLOWED_HOSTS (the public host name served by the proxy)');
  const bad = allowedHosts.filter((h) => !HOST_NAME.test(h));
  if (bad.length) throw new HostedConfigError('HOSTED_ALLOWED_HOSTS_INVALID', `not a host name: ${bad.join(', ')} (no scheme, port, path or wildcard)`);
  if (!String(env.SOURCING_MERCHANT_ID ?? '').trim() && !String(env.SOURCING_MERCHANT_PROFILE ?? '').trim()) throw new HostedConfigError('HOSTED_MERCHANT_REQUIRED', 'hosted mode needs SOURCING_MERCHANT_ID (or SOURCING_MERCHANT_PROFILE): no merchant is guessed');
  return { host: String(env.SOURCING_HOST ?? '').trim() || '0.0.0.0', allowedHosts, dataDir: String(env.SOURCING_DATA_DIR ?? '').trim() || 'data/local/sourcing' };
}
