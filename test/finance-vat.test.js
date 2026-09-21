import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildAccountantPack } from '../src/finance/accountant-pack.js';
import { loadDocsForReports, writePackFiles } from '../src/finance/reports.js';
import { lineTaxRateBp, normalizeOrderLine } from '../src/sync/normalize.js';
import { AGENT_ACTOR, CUSTOMER, MERCHANT, MERCHANT_ACTOR, issueInvoice, makeService } from './finance-fixtures.js';
import { makeMarketingData } from './fixtures/marketing-sample.js';

const RETAIL_CFG = mergeConfig({});
const period = { start: '2026-09-10', end: '2026-09-30' };

function dataWith(rates) {
  const data = makeMarketingData();
  data.orderLines = data.orderLines.map((l) => ({ ...l, tax_rate_bp: rates[l.id] === undefined ? 2100 : rates[l.id] }));
  return data;
}
function packFor(data, docs = [], over = {}) {
  const ledger = buildLedger(data, { config: RETAIL_CFG });
  return { ledger, pack: buildAccountantPack({ ledger, rawOrders: data.orders, docs, period, timeZone: 'UTC', now: new Date('2026-10-05T08:00:00Z'), config: RETAIL_CFG, today: '2026-10-05', ...over }) };
}
const cents = (x) => Math.round(x * 100);

test('rate capture: the source rate is stored per line; no tax lines = 0; several taxes or a missing rate = unavailable, never guessed', () => {
  assert.equal(lineTaxRateBp([{ rate: 0.21, priceSet: {} }]), 2100);
  assert.equal(lineTaxRateBp([{ rate: 0.06 }]), 600);
  assert.equal(lineTaxRateBp([]), 0);
  assert.equal(lineTaxRateBp(undefined), 0);
  assert.equal(lineTaxRateBp([{ rate: 0.21 }, { rate: 0.21 }]), null);
  assert.equal(lineTaxRateBp([{ rate: 0.05 }, { rate: 0.07 }]), null);
  assert.equal(lineTaxRateBp([{ priceSet: {} }]), null);
  const line = normalizeOrderLine({ id: 'l', title: 't', sku: null, quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '10' } }, discountAllocations: [], taxLines: [{ rate: 0.21, priceSet: { shopMoney: { amount: '1.74' } } }] }, 'o', null);
  assert.equal(line.tax_rate_bp, 2100);
  assert.equal(line.tax_amount, 1.74);
});

test('the ledger carries the rate without changing any Phase 2A number', () => {
  const withRates = buildLedger(dataWith({}), { config: RETAIL_CFG });
  const without = buildLedger(makeMarketingData(), { config: RETAIL_CFG });
  assert.equal(withRates.lineFacts[0].taxRateBp, 2100);
  assert.equal(without.lineFacts[0].taxRateBp, null);
  assert.deepEqual(withRates.lineFacts.map(({ taxRateBp, ...rest }) => rest), without.lineFacts.map(({ taxRateBp, ...rest }) => rest)); // identical apart from the added field
});

test('VAT by rate: every line has a reported rate -> COMPLETE, reconciles with the Phase 2A VAT total', () => {
  const { pack } = packFor(dataWith({}));
  const v = pack.retail.vat_by_rate;
  assert.equal(v.status, 'COMPLETE');
  assert.equal(v.unavailable, null);
  assert.deepEqual(v.by_rate.map((g) => g.vatRateBp), [2100]);
  assert.equal(v.reconciles_with_total_vat, true);
  assert.equal(v.by_rate[0].vatCents, cents(pack.retail.vat));
  assert.equal(v.by_rate[0].taxableCents, cents(pack.retail.net_sales_ex_vat));
  assert.equal(pack.completeness.reasons.some((r) => r.startsWith('RETAIL_VAT_RATE')), false);
});

test('VAT by rate: several rates split exactly, refunds reduce the rate they were charged at', () => {
  // l5 (order o5, 10.00 incl.) is a 6% line; l2 (o2, refunded in full) stays 21%
  const data = dataWith({ l5: 600 });
  data.orderLines = data.orderLines.map((l) => (l.id === 'l5' ? { ...l, tax_amount: 0.57 } : l));
  const { pack } = packFor(data, [], { period: { start: '2026-09-01', end: '2026-09-30' } });
  const v = pack.retail.vat_by_rate;
  assert.deepEqual(v.by_rate.map((g) => g.vatRateBp), [600, 2100]);
  assert.equal(v.by_rate[0].taxableCents, 943); // 10.00 - 0.57
  assert.equal(v.by_rate[0].vatCents, 57);
  assert.equal(v.status, 'COMPLETE');
  assert.equal(v.by_rate.reduce((a, g) => a + g.vatCents, 0), cents(pack.retail.vat));
  assert.equal(v.reconciles_with_total_vat, true);
});

test('VAT by rate: lines without a captured rate are UNAVAILABLE and make the pack PARTIAL; they are never spread across rates', () => {
  const { pack } = packFor(dataWith({ l4: null, l8: null }));
  const v = pack.retail.vat_by_rate;
  assert.equal(v.status, 'PARTIAL');
  assert.equal(v.unavailable.lines, 2);
  assert.ok(v.unavailable.taxableCents > 0);
  assert.equal(v.reconciles_with_total_vat, true); // known + unavailable still add up to the Phase 2A total
  assert.ok(pack.completeness.reasons.includes('RETAIL_VAT_RATE_UNAVAILABLE_FOR_2_LINES'));
  assert.equal(pack.completeness.status, 'PARTIAL');
  assert.deepEqual(pack.vat_summary.combined_by_rate.map((g) => g.vatRateBp), [2100]);
  assert.equal(pack.vat_summary.retail_unclassified.lines, 2);
  const all = packFor(makeMarketingData()).pack.retail.vat_by_rate; // nothing captured at all (older sync)
  assert.equal(all.status, 'PARTIAL');
  assert.deepEqual(all.by_rate, []);
});

test('B2B VAT: by rate and by treatment, with exempt / reverse-charge amounts shown separately', async () => {
  const { svc, store } = makeService();
  await issueInvoice(svc, { issueDate: '2026-09-20' }); // domestic: 21% and 6%
  await issueInvoice(svc, {
    issueDate: '2026-09-21', vat: { regime: 'reverse_charge', confirmed: true, mention: 'Reverse charge - VAT due by the customer' },
    lines: [{ description: 'Service', quantity: '1', unitPrice: '100.00', vatRate: '0' }],
  });
  await issueInvoice(svc, {
    issueDate: '2026-09-22', customer: { ...CUSTOMER, vatNumber: 'FR12345678901', enterpriseNumber: null, address: { street: 'Rue X', postalCode: '75001', city: 'Paris', countryCode: 'FR' } },
    vat: { regime: 'intra_eu_b2b_exempt', confirmed: true, mention: 'Intra-Community supply' }, lines: [{ description: 'Goods', quantity: '2', unitPrice: '25.00', vatRate: '0' }],
  });
  const { pack } = packFor(dataWith({}), await loadDocsForReports(store, MERCHANT));
  const b = pack.vat_summary.b2b;
  assert.deepEqual(b.by_treatment.map((t) => [t.regime, t.taxableCents, t.vatCents, t.exemptOrReverseCharge]).sort(), [['domestic', 6500, 690, false], ['intra_eu_b2b_exempt', 5000, 0, true], ['reverse_charge', 10000, 0, true]].sort());
  assert.equal(b.exempt_or_reverse_charge_base_cents, 15000);
  assert.deepEqual(b.by_rate.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents]), [[0, 15000, 0], [600, 4500, 270], [2100, 2000, 420]]);
  assert.ok(b.by_treatment.find((t) => t.regime === 'reverse_charge').legalMentions.includes('Reverse charge - VAT due by the customer'));
  const c = pack.vat_summary.combined_by_rate.map((g) => g.vatRateBp);
  assert.deepEqual(c, [0, 600, 2100]);
  assert.equal(pack.totals.vat_collected_cents, cents(pack.retail.vat) + 690); // exempt supplies add no VAT
});

test('VAT files: a by-rate CSV is exported with retail, B2B and combined rows and the availability status', async () => {
  const { pack } = packFor(dataWith({ l4: null }));
  const dir = mkdtempSync(join(tmpdir(), 'finvat-'));
  const files = await writePackFiles(pack, dir);
  const csv = readFileSync(join(dir, files.find((f) => f.endsWith('_vat_by_rate.csv'))), 'utf8');
  assert.match(csv, /source,treatment,rate_percent,taxable_base,vat,status/);
  assert.ok(csv.includes('rate not captured'));
  assert.ok(csv.includes('combined (known rates only)'));
  assert.ok(csv.includes('UNAVAILABLE'));
});
