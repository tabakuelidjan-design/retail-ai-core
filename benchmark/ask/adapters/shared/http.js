// The only place an adapter talks to the network, through an INJECTED `fetchImpl` (tests pass a mock; nothing here reaches a real server unless the runner was
// explicitly opted in). Timeouts, rate limits and provider errors become typed AdapterErrors; secrets are scrubbed from everything that can be logged.

import { scrubSecrets } from '../../lib/secrets.js';

export class AdapterError extends Error {
  /** @param {'PROVIDER_TIMEOUT'|'RATE_LIMIT'|'HTTP_ERROR'|'NETWORK'|'INVALID_RESPONSE'|'INCOMPLETE'|'MISSING_API_KEY'|'BAD_CONFIG'} code */
  constructor(code, message, extra = {}) { super(message); this.name = 'AdapterError'; this.code = code; Object.assign(this, extra); }
}

/** Removes a key whole or in part (see lib/secrets.js): exact value, long prefixes/suffixes, masked echoes such as "Incorrect API key provided: sk-...****abcd", key-shaped tokens. */
export const scrub = scrubSecrets;

export const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const MAX_WAIT_MS = 30_000;

export const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AdapterError('PROVIDER_TIMEOUT', 'aborted while waiting to retry')); }, { once: true });
});

/** retry-after: seconds, or an HTTP date. */
export function retryAfterMs(headerValue, now = Date.now()) {
  if (headerValue == null || headerValue === '') return null;
  const secs = Number(headerValue); if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(headerValue); return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * POST a JSON body and return the parsed JSON response.
 * 429 and 5xx (500, 502, 503, 504, 529) are retried up to `maxRetries` with `retry-after` (else exponential backoff); other statuses fail at once.
 * @returns {Promise<{ json: object, attempts: number, events: object[] }>}
 */
export async function postJson({ url, headers, body, fetchImpl, timeoutMs, signal = null, maxRetries = 2, sleep = defaultSleep, secrets = [], provider = 'provider' }) {
  const events = []; const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt += 1) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
    let res; let text;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: payload, signal: combined });
      text = res.ok ? null : await res.text().catch(() => '');
      if (res.ok) { const raw = await res.text(); try { return { json: JSON.parse(raw), attempts: attempt + 1, events }; } catch { throw new AdapterError('INVALID_RESPONSE', `${provider}: the response is not JSON`); } }
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      if (combined.aborted) throw new AdapterError('PROVIDER_TIMEOUT', `${provider}: no answer within ${timeoutMs} ms`);
      events.push({ kind: 'network', message: scrub(e?.message, secrets).slice(0, 120) });
      if (attempt < maxRetries) { await sleep(Math.min(MAX_WAIT_MS, 500 * 2 ** attempt), signal); continue; }
      throw new AdapterError('NETWORK', `${provider}: network error`, { events });
    } finally { clearTimeout(timer); }
    // an HTTP error status
    const status = res.status; const excerpt = scrub(text, secrets).replace(/\s+/g, ' ').slice(0, 160);
    events.push({ kind: status === 429 ? 'rate_limit' : RETRYABLE.has(status) ? 'server_error' : 'http_error', status });
    if (RETRYABLE.has(status) && attempt < maxRetries) {
      const wait = Math.min(MAX_WAIT_MS, retryAfterMs(res.headers?.get?.('retry-after')) ?? 500 * 2 ** attempt);
      await sleep(wait, signal); continue;
    }
    throw new AdapterError(status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR', `${provider}: HTTP ${status}${excerpt ? ` - ${excerpt}` : ''}`, { status, events });
  }
}
