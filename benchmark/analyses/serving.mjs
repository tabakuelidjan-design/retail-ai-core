// Serving benchmark for Analyses (Phase 0). MEASUREMENT, not a test: it never runs in `node --test`.
//   node --max-old-space-size=6144 benchmark/analyses/serving.mjs <orders>          one size, prints one JSON line
//   node benchmark/analyses/serving.mjs all                                         10k, 25k, 50k, 100k, each in a FRESH process, then the verdict
//
// SYNTHETIC deterministic dataset (seeded PRNG, no merchant data). What is measured is the REAL code of the current architecture:
//   ledger build, the period engine reading dataset.json (JSON.parse + buildLedger) and building Explorer/Products/Customers for a window.
// What is NOT measured: the network. The database read (loadDataset) is counted in requests and ESTIMATED at an assumed round trip; it is labelled ESTIMATE.
// Thresholds (proposed targets, to be confirmed by this measurement): see THRESHOLDS.
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLedger } from '../../src/metrics/ledger.js';
import { mergeConfig } from '../../src/metrics/config.js';
import { periodReport, resetPeriodCache } from '../../src/analytics-premium/server/period-engine.js';
import { bindReportsTenant, unbindReportsTenant, tenantStamp } from '../../src/analytics-premium/server/tenant.js';

export const THRESHOLDS = { coldPeriodSeconds: 3, warmPeriodSeconds: 1, eventLoopBlockMs: 200, refreshSeconds: 300, snapshotMegabytesWarn: 256, heapGigabytesWarn: 1 };
const ASSUMED_RTT_MS = { low: 60, high: 150 }; // PostgREST round trip from the hosting region: an ASSUMPTION (see report)
const DAY = 86_400_000;
const MERCHANT = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';

function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** Row shapes exactly as loadDataset returns them. About 2.5 lines per order, 5 % of orders partially refunded, 40 % repeat customers. */
export function generateDataset(orderCount, now = new Date('2026-10-03T10:00:00Z')) {
  const rnd = prng(20261003); const products = []; const variants = []; const costs = []; const snapshots = []; const orders = []; const orderLines = []; const refunds = []; const refundLines = [];
  const nProducts = Math.max(50, Math.round(orderCount / 150)); const nVariants = nProducts * 2;
  for (let p = 0; p < nProducts; p += 1) products.push({ id: `p${p}`, title: `Synthetic product ${p}`, handle: `p-${p}`, product_type: `Type ${p % 12}`, source_created_at: '2025-01-01T00:00:00Z', source_status: 'ACTIVE', image_url: null, image_alt_text: null, source_id: `gid://p${p}` });
  for (let v = 0; v < nVariants; v += 1) {
    variants.push({ id: `v${v}`, product_id: `p${v >> 1}`, sku: `SKU-${v}`, title: 'Default', source_id: `gid://v${v}` });
    costs.push({ variant_id: `v${v}`, unit_cost: 3 + (v % 17), currency: 'EUR', effective_from: '2025-01-01T00:00:00Z', source: 'shopify_unit_cost', validation_status: 'unverified' });
    snapshots.push({ id: `s${v}`, variant_id: `v${v}`, location_id: 'loc1', quantity: Math.floor(rnd() * 40), synced_at: new Date(now.getTime() - DAY).toISOString() });
  }
  const span = 1100; let lineSeq = 0; let refundSeq = 0; const customers = Math.round(orderCount * 0.6);
  for (let o = 0; o < orderCount; o += 1) {
    const at = new Date(now.getTime() - rnd() * span * DAY); const taxesIncluded = rnd() < 0.8; const id = `o${o}`;
    orders.push({ id, customer_key: `c${Math.floor(rnd() * customers)}`, ordered_at: at.toISOString(), status: 'PAID', currency: 'EUR', taxes_included: taxesIncluded, location_id: 'loc1', is_test: false, source_name: rnd() < 0.3 ? 'pos' : 'web', channel_handle: rnd() < 0.3 ? 'pos' : 'web', channel_name: rnd() < 0.3 ? 'Point of Sale' : 'Online Store', sub_channel_name: null, customer_order_index: 1 + Math.floor(rnd() * 3), journey_ready: true, days_to_conversion: null, order_name: `#${1000 + o}`, shipping_price: null, shipping_discount: null, shipping_tax: null, shipping_tax_rate_bp: null, cancelled_at: null, closed_at: null, lines_truncated: false });
    const n = 1 + Math.floor(rnd() * 4); const mine = [];
    for (let k = 0; k < n; k += 1) { const price = 5 + Math.floor(rnd() * 60); const qty = 1 + Math.floor(rnd() * 3); const line = { id: `l${lineSeq += 1}`, order_id: id, variant_id: `v${Math.floor(rnd() * nVariants)}`, title_snapshot: 'Synthetic line', sku_snapshot: null, quantity: qty, unit_price: price, discount_amount: rnd() < 0.1 ? 2 : 0, tax_amount: Math.round(price * qty * 0.1736 * 100) / 100, tax_rate_bp: 2100 }; orderLines.push(line); mine.push(line); }
    if (rnd() < 0.05) {
      const l = mine[0]; const rid = `r${refundSeq += 1}`; const amount = Math.round(l.unit_price * 100) / 100;
      refunds.push({ id: rid, order_id: id, amount, refunded_at: new Date(at.getTime() + (1 + Math.floor(rnd() * 20)) * DAY).toISOString(), shipping_subtotal: null, shipping_tax: null });
      refundLines.push({ id: `rl${refundSeq}`, refund_id: rid, order_line_id: l.id, quantity: 1, amount, tax_amount: Math.round(amount * 0.1736 * 100) / 100 });
    }
  }
  return { products, variants, orders, orderLines, refunds, refundLines, refundContext: { orders: [], orderLines: [] }, costs, snapshots, inventoryWindow: { newestSyncedAt: new Date(now.getTime() - DAY).toISOString(), from: new Date(now.getTime() - 3 * DAY).toISOString() }, collections: [], orderAttribution: [], locations: [{ id: 'loc1', name: 'Shop', type: 'physical', source_id: 'gid://loc1' }], firstOrderAt: orders.reduce((m, o) => (o.ordered_at < m ? o.ordered_at : m), orders[0].ordered_at) };
}

/** The requests loadDataset would issue for this dataset (orders pages of 1000, children in chunks of 40 ids, refund lines after refunds). */
export function loadRequests(d) {
  const pages = (n) => Math.max(1, Math.ceil(n / 1000)); const chunks = (n) => Math.ceil(n / 40);
  const fixed = 8; // products, variants, costs, collections, locations, snapshots probe + bulk, first order
  const total = fixed + pages(d.orders.length) + chunks(d.orders.length) /*attribution*/ + chunks(d.orders.length) /*lines*/ + chunks(d.orders.length) /*refunds*/ + chunks(d.refunds.length) /*refund_lines*/ + pages(d.refunds.length) /*window refunds*/;
  return total;
}

async function measureOne(orderCount) {
  const t0 = performance.now(); const data = generateDataset(orderCount); const genMs = performance.now() - t0;
  const requests = loadRequests(data);
  const dir = await mkdtemp(path.join(tmpdir(), 'analyses-bench-')); bindReportsTenant(dir, MERCHANT);
  const snapshot = { version: 1, tenant: tenantStamp(MERCHANT), generated_at: new Date('2026-10-03T10:00:00Z').toISOString(), time_zone: 'Europe/Brussels', currency: 'EUR', data };
  let peakHeap = 0; const sampler = setInterval(() => { const m = process.memoryUsage(); if (m.heapUsed > peakHeap) peakHeap = m.heapUsed; }, 50);
  let tx = performance.now(); const json = JSON.stringify(snapshot); const stringifyMs = performance.now() - tx; const bytes = Buffer.byteLength(json);
  await writeFile(path.join(dir, 'dataset.json'), json);
  tx = performance.now(); JSON.parse(json); const parseMs = performance.now() - tx;
  const config = mergeConfig(); tx = performance.now(); const ledger = buildLedger(data, { config }); const ledgerMs = performance.now() - tx;
  const now = new Date('2026-10-03T10:00:00Z'); const el = monitorEventLoopDelay({ resolution: 10 }); el.enable();
  const timed = async (query) => { const a = performance.now(); const r = await periodReport(dir, query, { now }); const ms = performance.now() - a; if (!r.ok) throw new Error(JSON.stringify(r)); return ms; };
  resetPeriodCache();
  const cold30 = await timed({ period: 'last_30_days' });            // first request after a dataset change: parse + ledger + workspaces
  const warm90 = await timed({ period: 'last_90_days' });            // ledger cached, new window
  const warm365 = await timed({ period: 'custom', from: '2025-10-04', to: '2026-10-02' });
  const warmAll = await timed({ period: 'custom', from: '2023-10-01', to: '2026-10-02' });
  el.disable(); clearInterval(sampler);
  await rm(dir, { recursive: true, force: true }); unbindReportsTenant(dir); void stat;
  const mem = process.memoryUsage();
  const refreshSeconds = { low: Math.round((requests * ASSUMED_RTT_MS.low) / 1000 + stringifyMs / 1000 + ledgerMs / 1000), high: Math.round((requests * ASSUMED_RTT_MS.high) / 1000 + stringifyMs / 1000 + ledgerMs / 1000) };
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    orders: orderCount, lines: data.orderLines.length, refunds: data.refunds.length, generateMs: Math.round(genMs), loadRequests: requests,
    snapshotMegabytes: r1(bytes / 1048576), stringifyMs: Math.round(stringifyMs), parseMs: Math.round(parseMs), ledgerMs: Math.round(ledgerMs),
    periodQuerySeconds: { cold_last_30_days: r1(cold30 / 1000), warm_last_90_days: r1(warm90 / 1000), warm_365_days: r1(warm365 / 1000), warm_3_years: r1(warmAll / 1000) },
    eventLoopMaxBlockMs: Math.round(el.max / 1e6), peakHeapMegabytes: Math.round(peakHeap / 1048576), rssMegabytes: Math.round(mem.rss / 1048576),
    refreshSecondsEstimate: refreshSeconds, assumedRoundTripMs: ASSUMED_RTT_MS, node: process.version,
  };
}

function verdict(rows) {
  const out = [];
  for (const r of rows) {
    const worstCold = r.periodQuerySeconds.cold_last_30_days; const worstWarm = Math.max(r.periodQuerySeconds.warm_last_90_days, r.periodQuerySeconds.warm_365_days, r.periodQuerySeconds.warm_3_years);
    const l1 = [worstCold > THRESHOLDS.coldPeriodSeconds && `cold period ${worstCold}s > ${THRESHOLDS.coldPeriodSeconds}s`, worstWarm > THRESHOLDS.warmPeriodSeconds && `warm period ${worstWarm}s > ${THRESHOLDS.warmPeriodSeconds}s`, r.eventLoopMaxBlockMs > THRESHOLDS.eventLoopBlockMs && `event loop block ${r.eventLoopMaxBlockMs}ms > ${THRESHOLDS.eventLoopBlockMs}ms`].filter(Boolean);
    const l2 = [r.refreshSecondsEstimate.high > THRESHOLDS.refreshSeconds && `refresh estimate ${r.refreshSecondsEstimate.high}s > ${THRESHOLDS.refreshSeconds}s`, r.snapshotMegabytes > THRESHOLDS.snapshotMegabytesWarn && `snapshot ${r.snapshotMegabytes} MB > ${THRESHOLDS.snapshotMegabytesWarn} MB`, r.peakHeapMegabytes / 1024 > THRESHOLDS.heapGigabytesWarn && `peak heap ${r.peakHeapMegabytes} MB > ${THRESHOLDS.heapGigabytesWarn} GB`].filter(Boolean);
    out.push({ orders: r.orders, level: l2.length ? 2 : l1.length ? 1 : 0, level1Triggers: l1, level2Triggers: l2 });
  }
  return out;
}

const arg = process.argv[2];
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (arg === 'all') {
    const rows = [];
    for (const n of [10000, 25000, 50000, 100000]) {
      const r = spawnSync(process.execPath, ['--max-old-space-size=6144', fileURLToPath(import.meta.url), String(n)], { encoding: 'utf8', maxBuffer: 1 << 26 });
      if (r.status !== 0) { console.error(r.stderr.slice(0, 2000)); rows.push({ orders: n, error: r.stderr.slice(0, 300) }); continue; }
      rows.push(JSON.parse(r.stdout.trim().split('\n').at(-1)));
    }
    console.log(JSON.stringify({ thresholds: THRESHOLDS, rows, verdict: verdict(rows.filter((x) => !x.error)) }, null, 1));
  } else if (/^\d+$/.test(arg ?? '')) console.log(JSON.stringify(await measureOne(Number(arg))));
  else { console.error('usage: node benchmark/analyses/serving.mjs <orders>|all'); process.exit(2); }
}
