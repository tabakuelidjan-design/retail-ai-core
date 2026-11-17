// Account creation for an accepted invitation, through Supabase Auth's admin API (service role, server side only: the key never reaches a browser, a log or an error).
// The e-mail is the invited one, fixed by the server; the person only chooses a name and a password. Signing in later goes through the usual Nordla sign-in.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {{ baseUrl: string, serviceKey: string, fetchImpl?: typeof fetch, timeoutMs?: number }} o */
export function createAuthAdmin({ baseUrl, serviceKey, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (!baseUrl || !serviceKey) throw new TypeError('createAuthAdmin needs the Supabase URL and the service key');
  async function createUser({ email, password, name = null }) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/auth/v1/admin/users`, { method: 'POST', redirect: 'error', signal: ctl.signal, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, email_confirm: true, ...(name ? { user_metadata: { name } } : {}) }) });
      let j = null; try { j = await res.json(); } catch { j = null; }
      const id = typeof j?.id === 'string' && UUID.test(j.id) ? j.id.toLowerCase() : null;
      return res.status >= 200 && res.status < 300 && id ? { ok: true, userId: id } : { ok: false, status: res.status };
    } catch { return { ok: false, status: 0 }; } finally { clearTimeout(timer); }
  }
  /** Sets a new password on an existing account (recovery). true only when the provider accepted it. */
  async function setPassword(id, password) {
    if (!UUID.test(String(id)) || typeof password !== 'string' || !password) return false;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/auth/v1/admin/users/${id}`, { method: 'PUT', redirect: 'error', signal: ctl.signal, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      return res.status === 200;
    } catch { return false; } finally { clearTimeout(timer); }
  }
  return Object.freeze({ createUser, setPassword });
}
