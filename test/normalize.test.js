import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVariant,
  normalizeProductCost,
  costHasChanged,
  shouldWriteInventorySnapshot,
} from '../src/sync/normalize.js';

test('variant with null SKU normalizes cleanly, sku stays null', () => {
  const row = normalizeVariant({ id: 'gid://shopify/ProductVariant/1', title: 'Red', sku: null }, 'product-uuid', 'merchant-uuid');
  assert.equal(row.sku, null);
  assert.equal(row.source_id, 'gid://shopify/ProductVariant/1');
});

test('duplicate SKU across two variants does not error and both normalize independently', () => {
  const a = normalizeVariant({ id: 'gid://shopify/ProductVariant/3', title: 'X', sku: 'DUP-001' }, 'product-b', 'merchant-uuid');
  const b = normalizeVariant({ id: 'gid://shopify/ProductVariant/4', title: 'Y', sku: 'DUP-001' }, 'product-c', 'merchant-uuid');
  assert.equal(a.sku, 'DUP-001');
  assert.equal(b.sku, 'DUP-001');
  assert.notEqual(a.source_id, b.source_id); // identity is source_id, not sku
});

test('product without unitCost normalizes to null (UNCLASSIFIED, no row)', () => {
  const row = normalizeProductCost('variant-uuid', 'merchant-uuid', null, new Date());
  assert.equal(row, null);
});

test('product with unitCost normalizes to a row with shopify_unit_cost/unverified', () => {
  const row = normalizeProductCost('variant-uuid', 'merchant-uuid', { amount: '5.00', currencyCode: 'EUR' }, new Date('2026-01-01T00:00:00Z'));
  assert.equal(row.unit_cost, 5);
  assert.equal(row.currency, 'EUR');
  assert.equal(row.source, 'shopify_unit_cost');
  assert.equal(row.validation_status, 'unverified');
});

test('unchanged unitCost is detected as not-changed', () => {
  const existing = { unit_cost: 5, currency: 'EUR', source: 'shopify_unit_cost', validation_status: 'unverified' };
  const candidate = { unit_cost: 5, currency: 'EUR', source: 'shopify_unit_cost', validation_status: 'unverified' };
  assert.equal(costHasChanged(existing, candidate), false);
});

test('changed unitCost is detected as changed', () => {
  const existing = { unit_cost: 5, currency: 'EUR', source: 'shopify_unit_cost', validation_status: 'unverified' };
  const candidate = { unit_cost: 6.5, currency: 'EUR', source: 'shopify_unit_cost', validation_status: 'unverified' };
  assert.equal(costHasChanged(existing, candidate), true);
});

test('no prior cost row always counts as changed (first insert)', () => {
  const candidate = { unit_cost: 5, currency: 'EUR', source: 'shopify_unit_cost', validation_status: 'unverified' };
  assert.equal(costHasChanged(null, candidate), true);
});

test('inventory snapshot: no prior snapshot -> should write', () => {
  assert.equal(shouldWriteInventorySnapshot(null, new Date('2026-01-02T10:00:00Z')), true);
});

test('inventory snapshot: same UTC day retry -> should NOT write again', () => {
  const latest = { synced_at: '2026-01-02T03:00:00Z' };
  const retryLaterSameDay = new Date('2026-01-02T23:00:00Z');
  assert.equal(shouldWriteInventorySnapshot(latest, retryLaterSameDay), false);
});

test('inventory snapshot: next UTC day -> should write', () => {
  const latest = { synced_at: '2026-01-02T23:59:00Z' };
  const nextDay = new Date('2026-01-03T00:01:00Z');
  assert.equal(shouldWriteInventorySnapshot(latest, nextDay), true);
});
