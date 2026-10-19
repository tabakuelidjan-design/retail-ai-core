// MARKET SEARCH contract + MARKET EVIDENCE model (provider-independent). Question answered, only when the OWNER asks for it: "is this product, or a genuinely comparable one, already sold in Europe, especially in
// Belgium?". It is MARKET EVIDENCE for the sourcing decision, not a web crawler and not a legal opinion:
//   - the search input is built from the strongest identity signals (model/reference, brand, GTIN, name, known traits, image reference when an approved image provider exists);
//   - every result is classified EXACT_MATCH / PROBABLE_MATCH / SIMILAR_PRODUCT; NO_MATCH_FOUND means "this search found nothing reliable", NEVER "not sold in Europe";
//   - evidence keeps its provenance (seller, country, URL, price, VAT status, model, brand, availability, marketplace vs retailer, match type, confidence, observation time) and is never fabricated: an unknown field is null;
//   - geography is kept apart: a French listing is evidence for France/the EU, not for Belgium;
//   - market presence is NOT EU legal marketability, NOT Amazon readiness and NOT product identity: a retailer listing proves none of them. Regulatory evidence stays in the rules pipeline.
//   - nothing is sent anywhere automatically; this repository integrates NO search or image-search provider. An approved adapter returns the same shape (provider.search(input) -> { status, evidence[] }).
export const MATCH = Object.freeze({ EXACT_MATCH: 'EXACT_MATCH', PROBABLE_MATCH: 'PROBABLE_MATCH', SIMILAR_PRODUCT: 'SIMILAR_PRODUCT', NO_MATCH_FOUND: 'NO_MATCH_FOUND' });
export const SEARCH_STATUS = Object.freeze({ PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED', DONE: 'DONE', ERROR: 'ERROR' });
export const SELLER_TYPE = Object.freeze({ RETAILER: 'RETAILER', MARKETPLACE: 'MARKETPLACE', MANUFACTURER: 'MANUFACTURER', UNKNOWN: 'UNKNOWN' });
export const REGION = Object.freeze({ BELGIUM: 'BELGIUM', NEIGHBOURING_EU: 'NEIGHBOURING_EU', EU: 'EU', OUTSIDE_EU: 'OUTSIDE_EU' });
const EU27 = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const NEIGHBOURS = new Set(['NL', 'FR', 'DE', 'LU']);
/** Geographic bucket of a listing's country: Belgium, the neighbouring markets, the rest of the EU, or outside the EU (never merged). */
export const regionOf = (country) => { const c = String(country ?? '').toUpperCase(); return c === 'BE' ? REGION.BELGIUM : NEIGHBOURS.has(c) ? REGION.NEIGHBOURING_EU : EU27.has(c) ? REGION.EU : REGION.OUTSIDE_EU; };
const RANK = { EXACT_MATCH: 3, PROBABLE_MATCH: 2, SIMILAR_PRODUCT: 1 };

/** The search input, from the strongest identity signals available. `strength` says how well the supplier's product is identified: MODEL (a reference), BRAND_NAME, NAME_ONLY. */
export function buildSearchInput(state, hypothesis = null) {
  const id = state.identity; const ids = id.identifiers ?? {};
  const traits = hypothesis ? Object.fromEntries(Object.entries(hypothesis.traits).filter(([, t]) => t.known).map(([k, t]) => [k, { value: t.value, status: t.status }])) : {};
  const strength = ids.gtin ? 'GTIN' : ids.model ? 'MODEL' : ids.brand ? 'BRAND_NAME' : 'NAME_ONLY';
  return { name: id.workingName || null, brand: ids.brand ?? null, model: ids.model ?? null, manufacturerRef: ids.manufacturer ?? null, gtin: ids.gtin ?? null, traits, category: hypothesis?.category?.value ?? hypothesis?.category?.best?.category ?? null, imageRef: id.photos?.at(-1)?.ref ?? null, strength, regions: [REGION.BELGIUM, REGION.NEIGHBOURING_EU, REGION.EU] };
}
/** What would leave the machine if the owner agrees: text only unless an image provider is approved AND the owner adds the image. */
export const outgoingFields = (input, { withImage = false } = {}) => ({ text: ['name', 'brand', 'model', 'manufacturerRef', 'gtin'].filter((k) => input[k]), image: withImage && !!input.imageRef });

/** One piece of evidence. Anything that is not well-formed is dropped, never repaired; unknown values stay null (nothing is invented). */
export function sanitizeEvidence(e, { provider = null } = {}) {
  if (!e || typeof e !== 'object' || !MATCH[e.matchType] || e.matchType === MATCH.NO_MATCH_FOUND) return null;
  if (!e.url && !e.source) return null; if (!/^[A-Za-z]{2}$/.test(String(e.country ?? ''))) return null; if (!Date.parse(e.observedAt ?? '')) return null;
  const price = e.price && Number.isFinite(Number(e.price.amount)) && Number(e.price.amount) > 0 && /^[A-Z]{3}$/.test(String(e.price.currency ?? '')) ? { amount: Number(e.price.amount), currency: e.price.currency, vatIncluded: typeof e.price.vatIncluded === 'boolean' ? e.price.vatIncluded : null } : null;
  const conf = ['LOW', 'MEDIUM', 'HIGH'].includes(e.confidence) ? e.confidence : 'LOW';
  return { seller: e.seller ?? null, sellerType: SELLER_TYPE[e.sellerType] ?? SELLER_TYPE.UNKNOWN, country: String(e.country).toUpperCase(), url: e.url ?? null, source: e.source ?? null, price, brand: e.brand ?? null, model: e.model ?? null, specs: e.specs && typeof e.specs === 'object' ? e.specs : {}, availability: e.availability ?? null, matchType: e.matchType, confidence: conf, observedAt: new Date(e.observedAt).toISOString(), provider: e.provider ?? provider, reason: e.reason ?? null };
}

/**
 * Runs a search through an APPROVED provider, if there is one. Without a provider the honest answer is PROVIDER_NOT_CONFIGURED: nothing is sent, nothing is guessed.
 * @param {object} input buildSearchInput(...) @param {{ name: string, region?: string, search: (input: object) => Promise<{ status?: string, evidence?: object[] }> }|null} provider
 */
export async function searchMarket(input, provider = null) {
  if (!provider || typeof provider.search !== 'function') return { status: SEARCH_STATUS.PROVIDER_NOT_CONFIGURED, evidence: [], note: 'No market-search provider is approved or configured: nothing was searched and nothing was sent.' };
  try { const r = await provider.search(input); return { status: SEARCH_STATUS.DONE, provider: provider.name, evidence: (r?.evidence ?? []).map((e) => sanitizeEvidence(e, { provider: provider.name })).filter(Boolean) }; }
  catch (e) { return { status: SEARCH_STATUS.ERROR, provider: provider?.name ?? null, evidence: [], error: String(e?.message ?? e) }; }
}

const range = (xs) => { const by = new Map(); for (const p of xs) { const k = `${p.currency}|${p.vatIncluded}`; (by.get(k) ?? by.set(k, []).get(k)).push(p.amount); } return [...by.entries()].map(([k, a]) => { const [currency, vat] = k.split('|'); return { currency, vatIncluded: vat === 'null' ? null : vat === 'true', min: Math.min(...a), max: Math.max(...a), n: a.length }; }); };

/**
 * Summary per region of what was OBSERVED. These are observed market signals, never a claim about total market coverage. `landedPerUnitEurMinor` (optional) is shown NEXT to the observed range as context
 * for the margin / positioning discussion; this function never judges, and nothing here changes the purchase decision.
 */
export function summarizeMarketEvidence(searches, { landedPerUnitEurMinor = null } = {}) {
  const done = (searches ?? []).filter((s) => s.status === SEARCH_STATUS.DONE); const evidence = done.flatMap((s) => (s.evidence ?? []).map((e) => ({ ...e, searchId: s.id })));
  const bucket = (regions) => { const es = evidence.filter((e) => regions.includes(regionOf(e.country)) && !e.specs?.excluded); /* listings flagged as lots / accessories / aberrant prices stay in the evidence but never enter a count or a price range */ const count = (t) => es.filter((e) => e.matchType === t).length; const sellers = [...new Map(es.map((e) => [`${e.seller ?? e.source}|${e.country}`, { seller: e.seller, source: e.source, country: e.country, type: e.sellerType }])).values()];
    const countries = [...new Set(es.map((e) => e.country))].sort(); const best = es.reduce((a, e) => Math.max(a, RANK[e.matchType]), 0);
    return { exact: count(MATCH.EXACT_MATCH), probable: count(MATCH.PROBABLE_MATCH), similar: count(MATCH.SIMILAR_PRODUCT), total: es.length, countries, sellers, brands: [...new Set(es.map((e) => e.brand).filter(Boolean))], priceRanges: range(es.map((e) => e.price).filter(Boolean)), strongest: best === 3 ? MATCH.EXACT_MATCH : best === 2 ? MATCH.PROBABLE_MATCH : best === 1 ? MATCH.SIMILAR_PRODUCT : null,
      verifiedExact: es.some((e) => e.matchType === MATCH.EXACT_MATCH && e.confidence === 'HIGH') }; };
  const belgium = bucket([REGION.BELGIUM]); const eu = bucket([REGION.BELGIUM, REGION.NEIGHBOURING_EU, REGION.EU]);
  const searched = done.length > 0; const last = done.at(-1) ?? null;
  return { searched, searchCount: (searches ?? []).length, lastSearchedAt: last?.completedAt ?? last?.requestedAt ?? null, belgium, eu, neighbouring: bucket([REGION.NEIGHBOURING_EU]),
    noMatchFound: searched && evidence.length === 0, // ONLY "this search found nothing reliable": never "not sold in Europe"
    noMatchMeansNotSold: false,
    note: 'Observed market signals from the searches the owner ran: not total market coverage, not proof of legal marketability, not Amazon readiness, not product identity.',
    context: landedPerUnitEurMinor !== null && landedPerUnitEurMinor !== undefined ? { landedPerUnitEurMinor, observedBelgium: belgium.priceRanges, note: 'Shown for context only: it does not make or change the purchase decision.' } : null };
}

/** What is missing to tell the supplier's product from a market match (feeds the needs engine: an exact model number may be the most valuable question when a probable match exists). */
export function marketIdentityGap(state) {
  const ids = state.identity?.identifiers ?? {}; const searches = state.marketSearches ?? []; const ev = searches.filter((s) => s.status === SEARCH_STATUS.DONE).flatMap((s) => s.evidence ?? []);
  const probable = ev.some((e) => e.matchType === MATCH.PROBABLE_MATCH || e.matchType === MATCH.SIMILAR_PRODUCT);
  const missing = []; if (!ids.model && (probable || searches.length)) missing.push('model');
  return { missing, probableMatchesNotDistinguishable: probable && !ids.model, searched: searches.length > 0 };
}

/** Reducer helpers (called from core/case.js). */
export function recordSearchRequest(s, ev, at) {
  const list = (s.marketSearches ??= []); const id = `ms-${1 + Math.max(0, ...list.map((x) => Number(String(x.id).slice(3)) || 0))}`;
  const rec = { id, requestedAt: at, completedAt: null, status: ev.status ?? SEARCH_STATUS.PROVIDER_NOT_CONFIGURED, provider: ev.provider ?? null, input: ev.input ?? null, outgoing: ev.outgoing ?? null, consent: ev.consent === true, evidence: [], note: ev.note ?? null };
  if (ev.status === SEARCH_STATUS.DONE || ev.status === SEARCH_STATUS.ERROR) { rec.completedAt = at; rec.evidence = (ev.evidence ?? []).map((e) => sanitizeEvidence(e, { provider: ev.provider })).filter(Boolean); if (ev.error) rec.error = String(ev.error); if (ev.radar && typeof ev.radar === 'object') rec.radar = ev.radar; }
  list.push(rec); return rec;
}
