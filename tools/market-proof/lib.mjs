// MARKET PROOF (isolated prototype, NOT wired into the sourcing server, NOT deployed): photo or reference -> identification -> real European listings with price, seller, link and date.
// Reuses the existing evidence contract of src/sourcing/core/market-search.js (sanitizeEvidence / summarizeMarketEvidence): a price without url + country + observation date is dropped, an unknown field stays null.
// Providers: Google Cloud Vision (identify the photo), DataForSEO Google Shopping (listings with prices), bol.com Marketing Catalog API (official, by EAN), ECB reference rates (currency conversion).
// Nothing is invented: a provider without credentials answers NOT_CONFIGURED and nothing is sent. Credentials are read from a file OUTSIDE the repository and are never printed.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MATCH, SEARCH_STATUS, sanitizeEvidence, summarizeMarketEvidence } from '../../src/sourcing/core/market-search.js';

export const ENV_FILE = join(homedir(), '.nordla', 'market-proof.env');
// Windows hides known extensions: a file saved as "market-proof.env" in Notepad often becomes "market-proof.env.txt". Both names are accepted (the plain one first).
export function loadEnv(file = ENV_FILE, base = process.env) {
  const out = { ...base }; const real = existsSync(file) ? file : existsSync(`${file}.txt`) ? `${file}.txt` : null;
  if (real) for (const line of readFileSync(real, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  return out;
}
export const configured = (env) => ({ vision: !!env.GOOGLE_VISION_API_KEY, shopping: !!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD), bol: !!(env.BOL_CLIENT_ID && env.BOL_CLIENT_SECRET) });

/** GTIN-8/12/13/14 check digit. */
export function validGtin(s) {
  const d = String(s ?? '').replace(/\D/g, ''); if (![8, 12, 13, 14].includes(d.length)) return false;
  const digits = [...d].map(Number); const check = digits.pop(); let sum = 0;
  digits.reverse().forEach((v, i) => { sum += v * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
const MODEL_RE = /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,}\b/g;

/** Photo -> identification candidates. The photo leaves the machine ONLY with consent === true. */
export async function identifyPhoto({ imageBase64, consent, env, fetchImpl = fetch }) {
  if (!env.GOOGLE_VISION_API_KEY) return { status: 'NOT_CONFIGURED', note: 'GOOGLE_VISION_API_KEY missing: the photo was not analysed and nothing was sent.' };
  if (consent !== true) return { status: 'CONSENT_REQUIRED', note: 'The photo goes to Google Cloud Vision: pass --consent to allow it. Nothing was sent.' };
  if (imageBase64.length > 7_000_000) return { status: 'ERROR', note: 'image too large (> ~5 MB): downscale it first.' };
  const body = { requests: [{ image: { content: imageBase64 }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }, { type: 'TEXT_DETECTION' }, { type: 'LOGO_DETECTION', maxResults: 3 }] }] };
  let r; try { r = await fetchImpl('https://vision.googleapis.com/v1/images:annotate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GOOGLE_VISION_API_KEY }, body: JSON.stringify(body) }); } catch (e) { return { status: 'ERROR', note: `network: ${e.message}` }; }
  if (!r.ok) return { status: 'ERROR', note: `Vision HTTP ${r.status}` };
  const j = await r.json(); const a = j.responses?.[0] ?? {}; if (a.error) return { status: 'ERROR', note: `Vision: ${a.error.message ?? 'error'}` };
  const w = a.webDetection ?? {}; const ocr = a.textAnnotations?.[0]?.description ?? '';
  const eans = [...new Set((ocr.match(/\b\d{8,14}\b/g) ?? []).filter(validGtin))];
  const models = [...new Set((ocr.toUpperCase().match(MODEL_RE) ?? []).filter((m) => !validGtin(m)))].slice(0, 5);
  return {
    status: 'DONE', provider: 'google-vision',
    bestGuess: (w.bestGuessLabels ?? []).map((l) => l.label).filter(Boolean),
    entities: (w.webEntities ?? []).filter((e) => e.description).slice(0, 6).map((e) => ({ description: e.description, score: e.score ?? null })),
    pages: (w.pagesWithMatchingImages ?? []).slice(0, 5).map((p) => ({ url: p.url, title: p.pageTitle ?? null })),
    logos: (a.logoAnnotations ?? []).map((l) => l.description).filter(Boolean), eans, models, ocrText: ocr.slice(0, 400),
  };
}

/** Identification -> search queries (strongest signal first). Each query says where it comes from. */
export function buildQueries(ident, { query = null, ean = null, model = null } = {}) {
  const qs = []; const add = (text, via, strength) => { const t = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 150); if (t && !qs.some((q) => q.text.toLowerCase() === t.toLowerCase())) qs.push({ text: t, via, strength }); };
  const e = ean ?? ident?.eans?.[0]; if (e && validGtin(e)) add(e, 'GTIN', 'GTIN');
  if (query) add(query, 'owner text', 'NAME_ONLY');
  const brand = ident?.logos?.[0]; const m = model ?? ident?.models?.[0];
  if (brand && m) add(`${brand} ${m}`, 'logo + OCR model', 'MODEL');
  for (const g of ident?.bestGuess ?? []) add(g, 'Vision best guess', 'NAME_ONLY');
  if (ident?.entities?.[0]) add(ident.entities[0].description, 'Vision web entity', 'NAME_ONLY');
  return qs.slice(0, 3);
}

/** Honest, deterministic match class. EXACT only with a GTIN hit or the exact model token in the title. Never a guess. */
export function classifyMatch(title, { gtinHit = false, model = null, brand = null, queryText = '' } = {}) {
  const t = String(title ?? '').toLowerCase(); if (gtinHit) return { matchType: MATCH.EXACT_MATCH, confidence: 'HIGH', reason: 'GTIN lookup' };
  if (model && t.includes(String(model).toLowerCase())) return { matchType: MATCH.EXACT_MATCH, confidence: 'MEDIUM', reason: `title contains the exact model ${model}` };
  const toks = queryText.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2); const hit = toks.filter((x) => t.includes(x)).length;
  if (brand && t.includes(String(brand).toLowerCase()) && toks.length && hit / toks.length >= 0.5) return { matchType: MATCH.PROBABLE_MATCH, confidence: 'MEDIUM', reason: 'brand + at least half of the query words in the title' };
  return { matchType: MATCH.SIMILAR_PRODUCT, confidence: 'LOW', reason: toks.length ? `${hit}/${toks.length} query words in the title` : 'no usable query words' };
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARKET = { BE: { name: 'Belgium', lang: 'nl' }, FR: { name: 'France', lang: 'fr' }, DE: { name: 'Germany', lang: 'de' }, NL: { name: 'Netherlands', lang: 'nl' } };

/** Google Shopping listings through DataForSEO (a provider that carries Google's scraping risk; documented in the report). Task API: POST task, then GET the result. */
export async function searchShopping({ queries, country = 'BE', env, now = () => new Date(), fetchImpl = fetch, pollMs = 4000, maxWaitMs = 120000, ctx = {} }) {
  if (!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)) return { status: SEARCH_STATUS.PROVIDER_NOT_CONFIGURED, provider: 'dataforseo-google-shopping', evidence: [], note: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD missing: nothing was searched.' };
  const auth = basic(env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD); const H = { authorization: auth, 'content-type': 'application/json' }; const base = 'https://api.dataforseo.com/v3/merchant/google';
  const mk = MARKET[country] ?? MARKET.BE; const evidence = []; const runs = []; let costUsd = 0;
  try {
    const lr = await fetchImpl(`${base}/locations`, { headers: H }); if (!lr.ok) throw new Error(`locations HTTP ${lr.status}`);
    const loc = ((await lr.json()).tasks?.[0]?.result ?? []).find((l) => l.country_iso_code === country || l.location_name === mk.name); if (!loc) throw new Error(`no location code for ${mk.name}`);
    for (const q of queries) {
      const pr = await fetchImpl(`${base}/products/task_post`, { method: 'POST', headers: H, body: JSON.stringify([{ keyword: q.text, location_code: loc.location_code, language_code: mk.lang, priority: 2, depth: 40 }]) });
      if (!pr.ok) throw new Error(`task_post HTTP ${pr.status}`); const task = (await pr.json()).tasks?.[0]; if (!task?.id || (task.status_code ?? 20100) >= 40000) throw new Error(`task_post: ${task?.status_message ?? 'no task id'}`);
      let items = null; const t0 = Date.now();
      while (Date.now() - t0 < maxWaitMs) {
        await sleep(pollMs); const gr = await fetchImpl(`${base}/products/task_get/advanced/${task.id}`, { headers: H }); if (!gr.ok) throw new Error(`task_get HTTP ${gr.status}`);
        const t = (await gr.json()).tasks?.[0]; if (t?.status_code === 20000) { items = t.result?.[0]?.items ?? []; costUsd += Number(t.cost) || 0; break; } if (t && t.status_code >= 40000 && ![40601, 40602].includes(t.status_code)) throw new Error(`task_get: ${t.status_message}`); // 40601 Task Handed / 40602 Task In Queue = still working: keep polling
      }
      if (items === null) { runs.push({ query: q.text, status: 'TIMEOUT' }); continue; }
      runs.push({ query: q.text, status: 'DONE', items: items.length });
      for (const raw of flattenItems(items)) { const ev = toEvidence(raw, { q, country, observedAt: now().toISOString(), ctx }); if (ev) evidence.push(ev); }
    }
  } catch (e) { return { status: SEARCH_STATUS.ERROR, provider: 'dataforseo-google-shopping', evidence: evidence.map((e) => sanitizeEvidence(e, { provider: 'dataforseo-google-shopping' })).filter(Boolean), error: String(e.message ?? e), runs, costUsd }; }
  return { status: SEARCH_STATUS.DONE, provider: 'dataforseo-google-shopping', evidence: evidence.map((e) => sanitizeEvidence(e, { provider: 'dataforseo-google-shopping' })).filter(Boolean), runs, costUsd };
}

/** DataForSEO account balance (free call). null when it cannot be read: the caller then refuses to spend. Shape of the answer is UNVERIFIED until a live run. */
export async function dfsBalance({ env, fetchImpl = fetch }) {
  if (!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)) return null;
  try { const r = await fetchImpl('https://api.dataforseo.com/v3/appendix/user_data', { headers: { authorization: basic(env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD) } }); if (!r.ok) return null; const b = (await r.json()).tasks?.[0]?.result?.[0]?.money?.balance; return Number.isFinite(Number(b)) ? Number(b) : null; } catch { return null; }
}
/** Upper bound of what a run can cost (deliberately pessimistic). Google Shopping lists from $0.001-0.002 per SERP of 40; the Amazon price per task was not readable: 0.01 is assumed. */
export const estimateCostUsd = ({ queries, amazon = false }) => +(queries.length * (0.01 + (amazon ? 0.01 : 0))).toFixed(4);
/** Spend guard: a paid call happens only with an explicit go, a readable balance, a trial-sized balance (no top-up) and an estimate that fits in it. */
export function spendGuard({ go, balance, estimate, allowFunded = false, trialCeiling = 2 }) {
  if (balance === null) return { ok: false, why: 'balance unreadable: refusing to spend (nothing sent)' };
  if (balance > trialCeiling && !allowFunded) return { ok: false, why: `balance ${balance} USD is above the trial ceiling (${trialCeiling}): the account looks funded; add --allow-funded only if you really want to spend real money` };
  if (estimate > balance) return { ok: false, why: `worst-case estimate ${estimate} USD exceeds the balance ${balance} USD` };
  if (!go) return { ok: false, why: 'dry plan only: add --go to run the paid calls', plan: true };
  return { ok: true };
}

/** Amazon results through DataForSEO's Amazon Merchant API (the provider collects Amazon; owner decision about Amazon's terms is pending: OFF unless --amazon). Locations are listed first (free): an unsupported marketplace is reported, never faked. */
export async function searchAmazon({ queries, country = 'BE', env, now = () => new Date(), fetchImpl = fetch, pollMs = 4000, maxWaitMs = 120000, ctx = {} }) {
  if (!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)) return { status: SEARCH_STATUS.PROVIDER_NOT_CONFIGURED, provider: 'dataforseo-amazon', evidence: [], note: 'DATAFORSEO credentials missing.' };
  const H = { authorization: basic(env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD), 'content-type': 'application/json' }; const base = 'https://api.dataforseo.com/v3/merchant/amazon'; const evidence = []; let costUsd = 0;
  try {
    const lr = await fetchImpl(`${base}/locations/${country}`, { headers: H }); if (!lr.ok) throw new Error(`amazon locations HTTP ${lr.status}`);
    const loc = ((await lr.json()).tasks?.[0]?.result ?? []).find((l) => l.country_iso_code === country); if (!loc) return { status: 'UNSUPPORTED', provider: 'dataforseo-amazon', evidence: [], note: `the provider lists no Amazon location for ${country}` };
    const lang = (loc.available_languages ?? loc.language_codes ?? [])[0]; const language_code = typeof lang === 'string' ? lang : lang?.language_code;
    for (const q of queries) {
      const pr = await fetchImpl(`${base}/products/task_post`, { method: 'POST', headers: H, body: JSON.stringify([{ keyword: q.text, location_code: loc.location_code, ...(language_code ? { language_code } : {}), priority: 2, depth: 40 }]) }); if (!pr.ok) throw new Error(`amazon task_post HTTP ${pr.status}`);
      const task = (await pr.json()).tasks?.[0]; if (!task?.id || (task.status_code ?? 20100) >= 40000) throw new Error(`amazon task_post: ${task?.status_message ?? 'no task id'}`);
      let items = null; const t0 = Date.now();
      while (Date.now() - t0 < maxWaitMs) { await sleep(pollMs); const gr = await fetchImpl(`${base}/products/task_get/advanced/${task.id}`, { headers: H }); if (!gr.ok) throw new Error(`amazon task_get HTTP ${gr.status}`); const t = (await gr.json()).tasks?.[0]; if (t?.status_code === 20000) { items = t.result?.[0]?.items ?? []; costUsd += Number(t.cost) || 0; break; } if (t && t.status_code >= 40000 && ![40601, 40602].includes(t.status_code)) throw new Error(`amazon task_get: ${t.status_message}`); }
      if (items === null) continue;
      for (const it of items.flatMap((x) => (x.type === 'amazon_serp' || x.type === 'amazon_paid' ? [x] : Array.isArray(x.items) ? x.items : []))) {
        if (!it.url) continue; const amount = Number(it.price_from); const price = Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(String(it.currency ?? '')) ? { amount, currency: it.currency, vatIncluded: null } : null; const m = classifyMatch(it.title, { model: ctx.model, brand: ctx.brand, queryText: q.text });
        evidence.push({ seller: it.domain ?? hostOf(it.url), sellerType: 'MARKETPLACE', country, url: it.url, source: 'amazon-via-dataforseo', price, specs: { title: it.title ?? null, asin: it.data_asin ?? null, domain: it.domain ?? null, priceTo: it.price_to ?? null, query: q.text, queryVia: q.via, matchReason: m.reason }, matchType: m.matchType, confidence: m.confidence, observedAt: now().toISOString() });
      }
    }
  } catch (e) { return { status: SEARCH_STATUS.ERROR, provider: 'dataforseo-amazon', evidence: evidence.map((e) => sanitizeEvidence(e, { provider: 'dataforseo-amazon' })).filter(Boolean), error: String(e.message ?? e), costUsd }; }
  return { status: SEARCH_STATUS.DONE, provider: 'dataforseo-amazon', evidence: evidence.map((e) => sanitizeEvidence(e, { provider: 'dataforseo-amazon' })).filter(Boolean), costUsd };
}

/** Marketplace split of what was found, so Amazon.be and bol.com are verified SEPARATELY and never assumed. */
export function marketplaceSplit(evidence) {
  const of = (e) => { const h = `${e.seller ?? ''} ${e.url ?? ''} ${e.specs?.domain ?? ''}`.toLowerCase(); const a = /amazon\.(com\.be|nl|fr|de|co\.uk|es|it)/.exec(h); if (a) return `amazon.${a[1]}`; if (/amazon/.test(h)) return 'amazon.(unknown domain)'; if (/bol\.com|\bbol\b/.test(h)) return 'bol.com'; return null; };
  const by = {}; for (const e of evidence) { const k = of(e); if (k) (by[k] ??= []).push(e); }
  const row = (k) => ({ found: (by[k] ?? []).length > 0, count: (by[k] ?? []).length, links: (by[k] ?? []).slice(0, 3).map((e) => e.url) });
  return { 'amazon.com.be': row('amazon.com.be'), 'bol.com': row('bol.com'), 'amazon.nl': row('amazon.nl'), 'amazon.fr': row('amazon.fr'), 'amazon.de': row('amazon.de'), other: Object.keys(by).filter((k) => !['amazon.com.be', 'bol.com', 'amazon.nl', 'amazon.fr', 'amazon.de'].includes(k)), note: 'found = a listing with a link was returned for that marketplace in THIS search; absence means "not in these results", never "not sold there"' };
}
export function flattenItems(items) { const out = []; for (const it of items ?? []) { if (it.type === 'google_shopping_serp') out.push(it); else if (Array.isArray(it.items)) for (const el of it.items) if (el && /product|carousel_element|serp/.test(String(el.type ?? ''))) out.push(el); } return out; }
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
export function toEvidence(raw, { q, country, observedAt, ctx = {} }) {
  const url = raw.url || raw.shopping_url || null; if (!url) return null; // no link = no provenance = dropped
  const amount = Number(raw.price); const price = Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(String(raw.currency ?? '')) ? { amount, currency: raw.currency, vatIncluded: null } : null;
  const m = classifyMatch(raw.title, { model: ctx.model, brand: ctx.brand, queryText: q.text });
  return { seller: raw.seller ?? raw.domain ?? hostOf(url), sellerType: 'UNKNOWN', country, url, source: 'google-shopping', price, brand: null, model: null, specs: { title: raw.title ?? null, domain: raw.domain ?? hostOf(url), productId: raw.product_id ?? null, query: q.text, queryVia: q.via, matchReason: m.reason }, availability: null, matchType: m.matchType, confidence: m.confidence, observedAt };
}

/** bol.com Marketing Catalog API (OFFICIAL, affiliate account required): by EAN only here, because the search parameters are not documented in what was readable. */
export async function bolByEan({ ean, country = 'NL', env, now = () => new Date(), fetchImpl = fetch }) {
  if (!(env.BOL_CLIENT_ID && env.BOL_CLIENT_SECRET)) return { status: SEARCH_STATUS.PROVIDER_NOT_CONFIGURED, provider: 'bol-marketing-catalog', evidence: [], note: 'BOL_CLIENT_ID / BOL_CLIENT_SECRET missing (free bol affiliate account): nothing was queried.' };
  if (!validGtin(ean)) return { status: SEARCH_STATUS.ERROR, provider: 'bol-marketing-catalog', evidence: [], error: 'no valid EAN: the bol catalog is looked up by EAN' };
  try {
    const tr = await fetchImpl('https://login.bol.com/token?grant_type=client_credentials', { method: 'POST', headers: { authorization: basic(env.BOL_CLIENT_ID, env.BOL_CLIENT_SECRET), accept: 'application/json', 'content-length': '0' } }); if (!tr.ok) throw new Error(`token HTTP ${tr.status}`);
    const H = { authorization: `Bearer ${(await tr.json()).access_token}`, accept: 'application/json', 'accept-language': 'nl-BE' };
    const root = `https://api.bol.com/marketing/catalog/v1/products/${encodeURIComponent(ean)}`;
    const pr = await fetchImpl(`${root}?country-code=${country}`, { headers: H }); if (pr.status === 404) return { status: SEARCH_STATUS.DONE, provider: 'bol-marketing-catalog', evidence: [], note: 'EAN not found on bol' }; if (!pr.ok) throw new Error(`product HTTP ${pr.status}`);
    const p = await pr.json(); const or = await fetchImpl(`${root}/offers/best?country-code=${country}`, { headers: H }); const o = or.ok ? await or.json() : null;
    const amount = Number(o?.price ?? o?.offer?.price ?? o?.bestOffer?.price); const price = Number.isFinite(amount) && amount > 0 ? { amount, currency: 'EUR', vatIncluded: true } : null; // field names of the offer are UNVERIFIED: no price unless one was really returned
    const link = p.url ?? p.bolProductUrl ?? p.productUrl ?? null; // no link = no provenance a person can open = nothing recorded
    const ev = !link ? null : sanitizeEvidence({ seller: 'bol', sellerType: 'MARKETPLACE', country, url: link, source: 'bol-marketing-catalog', price, matchType: MATCH.EXACT_MATCH, confidence: 'HIGH', observedAt: now().toISOString(), specs: { ean, offerHttp: or.status } }, { provider: 'bol-marketing-catalog' });
    return { status: SEARCH_STATUS.DONE, provider: 'bol-marketing-catalog', evidence: ev ? [ev] : [], note: ev ? null : 'bol answered but returned no usable link: nothing recorded' };
  } catch (e) { return { status: SEARCH_STATUS.ERROR, provider: 'bol-marketing-catalog', evidence: [], error: String(e.message ?? e) }; }
}

/** ECB reference rates (free, official): EUR per 1 unit of currency -> rate table. */
export async function ecbRates(fetchImpl = fetch) {
  const r = await fetchImpl('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'); if (!r.ok) throw new Error(`ECB HTTP ${r.status}`);
  const xml = await r.text(); const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] ?? null; const rates = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]); // ECB gives units of foreign currency per 1 EUR
  return { date, rates };
}
export const toEur = (amount, currency, ecb) => (currency === 'EUR' ? amount : ecb.rates[currency] ? amount / ecb.rates[currency] : null);

/** Supplier price against what was OBSERVED (never a verdict): per match class, converted at the ECB rate of the day. */
export function compareToSupplier({ evidence, supplier, ecb }) {
  const s = supplier?.price != null ? toEur(Number(supplier.price), supplier.currency, ecb) : null;
  const per = (type) => { const xs = evidence.filter((e) => e.matchType === type && e.price).map((e) => toEur(e.price.amount, e.price.currency, ecb)).filter((x) => x != null).sort((a, b) => a - b); if (!xs.length) return null; const med = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2; return { count: xs.length, minEur: +xs[0].toFixed(2), medianEur: +med.toFixed(2), maxEur: +xs.at(-1).toFixed(2), ratioSupplierToMedian: s != null ? +(s / med).toFixed(2) : null }; };
  return { ecbDate: ecb?.date ?? null, supplierEur: s != null ? +s.toFixed(2) : null, supplierInput: supplier ?? null, exact: per(MATCH.EXACT_MATCH), probable: per(MATCH.PROBABLE_MATCH), similar: per(MATCH.SIMILAR_PRODUCT),
    caveats: ['observed listing prices are consumer prices; VAT status is not stated by the source (vatIncluded = null)', 'a SIMILAR product is not the supplier product: its range is context, not a reference', 'landed cost (freight, duty, VAT, margin) is NOT included: this is not a margin or a go/no-go'] };
}

export { summarizeMarketEvidence };
