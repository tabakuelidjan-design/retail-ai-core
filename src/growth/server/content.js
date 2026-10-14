// Growth > Contenu - server-side source for ONE tenant (same contract as server/products.js and server/audience.js). The
// merchant is fixed when the source is created (NORDLA_MERCHANT_ID resolved at startup) and is never taken from a request.
// Reads the catalog Core already synced into Nordla - no Shopify call, no connector, no generated content.

import { loadDataset } from '../../metrics/load.js';
import { mergeConfig } from '../../metrics/config.js';
import { contentFacts, WEEKS } from '../content/facts.js';
import { buildContent } from '../content/content.js';

const DAY = 86400000;

export function createContentSource({ supabase, merchantId, timeZone = 'UTC', config = mergeConfig(), now = () => new Date(), cacheMs = 5 * 60_000 }) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createContentSource: merchantId is required (server context)');
  let cached = null; let cachedAt = 0;
  return async function content() {
    const t = now();
    if (cached && t.getTime() - cachedAt < cacheMs) return cached;
    const data = await loadDataset(supabase, merchantId, { since: new Date(t.getTime() - (WEEKS * 7 + 2) * DAY) });
    const f = contentFacts({ data, now: t, timeZone, config });
    const payload = { generatedAt: t.toISOString(), ...buildContent(f) };
    cached = payload; cachedAt = t.getTime();
    return payload;
  };
}
