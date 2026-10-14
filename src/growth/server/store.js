// Growth > Croissance magasin - server-side source for ONE tenant (same contract as the other Growth sources). The merchant is
// fixed when the source is created (NORDLA_MERCHANT_ID resolved at startup) and is never taken from a request. Reads the data
// Core already synced into Nordla - no POS, footfall or Google Business connector, no demonstration data.
// Product guards come from Produits Potentiels' own engine on the same data (no second, contradictory engine).

import { loadDataset } from '../../metrics/load.js';
import { mergeConfig } from '../../metrics/config.js';
import { storeFacts } from '../store/facts.js';
import { buildStore } from '../store/store.js';
import { productPotentialFacts } from '../products/facts.js';
import { buildProductPotential } from '../products/potential.js';
import { HISTORY_DAYS } from './products.js';

const DAY = 86400000;

export function createStoreSource({ supabase, merchantId, timeZone = 'UTC', config = mergeConfig(), now = () => new Date(), cacheMs = 5 * 60_000 }) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createStoreSource: merchantId is required (server context)');
  let cached = null; let cachedAt = 0;
  return async function store() {
    const t = now();
    if (cached && t.getTime() - cachedAt < cacheMs) return cached;
    const data = await loadDataset(supabase, merchantId, { since: new Date(t.getTime() - HISTORY_DAYS * DAY) });
    const f = storeFacts({ data, now: t, timeZone, config });
    const pf = productPotentialFacts({ data, now: t, timeZone, config });
    const pot = buildProductPotential(pf.facts, { config, currency: pf.currency, window: pf.window, dataQuality: pf.dataQuality });
    const potential = new Map(pot.rows.map((r) => [r.id, { status: r.status, action: r.action }]));
    const payload = { generatedAt: t.toISOString(), ...buildStore({ ...f, potential, config }) };
    cached = payload; cachedAt = t.getTime();
    return payload;
  };
}
