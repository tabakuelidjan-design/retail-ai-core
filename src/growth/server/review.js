// Growth > revue: server-side source of the before / after comparison for ONE tenant. The merchant is fixed when the source is created (the Growth server's context,
// NORDLA_MERCHANT_ID resolved at startup) and is never taken from a request. Read only: it reads the data Core already synced into Nordla (the same loadDataset as the other
// Growth pages), computes on demand when the merchant opens a review, and keeps nothing but a short in-memory cache.
import { loadDataset } from '../../metrics/load.js';
import { mergeConfig } from '../../metrics/config.js';
import { requireTimeZone } from '../../metrics/profile.js';
import { compareNetUnits, reviewWindows } from '../review/compare.js';

export function createReviewSource({ supabase, merchantId, timeZone, config = mergeConfig(), now = () => new Date(), cacheMs = 60_000, load = loadDataset }) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createReviewSource: merchantId is required (server context)');
  requireTimeZone(timeZone, 'createReviewSource');
  const cache = new Map();
  return async function review({ type, id, applied, review: reviewDate }) {
    const t = now(); const key = `${type}|${id}|${applied}|${reviewDate}`; const hit = cache.get(key);
    if (hit && t.getTime() - hit.at < cacheMs) return hit.value;
    const target = { type, id };
    const w = reviewWindows({ appliedDate: applied, reviewDate, now: t, timeZone });
    let value;
    if (!w.ok) value = compareNetUnits({ data: {}, target, appliedDate: applied, reviewDate, now: t, timeZone }); // no data is read when there is nothing complete to compare
    else {
      const data = await load(supabase, merchantId, { since: new Date(w.before.start) });
      value = compareNetUnits({ data, target, appliedDate: applied, reviewDate, now: t, timeZone, minUnits: config.demand.cover.minUnits });
    }
    cache.set(key, { at: t.getTime(), value });
    return value;
  };
}
