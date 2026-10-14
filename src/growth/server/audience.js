// Growth > Audience - server-side source for ONE tenant (same contract as server/products.js). The merchant is fixed when the
// source is created (NORDLA_MERCHANT_ID resolved at startup) and is never taken from a request. Reads the data Core already
// synced into Nordla - no Shopify, CRM or e-mail call, no demonstration data. Aggregate output only (see audience/audience.js).

import { loadDataset } from '../../metrics/load.js';
import { mergeConfig } from '../../metrics/config.js';
import { audienceFacts } from '../audience/facts.js';
import { buildAudience } from '../audience/audience.js';

const DAY = 86400000;
export const HISTORY_DAYS = 400; // same history depth as Potentiel produits: the window, the previous window and older buyers

export function createAudienceSource({ supabase, merchantId, timeZone = 'UTC', config = mergeConfig(), now = () => new Date(), cacheMs = 5 * 60_000 }) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createAudienceSource: merchantId is required (server context)');
  let cached = null; let cachedAt = 0;
  return async function audience() {
    const t = now();
    if (cached && t.getTime() - cachedAt < cacheMs) return cached;
    const data = await loadDataset(supabase, merchantId, { since: new Date(t.getTime() - HISTORY_DAYS * DAY) });
    const f = audienceFacts({ data, now: t, timeZone, config });
    const payload = { generatedAt: t.toISOString(), ...buildAudience({ orders: f.orders, window: f.window, historyStart: f.historyStart, config, currency: f.currency }) };
    cached = payload; cachedAt = t.getTime();
    return payload;
  };
}
