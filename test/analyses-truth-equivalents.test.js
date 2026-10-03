import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { loadDataset } from '../src/metrics/load.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { compareWindow } from '../src/metrics/validate.js';
import { mergeConfig } from '../src/metrics/config.js';
import { periodReport, resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { bindReportsTenant, unbindReportsTenant, tenantStamp } from '../src/analytics-premium/server/tenant.js';
import { ORDER_TOTALS_PAGE_QUERY } from '../src/shopify/queries.js';
import { makeData } from './fixtures/metrics-sample.js';

// Analyses Phase 0: defects of the same families as A-D found while auditing (inventory window read as zero stock, validation ignoring cancelled
// orders, a silent EUR default). Each unavailable fact is SURFACED. SYNTHETIC data only.
const M = randomUUID(); const DAY = 86_400_000;
const config = mergeConfig();

test('E1. stock older than the inventory read window is reported as NOT COVERED, never read as zero stock', async () => {
  const s = createFakeSupabase(); const p = randomUUID(); const [v1, v2] = [randomUUID(), randomUUID()]; const loc = randomUUID(); const now = Date.now();
  await s.insert('products', [{ id: p, merchant_id: M, title: 'P', product_type: 'T', source_system: 'shopify', source_id: 'p' }]);
  await s.insert('variants', [{ id: v1, merchant_id: M, product_id: p, sku: 'A', title: 'A', source_system: 'shopify', source_id: 'a' }, { id: v2, merchant_id: M, product_id: p, sku: 'B', title: 'B', source_system: 'shopify', source_id: 'b' }]);
  await s.insert('locations', [{ id: loc, merchant_id: M, name: 'L', type: 'physical', source_system: 'shopify', source_id: 'l' }]);
  await s.insert('inventory_snapshots', [{ id: randomUUID(), variant_id: v1, location_id: loc, merchant_id: M, quantity: 7, synced_at: new Date(now - DAY).toISOString() }, { id: randomUUID(), variant_id: v2, location_id: loc, merchant_id: M, quantity: 9, synced_at: new Date(now - 6 * DAY).toISOString() }]);
  const data = await loadDataset(s, M, { since: new Date(now - 60 * DAY) });
  assert.ok(data.inventoryWindow && data.inventoryWindow.newestSyncedAt && data.inventoryWindow.from, 'the read window is exposed');
  const ledger = buildLedger(data, { config });
  assert.deepEqual(ledger.stockCoverage, { variants: 2, withSnapshot: 1, withoutSnapshot: 1, newestSnapshotAt: new Date(now - DAY).toISOString(), windowFrom: data.inventoryWindow.from });
  assert.equal(ledger.stockByVariant.has(v2), false, 'no fabricated stock entry for the uncovered variant');
});

test('E2. no inventory at all: coverage says so (newest null)', () => {
  const ledger = buildLedger(makeData(), { config }); assert.equal(ledger.stockCoverage.variants, 4);
  const empty = makeData(); empty.snapshots = []; const l2 = buildLedger(empty, { config });
  assert.deepEqual([l2.stockCoverage.withSnapshot, l2.stockCoverage.withoutSnapshot, l2.stockCoverage.newestSnapshotAt], [0, 4, null]);
});

test('E3. validation against Shopify excludes cancelled orders exactly like the ledger does', () => {
  assert.match(ORDER_TOTALS_PAGE_QUERY, /\bcancelledAt\b/);
  const data = makeData(); const ledger = buildLedger(data, { config });
  const win = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z'), key: 'x' };
  const mk = (id, extra = {}) => ({ id, createdAt: '2026-09-12T10:00:00Z', test: false, displayFinancialStatus: 'PAID', taxesIncluded: true, subtotalPriceSet: { shopMoney: { amount: '20.00' } }, currentSubtotalPriceSet: { shopMoney: { amount: '20.00' } }, shippingLine: null, totalDiscountsSet: { shopMoney: { amount: '0' } }, totalTaxSet: { shopMoney: { amount: '0' } }, totalRefundedSet: { shopMoney: { amount: '0' } }, lineItems: { edges: [] }, refunds: [], ...extra });
  const rowsOf = (orders) => compareWindow(ledger, orders, win);
  const withCancelled = rowsOf([mk('s1'), mk('s2', { cancelledAt: '2026-09-13T08:00:00Z' })]); const without = rowsOf([mk('s1')]);
  assert.deepEqual(withCancelled, without, 'the cancelled Shopify order is not part of the comparison');
});

test('E4. the report currency comes from the countable orders, never from a silent EUR default', async () => {
  resetPeriodCache(); const dir = await mkdtemp(path.join(tmpdir(), 'cur-')); const merchant = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b'; bindReportsTenant(dir, merchant);
  try {
    const data = { products: [], variants: [], costs: [], snapshots: [], refunds: [], refundLines: [], orderLines: [{ id: 'l1', order_id: 'o1', variant_id: null, title_snapshot: 'X', quantity: 1, unit_price: 10, discount_amount: 0, tax_amount: 0 }],
      orders: [{ id: 'o1', ordered_at: new Date(Date.now() - 2 * DAY).toISOString(), status: 'PAID', currency: 'USD', taxes_included: false, is_test: false }] };
    await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, tenant: tenantStamp(merchant), generated_at: new Date().toISOString(), time_zone: 'Europe/Brussels', data })); // NO currency stamp
    const r = await periodReport(dir, { period: 'last_7_days' }, { now: new Date() }); assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.report.currency, 'USD');
  } finally { unbindReportsTenant(dir); resetPeriodCache(); }
});
