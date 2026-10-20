// MARKET RADAR service (server side): one controlled entry point between the phone and the search provider.
//  - credentials come ONLY from the server environment (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD) and never appear in a response, a log line or an error message;
//  - cost control: at most MARKET_MAX_QUERIES queries per search (default 2), a pessimistic estimate checked against MARKET_MAX_COST_USD (default 0.05) and against the account balance, a daily cap
//    (MARKET_DAILY_MAX, default 20), one search at a time, a minimum interval between searches, and a cache so the same search is never paid twice within MARKET_CACHE_HOURS (default 24);
//  - nothing is retried automatically (a retry is a second paid call); every failure becomes a named code with a plain message;
//  - PHOTOS: the search itself is text only. Photo recognition (`identify`, Google Cloud Vision) is OFF unless the operator sets MARKET_PHOTO_ENABLED=1 AND GOOGLE_VISION_API_KEY; it is OWNER-only; each photo needs the owner's explicit
//    consent bound to THIS image (its sha-256, checked here); the photo is never stored or logged; at most MARKET_PHOTO_DAILY_MAX per day (5). A local barcode read on the phone sends no photo at all (only the number).
//  - `identification` (from a barcode read, a photo, or the owner) only fills what the case lacks, is cleaned here (a GTIN needs a valid check digit) and keeps its source.
import { COUNTRIES, ProviderError, dfsBalance, estimateCostUsd, fetchShoppingListings } from '../adapters/market-dataforseo.js';
import { analyseListings, compareWithSupplier, identificationConfidence, mergeIdentification, queriesFromInput, sanitizeIdentification, toStoredEvidence } from '../adapters/market-radar.js';
import { MAX_IMAGE_BYTES, VISION_COST_PER_PHOTO_USD, imageKind, visionIdentify } from '../adapters/market-vision.js';
import { createHash } from 'node:crypto';
import { lookupGtin } from '../adapters/gtin-lookup.js';
import { analyseWithFacets, listingFromEvidence, proposeQuestion, refine as refineListings, sanitizeConfirmed } from '../adapters/market-refine.js';
const STORED_MAX = 60; // listings kept in the case (and re-read by the refine step): above the ~53 a real search returns
const FACETS = ['capacity', 'type', 'variant', 'model'];

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const FR = {
  NOT_CONFIGURED: 'La recherche de prix n\'est pas configurée sur ce serveur : rien n\'a été cherché ni envoyé.',
  INVALID_INPUT: 'Donnez au moins un nom, une marque, un modèle ou un code-barres au produit.',
  BUSY: 'Une recherche est déjà en cours. Attendez son résultat.',
  TOO_SOON: 'Une recherche vient d\'être faite. Patientez quelques secondes avant d\'en relancer une.',
  DAILY_LIMIT: 'La limite quotidienne de recherches est atteinte. Elle protège le budget : réessayez demain.',
  COST_LIMIT: 'Le coût estimé dépasse le plafond fixé : rien n\'a été envoyé.',
  BALANCE_LOW: 'Le crédit du service de recherche est insuffisant : rien n\'a été envoyé. Aucun rechargement automatique n\'existe.',
  BALANCE_UNREADABLE: 'Le solde du service de recherche est illisible : par prudence, rien n\'a été envoyé.',
  PROVIDER_AUTH: 'Le service de recherche refuse l\'accès (identifiants invalides ou compte désactivé). Contactez l\'administrateur.',
  PROVIDER_BALANCE: 'Le service de recherche signale un crédit insuffisant.',
  PROVIDER_RATE_LIMIT: 'Le service de recherche limite les appels pour le moment : réessayez plus tard.',
  PROVIDER_ERROR: 'Le service de recherche a répondu par une erreur. Rien n\'est inventé : réessayez plus tard.',
  NETWORK: 'Le service de recherche est injoignable (réseau). Vos données sont intactes : réessayez quand la connexion est revenue.',
  TIMEOUT: 'Le service de recherche n\'a pas répondu à temps. Aucune nouvelle tentative automatique n\'a été faite (elle serait facturée).',
  BAD_COUNTRY: 'Ce marché n\'est pas géré.',
  PHOTO_NOT_ENABLED: 'La reconnaissance par photo n\'est pas activée sur ce serveur : aucune photo n\'a été envoyée.',
  CONSENT_REQUIRED: 'Votre accord explicite pour envoyer cette photo est nécessaire : rien n\'a été envoyé.',
  CONSENT_MISMATCH: 'L\'accord donné ne correspond pas à cette image : rien n\'a été envoyé.',
  FORBIDDEN_ROLE: 'Seul le propriétaire peut envoyer une photo à un service externe.',
  BAD_IMAGE: 'La photo doit être un JPEG, PNG ou WebP de 3 Mo au maximum : rien n\'a été envoyé.',
  PHOTO_BUSY: 'Une photo est déjà en cours d\'analyse.',
  PHOTO_TOO_SOON: 'Une photo vient d\'être analysée : patientez quelques secondes.',
  PHOTO_DAILY_LIMIT: 'La limite quotidienne de photos analysées est atteinte. Elle protège le budget : réessayez demain.',
  VISION_AUTH: 'Le service de reconnaissance refuse l\'accès (clé invalide ou projet désactivé). Contactez l\'administrateur.',
  VISION_QUOTA: 'Le service de reconnaissance a atteint son quota : réessayez plus tard.',
  VISION_ERROR: 'Le service de reconnaissance a répondu par une erreur. Rien n\'est inventé : réessayez plus tard.',
};
const HTTP = { NOT_CONFIGURED: 503, INVALID_INPUT: 400, BUSY: 429, TOO_SOON: 429, DAILY_LIMIT: 429, COST_LIMIT: 402, BALANCE_LOW: 402, BALANCE_UNREADABLE: 503, PROVIDER_AUTH: 502, PROVIDER_BALANCE: 502, PROVIDER_RATE_LIMIT: 503, PROVIDER_ERROR: 502, NETWORK: 503, TIMEOUT: 504, BAD_COUNTRY: 400, PHOTO_NOT_ENABLED: 503, CONSENT_REQUIRED: 428, CONSENT_MISMATCH: 428, FORBIDDEN_ROLE: 403, BAD_IMAGE: 400, PHOTO_BUSY: 429, PHOTO_TOO_SOON: 429, PHOTO_DAILY_LIMIT: 429, VISION_AUTH: 502, VISION_QUOTA: 503, VISION_ERROR: 502 };
export class RadarError extends Error { constructor(code, extra = {}) { super(FR[code] ?? code); this.code = code; this.status = HTTP[code] ?? 500; Object.assign(this, extra); } }

export function createMarketRadar({ env = process.env, fetchImpl = fetch, now = () => new Date(), ecb = null, sleep, pollMs, maxWaitMs } = {}) {
  const login = String(env.DATAFORSEO_LOGIN ?? '').trim(); const password = String(env.DATAFORSEO_PASSWORD ?? '').trim(); const enabled = !!(login && password);
  const lim = { maxQueries: Math.min(3, Math.floor(num(env.MARKET_MAX_QUERIES, 2))), maxCostUsd: num(env.MARKET_MAX_COST_USD, 0.05), dailyMax: Math.floor(num(env.MARKET_DAILY_MAX, 20)), minIntervalMs: num(env.MARKET_MIN_INTERVAL_SEC, 10) * 1000, cacheMs: num(env.MARKET_CACHE_HOURS, 24) * 3_600_000 };
  const visionKey = String(env.GOOGLE_VISION_API_KEY ?? '').trim(); const photoEnabled = !!visionKey && String(env.MARKET_PHOTO_ENABLED ?? '') === '1';
  const plim = { dailyMax: Math.floor(num(env.MARKET_PHOTO_DAILY_MAX, 5)), minIntervalMs: num(env.MARKET_PHOTO_MIN_INTERVAL_SEC, 5) * 1000, maxCostUsd: num(env.MARKET_PHOTO_MAX_COST_USD, 0.02) };
  let photoBusy = false; let photoLastAt = 0; let todayPhotos = 0;
  const cache = new Map(); let inflight = false; let lastAt = 0; let day = ''; let todayCount = 0; let todaySpentUsd = 0;
  const today = () => now().toISOString().slice(0, 10); const rollDay = () => { if (day !== today()) { day = today(); todayCount = 0; todaySpentUsd = 0; todayPhotos = 0; } };
  const status = () => { rollDay(); return { enabled, provider: enabled ? 'dataforseo-google-shopping' : null, markets: Object.keys(COUNTRIES), limits: { maxQueriesPerSearch: lim.maxQueries, maxCostPerSearchUsd: lim.maxCostUsd, dailySearches: lim.dailyMax, minIntervalSec: lim.minIntervalMs / 1000, cacheHours: lim.cacheMs / 3_600_000 }, today: { searches: todayCount, spentUsd: +todaySpentUsd.toFixed(4) },
    photoIdentification: { enabled: photoEnabled, reason: photoEnabled ? null : visionKey ? 'NOT_ENABLED_BY_OPERATOR' : 'NO_KEY', provider: 'google-cloud-vision', region: 'US', ownerOnly: true, consentBoundToImage: true, dailyPhotos: plim.dailyMax, today: todayPhotos, estimatedCostPerPhotoUsd: VISION_COST_PER_PHOTO_USD, localBarcode: "lu sur le téléphone, aucune photo n'est envoyée" }, note: "La recherche est faite par texte (Google Shopping via DataForSEO) ; une photo n'est envoyée qu'avec un accord explicite pour cette photo." }; };

  async function search(body = {}) {
    if (!enabled) throw new RadarError('NOT_CONFIGURED');
    const country = String(body.country ?? 'BE').toUpperCase(); if (!COUNTRIES[country]) throw new RadarError('BAD_COUNTRY');
    const b = body.input && typeof body.input === 'object' ? body.input : {}; const identification = sanitizeIdentification(body.identification);
    const input = mergeIdentification({ name: str(b.name), brand: str(b.brand), model: str(b.model), manufacturerRef: str(b.manufacturerRef), gtin: digits(b.gtin), traits: b.traits && typeof b.traits === 'object' ? b.traits : {}, category: str(b.category) }, identification);
    const confirmedIn = sanitizeConfirmed(body.confirmed); if (confirmedIn) { input.confirmed = confirmedIn; if (confirmedIn.model) { input.model = confirmedIn.model; input.sources.model = 'OWNER_CONFIRMED'; } if (confirmedIn.brand) { input.brand = confirmedIn.brand; input.sources.brand = 'OWNER_CONFIRMED'; } }
    // a barcode alone cannot be searched reliably: resolve it to a NAME through the open Facts databases (only the number is sent; a hit is a proposal with its source and link; not found is normal for non-food goods)
    let gtinLookup = null; if (input.gtin && String(env.MARKET_GTIN_LOOKUP ?? '1') !== '0' && (!input.name || !input.brand)) { gtinLookup = await lookupGtin(input.gtin, { fetchImpl });
      if (gtinLookup.found) { if (!input.name) { input.name = gtinLookup.name; input.sources.name = 'GTIN_DB'; } if (!input.brand && gtinLookup.brand) { input.brand = gtinLookup.brand; input.sources.brand = 'GTIN_DB'; } if (gtinLookup.quantity) input.quantity = gtinLookup.quantity; input.gtinResolved = true; } }
    const queries = queriesFromInput(input, lim.maxQueries); if (!queries.length) throw new RadarError('INVALID_INPUT');
    const key = `${country}|${queries.map((q) => q.text.toLowerCase()).join('|')}`; const hit = cache.get(key);
    const supplier = body.supplier && Number.isFinite(Number(body.supplier.price)) ? { price: Number(body.supplier.price), currency: str(body.supplier.currency)?.toUpperCase() ?? null } : null;
    let rates = null; if (ecb) { try { rates = await ecb(); } catch { rates = null; } }
    const finish = (raw, cached) => { const { analysis: a, facet } = analyseWithFacets(raw.listings, input, { ecb: rates }); const comparison = compareWithSupplier({ reference: a.reference, supplier, ecb: rates });
      return { status: 'DONE', provider: 'dataforseo-google-shopping', market: { country, searchDomain: COUNTRIES[country].domain }, queries, input: { name: input.name, brand: input.brand, model: input.model, gtin: input.gtin, sources: input.sources, confirmed: input.confirmed ?? null }, question: proposeQuestion({ input, listings: raw.listings, facet }), identification: identification ? { ...identification, confidence: identificationConfidence(identification), ...(gtinLookup ? { gtinLookup } : {}) } : null, ...a, comparison, observedAt: raw.datetime ?? raw.at, partial: raw.partial, runs: raw.runs, cost: { estimatedMaxUsd: estimateCostUsd(queries.length), reportedUsd: raw.costUsd, cached }, cached,
        stored: a.listings.slice(0, STORED_MAX).map((r) => toStoredEvidence(r, country)), notes: ['Les liens « Google Shopping » ouvrent la page de Google Shopping du produit, pas la page directe du marchand ni d\'Amazon ou de bol.com', 'Aucun résultat ne prouve qu\'un produit n\'est pas vendu : « rien trouvé » signifie seulement que cette recherche n\'a rien de fiable', 'Observations de marché : ni marge, ni conformité UE, ni décision d\'achat'] }; };
    if (hit && now().getTime() - hit.at < lim.cacheMs) return finish(hit.raw, true);
    rollDay();
    if (inflight) throw new RadarError('BUSY');
    if (now().getTime() - lastAt < lim.minIntervalMs) throw new RadarError('TOO_SOON', { retryAfterSec: Math.ceil((lim.minIntervalMs - (now().getTime() - lastAt)) / 1000) });
    if (todayCount >= lim.dailyMax) throw new RadarError('DAILY_LIMIT');
    const estimate = estimateCostUsd(queries.length); if (estimate > lim.maxCostUsd) throw new RadarError('COST_LIMIT', { estimateUsd: estimate });
    inflight = true;
    try {
      const balance = await dfsBalance({ login, password, fetchImpl }); if (balance === null) throw new RadarError('BALANCE_UNREADABLE'); if (balance < estimate) throw new RadarError('BALANCE_LOW', { balanceUsd: balance });
      lastAt = now().getTime(); todayCount += 1;
      let raw; try { raw = await fetchShoppingListings({ queries, country, login, password, fetchImpl, now, ...(sleep ? { sleep } : {}), ...(pollMs !== undefined ? { pollMs } : {}), ...(maxWaitMs !== undefined ? { maxWaitMs } : {}) }); }
      catch (e) { if (e instanceof ProviderError) { todaySpentUsd += Number(e.costUsd) || 0; throw new RadarError(e.code in FR ? e.code : 'PROVIDER_ERROR'); } throw e; }
      todaySpentUsd += raw.costUsd; raw.at = now().toISOString(); if (!raw.partial) cache.set(key, { at: now().getTime(), raw });
      return finish(raw, false);
    } finally { inflight = false; }
  }

  /** Photo -> identification PROPOSAL (Google Cloud Vision). OWNER only, explicit consent bound to this image, off unless the operator enabled it, capped, never stored. Nothing here searches or spends DataForSEO credit. */
  async function identify(body = {}, actor = {}) {
    if (!photoEnabled) throw new RadarError('PHOTO_NOT_ENABLED');
    if (actor?.role !== 'OWNER') throw new RadarError('FORBIDDEN_ROLE');
    let bytes; try { bytes = Buffer.from(String(body.imageBase64 ?? ''), 'base64'); } catch { throw new RadarError('BAD_IMAGE'); }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !imageKind(bytes)) throw new RadarError('BAD_IMAGE');
    const sha = createHash('sha256').update(bytes).digest('hex'); const c = body.consent;
    if (!c || c.accepted !== true) throw new RadarError('CONSENT_REQUIRED', { provider: 'google-cloud-vision', region: 'US', sha256: sha, bytes: bytes.length });
    if (String(c.sha256 ?? '').toLowerCase() !== sha) throw new RadarError('CONSENT_MISMATCH');
    rollDay(); if (photoBusy) throw new RadarError('PHOTO_BUSY');
    if (now().getTime() - photoLastAt < plim.minIntervalMs) throw new RadarError('PHOTO_TOO_SOON', { retryAfterSec: Math.ceil((plim.minIntervalMs - (now().getTime() - photoLastAt)) / 1000) });
    if (todayPhotos >= plim.dailyMax) throw new RadarError('PHOTO_DAILY_LIMIT');
    if (VISION_COST_PER_PHOTO_USD > plim.maxCostUsd) throw new RadarError('COST_LIMIT', { estimateUsd: VISION_COST_PER_PHOTO_USD });
    photoBusy = true;
    try {
      photoLastAt = now().getTime(); todayPhotos += 1; let raw;
      try { raw = await visionIdentify({ apiKey: visionKey, imageBase64: bytes.toString('base64'), fetchImpl }); }
      catch (e) { if (e instanceof ProviderError) throw new RadarError(e.code in FR ? e.code : 'VISION_ERROR'); throw e; }
      const identification = sanitizeIdentification(raw); const confidence = identificationConfidence(identification);
      return { status: 'DONE', identification: { ...identification, confidence }, photo: { sha256: sha, bytes: bytes.length, kept: false }, consent: { at: now().toISOString(), sha256: sha, provider: 'google-cloud-vision', region: 'US' }, cost: { estimatedMaxUsd: VISION_COST_PER_PHOTO_USD },
        notes: ['Valeurs proposées par une machine : à confirmer. Une lecture de texte peut se tromper et une « meilleure estimation » est un nom de catégorie, pas un produit exact.', "La photo n'est ni conservée ni journalisée par le serveur."] };
    } finally { photoBusy = false; }
  }
  /** The owner's one-tap answer (or "I don't know" = no `confirmed`) applied to the listings ALREADY obtained: pure local re-analysis. It never calls the provider, never needs credentials and never costs anything
   *  (no fetch is made here); a new, paid search is a separate explicit action with its own caps. */
  async function refine(body = {}) {
    const ev = Array.isArray(body.evidence) ? body.evidence.slice(0, STORED_MAX) : []; if (!ev.length) throw new RadarError('INVALID_INPUT');
    const b = body.input && typeof body.input === 'object' ? body.input : {};
    const input = mergeIdentification({ name: str(b.name), brand: str(b.brand), model: str(b.model), gtin: digits(b.gtin), quantity: str(b.quantity), traits: b.traits && typeof b.traits === 'object' ? b.traits : {} }, sanitizeIdentification(body.identification)); // same hints as the search had (label size / models), same cleaning
    const bs = body.inputSources?.brand; if (['PHOTO_VISION', 'LOCAL_BARCODE', 'GTIN_DB', 'OWNER_CONFIRMED'].includes(bs)) input.sources = { ...(input.sources ?? {}), brand: bs }; // where the searched brand came from: a machine-read brand stays provisional
    const supplier = body.supplier && Number.isFinite(Number(body.supplier.price)) ? { price: Number(body.supplier.price), currency: str(body.supplier.currency)?.toUpperCase() ?? null } : null;
    let rates = null; if (ecb) { try { rates = await ecb(); } catch { rates = null; } }
    const listings = ev.map(listingFromEvidence); const r = refineListings({ listings, input, confirmed: body.confirmed, ecb: rates, supplier, asked: Math.min(2, Math.max(0, Math.floor(Number(body.asked) || 0))), declined: (Array.isArray(body.declined) ? body.declined : []).filter((x) => FACETS.includes(x)) }); const country = String(body.country ?? 'BE').toUpperCase();
    return { status: 'DONE', provider: 'local-refine', market: { country, searchDomain: COUNTRIES[country]?.domain ?? null }, input: { name: input.name, brand: input.brand, model: r.input.model ?? input.model, gtin: input.gtin, confirmed: r.confirmed }, confirmation: r.confirmed ? 'CONFIRMED' : 'UNKNOWN', question: r.question, ...r.analysis, comparison: r.comparison, cost: { estimatedMaxUsd: 0, reportedUsd: 0, calls: 0 }, cached: false,
      stored: r.analysis.listings.slice(0, STORED_MAX).map((x, i) => ({ ...toStoredEvidence(x, country), observedAt: ev[i]?.observedAt ?? x.observedAt })), notes: ['Nouvelle lecture locale des annonces déjà relevées : aucun appel au service de recherche, aucun coût, aucune photo envoyée.'] };
  }
  return { enabled, status, search, identify, refine };

}
const str = (v) => { const s = String(v ?? '').trim(); return s ? s.slice(0, 200) : null; };
const digits = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return [8, 12, 13, 14].includes(d.length) ? d : null; };
