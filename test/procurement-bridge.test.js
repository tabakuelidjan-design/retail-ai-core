import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, rejects, buyer, key, owner } from './procurement-fixtures.js';
import { importSourcingCase, draftOrderFromCase, caseToCapture } from '../src/procurement/sourcing-bridge.js';

// A case as the China Sourcing PWA saves it (plain JSON, the subset the bridge reads). No import from src/sourcing.
const visitCase = (over = {}) => ({
  schema: 2, id: 'case-mgnt01', identity: { workingName: 'Magnet fridge round 4cm', identifiers: { gtin: null, model: 'MG-04' }, photos: [{ ref: 'photo://case-mgnt01/1.jpg', note: 'stand B12', at: '2026-10-20T08:00:00Z' }, { ref: 'photo://case-mgnt01/2.jpg', at: '2026-10-20T08:01:00Z' }] },
  supplier: { name: 'Yiwu Sunshine Crafts Co., Ltd' }, documents: [{ id: 'doc-1', fileName: 'catalogue.pdf', ref: 'file://catalogue.pdf' }],
  quotes: [{ at: '2026-10-20T08:05:00Z', unitPrice: '0.52', currency: 'USD', moq: 500, incoterm: 'FOB', port: 'Ningbo', leadTimeDays: 25, payment: { depositPct: '30' }, tiers: [{ minQty: 500, unitPrice: '0.52' }, { minQty: 2000, unitPrice: '0.44' }] }],
  ...over,
});
let loc;
const setup = async () => { const w = await makeWorld(); loc = w.locs.warehouse.id; return w; };

test('a visit case becomes a supplier, a prospect item with its photos and a quote, with no retyping', async () => {
  const w = await setup();
  const r = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase() });
  assert.equal(r.status, 'IMPORTED'); assert.equal(r.supplier.created, true); assert.equal(r.item.created, true);
  const item = await w.q.item(r.item.id);
  assert.equal(item.status, 'PROSPECT'); assert.equal(item.sku, 'SRC-case-mgnt01'); assert.equal(item.attachments.length, 3); // 2 photos + the catalogue
  const sup = await w.q.supplier(r.supplier.id);
  assert.equal(sup.currency, 'USD'); assert.equal(sup.incotermDefault, 'FOB'); assert.equal(sup.depositBps, 3000);
  const h = await w.q.priceHistory({ supplierId: r.supplier.id, itemId: r.item.id });
  assert.equal(h.length, 1); assert.deepEqual(h[0].tiers, [{ minQty: 500, unitPrice: '0.52' }, { minQty: 2000, unitPrice: '0.44' }]);
  assert.equal(h[0].moq, 500); assert.equal(h[0].incoterm, 'FOB'); assert.equal(h[0].provenance, 'SUPPLIER_CLAIM');
  assert.match(h[0].reason, /case-mgnt01/);
});

test('importing the same case again creates nothing new; a changed quote adds exactly one revision; new photos are appended once', async () => {
  const w = await setup();
  const first = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase() });
  const again = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase() });
  assert.equal(again.supplier.id, first.supplier.id); assert.equal(again.item.id, first.item.id); assert.equal(again.supplier.created, false); assert.equal(again.item.created, false);
  assert.deepEqual(again.quotes.map((q) => q.status), ['UNCHANGED']);
  assert.equal((await w.q.suppliers()).length, 2); // the world's own supplier + the imported one
  assert.equal((await w.q.items()).filter((i) => i.sku.startsWith('SRC-')).length, 1);
  // the supplier moves the price during negotiation and a photo is added
  const c2 = visitCase({ identity: { ...visitCase().identity, photos: [...visitCase().identity.photos, { ref: 'photo://case-mgnt01/3.jpg' }] } });
  c2.quotes.push({ at: '2026-10-20T09:10:00Z', unitPrice: '0.49', currency: 'USD', moq: 500, incoterm: 'FOB', leadTimeDays: 25, payment: { depositPct: '30' }, tiers: [{ minQty: 500, unitPrice: '0.49' }, { minQty: 2000, unitPrice: '0.41' }] });
  const third = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: c2 });
  assert.deepEqual(third.quotes.map((q) => q.status), ['UNCHANGED', 'CREATED']);
  assert.equal((await w.q.priceHistory({ supplierId: first.supplier.id, itemId: first.item.id })).length, 2);
  assert.equal((await w.q.item(first.item.id)).attachments.length, 4);
  const fourth = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: c2 });
  assert.deepEqual(fourth.quotes.map((q) => q.status), ['UNCHANGED', 'UNCHANGED']);
  assert.equal((await w.q.item(first.item.id)).attachments.length, 4);
});

test('duplicates are prevented: an existing supplier is reused by normalised name, an ambiguous match is refused, never guessed', async () => {
  const w = await setup();
  const existing = (await w.mk(w.c.createSupplier, buyer, { name: 'YIWU SUNSHINE CRAFTS', currency: 'USD' })).supplier;
  const r = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase() });
  assert.equal(r.supplier.id, existing.id); assert.equal(r.supplier.created, false);
  // a second case from the same supplier, other product: same supplier, new item
  const other = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase({ id: 'case-mgnt02', identity: { workingName: 'Keychain acrylic', identifiers: {}, photos: [] } }) });
  assert.equal(other.supplier.id, existing.id); assert.notEqual(other.item.id, r.item.id);
  // two suppliers that normalise to the same name -> refuse
  const w2 = await setup();
  await w2.mk(w2.c.createSupplier, buyer, { name: 'Acme Trading Co', currency: 'USD' });
  await w2.mk(w2.c.createSupplier, buyer, { name: 'ACME Ltd', currency: 'USD' });
  const amb = await importSourcingCase({ commands: w2.c, queries: w2.q, actor: buyer, caseState: visitCase({ supplier: { name: 'Acme' } }) });
  assert.equal(amb.status, 'BLOCKED'); assert.equal(amb.issues[0].code, 'SUPPLIER_AMBIGUOUS'); assert.equal(amb.issues[0].candidates.length, 2);
  assert.equal((await w2.q.items()).filter((i) => i.sku.startsWith('SRC-')).length, 0, 'a blocked import wrote nothing');
});

test('a barcode in the case matches an existing catalogue item instead of creating a twin', async () => {
  const w = await setup();
  const known = w.itemA; // MAG-001, barcode 5400000000011
  const c = visitCase(); c.identity.identifiers.gtin = '5400000000011';
  const r = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: c });
  assert.equal(r.item.id, known.id); assert.equal(r.item.created, false);
});

test('nothing is invented: unreadable prices, missing currencies and unknown Incoterms are reported and skipped', async () => {
  const w = await setup();
  const c = visitCase();
  c.quotes = [
    { at: 'a', unitPrice: 'about 3 USD', currency: 'USD', moq: 100 },
    { at: 'b', unitPrice: '0.5', moq: 100 }, // no currency
    { at: 'c', unitPrice: '0,52', currency: 'usd', moq: 500, incoterm: 'XYZ' }, // decimal comma is fine, Incoterm unknown -> left empty
    { at: 'd', unitPrice: '0.40', currency: 'USD', tiers: [{ minQty: 100, unitPrice: '0.40' }, { minQty: 500, unitPrice: '0.45' }] }, // a higher tier costs more: refused by the module
  ];
  const r = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: c });
  assert.equal(r.status, 'PARTIAL');
  assert.deepEqual(r.issues.map((i) => i.code).sort(), ['CURRENCY_MISSING', 'INCOTERM_UNKNOWN', 'PRICE_NOT_PARSEABLE', 'TIER_PRICE_INCREASES']);
  assert.equal(r.quotes.filter((q) => q.status === 'CREATED').length, 1);
  const h = await w.q.priceHistory({ supplierId: r.supplier.id, itemId: r.item.id });
  assert.equal(h.length, 1); assert.equal(h[0].tiers[0].unitPrice, '0.52'); assert.equal(h[0].incoterm, null);
  // not a case / no supplier / no product -> BLOCKED, nothing written
  for (const bad of [null, {}, visitCase({ supplier: {} }), visitCase({ identity: { workingName: '', photos: [] } })]) {
    const b = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: bad });
    assert.equal(b.status, 'BLOCKED');
  }
  assert.equal(caseToCapture(visitCase({ quotes: [{ at: 'x', unitPrice: '1', currency: 'USD', moq: 10 }] })).quotes[0].tiers[0].minQty, 10);
});

test('a draft purchase order is prepared from the case and is never created twice', async () => {
  const w = await setup();
  const d = await draftOrderFromCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase(), qty: 2500, destinationLocationId: loc, expectedDate: '2026-12-01' });
  assert.equal(d.status, 'IMPORTED'); assert.equal(d.purchaseOrder.status, 'DRAFT'); assert.equal(d.purchaseOrder.reused, false);
  const po = await w.q.purchaseOrder(d.purchaseOrder.id);
  assert.equal(po.lines[0].qty, 2500); assert.equal(po.lines[0].unitPriceMicro, 440000, 'the 2000+ tier applies'); assert.equal(po.totalMinor, 110000);
  assert.deepEqual(po.schedule.map((s) => [s.kind, s.amountMinor]), [['DEPOSIT', 33000], ['BALANCE', 77000]]);
  const again = await draftOrderFromCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase(), qty: 2500, destinationLocationId: loc, expectedDate: '2026-12-01' });
  assert.equal(again.purchaseOrder.id, d.purchaseOrder.id); assert.equal(again.purchaseOrder.reused, true);
  assert.equal((await w.q.purchaseOrders()).length, 1);
  // below the MOQ: refused with a reason, no order
  const low = await draftOrderFromCase({ commands: w.c, queries: w.q, actor: buyer, caseState: visitCase(), qty: 100, destinationLocationId: loc, expectedDate: '2026-12-01' });
  assert.equal(low.purchaseOrder, null); assert.equal(low.issues.at(-1).code, 'BELOW_MOQ');
  // the draft is only a draft: it cannot be ordered without the whole approval path
  await rejects(w.c.placeOrder(owner, key(), { poId: d.purchaseOrder.id, approval: undefined }), 'INVALID_TRANSITION');
});
