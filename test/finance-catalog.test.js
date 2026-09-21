import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createShopifyPriceSource } from '../src/finance/catalog.js';
import { CUSTOMER_BODY, invoiceBody, startApp } from './finance-dashboard-helpers.js';

// SYNTHETIC catalogue appended to the Retail Core fixture. Retail Core stays the only catalogue: finance only reads it.
const P = 'prod-atelier-tote';
const CATALOG = {
  products: [
    { id: P, title: 'Atelier tote bag', handle: 'atelier-tote', product_type: 'Bags', source_status: 'ACTIVE', source_id: 'gid://test/Product/1' },
    { id: 'prod-old-mug', title: 'Vintage mug', handle: 'vintage-mug', product_type: 'Mugs', source_status: 'ARCHIVED', source_id: 'gid://test/Product/2' },
  ],
  variants: [
    { id: 'var-tote-grand', product_id: P, sku: 'CS-100', title: 'Grand', source_id: 'gid://test/Variant/1' },
    { id: 'var-tote-petit', product_id: P, sku: 'CS-200', title: 'Petit', source_id: 'gid://test/Variant/2' },
    { id: 'var-tote-mixed', product_id: P, sku: 'CS-300', title: 'Mixte', source_id: 'gid://test/Variant/3' }, // sold at two different VAT rates
    { id: 'var-mug-old', product_id: 'prod-old-mug', sku: 'CS-100', title: 'Default Title', source_id: 'gid://test/Variant/4' }, // same SKU as another product: SKU is never an identity
  ],
  orderLines: [
    { id: 'tl1', order_id: 'o1', variant_id: 'var-tote-grand', tax_rate_bp: 2100 }, { id: 'tl2', order_id: 'o1', variant_id: 'var-tote-grand', tax_rate_bp: 2100 },
    { id: 'tl3', order_id: 'o1', variant_id: 'var-tote-petit', tax_rate_bp: 600 },
    { id: 'tl4', order_id: 'o1', variant_id: 'var-tote-mixed', tax_rate_bp: 2100 }, { id: 'tl5', order_id: 'o1', variant_id: 'var-tote-mixed', tax_rate_bp: 600 },
  ],
};
CATALOG.snapshots = [
  { variant_id: 'var-tote-grand', location_id: 'l1', quantity: 12, synced_at: '2026-09-20T08:00:00Z' }, { variant_id: 'var-tote-grand', location_id: 'l2', quantity: 3, synced_at: '2026-09-20T08:00:00Z' },
  { variant_id: 'var-tote-grand', location_id: 'l1', quantity: 99, synced_at: '2026-09-01T08:00:00Z' }, // older count: ignored
  { variant_id: 'var-tote-petit', location_id: 'l1', quantity: 2, synced_at: '2026-09-20T08:00:00Z' }, { variant_id: 'var-tote-mixed', location_id: 'l1', quantity: 0, synced_at: '2026-09-20T08:00:00Z' },
]; // var-mug-old has never been counted
const PRICES = { 'gid://test/Variant/1': { amount: '25.00', taxesIncluded: true, imageUrl: 'https://cdn.shopify.com/test/tote.jpg' }, 'gid://test/Variant/2': { amount: '10.60', taxesIncluded: true }, 'gid://test/Variant/3': { amount: '12.00', taxesIncluded: true }, 'gid://test/Variant/4': { amount: '8.00', taxesIncluded: false } };

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
async function withCatalog(fn, { prices = PRICES, freeze = false } = {}) {
  const priceCalls = [];
  const a = await startApp({ priceSource: async (ids) => { priceCalls.push(...ids); if (prices === 'throw') throw new Error('shopify down'); return prices ? Object.fromEntries(ids.filter((id) => prices[id]).map((id) => [id, prices[id]])) : {}; } });
  a.fake.data.products.push(...CATALOG.products); a.fake.data.variants.push(...CATALOG.variants); a.fake.data.orderLines.push(...CATALOG.orderLines); a.fake.data.snapshots = [...(a.fake.data.snapshots ?? []), ...CATALOG.snapshots];
  if (freeze) { deepFreeze(a.fake.data.products); deepFreeze(a.fake.data.variants); deepFreeze(a.fake.data.orderLines); }
  try { await fn(a, await a.authed(), priceCalls); } finally { await a.close(); }
}
const find = async (c, q) => (await c.get(`/api/catalog/search?q=${encodeURIComponent(q)}`)).data.rows;
const select = async (c, variantId) => c.post('/api/catalog/select', { variantId });

test('search by PRODUCT name: every variant of the product is offered with its canonical ids', () => withCatalog(async (a, c) => {
  const rows = await find(c, 'atelier tote');
  assert.deepEqual(rows.map((r) => r.variantId).sort(), ['var-tote-grand', 'var-tote-mixed', 'var-tote-petit']);
  assert.ok(rows.every((r) => r.productId === P));
  assert.equal(rows.find((r) => r.variantId === 'var-tote-grand').name, 'Atelier tote bag - Grand');
}));
test('search by VARIANT name: only the matching variant', () => withCatalog(async (a, c) => {
  const rows = await find(c, 'petit');
  assert.deepEqual(rows.map((r) => r.variantId), ['var-tote-petit']);
  assert.equal((await find(c, 'tote petit')).length, 1); // every word must match, across product and variant names
}));
test('search by SKU: exact SKU first; the SAME SKU on two products returns both, distinguished by canonical ids (SKU is not an identity)', () => withCatalog(async (a, c) => {
  const rows = await find(c, 'cs-100');
  assert.deepEqual(rows.map((r) => r.variantId).sort(), ['var-mug-old', 'var-tote-grand']);
  assert.equal(rows[0].variantId, 'var-tote-grand', 'the active product ranks before the archived one');
  assert.equal(rows.find((r) => r.variantId === 'var-mug-old').archived, true);
  assert.deepEqual(await find(c, 'zzz-nothing'), []);
  assert.deepEqual(await find(c, 'a'), [], 'too-short queries return nothing');
}));

test('selection autofill: description, SKU, price excluding VAT (exact), canonical ids, VAT rate from consistent history, price snapshot', () => withCatalog(async (a, c, priceCalls) => {
  const r = (await select(c, 'var-tote-grand')).data;
  assert.equal(r.found, true);
  const l = r.line;
  assert.equal(l.description, 'Atelier tote bag - Grand');
  assert.equal(l.sku, 'CS-100');
  assert.equal(l.unitPrice, '20.6612'); // 25.00 incl. 21% VAT -> excl. VAT, integer maths
  assert.equal(l.vatRate, '21');
  assert.equal(l.quantity, '1');
  assert.equal(l.catalog.productId, P); assert.equal(l.catalog.variantId, 'var-tote-grand'); assert.equal(l.catalog.source, 'retail_core');
  assert.equal(l.catalog.priceSnapshot.amount, '25.00'); assert.equal(l.catalog.priceSnapshot.taxesIncluded, true);
  assert.deepEqual([...new Set(priceCalls)], ['gid://test/Variant/1']);
  assert.equal((await select(c, 'var-tote-petit')).data.line.vatRate, '6');
  assert.equal((await select(c, 'var-tote-petit')).data.line.unitPrice, '10.0000');
}));
test('VAT only where safely known: mixed history / never sold -> rate left for the merchant, and no price excl. VAT is invented', () => withCatalog(async (a, c) => {
  const m = (await select(c, 'var-tote-mixed')).data;
  assert.equal(m.line.vatRate, ''); assert.equal(m.line.unitPrice, ''); assert.match(m.notes.join(' '), /VAT rate: not set automatically/); assert.match(m.notes.join(' '), /including VAT/);
  const untaxed = (await select(c, 'var-mug-old')).data; // price WITHOUT VAT in the shop: usable as is, VAT still not guessed
  assert.equal(untaxed.line.unitPrice, '8.0000'); assert.equal(untaxed.line.vatRate, ''); assert.equal(untaxed.archived, true);
}));
test('price unavailable (Shopify down or no price source): the line is still filled, price left to type, clear note', async () => {
  for (const prices of ['throw', null]) {
    await withCatalog(async (a, c) => {
      const r = (await select(c, 'var-tote-grand')).data;
      assert.equal(r.line.description, 'Atelier tote bag - Grand'); assert.equal(r.line.unitPrice, ''); assert.equal(r.line.catalog.priceSnapshot, undefined);
      assert.match(r.notes.join(' '), /Current price could not be read/);
    }, { prices });
  }
});
test('selecting an unknown product returns 404, never an empty line', () => withCatalog(async (a, c) => {
  assert.equal((await select(c, 'var-does-not-exist')).status, 404);
}));

test('manual override: the merchant can change description, quantity, unit price, discount and VAT; the catalogue reference is kept', () => withCatalog(async (a, c) => {
  const sel = (await select(c, 'var-tote-grand')).data.line;
  const line = { ...sel, description: 'Tote bag, custom print (special offer)', quantity: '3', priceOrigin: 'NET_MANUAL', unitPrice: '18.00', discountPercent: '10', vatRate: '6' }; // typing an ex-VAT price makes the line NET_MANUAL
  const d = (await c.post('/api/documents', invoiceBody({ lines: [line] }))).data;
  const doc = (await c.get(`/api/documents/${d.id}`)).data.doc;
  const l = doc.lines[0];
  assert.equal(l.description, 'Tote bag, custom print (special offer)');
  assert.equal(l.qtyMilli, 3000); assert.equal(l.priceMicro, 180000); assert.equal(l.discountBp, 1000); assert.equal(l.vatRateBp, 600);
  assert.equal(l.sku, 'CS-100');
  assert.equal(l.catalog.productId, P); assert.equal(l.catalog.variantId, 'var-tote-grand');
  assert.equal(l.catalog.priceSnapshot.amount, '25.00', 'the original catalogue price stays as a traceable snapshot');
  // the same shared endpoint serves quotes
  const q = await c.post('/api/documents', { ...invoiceBody({ lines: [line] }), type: 'quote', revenueBasis: undefined });
  assert.equal(q.status, 201); assert.equal((await c.get(`/api/documents/${q.data.id}`)).data.doc.lines[0].catalog.variantId, 'var-tote-grand');
}));
test('custom line: no catalogue reference, works for services', () => withCatalog(async (a, c) => {
  const d = (await c.post('/api/documents', invoiceBody({ lines: [{ description: 'Design consultancy', quantity: '2', unitPrice: '75.00', vatRate: '21' }] }))).data;
  const l = (await c.get(`/api/documents/${d.id}`)).data.doc.lines[0];
  assert.equal(l.catalog, undefined); assert.equal(l.description, 'Design consultancy'); assert.equal(l.priceMicro, 750000);
}));
test('a forged / malformed catalogue reference is dropped, never trusted', () => withCatalog(async (a, c) => {
  const bad = { description: 'X', quantity: '1', unitPrice: '1.00', vatRate: '21', catalog: { source: 'somewhere_else', productId: 'p', variantId: 'v' } };
  const d = (await c.post('/api/documents', invoiceBody({ lines: [bad, { ...bad, catalog: { source: 'retail_core', productId: '<script>', variantId: 'var-tote-grand' } }] }))).data;
  const lines = (await c.get(`/api/documents/${d.id}`)).data.doc.lines;
  assert.ok(lines.every((l) => l.catalog === undefined));
}));

test('product removed / unavailable after the draft was created: the draft and the issued document keep their commercial line data unchanged', () => withCatalog(async (a, c) => {
  const sel = (await select(c, 'var-tote-grand')).data.line;
  const draft = (await c.post('/api/documents', invoiceBody({ lines: [sel] }))).data;
  const issuedSrc = (await c.post('/api/documents', invoiceBody({ lines: [sel] }))).data;
  await c.post(`/api/documents/${issuedSrc.id}/submit`, {});
  assert.equal((await c.post(`/api/documents/${issuedSrc.id}/approve`, {})).status, 200);
  const before = { draft: (await c.get(`/api/documents/${draft.id}`)).data.doc, issued: (await c.get(`/api/documents/${issuedSrc.id}`)).data.doc };

  // the product disappears from Retail Core, and its price changes in the shop
  a.fake.data.products.splice(0, a.fake.data.products.length, ...a.fake.data.products.filter((p) => p.id !== P));
  a.fake.data.variants.splice(0, a.fake.data.variants.length, ...a.fake.data.variants.filter((v) => v.product_id !== P));
  assert.equal((await select(c, 'var-tote-grand')).status, 404);
  assert.deepEqual(await find(c, 'atelier'), []);

  const after = { draft: (await c.get(`/api/documents/${draft.id}`)).data.doc, issued: (await c.get(`/api/documents/${issuedSrc.id}`)).data.doc };
  assert.deepEqual(after.draft.lines, before.draft.lines);
  assert.deepEqual(after.issued.lines, before.issued.lines);
  assert.deepEqual(after.draft.totals, before.draft.totals);
  assert.deepEqual(after.issued.totals, before.issued.totals);
  assert.equal(after.issued.lines[0].catalog.variantId, 'var-tote-grand');
  // editing the draft (another field) and recalculating still works and keeps the line as it was
  const upd = await c.put(`/api/documents/${draft.id}`, invoiceBody({ lines: after.draft.lines.map((l) => ({ description: l.description, quantity: '1', unitPrice: '20.6612', vatRate: '21', sku: l.sku, catalog: l.catalog })), notes: 'edited after the product was removed' }));
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const edited = (await c.get(`/api/documents/${draft.id}`)).data.doc;
  assert.equal(edited.lines[0].catalog.variantId, 'var-tote-grand'); assert.equal(edited.lines[0].description, 'Atelier tote bag - Grand');
}));

test('NO mutation of Retail Core: search and selection work on frozen catalogue data and never call anything but the read-only price lookup', () => withCatalog(async (a, c, priceCalls) => {
  const snap = JSON.stringify([a.fake.data.products, a.fake.data.variants, a.fake.data.orderLines]);
  await find(c, 'tote'); await find(c, 'cs-100'); await select(c, 'var-tote-grand'); await select(c, 'var-tote-mixed');
  await c.post('/api/documents', invoiceBody({ lines: [(await select(c, 'var-tote-grand')).data.line] }));
  assert.equal(JSON.stringify([a.fake.data.products, a.fake.data.variants, a.fake.data.orderLines]), snap, 'catalogue data is identical after use');
  assert.ok(priceCalls.every((id) => id.startsWith('gid://test/Variant/')));
  assert.equal(a.store.products, undefined); assert.equal(a.store.variants, undefined); // finance keeps no catalogue of its own
}, { freeze: true }));

test('the Shopify price lookup is a read-only GraphQL query; no product/price write exists in the catalogue modules', async () => {
  const seen = [];
  const price = await createShopifyPriceSource({ graphql: async (q, v) => { seen.push({ q, v }); return { nodes: [{ id: 'gid://x/1', price: '9.99', image: { url: 'https://cdn.shopify.com/i.jpg' } }, null], shop: { taxesIncluded: true } }; } })(['gid://x/1', 'gid://x/2']);
  assert.deepEqual(price, { 'gid://x/1': { amount: '9.99', taxesIncluded: true, imageUrl: 'https://cdn.shopify.com/i.jpg' } });
  assert.ok(/^\s*query\b/.test(seen[0].q) && !/mutation/i.test(seen[0].q));
  for (const f of ['catalog.js', 'retail-access.js']) {
    const src = readFileSync(new URL(`../src/finance/${f}`, import.meta.url), 'utf8');
    assert.ok(!/mutation|\.upsert\(|\.insert\(|\.update\(|\.delete\(|productUpdate|productVariantsBulkUpdate/i.test(src), `${f} has no write path`);
  }
});

test('UI: one shared product search used by both invoices and quotes, plus the custom line option', () => {
  const ui = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8');
  assert.equal((ui.match(/function productSearchBox\(/g) || []).length, 1);
  assert.equal((ui.match(/= productSearchBox\(\{/g) || []).length, 1, 'used by the single document form that serves invoices and quotes');
  assert.match(ui, /viewForm\('quote'|viewForm\('invoice'|viewForm\(kind/);
  for (const t of ['Search product name, variant or SKU', '+ Add product', '+ Add custom line', 'Change product', 'Remove line', 'Custom line', 'Price override', 'Confirm VAT rate']) assert.ok(ui.includes(t), t);
  assert.ok(!/\.innerHTML\s*=/.test(ui));
});

test('rich results: thumbnail, variant, SKU, available stock (latest count per location, summed), current catalogue price incl. VAT', () => withCatalog(async (a, c) => {
  const rows = await find(c, 'tote');
  const grand = rows.find((r) => r.variantId === 'var-tote-grand');
  assert.deepEqual(grand.stock, { qty: 15, state: 'ok' }); // 12 + 3; the older 99 is ignored
  assert.equal(grand.price.amount, '25.00'); assert.equal(grand.price.taxesIncluded, true);
  assert.equal(grand.imageUrl, 'https://cdn.shopify.com/test/tote.jpg');
  assert.equal(grand.variantTitle, 'Grand'); assert.equal(grand.sku, 'CS-100');
  assert.deepEqual(rows.find((r) => r.variantId === 'var-tote-petit').stock, { qty: 2, state: 'low' });
  assert.deepEqual(rows.find((r) => r.variantId === 'var-tote-mixed').stock, { qty: 0, state: 'out' });
  const mug = (await find(c, 'vintage'))[0]; assert.deepEqual(mug.stock, { qty: null, state: 'unknown' });
}));
test('row check comes from the deterministic engine: 49.00 incl. 21% VAT keeps the catalogue price (explicit rounding amount, not a warning)', async () => {
  const prices = { 'gid://test/Variant/1': { amount: '49.00', taxesIncluded: true } };
  await withCatalog(async (a, c) => {
    const r = (await select(c, 'var-tote-grand')).data;
    assert.equal(r.line.unitPrice, '40.4959'); assert.equal(r.line.priceOrigin, 'GROSS_CATALOGUE'); assert.equal(r.line.grossUnitPrice, '49.0000');
    assert.deepEqual(r.catalogue.check, { net: '40.50', vat: '8.51', gross: '49.01', rounding: '-0.01', payable: '49.00', roundingCents: -1, matchesCatalogue: true });
    assert.equal(r.catalogue.priceInclVat, '49.00');
    assert.ok(!r.notes.some((n) => /round/i.test(n)));
  }, { prices: { ...PRICES, ...prices } });
});
