// HOSTED mode of the China Sourcing server (a permanent server, no Windows PC, no temporary tunnel). Opt-in with SOURCING_HOSTED=1; without it the
// server behaves exactly as before (loopback by default, phone mode through a quick tunnel, development token).
//
// A hosted server is reachable from the internet, so a development token is NEVER its security: a person signs in with the Core identity
// (Supabase Auth account + ACTIVE membership of THIS merchant + 'sourcing' module ACTIVE) and gets a Nordla session (session-gate.js).
// The configuration must be complete or nothing starts - each missing piece is refused with its own code:
//   NORDLA_MERCHANT_ID            the merchant (UUID) this server works for: never taken from a request
//   SOURCING_PUBLIC_ORIGIN        the exact public origin, https only (e.g. https://app.nordla.app); its host is the only Host accepted
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY   the server's database client and Supabase Auth (identity)
//   NORDLA_IDENTITY_RATE_LIMIT_KEY, NORDLA_CSRF_KEY             two different secrets, >= 32 bytes each (checked by identity / security)
//   SOURCING_MERCHANT_ID or SOURCING_MERCHANT_PROFILE           the merchant's sourcing profile (fit checklist data)
// Behind Railway (proxy headers X-Real-IP / X-Forwarded-Proto / X-Forwarded-Host, as src/security expects).
// Optional: SOURCING_HOST (default 0.0.0.0), SOURCING_DATA_DIR (default data/local/sourcing, a mounted volume).
export class HostedConfigError extends Error { constructor(code, message) { super(message); this.name = 'HostedConfigError'; this.code = code; } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const isHosted = (env = process.env) => String(env.SOURCING_HOSTED ?? '').trim() === '1';

/** @returns {{ host, merchantId, origin, allowedHosts, dataDir }} or throws HostedConfigError. Pure: reads only `env` (secrets are checked by the identity / security layers). */
export function hostedConfig(env = process.env) {
  const merchantId = String(env.NORDLA_MERCHANT_ID ?? '').trim().toLowerCase();
  if (!UUID.test(merchantId)) throw new HostedConfigError('HOSTED_MERCHANT_REQUIRED', 'hosted mode needs NORDLA_MERCHANT_ID (the merchant UUID): no merchant is guessed');
  let origin; try { origin = new URL(String(env.SOURCING_PUBLIC_ORIGIN ?? '').trim()); } catch { origin = null; }
  if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.port || !HOST_NAME.test(origin.hostname)) {
    throw new HostedConfigError('HOSTED_ORIGIN_REQUIRED', 'hosted mode needs SOURCING_PUBLIC_ORIGIN: the exact https origin (https://host, no port, path or wildcard)');
  }
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'NORDLA_IDENTITY_RATE_LIMIT_KEY', 'NORDLA_CSRF_KEY']) {
    if (!String(env[k] ?? '').trim()) throw new HostedConfigError('HOSTED_IDENTITY_REQUIRED', `hosted mode needs ${k}: the Core identity is the only sign-in of a public server`);
  }
  if (!String(env.SOURCING_MERCHANT_ID ?? '').trim() && !String(env.SOURCING_MERCHANT_PROFILE ?? '').trim()) throw new HostedConfigError('HOSTED_PROFILE_REQUIRED', 'hosted mode needs SOURCING_MERCHANT_ID (or SOURCING_MERCHANT_PROFILE): the merchant sourcing profile');
  return { host: String(env.SOURCING_HOST ?? '').trim() || '0.0.0.0', merchantId, origin: origin.origin, allowedHosts: [origin.hostname], dataDir: String(env.SOURCING_DATA_DIR ?? '').trim() || 'data/local/sourcing' };
}
