// A fake Supabase Auth (GoTrue) REST server, reached through an injected fetch - no network. Synthetic users only.
// Tokens are generated at run time (never literals in the repository). Every request is recorded (URL, method, headers present).
import { randomBytes } from 'node:crypto';

/**
 * @param {{ users?: Array<{ id: string, email: string, password: string, banned?: boolean }>, mode?: string }} o
 *   mode: 'normal' | 'timeout' | 'network' | 'http500' | 'http429' | 'invalid200' | 'logoutFails'
 */
export function createFakeGoTrue({ users = [], mode = 'normal' } = {}) {
  const requests = [];
  const issued = []; // every access / refresh token handed out, to prove none leaks
  const state = { mode };
  const reply = (status, body) => ({ status, async json() { if (body === undefined) throw new Error('no body'); return body; } });

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    requests.push({ path: u.pathname, search: u.search, query: Object.fromEntries(u.searchParams), method: init.method, headers: { ...(init.headers ?? {}) }, hasSignal: Boolean(init.signal), redirect: init.redirect });
    if (state.mode === 'network') throw new TypeError('fetch failed');
    if (state.mode === 'timeout' && u.pathname.endsWith('/token')) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (u.pathname === '/auth/v1/token') {
      if (state.mode === 'http500') return reply(500, { msg: 'down' });
      if (state.mode === 'http429') return reply(429, { error_code: 'over_request_rate_limit' });
      const { email, password } = JSON.parse(init.body);
      const user = users.find((x) => x.email === email);
      if (!user || user.password !== password) return reply(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (user.banned) return reply(400, { code: 400, error_code: 'user_banned', msg: 'User is banned' });
      const access = `access.${randomBytes(24).toString('base64url')}`; const refresh = randomBytes(16).toString('base64url');
      issued.push(access, refresh);
      if (state.mode === 'invalid200') return reply(200, { token_type: 'bearer' });
      return reply(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh, user: { id: user.id, email: user.email, aud: 'authenticated' } });
    }
    if (u.pathname === '/auth/v1/logout') {
      if (state.mode === 'logoutFails') return reply(500, { msg: 'down' });
      return reply(204);
    }
    return reply(404, { msg: 'not found' });
  }

  return { fetchImpl, requests, issued, setMode: (m) => { state.mode = m; } };
}
