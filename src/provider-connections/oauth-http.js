// The real HTTP of the OAuth adapters, built on an injected `fetch` (no hidden global): reveals sealed values (client secret, code,
// tokens) only at the last moment, supports query, form-urlencoded and JSON bodies, and returns the parsed JSON body (or null).
// A raw response never leaves this boundary except through the adapters' allow-lists.

import { SealedSecret } from './validation.js';

const reveal = (value) => (value instanceof SealedSecret ? value.reveal() : value);
const revealDeep = (value) => {
  if (value instanceof SealedSecret) return value.reveal();
  if (Array.isArray(value)) return value.map(revealDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revealDeep(v)]));
  return value;
};

export function createOAuthHttp({ fetch: fetchFn }) {
  if (typeof fetchFn !== 'function') throw new TypeError('createOAuthHttp needs a fetch function');
  return async function http({
    method, url, headers = {}, query = null, form = null, body = null, signal,
  }) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(query ?? {})) if (value != null) target.searchParams.set(key, String(reveal(value)));
    const outHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(reveal(v))]));
    let payload;
    if (form != null) {
      payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null).map(([k, v]) => [k, String(reveal(v))])).toString();
      outHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body != null) {
      payload = JSON.stringify(revealDeep(body));
      outHeaders['Content-Type'] ??= 'application/json; charset=UTF-8';
    }
    const res = await fetchFn(target, { method, headers: outHeaders, body: payload, signal });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, headers: Object.fromEntries(res.headers?.entries?.() ?? []), body: parsed };
  };
}
