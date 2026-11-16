// Développement des ventes > Campagnes publicitaires (lot _06, first version) - the ad-campaign diagnosis. Pure and deterministic: the facts an ad source
// provides (the existing Nordla paid-acquisition import contract, src/marketing/paid.js) in, one diagnosis per campaign out. It reads nothing and writes nothing:
// no budget, no campaign is ever changed.
//
// FIRST CHANNEL: Meta Ads (Facebook / Instagram). Why: HABB's acquisition work is Instagram-first (a local shop, Namur), the contract's rows (campaign, day,
// cost, clicks, conversions) are what Meta's reporting returns, and Nordla already has an Instagram brand profile. Google Ads needs a developer-token approval
// that is not available to the owner today. NO ad account is connected to Nordla yet: the engine runs on the import contract (file / future connector); without
// data the payload says so (NOT_CONNECTED) and nothing is invented.
//
// THE FACTS COME FROM THE SOURCE, THE DIAGNOSIS EXPLAINS: a missing figure is NEVER zero. A row whose `conversions` is absent makes the campaign's conversions
// UNKNOWN; only a complete set of rows with real zeros is a real zero. Conversions reported by the platform are platform-reported (the contract's own limitation).
//
// RULE growth-ads.1 (one campaign, the period the source gave):
//   1. MATURE PERIOD. Conversions are reported late (the attribution window): only the days that ended at least `conversionLagDays` ago can be judged. The
//      mature period = [window.start, min(window.end, today - lag)). Shorter than `minMatureDays` -> NOT_MATURE: no conclusion, said as such.
//   2. COMPLETENESS. At least `minSpendCoverage` of the mature days must have a row (the same share the paid metrics use) -> otherwise INCOMPLETE_PERIOD.
//      A row without date, or a cost that is missing, cannot be placed/summed -> SPEND_UNKNOWN (no conclusion).
//   3. SPEND. Under `minSpend` (currency units) -> LOW_SPEND: nothing to say.
//   4. CONVERSIONS. Any mature row without a conversions figure -> CONVERSIONS_UNKNOWN (action: check the tracking). A complete zero: under `minClicks` clicks ->
//      LOW_TRAFFIC (not enough visits to blame the page); otherwise NO_CONVERSION (action: check the tracking first if the shop recorded orders for this campaign,
//      else examine the landing page). Conversions above zero -> OK (no item).
// Thresholds are explicit configuration (not recommendations); every diagnosis carries the figures and the dates it was computed from.

import { localDateString, addDays } from '../../metrics/windows.js';

export const ADS_RULE = 'growth-ads.1';
export const ADS_CONFIG = Object.freeze({ minSpend: 30, minClicks: 30, minMatureDays: 7, conversionLagDays: 7, minSpendCoverage: 0.95 });
/** Statuses that become an item in Opportunités. The others stay listed in the campaigns summary only. */
export const ACTIONABLE = Object.freeze(['NO_CONVERSION', 'CONVERSIONS_UNKNOWN']);
export const CHANNEL_NAMES = Object.freeze({ meta_ads: 'Meta Ads', google_ads: 'Google Ads' });

const DAY = 86400000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * @param {{ ads: object|null, now: Date, timeZone: string, config?: object, shopOrdersByCampaign?: Map<string, number>|null }} p
 *   ads = normalizeAds().ads (source_system, platform, currency, window {start, end exclusive}, retrieved_at, conversion_objective?, rows[])
 * @returns {{ rule: string, channel: string, currency: string|null, window: object|null, matureEnd: string|null, lagDays: number, campaigns: object[] }}
 */
export function diagnoseAds({ ads, now, timeZone, config = ADS_CONFIG, shopOrdersByCampaign = null }) {
  const cfg = { ...ADS_CONFIG, ...config };
  if (!ads || !Array.isArray(ads.rows)) return { rule: ADS_RULE, channel: ads?.platform ?? null, currency: null, window: null, matureEnd: null, lagDays: cfg.conversionLagDays, campaigns: [] };
  const today = localDateString(now, timeZone);
  const { start, end } = ads.window;
  const matureEnd = [end, addDays(today, -cfg.conversionLagDays)].sort()[0]; // exclusive: the last judged day is matureEnd - 1
  const matureDays = Math.max(0, dayDiff(start, matureEnd));
  const by = new Map();
  for (const r of ads.rows) (by.get(r.campaign_id) ?? by.set(r.campaign_id, []).get(r.campaign_id)).push(r);
  const campaigns = [...by.entries()].map(([campaignId, rows]) => {
    const name = rows.find((r) => r.campaign_name)?.campaign_name ?? null;
    const base = { campaignId, campaignName: name, channel: ads.platform, currency: ads.currency, objective: ads.conversion_objective ?? null, window: { start, end }, matureEnd, matureDays, lagDays: cfg.conversionLagDays, retrievedAt: ads.retrieved_at ?? null, source: ads.source_system, accountRef: ads.account_ref ?? null };
    const out = (status, evidence = {}) => ({ ...base, status, actionable: ACTIONABLE.includes(status), evidence, rule: ADS_RULE });
    if (matureDays < cfg.minMatureDays) return out('NOT_MATURE', { matureDays, minMatureDays: cfg.minMatureDays });
    const mature = rows.filter((r) => isDate(r.date) && r.date >= start && r.date < matureEnd);
    if (rows.some((r) => !isDate(r.date))) return out('SPEND_UNKNOWN', { reason: 'ROW_WITHOUT_DATE' });
    const days = new Set(mature.map((r) => r.date)).size; const coverage = matureDays > 0 ? days / matureDays : 0;
    if (coverage < cfg.minSpendCoverage) return out('INCOMPLETE_PERIOD', { daysWithData: days, matureDays, coverage: round2(coverage), minSpendCoverage: cfg.minSpendCoverage });
    if (mature.some((r) => r.cost === null || r.cost === undefined)) return out('SPEND_UNKNOWN', { reason: 'COST_MISSING' });
    const spend = round2(mature.reduce((a, r) => a + r.cost, 0)); const clicks = mature.reduce((a, r) => a + r.clicks, 0); const impressions = mature.reduce((a, r) => a + r.impressions, 0);
    const figures = { spend, clicks, impressions };
    if (spend < cfg.minSpend) return out('LOW_SPEND', { ...figures, minSpend: cfg.minSpend });
    const unknownRows = mature.filter((r) => r.conversions === null || r.conversions === undefined).length;
    if (unknownRows > 0) return out('CONVERSIONS_UNKNOWN', { ...figures, conversions: null, rowsWithConversions: mature.length - unknownRows, rows: mature.length });
    const conversions = mature.reduce((a, r) => a + r.conversions, 0);
    if (conversions > 0) return out('OK', { ...figures, conversions });
    if (clicks < cfg.minClicks) return out('LOW_TRAFFIC', { ...figures, conversions: 0, minClicks: cfg.minClicks });
    const shopOrders = shopOrdersByCampaign instanceof Map && shopOrdersByCampaign.has(campaignId) ? shopOrdersByCampaign.get(campaignId) : null;
    return out('NO_CONVERSION', { ...figures, conversions: 0, shopOrders, action: shopOrders > 0 ? 'checkTracking' : 'reviewLanding' });
  });
  campaigns.sort((a, b) => (b.evidence.spend ?? -1) - (a.evidence.spend ?? -1) || String(a.campaignId).localeCompare(String(b.campaignId)));
  return { rule: ADS_RULE, channel: ads.platform, currency: ads.currency, window: { start, end }, matureEnd, lagDays: cfg.conversionLagDays, campaigns };
}

/** The Opportunités items of a diagnosis (one per actionable campaign). The item carries the exact campaign, channel, period, spend, currency, objective and proof. */
export function adsItems(diagnosis) {
  return diagnosis.campaigns.filter((c) => c.actionable).map((c) => {
    const check = c.status === 'CONVERSIONS_UNKNOWN' ? 'tracking' : c.evidence.action === 'checkTracking' ? 'tracking' : 'landing';
    return {
      id: `ad:${c.channel}:${c.campaignId}`, category: 'ads', kind: 'adCampaign', sourcePage: 'ads',
      title: { code: `ads.${c.status}.title`, params: { name: c.campaignName ?? c.campaignId } }, explanation: { code: `ads.${c.status}.why`, params: {} },
      entity: { type: 'adCampaign', id: c.campaignId, title: c.campaignName ?? c.campaignId },
      evidence: { channel: c.channel, campaignId: c.campaignId, campaignName: c.campaignName, status: c.status, currency: c.currency, objective: c.objective, source: c.source, accountRef: c.accountRef, ...c.evidence, matureDays: c.matureDays, lagDays: c.lagDays },
      reliability: 'limited', // platform-reported conversions: never a verified figure (contract limitation)
      measurement: { start: c.window.start, end: c.matureEnd, calculatedAt: c.retrievedAt },
      preparedAction: { code: 'adCheck', check, campaign: { channel: c.channel, campaignId: c.campaignId, name: c.campaignName ?? c.campaignId } },
      target: { type: 'adCampaign', available: false, id: c.campaignId }, prerequisites: [], dataBlocker: null,
    };
  });
}
