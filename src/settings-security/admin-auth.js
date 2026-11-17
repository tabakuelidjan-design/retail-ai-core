// Supabase Auth admin calls needed by Paramètres > Sécurité (server side only, service role key never leaves this process): read ONE account, set its password.
// Neither the key, the password nor any token is ever put in an error or a log. Timeouts are explicit.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAdminAuth({ url, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (!url || !serviceRoleKey) throw new TypeError('createAdminAuth needs the Supabase URL and the service role key');
  const base = String(url).replace(/\/+$/, '');
  const call = async (path, init) => {
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/auth/v1${path}`, { ...init, signal: c.signal, redirect: 'error', headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
      let body = null; try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    /** @returns {Promise<object|null>} the account (id, email, identities, factors, last_sign_in_at) or null when unknown; throws on provider trouble */
    async getUser(id) {
      if (!UUID.test(id)) return null;
      const r = await call(`/admin/users/${id}`, { method: 'GET' });
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body?.id) throw new Error('auth provider unavailable');
      return { id: r.body.id, email: r.body.email ?? null, identities: (r.body.identities ?? []).map((i) => ({ provider: i.provider })), factors: (r.body.factors ?? []).map((f) => ({ id: f.id, status: f.status, factor_type: f.factor_type })), last_sign_in_at: r.body.last_sign_in_at ?? null };
    },
    /** Removes ONE factor of the account (admin: no second-factor proof is asked by the provider, the CALLER must have proven it). */
    async deleteFactor(id, factorId) {
      if (!UUID.test(id) || !UUID.test(String(factorId))) return false;
      const r = await call(`/admin/users/${id}/factors/${factorId}`, { method: 'DELETE' });
      return r.status === 200 || r.status === 204 || r.status === 404;
    },
    /** @returns {Promise<boolean>} true only when the provider accepted the new password */
    async setPassword(id, password) {
      if (!UUID.test(id) || typeof password !== 'string' || !password) return false;
      const r = await call(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ password }) });
      return r.status === 200;
    },
  });
}
