// HTTP boundary of the provider adapters. The domain core has NO hidden global fetch: every network call goes through an injected
// `http(request)` function, always with a timeout.
//
//   request  = { method, url, headers?, query?, body?, timeoutMs, signal }  (values may be SealedSecret - revealed only by createFetchHttp)
//   response = { status, headers?, body }                                    (body already parsed JSON, or null)
//
// A fake `http` in tests records requests safely: a SealedSecret serializes to "[REDACTED]".

import { DEFAULT_TIMEOUT_MS } from '../constants.js';
import { SealedSecret, deepFreeze } from '../validation.js';

export class ProviderCallError extends Error {
  /** @param {'TIMEOUT'|'NETWORK'} kind */
  constructor(kind) { super(kind); this.name = 'ProviderCallError'; this.kind = kind; }
}

/** Parses Retry-After (seconds or an HTTP date) into milliseconds, or null. */
export function parseRetryAfter(headers, nowMs = Date.now()) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** One provider call with a hard timeout. Never throws a provider payload: only ProviderCallError, or a normalized response. */
export async function callProvider(http, request, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof http !== 'function') throw new TypeError('an http function must be injected');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProviderCallError('TIMEOUT')); }, timeoutMs); });
  try {
    const response = await Promise.race([http({ ...request, timeoutMs, signal: controller.signal }), timeout]);
    const headers = Object.fromEntries(Object.entries(response?.headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]));
    return deepFreeze({ status: Number(response?.status), headers, body: response?.body ?? null });
  } catch (error) {
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError(error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

const reveal = (value) => (value instanceof SealedSecret ? value.reveal() : value);
// JSON.stringify would call SealedSecret.toJSON ("[REDACTED]") before any replacer: reveal the tree first.
const revealDeep = (value) => {
  if (value instanceof SealedSecret) return value.reveal();
  if (Array.isArray(value)) return value.map(revealDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revealDeep(v)]));
  return value;
};

/** The real `http`, built on an injected `fetch` (Node's global fetch in production). Reveals sealed values at the last moment. */
export function createFetchHttp({ fetch: fetchFn }) {
  if (typeof fetchFn !== 'function') throw new TypeError('createFetchHttp needs a fetch function');
  return async function http({ method, url, headers = {}, query = null, body = null, signal }) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(query ?? {})) if (value != null) target.searchParams.set(key, String(reveal(value)));
    const outHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(reveal(v))]));
    let payload;
    if (body != null) {
      payload = JSON.stringify(revealDeep(body));
      outHeaders['Content-Type'] ??= 'application/json; charset=UTF-8';
    }
    const res = await fetchFn(target, { method, headers: outHeaders, body: payload, signal });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, headers: Object.fromEntries(res.headers?.entries?.() ?? []), body: parsed };
  };
}
