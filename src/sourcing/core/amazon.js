// Amazon: (1) MARKET OBSERVATIONS - what was SEEN on a marketplace, with date and source; never scraped by Nordla (Amazon's terms) and never presented as demand,
// as "this may be sold" or as an approval; (2) READINESS - whether the compliance evidence Amazon asks sellers to hold is in place, separate from legal marketability.
// Adapters can add other channels later: an adapter returns observations in the shape below, or { status: 'UNAVAILABLE', reason }.
import { toMinor } from './money.js';
import { FACT_CLASS } from './levels.js';

export const MARKETPLACES = Object.freeze(['amazon.be', 'amazon.fr', 'amazon.de', 'amazon.nl']);
const DAY = 86400000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2); };

/** Normalises one observation. `price` is the consumer price incl. VAT in EUR. Throws nothing: an unusable price makes the observation UNAVAILABLE. */
export function normalizeObservation(o, now = new Date()) {
  const marketplace = String(o.marketplace ?? '').toLowerCase();
  const priceMinor = o.price === undefined || o.price === null || o.price === '' ? null : toMinor(o.price);
  const kind = o.kind === 'ESTIMATE' ? 'ESTIMATE' : 'OBSERVED';
  return {
    id: o.id ?? null, marketplace, marketplaceKnown: MARKETPLACES.includes(marketplace), kind, priceMinor, currency: 'EUR', title: o.title ?? null, url: o.url ?? null, asin: o.asin ?? null,
    rating: o.rating ?? null, reviews: o.reviews ?? null, sellerCount: o.sellerCount ?? null, rank: o.rank ?? null, amazonIsSeller: o.amazonIsSeller ?? null,
    observedAt: o.observedAt ?? now.toISOString(), source: o.source ?? 'MANUAL', status: priceMinor === null ? 'UNAVAILABLE' : kind === 'ESTIMATE' ? 'ESTIMATED' : 'OBSERVED',
    factClass: kind === 'ESTIMATE' ? FACT_CLASS.ESTIMATE : FACT_CLASS.OBSERVED_MARKET_DATA,
  };
}

export function summarizeMarket(observations = [], now = new Date(), staleDays = 14) {
  const norm = observations.map((o) => (o.factClass ? o : normalizeObservation(o, now)));
  const byMarketplace = MARKETPLACES.map((m) => {
    const list = norm.filter((o) => o.marketplace === m && o.priceMinor !== null);
    if (!list.length) return { marketplace: m, status: 'UNAVAILABLE', count: 0, reason: 'no observation entered for this marketplace' };
    const prices = list.map((o) => o.priceMinor); const newest = Math.max(...list.map((o) => Date.parse(o.observedAt)));
    const age = Math.floor((now.getTime() - newest) / DAY); const onlyEstimates = list.every((o) => o.kind === 'ESTIMATE');
    return { marketplace: m, status: onlyEstimates ? 'ESTIMATED' : 'OBSERVED', count: list.length, minMinor: Math.min(...prices), medianMinor: median(prices), maxMinor: Math.max(...prices), newestObservedAt: new Date(newest).toISOString(), ageDays: age, freshness: age > staleDays ? 'STALE' : 'FRESH' };
  });
  const seen = byMarketplace.filter((m) => m.status !== 'UNAVAILABLE');
  const all = norm.filter((o) => o.priceMinor !== null && o.kind === 'OBSERVED').map((o) => o.priceMinor);
  return {
    byMarketplace, observationCount: norm.length,
    referencePriceMinor: all.length ? median(all) : null, referenceBasis: all.length ? 'median of the OBSERVED listings entered (similar listings are NOT evidence that this product may be sold)' : null,
    caveats: ['an observed listing proves that someone sells something similar at that price, not that you may sell this product, not demand, and not that the price will hold', ...(seen.some((m) => m.freshness === 'STALE') ? ['some observations are older than 14 days: re-check before relying on them'] : []), ...(seen.length === 0 ? ['no Amazon observation entered yet: market price UNAVAILABLE'] : [])],
  };
}

/**
 * @param {{ rules: object, channels: string[], marketability: string, restricted: boolean|null }} a
 * `restricted`: the owner's answer from Seller Central for the category (true = gated / prohibited, false = open, null = not checked).
 * READY needs: Amazon documents in place, legal marketability GREEN and a Seller Central check that came back open. Never "Amazon approved".
 */
export function amazonReadiness({ rules, channels, marketability, restricted }) {
  if (!channels.includes('amazon')) return { requested: false, status: 'NOT_REQUESTED', items: [], notes: ['Amazon is not a target channel for this case'] };
  const az = (rules.results ?? []).filter((r) => r.jurisdiction === 'AMAZON');
  const items = az.flatMap((r) => (r.requiredEvidence ?? []).filter((e) => e.requirement !== 'NOT_APPLICABLE').map((e) => ({ ruleId: r.ruleId, id: e.id, label: e.label, requirement: e.requirement, coverage: e.coverage.status })));
  const open = items.filter((i) => ['MISSING', 'DOES_NOT_COVER_THIS_REGULATION', 'PRESENT_WITH_CONCERNS', 'OWN_ACTION'].includes(i.coverage));
  const notes = ['READY never means Amazon approval: Seller Central decides, category by category and listing by listing'];
  let status;
  if (restricted === true) status = 'NOT_READY';
  else if (marketability === 'RED') status = 'NOT_READY';
  else if (marketability === 'UNKNOWN') status = 'UNKNOWN';
  else if (open.length === 0 && marketability === 'GREEN' && restricted === false) status = 'READY';
  else status = 'CONDITIONALLY_READY';
  if (restricted === null || restricted === undefined) notes.push('category / brand restriction NOT checked: open Seller Central and check "Add a product" for the category before relying on this');
  if (restricted === true) notes.push('the category is restricted or gated for you: AMAZON_CATEGORY_RESTRICTION');
  return { requested: true, status, items, open, notes };
}
