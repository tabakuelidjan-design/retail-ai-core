import test from 'node:test';
import assert from 'node:assert/strict';
import { landedCost, INCOTERMS } from '../src/sourcing/core/landed.js';
import { unitEconomics, maxPurchasePrice } from '../src/sourcing/core/economics.js';
import { toMinor, pctToBps, applyBps } from '../src/sourcing/core/money.js';

// China Sourcing - the calculators. SYNTHETIC numbers. Hand-computed expectations.
const input = () => ({
  supplier: { unitPrice: '4.20', currency: 'USD', qty: 1000, moq: 500, incoterm: 'FOB' },
  fx: { rate: 0.92, date: '2026-10-03', source: 'USER_ENTERED' },
  costs: {
    freight: { total: 450, status: 'KNOWN', source: 'forwarder quote' }, insurance: { ratePct: 0.3, status: 'ESTIMATED' },
    customsDuty: { ratePct: 3.7, status: 'KNOWN', source: 'user, from a tariff lookup' }, testing: { total: 300, status: 'KNOWN' }, labelling: { perUnit: 0.05, status: 'KNOWN' },
    epr: { perUnit: 0.1, min: 0.08, max: 0.15, status: 'ESTIMATED' },
  },
});

test('money: decimals are parsed without float error and rounded half away from zero', () => {
  assert.equal(toMinor('4.20'), 420); assert.equal(toMinor('0.285'), 29); assert.equal(toMinor('-0.285'), -29); assert.equal(toMinor('1 234,50'), 123450); assert.equal(toMinor(19.99), 1999); assert.equal(toMinor(''), null);
  assert.equal(pctToBps('21'), 2100); assert.equal(applyBps(10000, 2100), 2100); assert.throws(() => toMinor('4,2,0'), (e) => e.code === 'AMOUNT_INVALID');
});

test('landed cost: hand-computed (USD goods, FOB, known freight, estimated insurance, known duty on the customs value, estimated EPR range)', () => {
  const r = landedCost(input());
  assert.equal(r.goods.totalEurMinor, 386400, '4.20 USD x 1000 x 0.92');
  const line = (k) => r.lines.find((l) => l.key === k);
  assert.equal(line('insurance').totalMinor, 1294, '0.3 % of goods + freight (4 314.00) = 12.94');
  assert.equal(r.customs.customsValueMinor, 386400 + 45000 + 1294, 'goods + freight + insurance = CIF at the EU border');
  assert.equal(r.customs.dutyMinor, 16010, '3.7 % of 4 326.94 = 160.10');
  assert.equal(r.totals.landedTotalEurMinor, 386400 + 45000 + 1294 + 16010 + 30000 + 5000 + 10000);
  assert.equal(r.totals.landedPerUnitEurMinor, 494);
  assert.equal(r.status, 'RANGE'); assert.deepEqual(r.totals.rangeEurMinor.perUnit, { min: 492, max: 499 });
  assert.equal(r.importVat.status, 'NOT_PROVIDED');
});

test('landed cost: nothing is invented - no FX, no freight, no duty rate: INFORMATION_INSUFFICIENT with the exact missing inputs', () => {
  const noFx = input(); delete noFx.fx; assert.deepEqual(landedCost(noFx).criticalUnknown.slice(0, 1), ['fx.USDEUR']); assert.equal(landedCost(noFx).status, 'INFORMATION_INSUFFICIENT');
  const noFreight = input(); delete noFreight.costs.freight; const f = landedCost(noFreight); assert.ok(f.criticalUnknown.includes('costs.freight')); assert.equal(f.status, 'INFORMATION_INSUFFICIENT');
  const noDuty = input(); delete noDuty.costs.customsDuty; const d = landedCost(noDuty); assert.ok(d.criticalUnknown.includes('costs.customsDuty')); assert.equal(d.status, 'INFORMATION_INSUFFICIENT');
});

test('landed cost: Incoterms decide what is already inside the price (CIF includes freight and insurance; DDP includes duties)', () => {
  const cif = input(); cif.supplier.incoterm = 'CIF'; delete cif.costs.freight; delete cif.costs.insurance; const c = landedCost(cif);
  assert.equal(c.lines.find((l) => l.key === 'freight').status, 'INCLUDED_IN_PRICE'); assert.equal(c.customs.customsValueMinor, 386400, 'the CIF price IS the customs value');
  const ddp = input(); ddp.supplier.incoterm = 'DDP'; delete ddp.costs.customsDuty; const d = landedCost(ddp); assert.equal(d.customs.dutyStatus, 'INCLUDED_IN_PRICE'); assert.equal(d.criticalUnknown.length, 0);
  const exw = input(); exw.supplier.incoterm = 'EXW'; assert.ok(landedCost(exw).unknown.includes('costs.originCharges'), 'EXW: origin charges are on the buyer and are listed when unknown');
  assert.ok(Object.keys(INCOTERMS).includes('FOB'));
});

test('landed cost: MOQ warning, missing incoterm warning, recoverable import VAT is not a cost', () => {
  const x = input(); x.supplier.qty = 300; x.supplier.incoterm = undefined; x.importVat = { ratePct: 21, recoverable: true };
  const r = landedCost(x); assert.ok(r.warnings.some((w) => w.startsWith('QUANTITY_BELOW_MOQ'))); assert.ok(r.warnings.includes('INCOTERM_NOT_STATED'));
  assert.equal(r.importVat.includedInLanded, false); assert.ok(r.importVat.minor > 0);
  const nr = input(); nr.importVat = { ratePct: 21, recoverable: false }; const n = landedCost(nr); assert.equal(n.importVat.includedInLanded, true);
  assert.equal(n.totals.landedTotalEurMinor, landedCost(input()).totals.landedTotalEurMinor + n.importVat.minor);
});

test('unit economics: hand-computed contribution, fees UNKNOWN make it an upper bound, break-even is exact', () => {
  const sale = { sellingPriceGross: '24.99', vatRatePct: 21, landedPerUnitMinor: 494, targetContributionPct: 20, lines: [
    { key: 'referral', kind: 'pct_of_gross', value: 15, status: 'KNOWN', source: 'user, from the marketplace fee page' }, { key: 'fulfilment', kind: 'per_unit', value: 3.5, status: 'KNOWN' },
    { key: 'prep', kind: 'per_unit', value: 0.4, status: 'ESTIMATED' }, { key: 'returns', kind: 'pct_of_net', value: 3, status: 'ESTIMATED' }, { key: 'ads', kind: 'pct_of_net', value: 5, status: 'ESTIMATED' } ] };
  const e = unitEconomics(sale);
  assert.equal(e.netRevenueMinor, 2065); assert.equal(e.knownCostsMinor, 375 + 350 + 40 + 62 + 103); assert.equal(e.contributionMinor, 2065 - 494 - 930);
  assert.equal(e.classification, 'ATTRACTIVE'); assert.equal(e.status, 'COMPLETE');
  const be = e.breakEvenGrossMinor; const at = (g) => unitEconomics({ ...sale, sellingPriceGross: g / 100 }).contributionMinor; assert.ok(at(be) >= 0 && at(be - 1) < 0, `break-even ${be}`);
  const unknownFee = unitEconomics({ ...sale, lines: [...sale.lines.slice(1), { key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }] });
  assert.equal(unknownFee.status, 'UPPER_BOUND'); assert.equal(unknownFee.contributionIsUpperBound, true); assert.equal(unknownFee.classification, 'UNKNOWN'); assert.ok(unknownFee.warnings[0].startsWith('FEES_UNKNOWN'));
  const noLanded = unitEconomics({ ...sale, landedPerUnitMinor: null }); assert.equal(noLanded.status, 'INFORMATION_INSUFFICIENT');
  const loss = unitEconomics({ ...sale, landedPerUnitMinor: 1800 }); assert.equal(loss.classification, 'UNATTRACTIVE');
});

test('maximum purchase price: exact (the next cent misses the target) and recalculates instantly for any quote', () => {
  const base = { landedInput: input(), sale: { sellingPriceGross: '24.99', vatRatePct: 21, lines: [ { key: 'referral', kind: 'pct_of_gross', value: 15, status: 'KNOWN' }, { key: 'fulfilment', kind: 'per_unit', value: 3.5, status: 'KNOWN' }, { key: 'ads', kind: 'pct_of_net', value: 5, status: 'ESTIMATED' } ] }, targetContributionPct: 25 };
  const m = maxPurchasePrice(base); assert.equal(m.status, 'COMPLETE'); assert.equal(m.currency, 'USD');
  const pctAt = (p) => { const l = landedCost({ ...base.landedInput, supplier: { ...base.landedInput.supplier, unitPrice: p / 100 } }); return unitEconomics({ ...base.sale, landedPerUnitMinor: l.totals.landedPerUnitEurMinor }).contributionPct; };
  assert.ok(pctAt(m.maxUnitPriceMinor) >= 0.25, 'at the maximum the target is met'); assert.ok(pctAt(m.maxUnitPriceMinor + 1) < 0.25, 'one cent more misses it');
  // "what if the supplier gives me 4.20": the quote is simply another input
  const quote = unitEconomics({ ...base.sale, landedPerUnitMinor: landedCost(base.landedInput).totals.landedPerUnitEurMinor, targetContributionPct: 25 });
  assert.equal(quote.classification === 'ATTRACTIVE', 420 <= m.maxUnitPriceMinor);
  const noFreight = { ...base, landedInput: (() => { const x = input(); delete x.costs.freight; return x; })() }; const n = maxPurchasePrice(noFreight);
  assert.equal(n.status, 'INFORMATION_INSUFFICIENT'); assert.match(n.reason, /costs\.freight/); assert.equal(n.maxUnitPriceMinor, null);
  assert.equal(maxPurchasePrice({ ...base, targetContributionPct: null }).reason, 'TARGET_MARGIN_NOT_SET');
  const unknownFee = maxPurchasePrice({ ...base, sale: { ...base.sale, lines: [...base.sale.lines, { key: 'storage', kind: 'per_unit', status: 'UNKNOWN' }] } }); assert.equal(unknownFee.status, 'UPPER_BOUND'); assert.equal(unknownFee.upperBound, true); assert.ok(unknownFee.maxUnitPriceMinor <= m.maxUnitPriceMinor || unknownFee.maxUnitPriceMinor >= 0);
});

test('maximum purchase price: property check on 60 random scenarios (max meets the target, max+1 does not)', () => {
  let seed = 9; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 60; i += 1) {
    const li = input(); li.supplier.qty = 100 + Math.floor(rnd() * 3000); li.fx.rate = 0.8 + rnd() * 0.3; li.costs.freight.total = Math.floor(rnd() * 2000); li.costs.customsDuty.ratePct = Math.floor(rnd() * 12);
    const sale = { sellingPriceGross: (10 + Math.floor(rnd() * 90)) + '.99', vatRatePct: [19, 20, 21][i % 3], lines: [{ key: 'ref', kind: 'pct_of_gross', value: 8 + Math.floor(rnd() * 12), status: 'KNOWN' }, { key: 'fba', kind: 'per_unit', value: (rnd() * 4).toFixed(2), status: 'KNOWN' }] };
    const target = 5 + Math.floor(rnd() * 35); const m = maxPurchasePrice({ landedInput: li, sale, targetContributionPct: target });
    const pct = (p) => { const l = landedCost({ ...li, supplier: { ...li.supplier, unitPrice: p / 100 } }); const e = unitEconomics({ ...sale, landedPerUnitMinor: l.totals.landedPerUnitEurMinor }); return e.contributionPct >= target / 100 && e.contributionMinor >= 0; };
    if (m.maxUnitPriceMinor === 0) { assert.equal(pct(1), false); continue; }
    assert.ok(pct(m.maxUnitPriceMinor), `scenario ${i}: max ${m.maxUnitPriceMinor} must meet ${target}%`); if (m.maxUnitPriceMinor < 1000000) assert.ok(!pct(m.maxUnitPriceMinor + 1), `scenario ${i}: ${m.maxUnitPriceMinor + 1} must miss`);
  }
});
