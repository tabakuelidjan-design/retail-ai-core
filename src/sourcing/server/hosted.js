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
// Project pin (staging / production separation): NORDLA_SUPABASE_PROJECT_REF names the ONE Supabase project this server may use. SUPABASE_URL must
// be exactly https://<ref>.supabase.co, and a JWT-shaped Supabase key whose payload names another project is refused (the key is never printed).
// Required on Railway (RAILWAY_* variables present), where a staging service must never reach production by a pasted URL or key; elsewhere it
// is checked when set.
export class HostedConfigError extends Error { constructor(code, message) { super(message); this.name = 'HostedConfigError'; this.code = code; } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const onRailway = (env) => Boolean(String(env.RAILWAY_SERVICE_ID ?? env.RAILWAY_ENVIRONMENT_ID ?? env.RAILWAY_PROJECT_ID ?? '').trim());
/** The `ref` claim of a JWT-shaped Supabase key (legacy anon / service_role keys), or null (opaque key, unreadable payload). Never returns the key. */
const keyRef = (key) => {
  const parts = String(key ?? '').trim().split('.'); if (parts.length !== 3) return null;
  try { const ref = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.ref; return typeof ref === 'string' ? ref : null; } catch { return null; }
};

/** @returns {string|null} the verified project ref, or null when no pin is required nor set. Throws HostedConfigError. */
export function supabaseProjectPin(env = process.env) {
  const ref = String(env.NORDLA_SUPABASE_PROJECT_REF ?? '').trim().toLowerCase();
  if (!ref) {
    if (onRailway(env)) throw new HostedConfigError('HOSTED_SUPABASE_PROJECT_REQUIRED', 'on Railway, NORDLA_SUPABASE_PROJECT_REF must name the one Supabase project this service may use (staging and production are never mixed)');
    return null;
  }
  if (!PROJECT_REF.test(ref)) throw new HostedConfigError('HOSTED_SUPABASE_PROJECT_INVALID', 'NORDLA_SUPABASE_PROJECT_REF must be a Supabase project ref (20 lowercase letters or digits)');
  let url; try { url = new URL(String(env.SUPABASE_URL ?? '').trim()); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.hostname !== `${ref}.supabase.co` || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HostedConfigError('HOSTED_SUPABASE_PROJECT_MISMATCH', `SUPABASE_URL is not https://${ref}.supabase.co: this service is pinned to project ${ref} and refuses any other (the address is not printed)`);
  }
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) {
    const r = keyRef(env[k]);
    if (r !== null && r !== ref) throw new HostedConfigError('HOSTED_SUPABASE_KEY_MISMATCH', `${k} belongs to another Supabase project than ${ref} (the key is not printed)`);
  }
  return ref;
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const isHosted = (env = process.env) => String(env.SOURCING_HOSTED ?? '').trim() === '1';

/** @returns {{ host, merchantId, origin, allowedHosts, dataDir, supabaseRef }} or throws HostedConfigError. Pure: reads only `env` (secrets are checked by the identity / security layers). */
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
  const supabaseRef = supabaseProjectPin(env);
  return { host: String(env.SOURCING_HOST ?? '').trim() || '0.0.0.0', merchantId, origin: origin.origin, allowedHosts: [origin.hostname], dataDir: String(env.SOURCING_DATA_DIR ?? '').trim() || 'data/local/sourcing', supabaseRef };
}

/**
 * Live check of a PINNED project at start (covers every key format: legacy JWT keys AND opaque sb_publishable_ / sb_secret_ keys, which do not
 * name their project). Every request goes to the pinned https://<ref>.supabase.co only, so a key of another project (production) is REJECTED
 * by that project's gateway: the service then refuses to start. The merchant must also exist in the pinned project (the production merchant
 * id does not exist in staging). An unreachable project is not a proof either way: logged, and sign-in stays closed until it answers.
 * @returns {Promise<'VERIFIED'|'UNVERIFIED_UNREACHABLE'>} or throws HostedConfigError. Never prints a key.
 */
export async function verifyPinnedProject(env, hosted, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!hosted?.supabaseRef) return 'NOT_PINNED';
  const base = `https://${hosted.supabaseRef}.supabase.co`;
  const ask = async (path, key) => {
    try { return await fetchImpl(`${base}${path}`, { headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
  };
  const service = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(); const anon = String(env.SUPABASE_ANON_KEY ?? '').trim();
  const row = await ask(`/rest/v1/merchants?select=id&id=eq.${encodeURIComponent(hosted.merchantId)}`, service);
  const auth = await ask('/auth/v1/settings', anon);
  for (const [r, k] of [[row, 'SUPABASE_SERVICE_ROLE_KEY'], [auth, 'SUPABASE_ANON_KEY']]) {
    if (r && (r.status === 401 || r.status === 403)) throw new HostedConfigError('HOSTED_SUPABASE_KEY_REJECTED', `${k} is refused by project ${hosted.supabaseRef} (a key of another project, e.g. production, or a revoked key); the key is not printed`);
  }
  if (!row || !auth || row.status >= 500 || auth.status >= 500) return 'UNVERIFIED_UNREACHABLE';
  if (!row.ok || !auth.ok) throw new HostedConfigError('HOSTED_SUPABASE_CHECK_FAILED', `project ${hosted.supabaseRef} answered ${row.status} / ${auth.status} to the start-up check`);
  let rows; try { rows = await row.json(); } catch { rows = null; }
  if (!Array.isArray(rows) || rows.length !== 1) throw new HostedConfigError('HOSTED_MERCHANT_NOT_IN_PROJECT', `merchant ${hosted.merchantId} does not exist in project ${hosted.supabaseRef}: wrong NORDLA_MERCHANT_ID for this project`);
  return 'VERIFIED';
}
