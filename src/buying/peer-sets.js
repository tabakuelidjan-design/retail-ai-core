#!/usr/bin/env node
// node --env-file=.env src/buying/peer-sets.js [--products]
// Lists the peer sets the merchant can name in a candidate file (collections and
// product types, with their Shopify ids and how usable each is as a benchmark),
// or with --products the individual products that can serve as reference items.
// Facts only: it never suggests which set fits a candidate - the merchant decides.

import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_PATHS, loadBuyingContext, parseArgs } from './context.js';
import { variantStockTrust } from './inventory-trust.js';
import { resolvePeerSet } from './peers.js';

const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v * 100)}%`);

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), ['policy', 'stock-verification', 'count-sheet']);
  const ctx = await loadBuyingContext({ policyPath: opts.policy ?? DEFAULT_PATHS.policy, verificationPath: opts['stock-verification'] ?? DEFAULT_PATHS.verification });
  const stamp = ctx.now.toISOString().slice(0, 10);
  await mkdir('reports', { recursive: true });

  if (opts['count-sheet']) {
    // A sheet of the peer variants worth counting, in the stock-verification file format. Fill counted_units and counted_at, correct Shopify, re-sync.
    const id = opts['count-sheet'];
    const isCollection = id.startsWith('gid://shopify/Collection/');
    const set = resolvePeerSet({ label: id, kind: isCollection ? 'collection_ids' : 'product_type', ids: [id] }, ctx.facts, ctx.verifications ?? new Map(), ctx.config);
    const peerKeys = new Set(ctx.facts.products.filter((p) => p.matched && p.source_status === 'ACTIVE' && (isCollection ? p.collections.some((c) => c.source_id === id) : p.product_type === id)).map((p) => p.product_key));
    const rows = ctx.facts.variants.filter((v) => peerKeys.has(v.product_key) && v.inventory.stock_units > 0)
      .sort((a, b) => b.inventory.stock_units - a.inventory.stock_units)
      .map((v) => ({ variant_id: v.variant_id, shopify_variant_id: v.shopify_variant_id, product_title: v.product_title, variant_title: v.variant_title, shopify_units_now: v.inventory.stock_units, shopify_stock_quality: v.inventory.stock_quality, trust: variantStockTrust(v, undefined), counted_units: null, counted_at: null }));
    const file = `reports/count-sheet-${stamp}.json`;
    await writeFile(file, JSON.stringify(rows, null, 2));
    console.log(`${rows.length} variants (${set.exposure.stock_units} units) in this peer set -> ${file}`);
    console.log('Fill counted_units + counted_at (ISO time of the count) for the rows you count, save as data/local/stock-verification.json, correct Shopify to the counted numbers, then run the sync.');
    return;
  }

  if (opts.products) {
    const rows = ctx.facts.products.filter((p) => p.matched && p.source_status === 'ACTIVE' && p.observable_weeks >= ctx.config.demand.minObservableWeeks)
      .sort((a, b) => b.demand.units_8w - a.demand.units_8w)
      .map((p) => ({ shopify_product_id: p.shopify_product_id, title: p.title, product_type: p.product_type, units_8w: p.demand.units_8w, velocity_8w: p.demand.velocity_8w, net_unit_price_ex_tax: p.demand.avg_net_unit_price_ex_tax, stock_units: p.inventory.stock_units, stock_quality: p.inventory.stock_quality }));
    await writeFile(`reports/reference-products-${stamp}.json`, JSON.stringify(rows, null, 2));
    console.log(`${rows.length} reference products -> reports/reference-products-${stamp}.json (top 25 by units below)`);
    for (const r of rows.slice(0, 25)) console.log(`${String(r.units_8w).padStart(3)}u  ${r.title.slice(0, 44).padEnd(44)}  ${r.shopify_product_id}`);
    return;
  }

  const sets = [
    ...ctx.facts.categories.collection.map((c) => ({ kind: 'collection_ids', label: c.category, id: c.category_key })),
    ...ctx.facts.categories.product_type.filter((c) => c.category !== 'UNCLASSIFIED').map((c) => ({ kind: 'product_type', label: c.category, id: c.category })),
  ];
  const rows = sets.map((s) => {
    const p = resolvePeerSet({ label: s.label, kind: s.kind, ids: [s.id] }, ctx.facts, new Map(), ctx.config);
    return {
      kind: s.kind, label: s.label, id: s.id, products: p.peers_total, observable: p.observable_peers, selling: p.selling_peers, benchmark: p.quality,
      velocity_median: p.velocity.median, price_median_ex_tax: p.price_ex_tax.median, stock_units: p.exposure.stock_units,
      no_sale_share: p.exposure.no_sale_share, cover_weeks: p.exposure.cover_weeks, stock_trust: p.stock_trust.trust, unreliable_share: p.stock_trust.unreliable_share,
    };
  }).sort((a, b) => b.selling - a.selling || a.label.localeCompare(b.label));
  const unclassified = ctx.facts.categories.product_type.find((c) => c.category === 'UNCLASSIFIED');
  await writeFile(`reports/peer-sets-${stamp}.json`, JSON.stringify({ generated_at: ctx.now.toISOString(), unclassified_products: unclassified?.products_total ?? 0, sets: rows }, null, 2));
  console.log(`${rows.length} peer sets -> reports/peer-sets-${stamp}.json  (${unclassified?.products_total ?? 0} products have no product_type and cannot be named as a product_type peer set)`);
  console.log('benchmark  selling/obs  no-sale  trust        kind             name');
  for (const r of rows) console.log(`${r.benchmark.padEnd(10)} ${`${r.selling}/${r.observable}`.padEnd(11)} ${pct(r.no_sale_share).padEnd(7)}  ${r.stock_trust.padEnd(11)}  ${r.kind.padEnd(15)}  ${r.label}`);
}

main().catch((err) => {
  console.error('peer-set listing failed:', err);
  process.exit(1);
});
