// MARKET RADAR provider: Google Shopping listings through DataForSEO (a data provider that collects Google's results; it carries Google's terms risk, not Nordla). SERVER SIDE ONLY: the credentials never reach
// a browser, a response, a log or Git (they come from the server environment). Every failure is a ProviderError with a code and a message built from status codes only: no header, URL with secret or body is ever copied.
// Task API: POST task -> poll the result. A task still "in queue" (40601 / 40602) is not an error. Nothing is retried automatically: a retry would be a second paid call.
const BASE = 'https://api.dataforseo.com/v3';
export const COUNTRIES = Object.freeze({ BE: { name: 'Belgium', lang: 'nl', domain: 'google.be' }, FR: { name: 'France', lang: 'fr', domain: 'google.fr' }, DE: { name: 'Germany', lang: 'de', domain: 'google.de' }, NL: { name: 'Netherlands', lang: 'nl', domain: 'google.nl' } });
export class ProviderError extends Error { constructor(code, message, extra = {}) { super(message); this.name = 'ProviderError'; this.code = code; Object.assign(this, extra); } }
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const httpError = (what, status) => new ProviderError(status === 401 || status === 403 ? 'PROVIDER_AUTH' : status === 402 ? 'PROVIDER_BALANCE' : status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ERROR', `${what}: HTTP ${status}`, { http: status });
const net = (what, e) => new ProviderError('NETWORK', `${what}: network error (${e?.cause?.code ?? e?.code ?? 'unreachable'})`);

/** Account balance in USD (a free call). null when it cannot be read. */
export async function dfsBalance({ login, password, fetchImpl = fetch }) {
  if (!login || !password) return null;
  try { const r = await fetchImpl(`${BASE}/appendix/user_data`, { headers: { authorization: basic(login, password) } }); if (!r.ok) return null; const b = (await r.json()).tasks?.[0]?.result?.[0]?.money?.balance; return Number.isFinite(Number(b)) ? Number(b) : null; } catch { return null; }
}

/** Upper bound of what one search can cost (deliberately pessimistic: Google Shopping lists from 0.001-0.002 USD per page of 40 results). */
export const estimateCostUsd = (queryCount) => +(queryCount * 0.01).toFixed(4);

export function flattenItems(items) {
  const out = [];
  for (const it of items ?? []) { if (it?.type === 'google_shopping_serp') out.push(it); else if (Array.isArray(it?.items)) for (const el of it.items) if (el && /product|carousel_element|serp/.test(String(el.type ?? ''))) out.push(el); }
  return out;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
/** One raw listing, normalised. No price unless the provider returned a real positive number AND an ISO currency. A listing without any link is dropped (no provenance a person can open). */
export function normaliseListing(raw, { query, queryVia, observedAt }) {
  const url = raw.url || raw.shopping_url || null; if (!url) return null;
  const amount = Number(raw.price); const ok = Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(String(raw.currency ?? ''));
  return { query, queryVia, title: raw.title ?? null, price: ok ? amount : null, currency: ok ? raw.currency : null, seller: raw.seller ?? raw.domain ?? hostOf(url), url, linkField: raw.url ? 'url' : 'shopping_url', domain: raw.domain ?? hostOf(url), productId: raw.product_id ?? null, observedAt };
}

/**
 * @param {{ queries: {text:string, via:string}[], country: string, login: string, password: string, fetchImpl?: Function, pollMs?: number, maxWaitMs?: number, sleep?: Function, now?: ()=>Date }} a
 * @returns {{ listings: object[], costUsd: number, runs: object[], partial: boolean, datetime: string|null }}
 */
export async function fetchShoppingListings({ queries, country = 'BE', login, password, fetchImpl = fetch, pollMs = 4000, maxWaitMs = 90_000, sleep = sleepReal, now = () => new Date() }) {
  const mk = COUNTRIES[country]; if (!mk) throw new ProviderError('BAD_COUNTRY', `unsupported market ${country}`);
  if (!login || !password) throw new ProviderError('NOT_CONFIGURED', 'the market search service is not configured');
  const H = { authorization: basic(login, password), 'content-type': 'application/json' }; const root = `${BASE}/merchant/google`;
  const listings = []; const runs = []; let costUsd = 0; let partial = false; let datetime = null;
  const call = async (what, url, opt) => { let r; try { r = await fetchImpl(url, { ...opt, headers: H }); } catch (e) { throw net(what, e); } if (!r.ok) throw httpError(what, r.status); return r.json(); };
  const loc = ((await call('locations', `${root}/locations`, {})).tasks?.[0]?.result ?? []).find((l) => l.country_iso_code === country || l.location_name === mk.name);
  if (!loc) throw new ProviderError('PROVIDER_ERROR', `no location code for ${mk.name}`);
  for (const q of queries) {
    const post = (await call('task_post', `${root}/products/task_post`, { method: 'POST', body: JSON.stringify([{ keyword: q.text, location_code: loc.location_code, language_code: mk.lang, priority: 2, depth: 40 }]) })).tasks?.[0];
    if (!post?.id || (post.status_code ?? 20100) >= 40000) throw new ProviderError('PROVIDER_ERROR', `task_post refused (${post?.status_code ?? 'no id'})`);
    costUsd += Number(post.cost) || 0; // the cost is reported on the POST answer
    let items = null; let at = null; const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      await sleep(pollMs); const t = (await call('task_get', `${root}/products/task_get/advanced/${post.id}`, {})).tasks?.[0];
      if (t?.status_code === 20000) { items = t.result?.[0]?.items ?? []; at = t.result?.[0]?.datetime ?? null; break; }
      if (t && t.status_code >= 40000 && ![40601, 40602].includes(t.status_code)) throw new ProviderError('PROVIDER_ERROR', `task_get failed (${t.status_code})`);
    }
    if (items === null) { runs.push({ query: q.text, status: 'TIMEOUT' }); partial = true; break; } // no automatic retry: it would be a second paid call
    const observedAt = (at ? new Date(String(at).replace(' +00:00', 'Z').replace(' ', 'T')) : now()).toISOString(); datetime = datetime ?? observedAt;
    const flat = flattenItems(items); runs.push({ query: q.text, status: 'DONE', items: flat.length });
    for (const raw of flat) { const l = normaliseListing(raw, { query: q.text, queryVia: q.via, observedAt }); if (l) listings.push(l); }
  }
  if (!listings.length && runs.every((r) => r.status === 'TIMEOUT')) throw new ProviderError('TIMEOUT', 'the search service did not answer in time', { costUsd });
  return { listings, costUsd, runs, partial, datetime };
}
