// Nordla identity - server-side e-mail + password verification with Supabase Auth (ADR 0004, D1 / D6; Core C1b).
//
//   1. POST {SUPABASE_URL}/auth/v1/token?grant_type=password   (apikey = SUPABASE_ANON_KEY)   -> 200 { access_token, refresh_token, user }
//   2. POST {SUPABASE_URL}/auth/v1/logout?scope=local          (Authorization: Bearer <access_token>)
//      Closes ONLY the temporary Supabase session this verification just opened. The scope is ALWAYS passed explicitly as 'local':
//      Supabase's default scope is 'global' (it would sign the person out of every device), which must never happen here.
//   3. Returns { ok: true, userId } - nothing else. The access and refresh tokens live only in local variables of verifyPassword(),
//      are never stored, logged, returned or put in an error, and the references are dropped before returning. (JavaScript cannot
//      wipe string memory; the strings become unreachable and are reclaimed by the garbage collector.)
//
// Failures: { ok: false, kind: 'INVALID' } when Supabase refuses the credentials (unknown address, wrong password, refused account -
// indistinguishable on purpose), { ok: false, kind: 'UNAVAILABLE', reason } when Supabase cannot answer (timeout, network, 5xx, 429,
// invalid response). Every request has an explicit timeout with AbortController. The browser never talks to Supabase.

export const AUTH_TIMEOUT_MS = 8_000;
export const LOGOUT_TIMEOUT_MS = 3_000;
export const LOGOUT_SCOPE = 'local';
export const UNAVAILABLE_REASONS = Object.freeze(['TIMEOUT', 'NETWORK', 'HTTP_5XX', 'PROVIDER_RATE_LIMITED', 'INVALID_RESPONSE']);
const MAX_PASSWORD_LENGTH = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GoTrueConfigError extends Error {
  constructor(variable, message) { super(message); this.name = 'GoTrueConfigError'; this.code = 'GOTRUE_CONFIG_INVALID'; this.variable = variable; }
}

/** SUPABASE_URL (https, or http on a loopback host for local tests) and SUPABASE_ANON_KEY. Values are never echoed in errors. */
export function loadGoTrueConfig(env = process.env) {
  const rawUrl = String(env.SUPABASE_URL ?? '').trim();
  let url;
  try { url = new URL(rawUrl); } catch { throw new GoTrueConfigError('SUPABASE_URL', 'SUPABASE_URL is missing or is not a URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new GoTrueConfigError('SUPABASE_URL', 'SUPABASE_URL must be an https URL (http only on a loopback host).');
  }
  const anonKey = String(env.SUPABASE_ANON_KEY ?? '').trim();
  if (anonKey.length < 20) throw new GoTrueConfigError('SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY is missing or too short.');
  return Object.freeze({ baseUrl: url.origin, anonKey });
}

/** fetch with a hard timeout (AbortController). Resolves to { status, json } or throws { name: 'TimeoutError' | network error name }. */
async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } catch (e) {
    const err = new Error(controller.signal.aborted ? 'timeout' : 'network');
    err.name = controller.signal.aborted ? 'TimeoutError' : 'NetworkError';
    throw err;
  } finally { clearTimeout(timer); }
}

/**
 * @param {{ config: ReturnType<typeof loadGoTrueConfig>, fetchImpl?: typeof fetch, timeoutMs?: number, logoutTimeoutMs?: number }} deps
 */
export function createGoTrueVerifier({ config, fetchImpl = globalThis.fetch, timeoutMs = AUTH_TIMEOUT_MS, logoutTimeoutMs = LOGOUT_TIMEOUT_MS } = {}) {
  if (!config || !config.baseUrl || !config.anonKey) throw new TypeError('createGoTrueVerifier needs a config from loadGoTrueConfig()');
  if (typeof fetchImpl !== 'function') throw new TypeError('createGoTrueVerifier needs fetch');
  const base = { apikey: config.anonKey, 'Content-Type': 'application/json', Accept: 'application/json' };

  /**
   * Verifies an already normalised e-mail address and a password.
   * @returns {Promise<{ ok: true, userId: string, localLogout: 'DONE'|'FAILED' } | { ok: false, kind: 'INVALID' } | { ok: false, kind: 'UNAVAILABLE', reason: string }>}
   */
  async function verifyPassword(email, password) {
    if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, kind: 'INVALID' };
    }
    let res;
    try {
      res = await timedFetch(fetchImpl, `${config.baseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: base, body: JSON.stringify({ email, password }) }, timeoutMs);
    } catch (e) {
      return { ok: false, kind: 'UNAVAILABLE', reason: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK' };
    }
    if (res.status === 429) return { ok: false, kind: 'UNAVAILABLE', reason: 'PROVIDER_RATE_LIMITED' };
    if (res.status >= 500) return { ok: false, kind: 'UNAVAILABLE', reason: 'HTTP_5XX' };
    if (res.status !== 200) return { ok: false, kind: 'INVALID' }; // 400 / 401 / 403 / 422: refused credentials, whatever the detail

    let access = typeof res.json?.access_token === 'string' ? res.json.access_token : null;
    let refresh = typeof res.json?.refresh_token === 'string' ? res.json.refresh_token : null; // never used: dropped below
    const userId = typeof res.json?.user?.id === 'string' && UUID.test(res.json.user.id) ? res.json.user.id.toLowerCase() : null;
    const wellFormed = Boolean(access) && Boolean(refresh) && Boolean(userId);
    res = null;
    let localLogout = 'FAILED';
    try {
      if (access) {
        // Close the temporary Supabase session: scope=local ALWAYS explicit (the default would be 'global').
        const out = await timedFetch(fetchImpl, `${config.baseUrl}/auth/v1/logout?scope=${LOGOUT_SCOPE}`, { method: 'POST', headers: { ...base, Authorization: `Bearer ${access}` } }, logoutTimeoutMs);
        if (out.status === 204 || out.status === 200) localLogout = 'DONE';
      }
    } catch { localLogout = 'FAILED'; } finally { access = null; refresh = null; }
    if (!wellFormed) return { ok: false, kind: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
    return { ok: true, userId, localLogout };
  }

  return Object.freeze({ verifyPassword });
}
