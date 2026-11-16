// Développement des ventes > Campagnes publicitaires - server source for ONE tenant (same contract as the other Growth sources: the merchant is fixed by the
// server context). It READS the ad facts through an injectable `load()` (today: the paid-acquisition import contract; later: an ad connector) and hands them to the
// pure engine (ads/ads.js). It never calls an ad platform and never changes a budget or a campaign.
//   - no `load` (no ad account connected): state NOT_CONNECTED, the missing connection is named, nothing is invented;
//   - the facts do not pass the contract (src/marketing/paid.js#normalizeAds): state INVALID with the reasons;
//   - otherwise state OK with every campaign's diagnosis and the items for Opportunités.
import { normalizeAds } from '../../marketing/paid.js';
import { diagnoseAds, adsItems, ADS_CONFIG, ADS_RULE } from '../ads/ads.js';

export const FIRST_CHANNEL = 'meta_ads';

export function createAdsSource({ load = null, timeZone, now = () => new Date(), config = ADS_CONFIG, shopOrders = null, cacheMs = 5 * 60_000 } = {}) {
  let cached = null; let cachedAt = 0;
  return async function ads() {
    const t = now();
    if (cached && t.getTime() - cachedAt < cacheMs) return cached;
    const base = { rule: ADS_RULE, channel: FIRST_CHANNEL, generatedAt: t.toISOString() };
    let payload;
    if (typeof load !== 'function') payload = { ...base, state: 'NOT_CONNECTED', missing: 'AD_ACCOUNT_CONNECTION', campaigns: [], items: [] };
    else {
      let raw = null; try { raw = await load(); } catch (e) { console.error('growth ads: source unavailable:', e?.message ?? e); }
      if (!raw) payload = { ...base, state: 'UNAVAILABLE', campaigns: [], items: [] };
      else {
        const { ads: normalized, errors } = normalizeAds(raw);
        if (!normalized) payload = { ...base, state: 'INVALID', errors, campaigns: [], items: [] };
        else {
          normalized.conversion_objective = typeof raw.conversion_objective === 'string' && raw.conversion_objective.trim() ? raw.conversion_objective.trim() : null; // the contract does not carry it: kept as the source stated it, else unknown
          const orders = typeof shopOrders === 'function' ? await shopOrders().catch(() => null) : shopOrders;
          const d = diagnoseAds({ ads: normalized, now: t, timeZone, config, shopOrdersByCampaign: orders });
          payload = { ...base, state: 'OK', channel: d.channel ?? FIRST_CHANNEL, currency: d.currency, window: d.window, matureEnd: d.matureEnd, lagDays: d.lagDays, retrievedAt: normalized.retrieved_at ?? null, campaigns: d.campaigns, items: adsItems(d) };
        }
      }
    }
    cached = payload; cachedAt = t.getTime();
    return payload;
  };
}
