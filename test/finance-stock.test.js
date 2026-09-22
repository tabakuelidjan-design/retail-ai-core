import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createShopifyStockApplier, createStockService, planMovements } from '../src/finance/stock.js';
import { validateSettings } from '../src/finance/settings.js';
import { baseSettings, invoiceBody, startApp } from './finance-dashboard-helpers.js';

// SYNTHETIC catalogue, locations and a fake Shopify applier. Nothing here talks to Shopify.
const PRODUCTS = [{ id: 'prod-stock-tote', title: 'Tote bag', handle: 'tote', product_type: 'Bags', source_status: 'ACTIVE', source_id: 'gid://test/Product/1' }];
const VARIANTS = [{ id: 'var-stock-grand', product_id: 'prod-stock-tote', sku: 'ST-1', title: 'Grand', source_id: 'gid://test/Variant/11' }, { id: 'var-stock-petit', product_id: 'prod-stock-tote', sku: 'ST-2', title: 'Petit', source_id: 'gid://test/Variant/12' }];
const LOC1 = { id: 'loc-main-0001', name: 'Main shop', type: 'physical', source_id: 'gid://test/Location/1' };
const LOC2 = { id: 'loc-back-0002', name: 'Back store', type: 'physical', source_id: 'gid://test/Location/2' };
const cat = (variantId, q = '2', extra = {}) => ({ description: 'Tote', quantity: q, unitPrice: '20.00', vatRate: '21', catalog: { source: 'retail_core', productId: 'prod-stock-tote', variantId }, ...extra });
const custom = { description: 'Design work', quantity: '3', unitPrice: '50.00', vatRate: '21' };

function fakeApplier(opts = {}) {
  const calls = { adjust: [], lookup: [], scope: 0 };
  return {
    calls, scope: opts.scope ?? true, mode: opts.mode ?? 'ok',
    async hasScope() { calls.scope += 1; if (opts.scopeThrows) throw new Error('shopify down'); return this.scope; },
    async lookup(id) { calls.lookup.push(id); if (opts.untracked) return { inventoryItemId: `item-${id}`, tracked: false }; return { inventoryItemId: `item-${id}`, tracked: true }; },
    async adjust(a) { calls.adjust.push(a); if (this.mode === 'throw') throw new Error('socket hang up'); if (this.mode === 'refuse') return { ok: false, errors: ['not stocked at location'] }; return { ok: true, adjustmentId: `gid://test/Adjustment/${calls.adjust.length}` }; },
  };
}
async function harness({ mode = 'live', locations = [LOC1], locationId = null, applier = fakeApplier() } = {}) {
  const s = baseSettings(); s.stock = { mode, locationId };
  const a = await startApp({ settings: s, stockApplier: applier });
  a.fake.data.products.push(...PRODUCTS); a.fake.data.variants.push(...VARIANTS); a.fake.data.locations = locations;
  const c = await a.authed();
  const issue = async (over = {}) => {
    const d = (await c.post('/api/documents', invoiceBody(over))).data;
    assert.ok(d.id, JSON.stringify(d));
    assert.equal((await c.post(`/api/documents/${d.id}/submit`, {})).status, 200);
    const r = await c.post(`/api/documents/${d.id}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
    return d.id;
  };
  const movements = async (documentId) => (await c.get(`/api/stock/movements${documentId ? `?documentId=${documentId}` : ''}`)).data.rows;
  return { a, c, applier, issue, movements, close: () => a.close() };
}
const run = (cfg, fn) => async () => { const h = await harness(cfg); try { await fn(h); } finally { await h.close(); } };

test('standalone B2B invoice: catalogue lines decrement Shopify exactly once when the invoice is ISSUED; custom lines never', run({}, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '2'), cat('var-stock-petit', '3'), custom] });
  const m = await h.movements(id);
  assert.equal(m.length, 2, 'one movement per catalogue line, none for the custom line');
  assert.deepEqual(m.map((x) => [x.linePosition, x.variantId, x.delta, x.status]).sort(), [[1, 'var-stock-grand', -2, 'APPLIED'], [2, 'var-stock-petit', -3, 'APPLIED']]);
  assert.equal(h.applier.calls.adjust.length, 2);
  const first = h.applier.calls.adjust[0];
  assert.equal(first.delta, -2); assert.equal(first.locationSourceId, LOC1.source_id); assert.equal(first.reason, 'other'); assert.match(first.referenceUri, /^gid:\/\/finance-app\/invoice\//);
  // permanent audit chain: document -> line -> variant -> location -> quantity -> Shopify adjustment
  const x = m.find((r) => r.linePosition === 1);
  assert.equal(x.documentId, id); assert.ok(x.documentNumber); assert.equal(x.variantSourceId, 'gid://test/Variant/11'); assert.equal(x.locationId, LOC1.id); assert.equal(x.quantity, 2); assert.match(x.shopifyAdjustmentId, /^gid:\/\/test\/Adjustment\//); assert.ok(x.appliedAt);
}));

test('draft, quote and unissued documents change no stock', run({}, async (h) => {
  const d = (await h.c.post('/api/documents', invoiceBody({ lines: [cat('var-stock-grand')] }))).data;
  const q = (await h.c.post('/api/documents', { ...invoiceBody({ lines: [cat('var-stock-grand')] }), type: 'quote', revenueBasis: undefined })).data;
  assert.equal((await h.c.post(`/api/documents/${q.id}/send-quote`, {})).status, 200);
  assert.equal((await h.movements()).length, 0); assert.equal(h.applier.calls.adjust.length, 0);
  assert.equal(planMovements({ type: 'invoice', id: d.id, status: 'DRAFT', lockedAt: null, revenueBasis: 'standalone_b2b', lines: [] }).reason, 'NOT_ISSUED');
}));

test('an invoice linked to a Shopify / POS order NEVER decrements again', run({}, async (h) => {
  const target = (await h.c.get('/api/orders')).data.rows[0];
  const id = await h.issue({ revenueBasis: 'linked_source_order', sourceOrderId: target.sourceOrderId, lines: [cat('var-stock-grand', '1', { unitPrice: (Math.round(target.totalCents / 1.21) / 100).toFixed(2) })] });
  assert.equal((await h.movements(id)).length, 0); assert.equal(h.applier.calls.adjust.length, 0);
}));

test('fractional quantities cannot be a stock movement: recorded as SKIPPED for review, never applied', run({}, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '1.5')] });
  const m = await h.movements(id);
  assert.equal(m.length, 1); assert.equal(m[0].status, 'SKIPPED'); assert.equal(m[0].error, 'FRACTIONAL_OR_INVALID_QUANTITY'); assert.equal(h.applier.calls.adjust.length, 0);
}));

test('IDEMPOTENT: recording twice, applying twice, reconciling and reloading never adjust the same line twice', run({}, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
  assert.equal(h.applier.calls.adjust.length, 1);
  assert.equal((await h.c.post('/api/stock/apply', {})).data.applied, 0);
  assert.equal((await h.c.post('/api/stock/reconcile', {})).data.created, 0);
  await h.c.get(`/api/documents/${id}`); await h.c.post('/api/stock/apply', {});
  assert.equal(h.applier.calls.adjust.length, 1); assert.equal((await h.movements(id)).length, 1);
}));

test('two runs at the same time cannot both adjust the same movement (compare-and-set claim)', async () => {
  const store = createMemoryStore(); const applier = fakeApplier();
  const svc = createStockService({ store, merchantId: 'm1', retail: { getCatalogVariant: async () => ({ variantSourceId: 'gid://test/Variant/11', sku: 'S' }), listLocations: async () => [LOC1] }, applier, getSettings: async () => ({ stock: { mode: 'live', locationId: null } }) });
  const doc = { id: 'doc-1', merchantId: 'm1', type: 'invoice', number: 'INV-1', status: 'ISSUED', lockedAt: 'x', revenueBasis: 'standalone_b2b', lines: [{ position: 1, qtyMilli: 4000, catalog: { variantId: 'var-stock-grand' } }] };
  await svc.record(doc); await svc.record(doc);
  await Promise.all([svc.applyPending(), svc.applyPending(), svc.applyPending()]);
  assert.equal(applier.calls.adjust.length, 1);
  assert.equal((await store.listStockMovements({ merchantId: 'm1' }))[0].status, 'APPLIED');
});

test('modes: off does nothing, dry_run reports what WOULD happen without writing, live writes', async () => {
  for (const [mode, adjusts, status] of [['off', 0, undefined], ['dry_run', 0, 'PENDING'], ['live', 1, 'APPLIED']]) {
    const h = await harness({ mode }); try {
      const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
      if (mode !== 'live') { const r = (await h.c.post('/api/stock/apply', {})).data; assert.equal(r.mode, mode); if (mode === 'dry_run') assert.deepEqual(r.results.map((x) => [x.outcome, x.delta]), [['WOULD_ADJUST', -2]]); }
      assert.equal(h.applier.calls.adjust.length, adjusts, mode); assert.equal((await h.movements(id))[0]?.status, status, mode);
      if (mode === 'off') { const st = h.a.getSettings(); st.stock.mode = 'dry_run'; h.a.setSettings(st); assert.equal((await h.c.post('/api/stock/reconcile', {})).data.created, 1, 'enabling later catches up on issued documents'); assert.equal((await h.movements(id))[0].status, 'PENDING'); }
    } finally { await h.close(); }
  }
});

test('missing write_inventory scope: nothing is written, movements wait as PENDING and apply once the scope exists', async () => {
  const applier = fakeApplier({ scope: false }); const h = await harness({ applier });
  try {
    const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
    assert.equal(applier.calls.adjust.length, 0); assert.equal((await h.movements(id))[0].status, 'PENDING');
    assert.equal((await h.c.post('/api/stock/apply', {})).data.blocked, 'SCOPE_MISSING_WRITE_INVENTORY');
    assert.equal((await h.c.get('/api/stock/status')).data.scope, 'MISSING');
    applier.scope = true; const r = (await h.c.post('/api/stock/apply', {})).data;
    assert.equal(r.applied, 1); assert.equal(applier.calls.adjust.length, 1);
  } finally { await h.close(); }
});

test('Shopify refuses (userErrors): FAILED, never silently retried; an explicit retry applies it once', run({ applier: fakeApplier({ mode: 'refuse' }) }, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
  let m = (await h.movements(id))[0]; assert.equal(m.status, 'FAILED'); assert.match(m.error, /not stocked/);
  await h.c.post('/api/stock/apply', {}); assert.equal(h.applier.calls.adjust.length, 1, 'a failed movement is not retried automatically');
  h.applier.mode = 'ok';
  assert.equal((await h.c.post(`/api/stock/movements/${m.id}/retry`, {})).data.status, 'PENDING');
  assert.equal((await h.c.post('/api/stock/apply', {})).data.applied, 1);
  m = (await h.movements(id))[0]; assert.equal(m.status, 'APPLIED'); assert.equal(h.applier.calls.adjust.length, 2);
}));

test('unknown outcome (connection cut): UNCERTAIN, never re-applied automatically; the merchant says what Shopify shows', run({ applier: fakeApplier({ mode: 'throw' }) }, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
  let m = (await h.movements(id))[0]; assert.equal(m.status, 'UNCERTAIN');
  h.applier.mode = 'ok'; await h.c.post('/api/stock/apply', {}); assert.equal(h.applier.calls.adjust.length, 1, 'no second adjustment');
  assert.equal((await h.c.post(`/api/stock/movements/${m.id}/retry`, {})).status, 409, 'an explicit answer is required');
  assert.equal((await h.c.post(`/api/stock/movements/${m.id}/retry`, { appliedInShopify: true })).data.status, 'APPLIED'); assert.equal(h.applier.calls.adjust.length, 1);
}));
test('UNCERTAIN + "not applied in Shopify" puts the movement back to PENDING', run({ applier: fakeApplier({ mode: 'throw' }) }, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '1')] });
  const m = (await h.movements(id))[0]; h.applier.mode = 'ok';
  assert.equal((await h.c.post(`/api/stock/movements/${m.id}/retry`, { appliedInShopify: false })).data.status, 'PENDING');
  assert.equal((await h.c.post('/api/stock/apply', {})).data.applied, 1); assert.equal(h.applier.calls.adjust.length, 2);
}));

test('stock locations: single location is used; several need a choice (movements wait), then apply at the chosen location', async () => {
  const h = await harness({ locations: [LOC1, LOC2] });
  try {
    const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
    let m = (await h.movements(id))[0]; assert.equal(m.status, 'PENDING'); assert.equal(m.locationId, null); assert.equal(h.applier.calls.adjust.length, 0);
    assert.equal((await h.c.post('/api/stock/apply', {})).data.results[0].reason, 'LOCATION_NOT_CONFIGURED');
    const st = h.a.getSettings(); st.stock.locationId = LOC2.id; h.a.setSettings(st);
    assert.equal((await h.c.post('/api/stock/apply', {})).data.applied, 1);
    assert.equal(h.applier.calls.adjust[0].locationSourceId, LOC2.source_id); m = (await h.movements(id))[0]; assert.equal(m.locationId, LOC2.id);
    assert.equal((await h.c.get('/api/stock/status')).data.locationName, 'Back store');
  } finally { await h.close(); }
});

test('untracked inventory cannot be adjusted: FAILED with a clear reason, not silently ignored', run({ applier: fakeApplier({ untracked: true }) }, async (h) => {
  const id = await h.issue({ lines: [cat('var-stock-grand', '1')] });
  const m = (await h.movements(id))[0]; assert.equal(m.status, 'FAILED'); assert.equal(m.error, 'INVENTORY_NOT_TRACKED'); assert.equal(h.applier.calls.adjust.length, 0);
}));

test('CREDIT NOTE: the merchant must decide whether goods return to sellable stock; yes restocks once, no changes nothing; linked invoices need no decision', async () => {
  for (const restock of [true, false]) {
    const h = await harness(); try {
      const id = await h.issue({ lines: [cat('var-stock-grand', '3')] });
      assert.equal(h.applier.calls.adjust.length, 1);
      const cn = (await h.c.post(`/api/documents/${id}/credit-note`, { reason: 'Returned goods' })).data;
      assert.equal((await h.c.get(`/api/documents/${id}`)).data.hadStockMovements, true);
      const sub = await h.c.post(`/api/documents/${cn.id}/submit`, {});
      assert.equal(sub.status, 422, 'undecided restock blocks the credit note'); assert.match(JSON.stringify(sub.data), /STOCK_RESTOCK_DECISION_REQUIRED/);
      const cn2 = (await h.c.post(`/api/documents/${id}/credit-note`, { reason: 'Returned goods', restock })).data;
      assert.equal((await h.c.post(`/api/documents/${cn2.id}/submit`, {})).status, 200);
      assert.equal((await h.c.post(`/api/documents/${cn2.id}/approve`, {})).status, 200);
      const mv = await h.movements(cn2.id);
      if (restock) { assert.equal(mv.length, 1); assert.equal(mv[0].kind, 'RETURN_RESTOCK'); assert.equal(mv[0].delta, 3); assert.equal(mv[0].status, 'APPLIED'); assert.equal(h.applier.calls.adjust[1].reason, 'restock'); assert.equal(h.applier.calls.adjust[1].delta, 3); }
      else { assert.equal(mv.length, 0); assert.equal(h.applier.calls.adjust.length, 1); }
    } finally { await h.close(); }
  }
  const h = await harness(); try {
    const target = (await h.c.get('/api/orders')).data.rows[0];
    const id = await h.issue({ revenueBasis: 'linked_source_order', sourceOrderId: target.sourceOrderId, lines: [cat('var-stock-grand', '1', { unitPrice: (Math.round(target.totalCents / 1.21) / 100).toFixed(2) })] });
    const cn = (await h.c.post(`/api/documents/${id}/credit-note`, { reason: 'x' })).data;
    assert.equal((await h.c.post(`/api/documents/${cn.id}/submit`, {})).status, 200, 'no decision needed: nothing was decremented');
  } finally { await h.close(); }
});

test('an issued invoice stays issued if the stock step fails; the failure is audited and reconciliation catches up', async () => {
  const applier = fakeApplier({ scopeThrows: true }); const h = await harness({ applier });
  try {
    const id = await h.issue({ lines: [cat('var-stock-grand', '2')] });
    const d = (await h.c.get(`/api/documents/${id}`)).data;
    assert.equal(d.status, 'ISSUED'); assert.ok(d.events.some((e) => e.action === 'STOCK_HOOK_FAILED'));
    assert.equal((await h.movements(id))[0].status, 'PENDING', 'recorded before the failure');
  } finally { await h.close(); }
});

test('reconcile creates movements for issued standalone invoices that have none (crash between issuing and recording) without duplicates', async () => {
  const store = createMemoryStore(); const applier = fakeApplier();
  const svc = createStockService({ store, merchantId: 'm1', retail: { getCatalogVariant: async () => ({ variantSourceId: 'gid://test/Variant/11' }), listLocations: async () => [LOC1] }, applier, getSettings: async () => ({ stock: { mode: 'live' } }) });
  const doc = { id: 'doc-9', merchantId: 'm1', type: 'invoice', number: 'INV-9', status: 'ISSUED', lockedAt: 'x', revenueBasis: 'standalone_b2b', lines: [{ position: 1, qtyMilli: 1000, catalog: { variantId: 'v' } }] };
  assert.equal((await svc.reconcile([doc], async () => null)).created, 1); assert.equal((await svc.reconcile([doc], async () => null)).created, 0);
});

test('tenant isolation: another merchant cannot retry or see a movement', async () => {
  const store = createMemoryStore();
  const mk = (merchantId) => createStockService({ store, merchantId, retail: { getCatalogVariant: async () => ({ variantSourceId: 'v' }), listLocations: async () => [LOC1] }, applier: fakeApplier(), getSettings: async () => ({ stock: { mode: 'off' } }) });
  const a = mk('m1'); const b = mk('m2');
  const doc = { id: 'd1', merchantId: 'm1', type: 'invoice', number: 'X', status: 'ISSUED', lockedAt: 'x', revenueBasis: 'standalone_b2b', lines: [{ position: 1, qtyMilli: 1000, catalog: { variantId: 'v' } }] };
  const [m] = (await a.record(doc)).created;
  assert.equal((await b.list()).length, 0);
  await assert.rejects(() => b.retry(m.id), /STOCK_MOVEMENT_NOT_FOUND/);
  await assert.rejects(() => b.record(doc), /DOCUMENT_NOT_FOUND/);
});

test('the ledger is append-only: content is immutable, APPLIED is final, only allowed transitions', async () => {
  const store = createMemoryStore();
  const { row } = await store.insertStockMovement({ merchantId: 'm1', documentId: 'd', idempotencyKey: 'k', status: 'PENDING', quantity: 1, delta: -1, kind: 'SALE_DECREMENT' });
  await assert.rejects(() => store.updateStockMovement(row.id, { quantity: 99 }, 'PENDING'), /STOCK_MOVEMENT_IS_IMMUTABLE/);
  await assert.rejects(() => store.updateStockMovement(row.id, { status: 'PENDING' }, 'PENDING'), /INVALID_TRANSITION/);
  await store.updateStockMovement(row.id, { status: 'APPLYING' }, 'PENDING'); await store.updateStockMovement(row.id, { status: 'APPLIED' }, 'APPLYING');
  await assert.rejects(() => store.updateStockMovement(row.id, { status: 'PENDING' }, 'APPLIED'), /INVALID_TRANSITION/);
  assert.equal(await store.updateStockMovement(row.id, { status: 'FAILED' }, 'PENDING'), null, 'a stale expectation changes nothing');
  assert.equal((await store.insertStockMovement({ merchantId: 'm1', idempotencyKey: 'k', status: 'PENDING' })).created, false);
});

test('Shopify applier: inventory adjustment only. No product, variant, price or image is ever written; the migration guards the ledger', async () => {
  const src = readFileSync(new URL('../src/finance/stock.js', import.meta.url), 'utf8');
  const mutations = [...src.matchAll(/mutation\s*\(/g)];
  assert.equal(mutations.length, 1); assert.match(src, /inventoryAdjustQuantities/);
  assert.ok(!/productUpdate|productVariantsBulk|productVariantUpdate|productCreate|productDelete|priceListFixedPrices|collectionUpdate|fileCreate|productSet/i.test(src));
  const calls = [];
  const applier = createShopifyStockApplier({ graphql: async (q, v) => { calls.push({ q, v }); if (/currentAppInstallation/.test(q)) return { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'write_inventory' }] } }; if (/productVariant\(/.test(q)) return { productVariant: { inventoryItem: { id: 'gid://i/1', tracked: true } } }; return { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'gid://adj/1' }, userErrors: [] } }; } });
  assert.equal(await applier.hasScope(), true);
  assert.deepEqual(await applier.lookup('gid://v/1'), { inventoryItemId: 'gid://i/1', tracked: true });
  assert.deepEqual(await applier.adjust({ inventoryItemId: 'gid://i/1', locationSourceId: 'gid://l/1', delta: -2, reason: 'other', referenceUri: 'gid://finance-app/invoice/1' }), { ok: true, adjustmentId: 'gid://adj/1' });
  const sent = calls.at(-1).v.input; assert.equal(sent.name, 'available'); assert.deepEqual(sent.changes, [{ delta: -2, inventoryItemId: 'gid://i/1', locationId: 'gid://l/1' }]);
  const sql = readFileSync(new URL('../supabase/migrations/20260922180000_finance_stock_movements.sql', import.meta.url), 'utf8');
  for (const t of ['append-only', 'idempotency', 'fin_stock_movements_guard', 'unique index fin_stock_movements_key_uq']) assert.ok(sql.includes(t), t);
});

test('settings: stock mode and location are validated; default is OFF', () => {
  assert.equal(validateSettings({}, undefined).settings.stock.mode, 'off');
  assert.equal(validateSettings({ stock: { mode: 'live', locationId: 'loc-main-0001' } }, undefined).settings.stock.mode, 'live');
  assert.ok(validateSettings({ stock: { mode: 'yolo' } }, undefined).errors.some((e) => e.code === 'MODE_INVALID'));
  assert.ok(validateSettings({ stock: { locationId: '<script>' } }, undefined).errors.some((e) => e.code === 'LOCATION_INVALID'));
});
