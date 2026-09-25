import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountantPack, summaryLines } from '../src/finance/accountant-pack.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { refundCsvRows, refundRows } from '../src/finance/refund-rows.js';
import { changesSince, fingerprintOf } from '../src/finance/pack-comptable.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';

// SYNTHETIC data only: the shared metrics fixture with invented shipping figures.

function dataWithShipping() {
  const d = makeData();
  const by = (id) => d.orders.find((o) => o.id === id);
  Object.assign(by('o1'), { order_name: '#1001', channel_handle: 'web', shipping_price: 7, shipping_discount: 0, shipping_tax: 1.21, shipping_tax_rate_bp: 2100 });
  Object.assign(by('o2'), { order_name: '#1002', channel_handle: 'pos', shipping_price: 0, shipping_discount: 0, shipping_tax: 0, shipping_tax_rate_bp: null });
  Object.assign(by('o3'), { order_name: '#1003', channel_handle: 'web', shipping_price: 10, shipping_discount: 2, shipping_tax: 1.68, shipping_tax_rate_bp: 2100 });
  d.orderLines.forEach((l) => { l.tax_rate_bp = 2100; }); // every product line carries its source-reported rate
  d.refunds.forEach((r) => Object.assign(r, { shipping_subtotal: 4.13, shipping_tax: 0.87 })); // the fixture refund carries 5.00 of shipping (on o1)
  return d;
}
const PERIOD = { start: '2026-09-01', end: '2026-09-30' };
const pack = (d) => buildAccountantPack({ ledger: buildLedger(d, { config: CONFIG }), rawOrders: d.orders, docs: [], period: PERIOD, timeZone: 'UTC', now: new Date('2026-10-05T10:00:00Z'), config: CONFIG, today: '2026-10-05' });
const cents = (x) => Math.round(x * 100);

test('Pack: shipping is its own revenue line, added to the totals, product figures unchanged', () => {
  const withShip = pack(dataWithShipping()); const without = pack(makeData());
  for (const k of ['gross_sales', 'discounts', 'refunds', 'net_sales', 'vat', 'net_sales_ex_vat']) assert.equal(withShip.retail[k], without.retail[k], `product ${k} untouched`);
  const s = withShip.retail.shipping;
  assert.equal(s.charged_incl_tax, 16.68); assert.equal(s.net_ex_tax, 13.79); assert.equal(s.tax, 2.89);
  assert.equal(s.refunds_incl_tax, 5); assert.equal(s.refunds_ex_tax, 4.13); assert.equal(s.refunds_tax, 0.87);
  assert.equal(withShip.retail.total_net_sales, Math.round((withShip.retail.net_sales + 16.68 - 5) * 100) / 100);
  assert.equal(withShip.totals.sales_incl_vat_cents, cents(withShip.retail.total_net_sales));
  assert.equal(withShip.totals.vat_collected_cents, cents(withShip.retail.total_vat));
  assert.equal(withShip.totals.sales_ex_vat_cents, cents(withShip.retail.total_net_sales_ex_vat));
  // online carries the shipping, the POS order none
  assert.equal(withShip.retail.by_channel.pos.shipping_incl_vat_after_refunds, 0);
  assert.ok(withShip.retail.by_channel.online.shipping_incl_vat_after_refunds > 0);
});

test('Pack VAT: shipping VAT is taken from the reported tax line, by rate, and the breakdown reconciles with the total VAT', () => {
  const p = pack(dataWithShipping());
  assert.equal(p.retail.vat_by_rate.reconciles_with_total_vat, true);
  const vatByRate = Object.fromEntries(p.retail.vat_by_rate.by_rate.map((g) => [g.vatRateBp, g.vatCents]));
  const sumVat = p.retail.vat_by_rate.by_rate.reduce((a, g) => a + g.vatCents, 0);
  assert.equal(sumVat, cents(p.retail.total_vat), 'VAT by rate = product VAT + shipping VAT - refunded VAT');
  assert.ok(vatByRate[2100] > 0);
  // the shipping VAT alone: 1.21 + 1.68 - 0.87 = 2.02 more than the product-only breakdown
  const base = makeData(); base.orderLines.forEach((l) => { l.tax_rate_bp = 2100; });
  const productOnly = pack(base);
  const prod2100 = productOnly.retail.vat_by_rate.by_rate.find((g) => g.vatRateBp === 2100)?.vatCents ?? 0;
  assert.equal(vatByRate[2100] - prod2100, cents(1.21 + 1.68 - 0.87));
});

test('Pack VAT: several different shipping rates are never collapsed - the breakdown becomes PARTIAL', () => {
  const d = dataWithShipping();
  d.orders.find((o) => o.id === 'o3').shipping_tax_rate_bp = null; // mixed rates on that order's shipping (tax stays > 0)
  const p = pack(d);
  assert.equal(p.retail.vat_by_rate.status, 'PARTIAL');
  assert.ok(p.completeness.reasons.some((r) => r.startsWith('RETAIL_VAT_RATE_UNAVAILABLE')));
});

test('Pack: orders without captured shipping are reported, never treated as zero shipping', () => {
  const d = dataWithShipping();
  delete d.orders.find((o) => o.id === 'o3').shipping_price; d.orders.find((o) => o.id === 'o3').shipping_price = null;
  const p = pack(d);
  assert.equal(p.retail.shipping.orders_without_shipping_data, 1); assert.equal(p.retail.shipping.coverage, 'PARTIAL');
  assert.ok(p.completeness.reasons.includes('SHIPPING_NOT_CAPTURED_FOR_1_ORDERS'));
});

test('Pack summary lines: product, shipping and total figures are labelled apart and reconcile', () => {
  const lines = Object.fromEntries(summaryLines(pack(dataWithShipping())).map((l) => [l.line, Number(l.amount.replace(',', '.').replace(/\s/g, ''))]));
  assert.ok('Retail product refunds' in lines && 'Retail shipping charged incl. VAT' in lines && 'Retail refunds total (products + shipping + other)' in lines);
  assert.equal(Math.round((lines['Retail product refunds'] + lines['Retail shipping refunds incl. VAT']) * 100) / 100, lines['Retail refunds total (products + shipping + other)']);
  assert.equal(Math.round((lines['Retail product net sales incl. VAT'] + lines['Retail shipping charged incl. VAT'] - lines['Retail shipping refunds incl. VAT']) * 100) / 100, lines['Retail net sales incl. VAT']);
});

test('Refund file: product refund, shipping refund and total refund are separate columns, with the source order reference', () => {
  const d = dataWithShipping();
  d.refundLines = d.refundLines ?? [];
  const rows = refundRows(d, () => true);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.orderRef, '#1001', 'the source order reference is kept');
  assert.equal(r.amount, '25'); assert.equal(r.shippingAmount, '5'); assert.equal(r.shippingCaptured, true);
  assert.equal(Math.round((Number(r.productAmount) + Number(r.shippingAmount) + Number(r.otherAmount)) * 100) / 100, 25, 'product + shipping + other = total');
  const [csv] = refundCsvRows(rows);
  assert.deepEqual(Object.keys(csv), ['date', 'commande', 'remboursement_produits', 'remboursement_livraison', 'remboursement_autre', 'remboursement_total', 'livraison_renseignee']);
  assert.equal(csv.commande, '#1001'); assert.equal(csv.livraison_renseignee, 'oui');
  // shipping not captured on the refund: the shipping column is EMPTY (unknown), not 0, and the flag says so
  const legacy = makeData(); legacy.orders.find((o) => o.id === 'o1').order_name = '#1001';
  const [old] = refundCsvRows(refundRows(legacy, () => true));
  assert.equal(old.remboursement_livraison, ''); assert.equal(old.livraison_renseignee, 'non'); assert.equal(old.remboursement_total, '25');
});

test('version change detection notices a new Shopify sync that only changes shipping, VAT or a refund', () => {
  const build = (d) => { const p = pack(d); return fingerprintOf({ invoices: [], creditNotes: [], purchases: [], bank: { transactions: [] }, pack: p, refunds: refundRows(d, () => true) }); };
  const a = build(dataWithShipping());
  assert.equal(changesSince(a, build(dataWithShipping())), null, 'the same data is not a change');
  const moreShipping = dataWithShipping(); moreShipping.orders.find((o) => o.id === 'o2').shipping_price = 7; moreShipping.orders.find((o) => o.id === 'o2').shipping_tax = 1.21; moreShipping.orders.find((o) => o.id === 'o2').shipping_tax_rate_bp = 2100;
  assert.equal(changesSince(a, build(moreShipping)).retailChanged, true);
  const laterRefund = dataWithShipping(); laterRefund.refunds[0].amount = 30;
  assert.equal(changesSince(a, build(laterRefund)).retailChanged, true);
});
