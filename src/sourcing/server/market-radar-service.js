// MARKET RADAR service (server side): one controlled entry point between the phone and the search provider.
//  - credentials come ONLY from the server environment (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD) and never appear in a response, a log line or an error message;
//  - cost control: at most MARKET_MAX_QUERIES queries per search (default 2), a pessimistic estimate checked against MARKET_MAX_COST_USD (default 0.05) and against the account balance, a daily cap
//    (MARKET_DAILY_MAX, default 20), one search at a time, a minimum interval between searches, and a cache so the same search is never paid twice within MARKET_CACHE_HOURS (default 24);
//  - nothing is retried automatically (a retry is a second paid call); every failure becomes a named code with a plain message;
//  - no photo, no image: text queries only. `identification` is an OPTIONAL input where a future photo step can put what it recognised (it fills only what the case lacks).
import { COUNTRIES, ProviderError, dfsBalance, estimateCostUsd, fetchShoppingListings } from '../adapters/market-dataforseo.js';
import { analyseListings, compareWithSupplier, mergeIdentification, queriesFromInput, toStoredEvidence } from '../adapters/market-radar.js';

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
};
const HTTP = { NOT_CONFIGURED: 503, INVALID_INPUT: 400, BUSY: 429, TOO_SOON: 429, DAILY_LIMIT: 429, COST_LIMIT: 402, BALANCE_LOW: 402, BALANCE_UNREADABLE: 503, PROVIDER_AUTH: 502, PROVIDER_BALANCE: 502, PROVIDER_RATE_LIMIT: 503, PROVIDER_ERROR: 502, NETWORK: 503, TIMEOUT: 504, BAD_COUNTRY: 400 };
export class RadarError extends Error { constructor(code, extra = {}) { super(FR[code] ?? code); this.code = code; this.status = HTTP[code] ?? 500; Object.assign(this, extra); } }

export function createMarketRadar({ env = process.env, fetchImpl = fetch, now = () => new Date(), ecb = null, sleep, pollMs, maxWaitMs } = {}) {
  const login = String(env.DATAFORSEO_LOGIN ?? '').trim(); const password = String(env.DATAFORSEO_PASSWORD ?? '').trim(); const enabled = !!(login && password);
  const lim = { maxQueries: Math.min(3, Math.floor(num(env.MARKET_MAX_QUERIES, 2))), maxCostUsd: num(env.MARKET_MAX_COST_USD, 0.05), dailyMax: Math.floor(num(env.MARKET_DAILY_MAX, 20)), minIntervalMs: num(env.MARKET_MIN_INTERVAL_SEC, 10) * 1000, cacheMs: num(env.MARKET_CACHE_HOURS, 24) * 3_600_000 };
  const cache = new Map(); let inflight = false; let lastAt = 0; let day = ''; let todayCount = 0; let todaySpentUsd = 0;
  const today = () => now().toISOString().slice(0, 10); const rollDay = () => { if (day !== today()) { day = today(); todayCount = 0; todaySpentUsd = 0; } };
  const status = () => { rollDay(); return { enabled, provider: enabled ? 'dataforseo-google-shopping' : null, markets: Object.keys(COUNTRIES), limits: { maxQueriesPerSearch: lim.maxQueries, maxCostPerSearchUsd: lim.maxCostUsd, dailySearches: lim.dailyMax, minIntervalSec: lim.minIntervalMs / 1000, cacheHours: lim.cacheMs / 3_600_000 }, today: { searches: todayCount, spentUsd: +todaySpentUsd.toFixed(4) },
    photoIdentification: { enabled: false, reason: 'NOT_AUTHORIZED', note: 'aucune photo n\'est envoyée à un service externe ; l\'identification par photo sera branchée ici plus tard (champ identification)' }, note: 'Recherche par texte seulement (Google Shopping via DataForSEO).' }; };

  async function search(body = {}) {
    if (!enabled) throw new RadarError('NOT_CONFIGURED');
    const country = String(body.country ?? 'BE').toUpperCase(); if (!COUNTRIES[country]) throw new RadarError('BAD_COUNTRY');
    const b = body.input && typeof body.input === 'object' ? body.input : {};
    const input = mergeIdentification({ name: str(b.name), brand: str(b.brand), model: str(b.model), manufacturerRef: str(b.manufacturerRef), gtin: digits(b.gtin), traits: b.traits && typeof b.traits === 'object' ? b.traits : {}, category: str(b.category) }, body.identification);
    const queries = queriesFromInput(input, lim.maxQueries); if (!queries.length) throw new RadarError('INVALID_INPUT');
    const key = `${country}|${queries.map((q) => q.text.toLowerCase()).join('|')}`; const hit = cache.get(key);
    const supplier = body.supplier && Number.isFinite(Number(body.supplier.price)) ? { price: Number(body.supplier.price), currency: str(body.supplier.currency)?.toUpperCase() ?? null } : null;
    let rates = null; if (ecb) { try { rates = await ecb(); } catch { rates = null; } }
    const finish = (raw, cached) => { const a = analyseListings(raw.listings, input, { ecb: rates }); const comparison = compareWithSupplier({ reference: a.reference, supplier, ecb: rates });
      return { status: 'DONE', provider: 'dataforseo-google-shopping', market: { country, searchDomain: COUNTRIES[country].domain }, queries, input: { name: input.name, brand: input.brand, model: input.model, gtin: input.gtin, sources: input.sources }, ...a, comparison, observedAt: raw.datetime ?? raw.at, partial: raw.partial, runs: raw.runs, cost: { estimatedMaxUsd: estimateCostUsd(queries.length), reportedUsd: raw.costUsd, cached }, cached,
        stored: a.listings.slice(0, 40).map((r) => toStoredEvidence(r, country)), notes: ['Les liens « Google Shopping » ouvrent la page de Google Shopping du produit, pas la page directe du marchand ni d\'Amazon ou de bol.com', 'Aucun résultat ne prouve qu\'un produit n\'est pas vendu : « rien trouvé » signifie seulement que cette recherche n\'a rien de fiable', 'Observations de marché : ni marge, ni conformité UE, ni décision d\'achat'] }; };
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
  return { enabled, status, search };
}
const str = (v) => { const s = String(v ?? '').trim(); return s ? s.slice(0, 200) : null; };
const digits = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return [8, 12, 13, 14].includes(d.length) ? d : null; };
