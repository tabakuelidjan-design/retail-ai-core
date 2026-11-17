// Password recovery on top of Supabase Auth (the ONLY account system Nordla uses). Server side only.
//   request(email, redirectTo)        POST /auth/v1/recover : the provider sends the e-mail. Always answered the same way (no account enumeration).
//   userOf(token)                     GET  /auth/v1/user with the recovery token: { id, factors } or null (expired, used, unknown).
//   close(token)                      POST /auth/v1/logout?scope=global: the recovery token and every provider session of the person die.
// The link in the e-mail is single use and expires at the provider; the page sends the token it finds in the URL fragment to Nordla, never anywhere else.
const TIMEOUT = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRecoveryProvider({ config, fetchImpl = globalThis.fetch }) {
  if (!config?.baseUrl || !config?.anonKey) throw new TypeError('createRecoveryProvider needs the auth config');
  const base = { apikey: config.anonKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = async (path, init) => {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT);
    try { const r = await fetchImpl(`${config.baseUrl}/auth/v1${path}`, { ...init, signal: c.signal, redirect: 'error' }); let json = null; try { json = await r.json(); } catch { json = null; } return { status: r.status, json }; } finally { clearTimeout(t); }
  };
  return Object.freeze({
    /**
     * What the provider answered, for the INTERNAL journal only (the person always gets the same neutral answer):
     *   ACCEPTED         200: handed to the mail system (this is NOT proof of delivery in the inbox)
     *   QUOTA_EXCEEDED   429 over_email_send_rate_limit: the project's e-mail quota is used up
     *   RATE_LIMITED     any other 429 (request frequency)
     *   SMTP_ERROR       5xx: the provider could not hand the mail to the SMTP service (bad credentials, sender not verified, outage)
     *   REFUSED          other 4xx (e.g. the redirect address is not allowed)
     *   UNREACHABLE      timeout or network failure towards the auth provider
     * @returns {Promise<{ outcome: string, status: number|null, ms: number, sent: boolean, limited: boolean }>}
     */
    async request(email, redirectTo) {
      const t0 = Date.now();
      const out = (outcome, status) => ({ outcome, status, ms: Date.now() - t0, sent: outcome === 'ACCEPTED', limited: outcome === 'QUOTA_EXCEEDED' || outcome === 'RATE_LIMITED' });
      try {
        const r = await call(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', headers: base, body: JSON.stringify({ email }) });
        if (r.status === 200) return out('ACCEPTED', 200);
        if (r.status === 429) return out(r.json?.error_code === 'over_email_send_rate_limit' ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED', 429);
        if (r.status >= 500) return out('SMTP_ERROR', r.status);
        return out('REFUSED', r.status);
      } catch { return out('UNREACHABLE', null); }
    },
    async userOf(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || /\s/.test(token)) return null;
      try {
        const r = await call('/user', { method: 'GET', headers: { ...base, Authorization: `Bearer ${token}` } });
        if (r.status !== 200 || !UUID.test(r.json?.id ?? '')) return null;
        return { id: r.json.id.toLowerCase(), factors: (r.json.factors ?? []).map((f) => ({ id: f.id, status: f.status, factor_type: f.factor_type })) };
      } catch { return null; }
    },
    /** TOTP check with the recovery token (a recovery session may challenge and verify its own factor). */
    async verifyTotp(token, factorId, code) {
      try {
        const ch = await call(`/factors/${factorId}/challenge`, { method: 'POST', headers: { ...base, Authorization: `Bearer ${token}` }, body: '{}' });
        if (ch.status !== 200 || !ch.json?.id) return false;
        const v = await call(`/factors/${factorId}/verify`, { method: 'POST', headers: { ...base, Authorization: `Bearer ${token}` }, body: JSON.stringify({ challenge_id: ch.json.id, code }) });
        return v.status === 200;
      } catch { return false; }
    },
    async close(token) { try { await call('/logout?scope=global', { method: 'POST', headers: { ...base, Authorization: `Bearer ${token}` } }); } catch { /* best effort */ } },
  });
}
