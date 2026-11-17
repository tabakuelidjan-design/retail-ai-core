// Supabase Auth MFA (TOTP) calls for Settings > Security V2, server side only. The browser never talks to Supabase and no Supabase token survives a call:
// each step re-checks the person's password (grant), acts with that short-lived token, then closes the temporary Supabase session (scope=local, always explicit).
//   enroll(email, password)                   -> { factorId, secret, uri, qr }   (factor created, NOT yet active)
//   confirm(email, password, factorId, code)  -> { ok: true } when the first authenticator code is right (factor becomes verified)
// Failures: { ok: false, kind: 'INVALID' | 'UNAVAILABLE' | 'ALREADY' }. Nothing here logs a secret.
const TIMEOUT = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMfaProvider({ config, fetchImpl = globalThis.fetch, adminAuth }) {
  if (!config?.baseUrl || !config?.anonKey || !adminAuth) throw new TypeError('createMfaProvider needs the auth config and the admin auth');
  const base = { apikey: config.anonKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = async (path, init) => {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT);
    try { const r = await fetchImpl(`${config.baseUrl}/auth/v1${path}`, { ...init, signal: c.signal, redirect: 'error' }); let json = null; try { json = await r.json(); } catch { json = null; } return { status: r.status, json }; } finally { clearTimeout(t); }
  };
  /** password grant -> { access, userId, factors } | { kind } */
  async function grant(email, password) {
    let r; try { r = await call('/token?grant_type=password', { method: 'POST', headers: base, body: JSON.stringify({ email, password }) }); } catch { return { kind: 'UNAVAILABLE' }; }
    if (r.status >= 500 || r.status === 429) return { kind: 'UNAVAILABLE' };
    if (r.status !== 200 || typeof r.json?.access_token !== 'string' || !UUID.test(r.json?.user?.id ?? '')) return { kind: 'INVALID' };
    return { access: r.json.access_token, userId: r.json.user.id.toLowerCase(), factors: Array.isArray(r.json.user.factors) ? r.json.user.factors : [] };
  }
  const closeLocal = async (access) => { try { await call('/logout?scope=local', { method: 'POST', headers: { ...base, Authorization: `Bearer ${access}` } }); } catch { /* best effort */ } };
  const bearer = (access) => ({ ...base, Authorization: `Bearer ${access}` });

  return Object.freeze({
    async enroll(email, password) {
      const g = await grant(email, password); if (!g.access) return { ok: false, kind: g.kind };
      let access = g.access;
      try {
        if (g.factors.some((f) => f.status === 'verified')) return { ok: false, kind: 'ALREADY' };
        for (const f of g.factors) if (f.status !== 'verified') { try { await adminAuth.deleteFactor(g.userId, f.id); } catch { /* a stale unverified factor may remain: the name below is unique anyway */ } }
        const name = `Nordla ${Date.now().toString(36)}`;
        const r = await call('/factors', { method: 'POST', headers: bearer(access), body: JSON.stringify({ factor_type: 'totp', friendly_name: name, issuer: 'Nordla' }) });
        if (r.status >= 500 || r.status === 429) return { ok: false, kind: 'UNAVAILABLE' };
        if (r.status !== 200 || !r.json?.id || !r.json?.totp?.secret) return { ok: false, kind: 'UNAVAILABLE' };
        return { ok: true, userId: g.userId, factorId: r.json.id, secret: r.json.totp.secret, uri: r.json.totp.uri, qr: r.json.totp.qr_code ?? null };
      } finally { await closeLocal(access); access = null; }
    },
    async confirm(email, password, factorId, code) {
      if (!UUID.test(String(factorId ?? '')) || !/^\d{6}$/.test(String(code ?? '').trim())) return { ok: false, kind: 'INVALID' };
      const g = await grant(email, password); if (!g.access) return { ok: false, kind: g.kind };
      let access = g.access;
      try {
        if (!g.factors.some((f) => f.id === factorId)) return { ok: false, kind: 'INVALID' }; // only a factor of THIS account
        const ch = await call(`/factors/${factorId}/challenge`, { method: 'POST', headers: bearer(access), body: '{}' });
        if (ch.status >= 500 || ch.status === 429) return { ok: false, kind: 'UNAVAILABLE' };
        if (ch.status !== 200 || !ch.json?.id) return { ok: false, kind: 'INVALID' };
        const v = await call(`/factors/${factorId}/verify`, { method: 'POST', headers: bearer(access), body: JSON.stringify({ challenge_id: ch.json.id, code: String(code).trim() }) });
        if (v.status >= 500 || v.status === 429) return { ok: false, kind: 'UNAVAILABLE' };
        if (v.status !== 200) return { ok: false, kind: 'INVALID' };
        if (typeof v.json?.access_token === 'string') access = v.json.access_token;
        return { ok: true, userId: g.userId };
      } finally { await closeLocal(access); access = null; }
    },
  });
}
