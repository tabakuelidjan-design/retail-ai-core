// Network layer of the phone app: the access token (kept from the pairing link, never left in the address bar), requests that never throw (a lost connection is a
// status 0 the screens can show), and a "last good answer" memory so the screens can still be READ when the connection drops (clearly labelled as old).
const TOKEN_KEY = 'nordla.proc.token';
const CACHE_PREFIX = 'nordla.proc.cache:';
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

export const getToken = () => safe(() => localStorage.getItem(TOKEN_KEY));
/** The pairing link carries the token after "#t=". Keep it, then remove it from the address bar and the history entry. */
export function initToken() {
  const m = /[#&]t=([A-Za-z0-9]{24,})/.exec(location.hash);
  if (m) { safe(() => localStorage.setItem(TOKEN_KEY, m[1])); history.replaceState(null, '', location.pathname + location.search); }
  return getToken();
}
export const forgetToken = () => safe(() => localStorage.removeItem(TOKEN_KEY));

let onStatus = () => {};
export const setStatusListener = (fn) => { onStatus = fn; };

/** @returns {Promise<{status: number, json: any, error?: string}>} status 0 = no answer (offline, timeout, tunnel down) */
export async function request(method, path, { body, key, raw, contentType, timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method, signal: ctrl.signal, cache: 'no-store',
      headers: { 'x-nordla-token': getToken() ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(contentType ? { 'content-type': contentType } : {}), ...(method !== 'GET' && key ? { 'idempotency-key': key } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    let json = null; try { json = await res.json(); } catch { /* an empty or non-JSON body */ }
    onStatus(res.status === 0 ? 0 : res.status);
    return { status: res.status, json };
  } catch (e) { onStatus(0); return { status: 0, json: null, error: e?.name === 'AbortError' ? 'timeout' : 'offline' }; } finally { clearTimeout(timer); }
}

/** GET with a memory of the last good answer: { data, stale, at }. stale = the connection failed and this is the previous answer. */
export async function getJson(path) {
  const r = await request('GET', path);
  if (r.status === 200) { safe(() => localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ at: new Date().toISOString(), data: r.json }))); return { data: r.json, stale: false, at: new Date().toISOString(), status: 200 }; }
  if (r.status === 0 || r.status >= 500) {
    const c = safe(() => JSON.parse(localStorage.getItem(CACHE_PREFIX + path)));
    if (c) return { data: c.data, stale: true, at: c.at, status: r.status };
  }
  return { data: null, stale: false, at: null, status: r.status, error: r.json?.message ?? r.json?.error ?? r.error ?? `HTTP ${r.status}` };
}

const urls = new Map();
/** Photos need the token, so they are fetched with it and shown from a local blob URL. */
export async function photoUrl(ref) {
  const name = /^upload:\/\/([0-9a-f]{64}\.(?:jpg|png|webp))$/.exec(String(ref))?.[1];
  if (!name) return null;
  if (urls.has(name)) return urls.get(name);
  try {
    const res = await fetch(`/api/uploads/${name}`, { headers: { 'x-nordla-token': getToken() ?? '' } });
    if (!res.ok) return null;
    const u = URL.createObjectURL(await res.blob()); urls.set(name, u); return u;
  } catch { return null; }
}
