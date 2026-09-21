import test from 'node:test';
import assert from 'node:assert/strict';
import { syncOrders } from '../src/sync/orders.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import {
  FAKE_ORDER_1,
  orderWithPartialLineRefund,
  orderWithFullLineRefundAndMultipleRefundLines,
  ordersPage,
} from './fixtures/shopify-orders-sample.js';

const MERCHANT_ID = 'merchant-1';

function fakeShopify(orderNodes) {
  return {
    async graphql(query) {
      if (query.includes('orders(')) return ordersPage(orderNodes);
      throw new Error('unexpected query in fake shopify client');
    },
  };
}

async function seedCatalog(supabase) {
  await supabase.upsert('locations', [{ merchant_id: MERCHANT_ID, source_id: 'gid://shopify/Location/1', name: 'Fixture Store' }], {
    onConflict: 'merchant_id,source_system,source_id',
  });
  await supabase.upsert(
    'variants',
    [
      { merchant_id: MERCHANT_ID, source_id: 'gid://shopify/ProductVariant/1' },
      { merchant_id: MERCHANT_ID, source_id: 'gid://shopify/ProductVariant/2' },
      { merchant_id: MERCHANT_ID, source_id: 'gid://shopify/ProductVariant/3' },
    ],
    { onConflict: 'merchant_id,source_system,source_id' },
  );
}

test('order sync creates one order and its lines, with correct amounts', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  const summary = await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  assert.equal(summary.errors.length, 0);
  assert.equal(supabase._tables.get('orders').length, 1);
  assert.equal(supabase._tables.get('order_lines').length, 2);
  assert.equal(summary.ordersFetched, 1);
  assert.equal(summary.orderLinesFetched, 2);
});

test('order idempotency: running twice does not duplicate the order', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });
  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  assert.equal(supabase._tables.get('orders').length, 1);
});

test('order line idempotency: running twice does not duplicate lines', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });
  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  assert.equal(supabase._tables.get('order_lines').length, 2);
});

test('nullable variant_id: a deleted/custom item line still gets stored, with variant_id null', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  const customLine = supabase._tables.get('order_lines').find((l) => l.source_id === 'gid://shopify/LineItem/2');
  assert.equal(customLine.variant_id, null);
  assert.equal(customLine.title_snapshot, 'Discontinued custom engraving (deleted product)');
  assert.equal(customLine.sku_snapshot, 'OLD-SKU-001');
});

test('discounts: summed discountAllocations are captured as discount_amount (LineItem.totalDiscountSet is 0 for manual POS discounts)', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  const discountedLine = supabase._tables.get('order_lines').find((l) => l.source_id === 'gid://shopify/LineItem/1');
  assert.equal(discountedLine.discount_amount, 5);
  assert.equal(discountedLine.unit_price, 25);
  assert.equal(discountedLine.tax_amount, 8.68);
});

test('tax-inclusive order: taxes_included is stored as true for HABB-style orders', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  const [order] = supabase._tables.get('orders');
  assert.equal(order.taxes_included, true);
});

test('order without retailLocation gets location_id null (online order)', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  const summary = await syncOrders({ shopify: fakeShopify([orderWithPartialLineRefund()]), supabase }, { merchantId: MERCHANT_ID });

  const [order] = supabase._tables.get('orders');
  assert.equal(order.location_id, null);
  assert.equal(summary.ordersWithoutLocation, 1);
});

test('partial line refund: quantity and amount reflect only the refunded portion', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([orderWithPartialLineRefund()]), supabase }, { merchantId: MERCHANT_ID });

  assert.equal(supabase._tables.get('refunds').length, 1);
  const refundLines = supabase._tables.get('refund_lines');
  assert.equal(refundLines.length, 1);
  assert.equal(refundLines[0].quantity, 1); // 1 of 3 units
  assert.equal(refundLines[0].amount, 10);
});

test('full line refund with multiple refund lines: both lines recorded correctly', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders(
    { shopify: fakeShopify([orderWithFullLineRefundAndMultipleRefundLines()]), supabase },
    { merchantId: MERCHANT_ID },
  );

  const refundLines = supabase._tables.get('refund_lines');
  assert.equal(refundLines.length, 2);
  const gadgetRefund = refundLines.find((r) => r.amount === 30);
  const accessoryRefund = refundLines.find((r) => r.amount === 8);
  assert.equal(gadgetRefund.quantity, 3); // full quantity
  assert.equal(accessoryRefund.quantity, 1);
});

test('refund idempotency: running twice does not duplicate refunds or refund lines', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);
  const order = orderWithFullLineRefundAndMultipleRefundLines();

  await syncOrders({ shopify: fakeShopify([order]), supabase }, { merchantId: MERCHANT_ID });
  await syncOrders({ shopify: fakeShopify([order]), supabase }, { merchantId: MERCHANT_ID });

  assert.equal(supabase._tables.get('refunds').length, 1);
  assert.equal(supabase._tables.get('refund_lines').length, 2);
});

test('no PII stored: order and line rows contain no customer-identifying fields', async () => {
  const supabase = createFakeSupabase();
  await seedCatalog(supabase);

  await syncOrders({ shopify: fakeShopify([FAKE_ORDER_1]), supabase }, { merchantId: MERCHANT_ID });

  const piiKeys = ['email', 'phone', 'customer', 'shipping_address', 'billing_address', 'name', 'address'];
  for (const table of ['orders', 'order_lines']) {
    for (const row of supabase._tables.get(table)) {
      for (const key of piiKeys) {
        assert.equal(Object.prototype.hasOwnProperty.call(row, key), false, `${table} row unexpectedly has PII-shaped key "${key}"`);
      }
    }
  }
});
