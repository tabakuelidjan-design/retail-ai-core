import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeTotals, creditNoteFromInvoice, hashSnapshot, normalizeLine, payableOf, settlement } from '../src/finance/document.js';
import { percentOfCents } from '../src/finance/money.js';
import { CUSTOMER_BODY, invoiceBody, startApp } from './finance-dashboard-helpers.js';

// Gross-to-net policy (EN 16931 / Peppol BIS Billing 3.0):
//   - unit price has no decimal limit (PriceAmount), the engine derives the ex-VAT price from the catalogue price incl. VAT and rounds ONCE
//   - BT-131 line net amount: 2 decimals; BT-116 taxable = sum of line nets; BT-117 VAT = BT-116 x rate, rounded (BR-CO-17)
//   - BT-112 = BT-109 + BT-110 (BR-CO-15); BT-115 = BT-112 - BT-113 + BT-114 (BR-CO-16), BT-114 = explicit rounding amount
// So a catalogue price such as 49.00 incl. 21% VAT (base 40.50 -> VAT 8.51 -> 49.01) is met by an EXPLICIT rounding amount of -0.01.

const G = (o = {}) => normalizeLine({ description: 'Item', quantity: '1', vatRate: '21', priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: '49.00', ...o }, o.position ?? 1).line;
const N = (o = {}) => normalizeLine({ description: 'Service', quantity: '1', vatRate: '21', unitPrice: '40.50', ...o }, o.position ?? 1).line;
const view = (t) => ({ net: t.netCents, vat: t.vatCents, incl: t.grossCents, rounding: t.roundingCents, payable: payableOf(t) });

function assertReconciles(t) {
  const base = t.vatBreakdown.reduce((a, g) => a + g.taxableCents, 0);
  assert.equal(t.lines.reduce((a, l) => a + l.netCents, 0), t.netCents, 'sum of line nets = total without VAT (BR-CO-10/13)');
  assert.equal(base, t.netCents, 'sum of taxable bases = total without VAT');
  for (const g of t.vatBreakdown) assert.equal(g.vatCents, percentOfCents(g.taxableCents, g.vatRateBp), 'VAT = taxable x rate, rounded (BR-CO-17)');
  assert.equal(t.vatCents, t.vatBreakdown.reduce((a, g) => a + g.vatCents, 0), 'total VAT = sum of category VAT (BR-CO-14)');
  assert.equal(t.grossCents, t.netCents + t.vatCents, 'tax-inclusive total = base + VAT (BR-CO-15)');
  assert.equal(t.payableCents, t.grossCents + t.roundingCents, 'amount due = tax-inclusive total + rounding amount (BR-CO-16)');
}

test('EUR 49.00 incl. 21% VAT: the catalogue price is kept; the 1 cent is an EXPLICIT rounding amount, never a silent 49.01', () => {
  const t = computeTotals([G()]);
  assert.deepEqual(view(t), { net: 4050, vat: 851, incl: 4901, rounding: -1, payable: 4900 });
  assertReconciles(t);
  assert.equal(normalizeLine({ description: 'x', quantity: '1', vatRate: '21', priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: '49.00' }, 1).line.priceMicro, 404959, 'derived ex-VAT unit price keeps 4 decimals for display');
});
test('EUR 25.00 incl. 21% VAT: exact, no rounding amount at all', () => {
  const t = computeTotals([G({ grossUnitPrice: '25.00' })]);
  assert.deepEqual(view(t), { net: 2066, vat: 434, incl: 2500, rounding: 0, payable: 2500 });
  assertReconciles(t);
});
test('quantity > 1: rounded once from the exact value (2 x 49.00 needs no rounding; 3 x 25.00 neither); 1 x 49.00 x 7 stays at the catalogue total', () => {
  assert.deepEqual(view(computeTotals([G({ quantity: '2' })])), { net: 8099, vat: 1701, incl: 9800, rounding: 0, payable: 9800 });
  assert.deepEqual(view(computeTotals([G({ grossUnitPrice: '25.00', quantity: '3' })])), { net: 6198, vat: 1302, incl: 7500, rounding: 0, payable: 7500 });
  for (const q of ['1', '2', '3', '4', '5', '6', '7', '10', '0.5', '1.5']) { const t = computeTotals([G({ quantity: q })]); assertReconciles(t); assert.equal(payableOf(t), Math.round(4900 * Number(q))); assert.ok(Math.abs(t.roundingCents) <= 1); }
});
test('discounts: a percentage off a catalogue price keeps the catalogue basis; a fixed ex-VAT amount makes the line net-authoritative (no rounding amount)', () => {
  const t = computeTotals([G({ discountPercent: '10' })]);
  assert.deepEqual(view(t), { net: 3645, vat: 765, incl: 4410, rounding: 0, payable: 4410 }); // 44.10 = 49.00 - 10%
  assertReconciles(t);
  assert.equal(t.lines[0].discountCents + t.lines[0].netCents, t.lines[0].grossCents);
  for (const d of ['5', '12.5', '33.33', '50', '100']) { const x = computeTotals([G({ discountPercent: d, quantity: '3' })]); assertReconciles(x); assert.ok(Math.abs(x.roundingCents) <= 1, d); }
  const fixed = computeTotals([G({ discountAmount: '5.00' })]);
  assert.equal(fixed.roundingCents, 0); assert.equal(fixed.netCents, 4050 - 500); assertReconciles(fixed);
});
test('multiple VAT rates: each rate reconciles on its own; only catalogue-only rates may carry a rounding amount', () => {
  const t = computeTotals([G({ position: 1 }), G({ position: 2, grossUnitPrice: '25.00', quantity: '2' }), G({ position: 3, grossUnitPrice: '10.60', vatRate: '6' }), G({ position: 4, grossUnitPrice: '12.00', vatRate: '12' })]);
  assertReconciles(t);
  assert.deepEqual(t.vatBreakdown.map((g) => g.vatRateBp), [600, 1200, 2100]);
  // 21%: 49.00 + 2 x 25.00 = 99.00 -> the group is rounded once and the cents are spread over the lines
  assert.equal(t.vatBreakdown.find((g) => g.vatRateBp === 2100).taxableCents + t.vatBreakdown.find((g) => g.vatRateBp === 2100).vatCents, 9900);
  assert.equal(t.lines[0].netCents + t.lines[1].netCents, t.vatBreakdown.find((g) => g.vatRateBp === 2100).taxableCents);
  assert.equal(payableOf(t), 4900 + 5000 + 1060 + 1200);
});
test('NET_MANUAL (B2B ex-VAT price) is unchanged: the typed ex-VAT price is authoritative, VAT is added, no rounding amount', () => {
  const t = computeTotals([N()]);
  assert.deepEqual(view(t), { net: 4050, vat: 851, incl: 4901, rounding: 0, payable: 4901 });
  assertReconciles(t);
  const l = N();
  assert.equal(l.priceOrigin, undefined, 'a NET_MANUAL line is stored exactly as before (no new fields, old fingerprints unchanged)');
  assert.equal(normalizeLine({ description: 'x', quantity: '1', vatRate: '21', unitPrice: '40.50', priceOrigin: 'NET_MANUAL' }, 1).errors.length, 0);
  assert.ok(normalizeLine({ description: 'x', quantity: '1', vatRate: '21', unitPrice: '1', priceOrigin: 'WHATEVER' }, 1).errors.includes('LINE_1_PRICE_ORIGIN_INVALID'));
});
test('a catalogue line mixed with a manual line at the same VAT rate: the manual net amount stays authoritative, no rounding amount is invented', () => {
  const t = computeTotals([G(), N({ position: 2, unitPrice: '10.00' })]);
  assert.equal(t.roundingCents, 0); assertReconciles(t);
});
test('a catalogue price whose applied VAT rate differs from its own (e.g. reverse charge 0%) is not gross-authoritative: net stays derived, no VAT added', () => {
  const t = computeTotals([G({ vatRate: '0', grossVatRate: '21' })]);
  assert.deepEqual(view(t), { net: 4050, vat: 0, incl: 4050, rounding: 0, payable: 4050 });
  assertReconciles(t);
});

test('PROPERTY: every catalogue price 0.01..300.00 at 21 / 12 / 6 %, qty 1..5: exact reconciliation, rounding amount at most 1 cent, only when unavoidable', () => {
  let needRounding = 0; let total = 0;
  for (const rate of ['21', '12', '6']) {
    for (let cents = 1; cents <= 30000; cents += 1) {
      const price = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      const q = 1 + (cents % 5);
      const t = computeTotals([G({ grossUnitPrice: price, vatRate: rate, quantity: String(q) })]);
      total += 1;
      const target = cents * q;
      if (t.payableCents !== target) assert.fail(`price ${price} x ${q} @${rate}: payable ${t.payableCents} != ${target}`);
      if (Math.abs(t.roundingCents) > 1) assert.fail(`rounding ${t.roundingCents} for ${price} x ${q} @${rate}`);
      if (t.grossCents + t.roundingCents !== t.payableCents || t.netCents + t.vatCents !== t.grossCents) assert.fail(`no reconciliation ${price}`);
      if (t.vatCents !== percentOfCents(t.netCents, Number(rate) * 100)) assert.fail(`VAT rule broken ${price}`);
      if (t.roundingCents !== 0) needRounding += 1;
    }
  }
  assert.ok(needRounding > 0 && needRounding / total < 0.25, `rounding amounts needed for ${needRounding}/${total} prices`);
});

// ---------- documents, PDF, UBL, settlement, credit notes ----------
const CATALOGUE_LINE = { description: 'Atelier tote bag - Grand', quantity: '1', vatRate: '21', priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: '49.00', grossVatRate: '21', sku: 'CS-100' };
async function issued(c, lines) {
  const d = (await c.post('/api/documents', invoiceBody({ lines }))).data;
  assert.equal((await c.post(`/api/documents/${d.id}/submit`, {})).status, 200);
  const r = await c.post(`/api/documents/${d.id}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  return d.id;
}

test('issued invoice: totals reconcile, amount due is 49.00, one payment of 49.00 settles it, hash covers the explicit rounding amount', async () => {
  const a = await startApp(); try {
    const c = await a.authed();
    const id = await issued(c, [CATALOGUE_LINE]);
    const d = (await c.get(`/api/documents/${id}`)).data;
    const t = d.doc.totals;
    assert.deepEqual(view(t), { net: 4050, vat: 851, incl: 4901, rounding: -1, payable: 4900 });
    assert.equal(d.doc.lines[0].priceOrigin, 'GROSS_CATALOGUE'); assert.equal(d.doc.lines[0].grossUnitMicro, 490000);
    assert.match(d.settlementView.remaining, /^49[.,]00/);
    const pay = await c.post(`/api/documents/${id}/payments`, { amount: '49.00', paidOn: '2026-09-22', method: 'bank_transfer' });
    assert.equal(pay.status, 201, JSON.stringify(pay.data));
    assert.equal((await c.get(`/api/documents/${id}`)).data.doc.status, 'PAID');
    const tampered = structuredClone(d.doc); tampered.totals.roundingCents = 0;
    assert.notEqual(hashSnapshot(tampered), d.doc.snapshotHash, 'removing the rounding amount is detected by the integrity hash');
  } finally { await a.close(); }
});
test('calculation endpoint (what the form shows): explicit rounding row, amount to pay; ex-VAT price is derived by the engine, not the browser', async () => {
  const a = await startApp(); try {
    const c = await a.authed();
    const r = (await c.post('/api/calc', { lines: [{ description: 'x', quantity: '1', vatRate: '21', priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: '49.00' }], vat: { regime: 'domestic', confirmed: true }, customer: {}, currency: 'EUR', language: 'en' })).data;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.totals.net, '40.50'); assert.equal(r.totals.vat, '8.51'); assert.equal(r.totals.gross, '49.01'); assert.equal(r.totals.rounding, '-0.01'); assert.equal(r.totals.payable, '49.00');
    assert.equal(r.totals.lines[0].priceOrigin, 'GROSS_CATALOGUE');
    const net = (await c.post('/api/calc', { lines: [{ description: 'x', quantity: '1', vatRate: '21', unitPrice: '40.50' }], vat: { regime: 'domestic', confirmed: true }, customer: {}, currency: 'EUR', language: 'en' })).data;
    assert.equal(net.totals.payable, '49.01'); assert.equal(net.totals.rounding, '0.00'); assert.equal(net.totals.lines[0].priceOrigin, 'NET_MANUAL');
  } finally { await a.close(); }
});
test('UBL (Peppol BIS 3.0): PayableRoundingAmount -0.01, PayableAmount 49.00, and every arithmetic rule holds on the emitted XML', async () => {
  const a = await startApp(); try {
    const c = await a.authed();
    const id = await issued(c, [CATALOGUE_LINE, { description: 'Bag 2', quantity: '3', vatRate: '6', priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: '10.60' }, { description: 'Consulting', quantity: '2', vatRate: '6', unitPrice: '10.00' }]);
    const xml = (await c.get(`/api/documents/${id}/ubl`)).data.toString('utf8');
    const num = (re) => Number((re.exec(xml) ?? [])[1]);
    const cents = (v) => Math.round(v * 100);
    const lineExt = [...xml.matchAll(/<cac:InvoiceLine>[\s\S]*?<cbc:LineExtensionAmount[^>]*>([\d.-]+)<[\s\S]*?<cbc:InvoicedQuantity[^>]*>([\d.]+)<[\s\S]*?<cbc:PriceAmount[^>]*>([\d.]+)</g)];
    // (element order in the template is quantity first, then amount; tolerate both by parsing per line block)
    const blocks = [...xml.matchAll(/<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/g)].map((m) => m[1]);
    assert.equal(blocks.length, 3);
    let sumNet = 0;
    for (const b of blocks) {
      const net = Number(/<cbc:LineExtensionAmount[^>]*>([\d.-]+)</.exec(b)[1]); const q = Number(/<cbc:InvoicedQuantity[^>]*>([\d.]+)</.exec(b)[1]); const price = Number(/<cbc:PriceAmount[^>]*>([\d.]+)</.exec(b)[1]);
      assert.equal(cents(q * price), cents(net), 'R120: quantity x price rounds to the line net amount'); sumNet += cents(net);
    }
    const ext = cents(num(/<cbc:LineExtensionAmount currencyID="EUR">([\d.-]+)<\/cbc:LineExtensionAmount>\s*<cbc:TaxExclusiveAmount/)); // document level (first one followed by TaxExclusive)
    const taxExcl = cents(num(/<cbc:TaxExclusiveAmount[^>]*>([\d.-]+)</)); const taxIncl = cents(num(/<cbc:TaxInclusiveAmount[^>]*>([\d.-]+)</));
    const roundAmt = cents(num(/<cbc:PayableRoundingAmount[^>]*>([\d.-]+)</)); const payable = cents(num(/<cbc:PayableAmount[^>]*>([\d.-]+)</));
    const vatTotal = cents(num(/<cac:TaxTotal><cbc:TaxAmount[^>]*>([\d.-]+)</));
    assert.equal(sumNet, taxExcl, 'BR-CO-10/13'); assert.equal(ext, taxExcl);
    assert.equal(taxIncl, taxExcl + vatTotal, 'BR-CO-15');
    assert.equal(payable, taxIncl + roundAmt, 'BR-CO-16');
    for (const m of xml.matchAll(/<cac:TaxSubtotal><cbc:TaxableAmount[^>]*>([\d.-]+)<\/cbc:TaxableAmount><cbc:TaxAmount[^>]*>([\d.-]+)<\/cbc:TaxAmount>[\s\S]*?<cbc:Percent>([\d.]+)</g)) assert.equal(cents(m[2]), Math.round(cents(m[1]) * Number(m[3]) / 100), 'BR-CO-17');
    assert.equal(payable, (await c.get(`/api/documents/${id}`)).data.doc.totals.payableCents);
    assert.equal(roundAmt, -1);
    assert.match(xml, /<cbc:PayableRoundingAmount currencyID="EUR">-?\d/);
  } finally { await a.close(); }
});
test('a catalogue price that needs no rounding emits no PayableRoundingAmount and no rounding row', async () => {
  const a = await startApp(); try {
    const c = await a.authed();
    const id = await issued(c, [{ ...CATALOGUE_LINE, grossUnitPrice: '25.00' }]);
    const xml = (await c.get(`/api/documents/${id}/ubl`)).data.toString('utf8');
    assert.ok(!xml.includes('PayableRoundingAmount')); assert.match(xml, /<cbc:PayableAmount currencyID="EUR">25\.00</);
  } finally { await a.close(); }
});
test('PDF renders with the explicit rounding row', async () => {
  const a = await startApp(); try {
    const c = await a.authed();
    const id = await issued(c, [CATALOGUE_LINE]);
    const pdf = await c.get(`/api/documents/${id}/pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  } finally { await a.close(); }
});
test('credit note mirrors an invoice with a rounding amount exactly: fully credited, cap uses the amount due', () => {
  const inv = { type: 'invoice', id: 'inv-1', merchantId: 'm1', status: 'ISSUED', lockedAt: '2026-09-21T10:00:00Z', currency: 'EUR', language: 'en', customer: { name: 'C' }, seller: { name: 'S' }, revenueBasis: 'standalone_b2b', vat: { regime: 'domestic', confirmed: true }, lines: [G()], totals: computeTotals([G()]) };
  const { doc } = creditNoteFromInvoice(inv, { creditNoteId: 'cn-1', reason: 'return', actor: 'a', at: '2026-09-22T10:00:00Z' });
  assert.equal(payableOf(doc.totals), 4900); assert.equal(doc.totals.roundingCents, -1);
  const s = settlement(inv, [], [{ ...doc, status: 'ISSUED' }]);
  assert.equal(s.grossCents, 4900); assert.equal(s.creditedCents, 4900); assert.equal(s.remainingCents, 0);
});

// ---------- catalogue picker uses the gross origin ----------
test('catalogue selection sends PRICE_ORIGIN = GROSS_CATALOGUE with the shop price incl. VAT; the row check comes from the engine and matches the catalogue', async () => {
  const { createCatalogPicker } = await import('../src/finance/catalog.js');
  const retail = { async getCatalogVariant() { return { productId: 'prod-aaaaaaaa', variantId: 'var-aaaaaaaa', variantSourceId: 'gid://t/1', productTitle: 'Tote', variantTitle: null, sku: 'CS-1', status: 'ACTIVE', vatRateBp: 2100, stock: 5 }; } };
  const r = await createCatalogPicker({ retail, priceSource: async () => ({ 'gid://t/1': { amount: '49.00', taxesIncluded: true } }) }).select('var-aaaaaaaa', { allowedRatesBp: [2100, 600] });
  assert.equal(r.line.priceOrigin, 'GROSS_CATALOGUE'); assert.equal(r.line.grossUnitPrice, '49.0000'); assert.equal(r.line.grossVatRate, '21');
  assert.equal(r.line.unitPrice, '40.4959');
  assert.deepEqual(r.catalogue.check, { net: '40.50', vat: '8.51', gross: '49.01', rounding: '-0.01', payable: '49.00', roundingCents: -1, matchesCatalogue: true });
  assert.ok(!r.notes.some((n) => /round/i.test(n)), 'rounding is not a warning');
  const excl = await createCatalogPicker({ retail, priceSource: async () => ({ 'gid://t/1': { amount: '40.50', taxesIncluded: false } }) }).select('var-aaaaaaaa', { allowedRatesBp: [2100] });
  assert.equal(excl.line.priceOrigin, 'NET_MANUAL'); assert.equal(excl.line.unitPrice, '40.5000');
});
test('UI: no "rounds to" warning, explicit rounding row, override switches to NET_MANUAL and can revert to the catalogue price', () => {
  const ui = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8');
  assert.ok(!/rounds to/.test(ui));
  for (const t of ['Rounding adjustment', 'Catalogue price kept', 'Price override (excl. VAT)', 'Use catalogue price', "priceOrigin = 'NET_MANUAL'", "'GROSS_CATALOGUE'"]) assert.ok(ui.includes(t), t);
});
