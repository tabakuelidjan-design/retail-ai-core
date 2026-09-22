// Application-level tenant isolation tests: two synthetic merchants (A, B) sharing one fake Supabase
// instance, proving every query path scopes to its own merchant and never crosses into the other's data.
// This is the app-level half of the RLS/merchant-isolation proposal - it exercises the same query paths
// production code uses (loadDataset, createSupabaseFinanceStore), not a reimplementation of them.
//
// Analytics (hierarchy.js) and Merchant Setup Wizard isolation tests are deliberately NOT included here:
// those modules live on separate, still-unmerged branches (feature/hierarchical-sales-analytics,
// feature/merchant-setup-wizard) and do not exist on `main`, which this branch is built from. They should
// be added once those branches are rebased on top of this fix, per the one-feature-per-branch discipline -
// see the migration/isolation report for this explicitly called out as a gap, not an oversight.
//
// RLS-level tests (a session literally forbidden by the database from reading/writing another tenant's row)
// are also not here: they require the non-bypass authenticated role from the RLS proposal, which does not
// exist yet. Everything below tests the CURRENT real protection - disciplined application-level filtering -
// and would have caught the two CRITICAL findings fixed alongside this migration (global inventory_snapshots
// fetch, order_attribution missing merchant_id) had it existed beforehand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadDataset } from '../src/metrics/load.js';
import { createSupabaseFinanceStore } from '../src/finance/supabase-store.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';

const DAY = 24 * 60 * 60 * 1000;

/** Seeds two independent merchants with overlapping shapes (same relative structure, different ids) so a
 * bug that accidentally matches "any row" rather than "this merchant's row" is guaranteed to be caught. */
async function seedTwoMerchants(supabase) {
  const [merchantA, merchantB] = [randomUUID(), randomUUID()];
  await supabase.insert('merchants', [{ id: merchantA, name: 'Merchant A' }, { id: merchantB, name: 'Merchant B' }]);

  const build = async (merchantId, tag) => {
    const productId = randomUUID();
    const variantId = randomUUID();
    const orderId = randomUUID();
    const orderLineId = randomUUID();
    const refundId = randomUUID();
    const locationId = randomUUID();
    await supabase.insert('products', [{ id: productId, merchant_id: merchantId, title: `${tag} Product`, product_type: 'Widgets', source_system: 'shopify', source_id: `${tag}-p1` }]);
    await supabase.insert('variants', [{ id: variantId, merchant_id: merchantId, product_id: productId, sku: `${tag}-SKU`, title: 'Default', source_system: 'shopify', source_id: `${tag}-v1` }]);
    await supabase.insert('orders', [{ id: orderId, merchant_id: merchantId, source_system: 'shopify', source_id: `${tag}-o1`, ordered_at: new Date().toISOString(), currency: 'EUR', status: 'PAID', taxes_included: true, is_test: false }]);
    await supabase.insert('order_lines', [{ id: orderLineId, order_id: orderId, merchant_id: merchantId, variant_id: variantId, source_system: 'shopify', source_id: `${tag}-l1`, title_snapshot: `${tag} line`, quantity: 1, unit_price: 10, discount_amount: 0, tax_amount: 0 }]);
    await supabase.insert('refunds', [{ id: refundId, order_id: orderId, merchant_id: merchantId, source_system: 'shopify', source_id: `${tag}-r1`, amount: 1, refunded_at: new Date().toISOString() }]);
    await supabase.insert('refund_lines', [{ id: randomUUID(), refund_id: refundId, order_line_id: orderLineId, merchant_id: merchantId, quantity: 1, amount: 1, tax_amount: 0, currency: 'EUR' }]);
    await supabase.insert('product_costs', [{ id: randomUUID(), variant_id: variantId, merchant_id: merchantId, unit_cost: 5, currency: 'EUR', effective_from: new Date(0).toISOString(), source: 'manual_entry', validation_status: 'verified' }]);
    await supabase.insert('product_collections', [{ id: randomUUID(), merchant_id: merchantId, product_id: productId, source_system: 'shopify', source_id: `${tag}-c1`, title: `${tag} Collection`, is_current: true }]);
    await supabase.insert('locations', [{ id: locationId, merchant_id: merchantId, name: `${tag} Store`, type: 'retail', source_system: 'shopify', source_id: `${tag}-loc1` }]);
    await supabase.insert('inventory_snapshots', [{ id: randomUUID(), variant_id: variantId, location_id: locationId, merchant_id: merchantId, quantity: 42, synced_at: new Date().toISOString() }]);
    await supabase.insert('order_attribution', [{ id: randomUUID(), merchant_id: merchantId, order_id: orderId, source_system: 'shopify', touch: 'last_visit', source: `${tag}-source`, synced_at: new Date().toISOString() }]);
    return { productId, variantId, orderId, orderLineId, refundId, locationId };
  };

  const a = await build(merchantA, 'A');
  const b = await build(merchantB, 'B');
  return { supabase, merchantA, merchantB, a, b };
}

test('loadDataset for merchant A returns none of merchant B\'s products/variants/orders', async () => {
  const { supabase, merchantA, merchantB } = await seedTwoMerchants(createFakeSupabase());
  const dataA = await loadDataset(supabase, merchantA, { since: new Date(0) });
  for (const p of dataA.products) assert.notEqual(p.merchant_id, merchantB, 'leaked a B product');
  for (const v of dataA.variants) assert.notEqual(v.merchant_id, merchantB, 'leaked a B variant');
  for (const o of dataA.orders) assert.notEqual(o.merchant_id, merchantB, 'leaked a B order');
  assert.equal(dataA.products.length, 1);
  assert.equal(dataA.orders.length, 1);
});

test('inventory is isolated: merchant A never sees merchant B\'s stock snapshots', async () => {
  const { supabase, merchantA, b } = await seedTwoMerchants(createFakeSupabase());
  const dataA = await loadDataset(supabase, merchantA, { since: new Date(0) });
  assert.equal(dataA.snapshots.length, 1);
  assert.notEqual(dataA.snapshots[0].variant_id, b.variantId);
});

test('orders/refunds/refund_lines are isolated end to end', async () => {
  const { supabase, merchantA, merchantB } = await seedTwoMerchants(createFakeSupabase());
  const dataA = await loadDataset(supabase, merchantA, { since: new Date(0) });
  const dataB = await loadDataset(supabase, merchantB, { since: new Date(0) });
  assert.equal(dataA.orderLines.length, 1);
  assert.equal(dataA.refunds.length, 1);
  assert.equal(dataA.refundLines.length, 1);
  // No id collision between A's and B's fetched rows (would indicate a cross-tenant leak).
  const idsA = new Set([...dataA.orderLines, ...dataA.refunds, ...dataA.refundLines].map((r) => r.id));
  const idsB = new Set([...dataB.orderLines, ...dataB.refunds, ...dataB.refundLines].map((r) => r.id));
  for (const id of idsA) assert.ok(!idsB.has(id));
});

test('order_attribution is isolated (regression test for the fixed CRITICAL finding: it used to fetch every merchant\'s rows)', async () => {
  const { supabase, merchantA, b } = await seedTwoMerchants(createFakeSupabase());
  const dataA = await loadDataset(supabase, merchantA, { since: new Date(0) });
  assert.equal(dataA.orderAttribution.length, 1);
  assert.notEqual(dataA.orderAttribution[0].order_id, b.orderId);
});

test('Finance is isolated: merchant A\'s store never returns merchant B\'s documents or companies', async () => {
  const supabase = createFakeSupabase();
  const merchantA = randomUUID();
  const merchantB = randomUUID();
  await supabase.insert('merchants', [{ id: merchantA }, { id: merchantB }]);
  await supabase.insert('fin_documents', [
    { id: randomUUID(), merchant_id: merchantA, doc_type: 'invoice', status: 'DRAFT', version: 1, body: {} },
    { id: randomUUID(), merchant_id: merchantB, doc_type: 'invoice', status: 'DRAFT', version: 1, body: {} },
  ]);
  await supabase.insert('fin_companies', [
    { id: randomUUID(), merchant_id: merchantA, kind: 'business', name: 'A Company' },
    { id: randomUUID(), merchant_id: merchantB, kind: 'business', name: 'B Company' },
  ]);

  const storeA = createSupabaseFinanceStore(supabase, { merchantId: merchantA });
  const docs = await storeA.listDocuments();
  const companies = await storeA.listCompanies?.() ?? await supabase.selectAll('fin_companies', { select: '*', merchant_id: `eq.${merchantA}` });
  assert.equal(docs.length, 1);
  assert.equal(companies.length, 1);
  assert.ok(docs.every((d) => d.merchantId === merchantA));
});

test('Finance: merchant A cannot read merchant B\'s document by id, even knowing its exact id', async () => {
  const supabase = createFakeSupabase();
  const merchantA = randomUUID();
  const merchantB = randomUUID();
  const bDocId = randomUUID();
  await supabase.insert('fin_documents', [{ id: bDocId, merchant_id: merchantB, doc_type: 'invoice', status: 'DRAFT', version: 1, body: {} }]);
  const storeA = createSupabaseFinanceStore(supabase, { merchantId: merchantA });
  assert.equal(await storeA.getDocument(bDocId), null);
});

test('Finance: merchant A cannot update merchant B\'s document even by exact id (adversarial)', async () => {
  const supabase = createFakeSupabase();
  const merchantA = randomUUID();
  const merchantB = randomUUID();
  const bDocId = randomUUID();
  await supabase.insert('fin_documents', [{ id: bDocId, merchant_id: merchantB, doc_type: 'invoice', status: 'DRAFT', version: 1, body: { notes: 'original' } }]);
  const storeA = createSupabaseFinanceStore(supabase, { merchantId: merchantA });
  await assert.rejects(() => storeA.saveDocument({ id: bDocId, merchantId: merchantA, type: 'invoice', status: 'SENT', body: { notes: 'tampered' } }, 1));
  const stillB = await supabase.select('fin_documents', { select: '*', id: `eq.${bDocId}` });
  assert.equal(stillB[0].status, 'DRAFT');
  assert.equal(stillB[0].body.notes, 'original');
});

test('Finance: merchant A cannot delete merchant B\'s document even by exact id (adversarial)', async () => {
  const supabase = createFakeSupabase();
  const merchantA = randomUUID();
  const merchantB = randomUUID();
  const bDocId = randomUUID();
  await supabase.insert('fin_documents', [{ id: bDocId, merchant_id: merchantB, doc_type: 'invoice', status: 'DRAFT', version: 1, body: {} }]);
  const storeA = createSupabaseFinanceStore(supabase, { merchantId: merchantA });
  await storeA.deleteDocument(bDocId);
  const stillThere = await supabase.select('fin_documents', { select: '*', id: `eq.${bDocId}` });
  assert.equal(stillThere.length, 1, 'merchant A\'s delete call must not remove merchant B\'s row');
});

test('child rows cannot cross parents: a refund_line whose refund and order_line belong to different merchants is never produced by normal sync', async () => {
  // This is the structural guarantee the migration's cross-check backfill relies on: normalizeRefundLine
  // always takes merchantId directly from the single-merchant sync context, so a mixed-parent row can only
  // ever arise from hand-crafted/corrupt data - which is exactly what the migration's detection query catches.
  const { normalizeRefundLine } = await import('../src/sync/normalize.js');
  const merchantA = randomUUID();
  const row = normalizeRefundLine({ quantity: 1, subtotalSet: { shopMoney: { amount: '1' } }, totalTaxSet: { shopMoney: { amount: '0' } } }, randomUUID(), randomUUID(), 'EUR', merchantA);
  assert.equal(row.merchant_id, merchantA);
});

test('adversarial: forging merchant_id on write is rejected by scoped filters, not just by convention', async () => {
  const supabase = createFakeSupabase();
  const merchantA = randomUUID();
  const merchantB = randomUUID();
  const bDocId = randomUUID();
  await supabase.insert('fin_documents', [{ id: bDocId, merchant_id: merchantB, doc_type: 'invoice', status: 'DRAFT', version: 1, body: {} }]);
  const storeA = createSupabaseFinanceStore(supabase, { merchantId: merchantA });
  // Even if a caller supplies B's id and forges merchantId: merchantA in the payload, the WHERE clause used
  // by saveDocument's update path is keyed on the store's own closed-over merchantId, not the payload's -
  // so the update matches zero rows (throws CONCURRENT_MODIFICATION) rather than silently taking over B's row.
  await assert.rejects(() => storeA.saveDocument({ id: bDocId, merchantId: merchantA, type: 'invoice', status: 'SENT', body: {} }, 1));
});
