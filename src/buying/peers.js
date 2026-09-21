// Peer sets: the merchant NAMES which existing items a candidate should be
// compared with (Shopify product ids, collection ids, or an exact product_type).
// Nothing is matched by title, SKU or text. Benchmarks are computed only from
// peers that have existed long enough to be judged, and expose sample sizes
// instead of pretending to precision.

import { percentile, round2 } from './economics.js';
import { peerStockTrust } from './inventory-trust.js';

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

function pick(facts, set) {
  const catalog = facts.products.filter((p) => p.matched);
  if (set.kind === 'reference_product_ids') {
    // Shopify product id is canonical; internal database keys are never accepted here.
    const found = catalog.filter((p) => set.ids.includes(p.shopify_product_id));
    return { products: found, unresolved: set.ids.filter((id) => !found.some((p) => p.shopify_product_id === id)) };
  }
  if (set.kind === 'collection_ids') {
    const found = catalog.filter((p) => p.collections.some((c) => set.ids.includes(c.source_id)));
    const seen = new Set(found.flatMap((p) => p.collections.map((c) => c.source_id)));
    return { products: found, unresolved: set.ids.filter((id) => !seen.has(id)) };
  }
  const found = catalog.filter((p) => p.product_type === set.ids[0]);
  return { products: found, unresolved: found.length ? [] : [set.ids[0]] };
}

export function resolvePeerSet(set, facts, verifications, config) {
  const dcfg = config.demand;
  const { products: all, unresolved } = pick(facts, set);
  const peers = all.filter((p) => p.source_status === 'ACTIVE');
  const observable = peers.filter((p) => p.observable_weeks >= dcfg.minObservableWeeks);
  const selling = observable.filter((p) => p.demand.units_8w > 0);
  const minPeers = dcfg.minPeersForBenchmark;

  let quality = 'USABLE';
  if (observable.length === 0) quality = 'NONE';
  else if (selling.length === 0) quality = 'NO_DEMAND_EVIDENCE';
  else if (selling.length < minPeers) quality = 'THIN';

  const velocities = selling.map((p) => p.demand.velocity_8w).filter((v) => v !== null).sort((a, b) => a - b);
  const prices = selling.map((p) => p.demand.avg_net_unit_price_ex_tax).filter((v) => v !== null).sort((a, b) => a - b);
  const usable = quality === 'USABLE';

  const peerKeys = new Set(peers.map((p) => p.product_key));
  const variants = facts.variants.filter((v) => peerKeys.has(v.product_key));
  const stockUnits = sum(peers, (p) => p.inventory.stock_units);
  const unitsIn = (cls) => sum(peers.filter((p) => p.inventory.inventory_class === cls), (p) => p.inventory.stock_units);
  const share = (x) => (stockUnits > 0 ? Math.round((x / stockUnits) * 10000) / 10000 : null);
  const peerUnits8w = sum(peers, (p) => p.demand.units_8w);
  const weeklyVelocity = sum(peers, (p) => p.demand.velocity_8w ?? 0);
  const coverWeeks = stockUnits > 0 && peerUnits8w >= dcfg.cover.minUnits && weeklyVelocity > 0 ? round2(stockUnits / weeklyVelocity) : null;

  return {
    label: set.label, kind: set.kind, ids: set.ids, unresolved_ids: unresolved,
    peers_total: peers.length, non_active_excluded: all.length - peers.length,
    observable_peers: observable.length, selling_peers: selling.length, min_peers_required: minPeers, quality,
    sell_rate: { selling: selling.length, observable: observable.length },
    velocity: { observed: velocities, p25: usable ? percentile(velocities, 0.25) : null, median: usable ? percentile(velocities, 0.5) : null, p75: usable ? percentile(velocities, 0.75) : null },
    price_ex_tax: { observed: prices, min: usable ? prices[0] : null, median: usable ? percentile(prices, 0.5) : null, max: usable ? prices.at(-1) : null },
    exposure: {
      stock_units: stockUnits, peer_units_8w: peerUnits8w, cover_weeks: coverWeeks,
      no_sale_share: share(unitsIn('NO_SALE_IN_WINDOW')), slow_share: share(unitsIn('SLOW_COVER')), too_new_share: share(unitsIn('TOO_NEW')),
    },
    stock_trust: peerStockTrust(variants, verifications, config.buying.stockTrust),
  };
}
