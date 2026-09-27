// Growth > Potentiel produits - server-side source for ONE tenant. The merchant is fixed when the source is created (from the
// Growth server's context: NORDLA_MERCHANT_ID resolved at startup) and is never taken from a request. Reads the data Core already
// synced into Nordla (Supabase) - no Shopify call, no demonstration data. Small in-memory cache (the facts are 8-week facts).

import { loadDataset } from '../../metrics/load.js';
import { mergeConfig } from '../../metrics/config.js';
import { productPotentialFacts } from '../products/facts.js';
import { buildProductPotential } from '../products/potential.js';

const DAY = 86400000;
export const HISTORY_DAYS = 400; // same history depth as Finance's retail load: enough for the product's first-sale / age facts

export function createProductPotentialSource({ supabase, merchantId, timeZone = 'UTC', config = mergeConfig(), now = () => new Date(), cacheMs = 5 * 60_000 }) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createProductPotentialSource: merchantId is required (server context)');
  let cached = null; let cachedAt = 0;
  return async function productPotential() {
    const t = now();
    if (cached && t.getTime() - cachedAt < cacheMs) return cached;
    const data = await loadDataset(supabase, merchantId, { since: new Date(t.getTime() - HISTORY_DAYS * DAY) });
    const f = productPotentialFacts({ data, now: t, timeZone, config });
    const payload = { generatedAt: t.toISOString(), ...buildProductPotential(f.facts, { config, currency: f.currency, window: f.window, dataQuality: f.dataQuality }) };
    cached = payload; cachedAt = t.getTime();
    return payload;
  };
}
