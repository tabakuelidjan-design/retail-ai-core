// Growth > receiving the personalizer's technical events from the shop's storefront (PUBLIC route, no Nordla session: a visitor has none).
// What makes this safe to leave public:
//   - ONE merchant: the server's (NORDLA_MERCHANT_ID); nothing in the request chooses it.
//   - ORIGIN allow-list (default https://habb.be): another origin is refused. (A browser always sends Origin on a cross-origin POST; a script off-browser can fake it,
//     so the schema and the rate limits below are the real protection, not the Origin.)
//   - STRICT SCHEMA (funnel/personalizer.js): known step/status/device, a product handle, a random attempt token, the visitor's analytics consent flag. Any other field
//     (a file name, a URL, a text, an e-mail...) makes the whole event refused - it is never trimmed and stored.
//   - SMALL: body <= 1 KB; per-IP and per-attempt rate limits; nothing about the sender (no IP, no user agent) is stored.
//   - IDEMPOTENT: the same (attempt, step, n) twice is stored once (database unique key + insert-ignoring-duplicates).
//   - SILENT: an accepted or a refused-by-schema event both answer 204 with no body (nothing to learn by probing); only a bad origin, a bad method or a flood answer otherwise.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validatePersonalizerEvent } from '../dropoff/personalizer.js';
import { errorLabel } from './safe-log.js';

export const COLLECT_PATH = '/api/growth/collect/personalizer';

/**
 * The server's own collection channels (never taken from a request):
 *  - test: GROWTH_COLLECT_TEST_CHANNEL, else derived from the server secret NORDLA_CSRF_KEY (HMAC), so the draft theme works without any variable;
 *  - live: GROWTH_COLLECT_LIVE_CHANNEL ONLY. Unset = live collection is NOT enabled: nothing can be classified live. It must differ from the test key (16-64 chars [A-Za-z0-9_-]).
 * The key travels in the theme's script (public by nature): it names a CHANNEL, it is not a proof of identity. What it guarantees: a draft-theme script that still carries the test
 * key stays 'test' even if it runs after the launch; an event without a recognised key is 'unknown'; and a browser cannot make an event live by writing the word live.
 */
export function collectChannels(env = process.env) {
  const ok = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(k);
  const derived = env.NORDLA_CSRF_KEY ? createHmac('sha256', String(env.NORDLA_CSRF_KEY)).update('nordla.growth.collect.test.v1').digest('hex').slice(0, 32) : null;
  const test = ok(env.GROWTH_COLLECT_TEST_CHANNEL) ? env.GROWTH_COLLECT_TEST_CHANNEL : derived;
  const live = ok(env.GROWTH_COLLECT_LIVE_CHANNEL) && env.GROWTH_COLLECT_LIVE_CHANNEL !== test ? env.GROWTH_COLLECT_LIVE_CHANNEL : null;
  return { test, live };
}
const same = (a, b) => { const x = createHash('sha256').update(String(a)).digest(); const y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y); };
/** 'live' | 'test' | 'unknown' from the presented channel key and the SERVER's channels. */
export function channelProvenance(ch, channels = {}) {
  if (typeof ch !== 'string' || !ch) return 'unknown';
  if (channels.live && same(ch, channels.live)) return 'live';
  if (channels.test && same(ch, channels.test)) return 'test';
  return 'unknown';
}
const MAX_BODY = 1024;
const text = (res, status, headers = {}) => { res.writeHead(status, { 'cache-control': 'no-store', ...headers }); res.end(); };

export function createPersonalizerCollector({ store, allowedOrigins = ['https://habb.be'], channels = { test: null, live: null }, now = () => Date.now(), perIpPerMinute = 60, perAttempt = 40 } = {}) {
  if (!store || typeof store.insert !== 'function') throw new TypeError('createPersonalizerCollector: a store with insert() is required');
  const origins = new Set(allowedOrigins);
  const ipHits = new Map(); const attemptHits = new Map();
  const hit = (map, key, limit, windowMs) => { // sliding window, in memory: restarts forget it (it is a brake, not a record)
    const t = now(); const arr = (map.get(key) ?? []).filter((x) => t - x < windowMs); arr.push(t); map.set(key, arr);
    if (map.size > 5000) for (const [k, v] of map) if (!v.length || t - v.at(-1) > windowMs) map.delete(k);
    return arr.length <= limit;
  };
  const ipOf = (req) => createHash('sha256').update(String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || String(req.socket?.remoteAddress ?? '')).digest('hex').slice(0, 16); // hashed, used only as an in-memory key

  return async function collect(req, res) {
    const origin = String(req.headers.origin ?? '');
    const cors = origins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
    const method = String(req.method ?? '').toUpperCase();
    if (method === 'OPTIONS') return text(res, origins.has(origin) ? 204 : 403, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
    if (method !== 'POST') return text(res, 405, { allow: 'POST, OPTIONS' });
    if (!origins.has(origin)) return text(res, 403, cors);
    if (!hit(ipHits, ipOf(req), perIpPerMinute, 60_000)) return text(res, 429, { ...cors, 'retry-after': '60' });
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BODY) return text(res, 413, cors); chunks.push(c); }
    let raw; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return text(res, 204, cors); }
    const v = validatePersonalizerEvent(raw);
    if (!v.ok) return text(res, 204, cors); // refused by the schema: silent
    if (!hit(attemptHits, v.row.attempt_id, perAttempt, 3_600_000)) return text(res, 204, cors);
    try { await store.insert({ ...v.row, provenance: channelProvenance(v.channel, channels) }); /* provenance: assigned HERE from the server's configuration */ } catch (e) { console.error('personalizer collect failed:', errorLabel(e)); return text(res, 503, cors); }
    return text(res, 204, cors);
  };
}

/** Supabase store (the hosted server): one row per (attempt, step, n); reads are the merchant's, limited to the retention window. */
export function createSupabasePersonalizerStore(supabase, merchantId, { table = 'growth_personalizer_events' } = {}) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createSupabasePersonalizerStore: merchantId is required (server context)');
  return {
    async insert(row) { await supabase.insertIgnoringDuplicates(table, [{ merchant_id: merchantId, ...row }], { onConflict: 'merchant_id,attempt_id,step,n' }); }, // row.provenance is test | live | unknown (server-assigned)
    async list({ since }) {
      return (await supabase.select(table, { select: 'attempt_id,step,status,device,product,n,provenance,received_at', merchant_id: `eq.${merchantId}`, received_at: `gte.${since.toISOString()}`, order: 'received_at.asc', limit: '20000' })) ?? [];
    },
  };
}

/** In-memory store (tests, local preview). */
export function createMemoryPersonalizerStore({ now = () => new Date() } = {}) {
  const rows = new Map();
  return {
    async insert(row) { const k = `${row.attempt_id}|${row.step}|${row.n}`; if (!rows.has(k)) rows.set(k, { ...row, received_at: now().toISOString() }); },
    async list({ since }) { return [...rows.values()].filter((r) => r.received_at >= since.toISOString()); },
    _all: () => [...rows.values()],
  };
}
