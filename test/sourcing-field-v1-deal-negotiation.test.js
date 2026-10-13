// Field V1 - DealIntelligence and NegotiationCoach: numbers come only from what was entered; a missing cost is a lower bound or UNKNOWN; a target exists only when it can be derived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, assess } from '../src/sourcing/core/case.js';
import { dealIntelligence, compareDeals, incotermEffect } from '../src/sourcing/core/field/deal.js';
import { negotiationPlan, NO_TARGET } from '../src/sourcing/core/field/negotiation.js';
import { tumbler, importAndConfirm, withDocs, costsEvent, NOW, EXT, PROFILE, t } from './sourcing-field-v1-fixtures.js';

const A = (c) => assess(c, { now: NOW, externals: EXT });
const deal = (c, profile = PROFILE) => dealIntelligence(c, A(c), { profile });
const offer = (c, text, h = 9) => importAndConfirm(c, { source: 'PASTED_QUOTE', text }, t(h));
const TIERS = 'TB-500. 500-999pcs USD3.60, 1000-1999pcs USD3.20, 2000+pcs USD2.90. MOQ 500pcs. FOB Ningbo. Lead time 25 days. T/T 30% deposit, 70% before shipment. Sample USD15.';

test('deal: quoted price, tiers, MOQ, landed per unit, maximum and target purchase price, margin, cash and sample cost - each with its status', () => {
  const d = deal(offer(tumbler('C', { qty: 1000 }), TIERS));
  assert.equal(d.quoted.status, 'SUPPLIER_CLAIM'); assert.equal(d.quoted.unitPrice, '3.20'); assert.equal(d.quoted.atQty, 1000); assert.equal(d.quoted.moq, 500); assert.equal(d.quoted.tiers.length, 3); assert.equal(d.quoted.incoterm, 'FOB');
  assert.equal(d.landed.status, 'COMPLETE'); assert.ok(d.landed.perUnitEurMinor > 0 && d.landed.isLowerBound === false);
  assert.equal(d.maxPurchasePrice.status, 'CALCULATED'); assert.ok(d.maxPurchasePrice.minor > 0);
  assert.equal(d.targetPurchasePrice.status, 'CONFIGURED_STEP'); assert.equal(d.targetPurchasePrice.minor, Math.round(d.maxPurchasePrice.minor * 0.85)); assert.match(d.targetPurchasePrice.basis, /15% below.*merchant setting/);
  assert.equal(d.margin.status, 'ESTIMATED'); assert.equal(d.margin.targetPct, 55); assert.equal(d.margin.minAcceptablePct, 55);
  assert.equal(d.cash.depositPct, 30); assert.equal(d.cash.depositEurMinor, Math.round(d.cash.goodsEurMinor * 0.3)); assert.equal(d.cash.sample.status, 'SUPPLIER_CLAIM'); assert.equal(d.cash.sample.amount, '15'); assert.equal(d.cash.sample.eurMinor, Math.round(1500 * 0.92));
  assert.equal(d.incotermEffect.incoterm, 'FOB'); assert.match(d.incotermEffect.text, /origin charges/);
  assert.deepEqual(d.unknown, []);
});

test('deal: tier breakpoints are priced with the real landed-cost functions; more volume lowers the unit cost and raises the cash needed', () => {
  const d = deal(offer(tumbler('C', { qty: 1000 }), TIERS)); assert.deepEqual(d.breakpoints.map((b) => b.minQty), [500, 1000, 2000]);
  const [b5, b10, b20] = d.breakpoints; assert.ok(b5.landedPerUnitEurMinor > b10.landedPerUnitEurMinor && b10.landedPerUnitEurMinor > b20.landedPerUnitEurMinor);
  assert.ok(b5.cashTotalEurMinor < b10.cashTotalEurMinor && b10.cashTotalEurMinor < b20.cashTotalEurMinor); assert.equal(b10.maxQty, 1999); assert.equal(b20.maxQty, null);
  assert.deepEqual(d.breakpoints.map((b) => b.withinMaxPrice), [false, true, true], 'the 500-piece tier (3.60) is above the maximum purchase price of this scenario (3.54)'); assert.ok(d.insights.some((x) => /lowers the landed cost per unit.*raises the cash needed/.test(x)));
});

test('deal: nothing is guessed - without a selling price there is no maximum, no target and no margin; without FX or freight the landed cost is UNKNOWN with the reason', () => {
  let c = offer(tumbler('C'), TIERS); c = dispatch(c, { type: 'SALE', sale: { sellingPriceGross: '', vatRatePct: 21 } }, t(10)); let d = deal(c);
  assert.equal(d.maxPurchasePrice.status, 'UNKNOWN'); assert.equal(d.targetPurchasePrice.status, 'UNKNOWN'); assert.equal(d.margin.status, 'UNKNOWN'); assert.ok(d.unknown.includes('maximum purchase price'));
  let n = offer(tumbler('N'), TIERS); n = dispatch(n, { type: 'COSTS', costs: { fx: null } }, t(10)); d = deal(n);
  assert.equal(d.landed.status, 'UNKNOWN'); assert.match(d.landed.reason, /fx/i); assert.equal(d.landed.perUnitEurMinor, null); assert.equal(d.cash.status, 'UNKNOWN'); assert.ok(d.unknown.includes('landed cost'));
  const bare = deal(tumbler('B')); assert.equal(bare.quoted.status, 'UNKNOWN'); assert.ok(bare.unknown.includes('unit price') && bare.unknown.includes('MOQ') && bare.unknown.includes('Incoterm'));
});

test('deal: a cost that is not entered makes the landed cost a LOWER BOUND, said out loud; a merchant without a target step has NO target (not a default)', () => {
  let c = offer(tumbler('C'), TIERS); c = dispatch(c, { type: 'COSTS', costs: { costs: { ...c.costs.costs, brokerage: undefined } } }, t(10)); const d = deal(c);
  assert.equal(d.landed.isLowerBound, true); assert.match(d.landed.display, /LOWER BOUND/); assert.ok(d.landed.unknownCostComponents.includes('brokerage')); assert.ok(d.insights.some((x) => /LOWER BOUND/.test(x)));
  const none = deal(offer(tumbler('C'), TIERS), null); assert.equal(none.targetPurchasePrice.status, 'NOT_CONFIGURED'); assert.equal(none.targetPurchasePrice.minor, null);
});

test('incoterm effect: what the price already covers, from the landed-cost engine\'s own table', () => {
  assert.deepEqual(incotermEffect('FOB').supplierCovers, ['origin charges (export clearance, loading)']);
  assert.deepEqual(incotermEffect('EXW').supplierCovers, []); assert.match(incotermEffect('EXW').text, /you pay origin charges/);
  assert.equal(incotermEffect('DDP').youPay.length, 0); assert.equal(incotermEffect(null).status, 'UNKNOWN'); assert.equal(incotermEffect('XYZ').status, 'UNKNOWN');
});

test('a lower EXW price can be a WORSE landed cost than a higher FOB offer, and the reason is spelled out', () => {
  const exw = offer(tumbler('EXW', { supplier: 'Cheap EXW', costs: { origin: 600 } }), 'TB-500. USD3.00 for 1000 pcs. MOQ 500. EXW Ningbo. Lead time 20 days.');
  const fob = offer(tumbler('FOB', { supplier: 'Dearer FOB' }), 'TB-500. USD3.20 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 20 days.');
  const dx = deal(exw); const df = deal(fob); assert.ok(dx.landed.perUnitEurMinor > df.landed.perUnitEurMinor, `${dx.landed.perUnitEurMinor} vs ${df.landed.perUnitEurMinor}`);
  const cmp = compareDeals([{ caseId: 'EXW', name: 'Cheap EXW', deal: dx }, { caseId: 'FOB', name: 'Dearer FOB', deal: df }]);
  assert.equal(cmp.cheapestQuote.caseId, 'EXW'); assert.equal(cmp.bestLanded.caseId, 'FOB'); assert.equal(cmp.inversion, true); assert.equal(cmp.provisional, false);
  assert.ok(cmp.reasons.some((r) => /lowest quote.*lowest landed/.test(r))); assert.ok(cmp.reasons.some((r) => /EXW excludes origin charges.*that FOB already includes/.test(r)));
});

test('compareDeals: different currencies are not compared price against price; unknown landed costs make the answer PROVISIONAL and are listed', () => {
  const usd = deal(offer(tumbler('U', { supplier: 'U' }), 'TB-500. USD3.20 for 1000 pcs. MOQ 500. FOB Ningbo.')); const eur = deal(offer(tumbler('E', { supplier: 'E' }), 'TB-500. EUR 2.90 for 1000 pcs. MOQ 500. FOB Ningbo.'));
  const cmp = compareDeals([{ caseId: 'U', name: 'U', deal: usd }, { caseId: 'E', name: 'E', deal: eur }]); assert.equal(cmp.cheapestQuote, null); assert.ok(cmp.reasons.some((r) => /different currencies/.test(r))); assert.ok(cmp.bestLanded);
  const bare = deal(tumbler('B')); const mix = compareDeals([{ caseId: 'U', name: 'U', deal: usd }, { caseId: 'B', name: 'B', deal: bare }]);
  assert.equal(mix.provisional, true); assert.ok(mix.notComparable.some((x) => x.caseId === 'B')); assert.ok(mix.reasons.some((r) => /PROVISIONAL/.test(r)));
});

// ---- negotiation ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const plan = (c, profile = PROFILE) => { const a = A(c); return negotiationPlan({ state: c, a, deal: dealIntelligence(c, a, { profile }), profile }); };
const dear = (c) => offer(c, 'TB-500. USD3.45 for 1000 pcs. MOQ 2000. EXW Ningbo. Lead time 25 days. Sample USD15.'); // above the opening target of this scenario

test('negotiation: the target and the walk-away come from the economics, never from thin air; the price lever shows the gap', () => {
  const c = dear(tumbler('C', { qty: 1000 })); const p = plan(c); const d = deal(c);
  assert.equal(p.status, 'READY'); assert.equal(p.walkAway.minor, d.maxPurchasePrice.minor); assert.equal(p.target.minor, d.targetPurchasePrice.minor); assert.equal(p.autonomous, false);
  const price = p.askNow.find((l) => l.dimension === 'PRICE'); assert.ok(price, JSON.stringify(p.askNow.map((l) => l.dimension)));
  assert.match(price.basis, /merchant setting|maximum purchase price/); assert.ok(/Ask for|do not accept/.test(price.ask));
  assert.match(p.noForecast, /does not predict/);
});

test('negotiation: with no maximum purchase price there is NO target - the plan says so, lists what is missing, and still asks the open basics', () => {
  let c = dear(tumbler('C')); c = dispatch(c, { type: 'SALE', sale: { sellingPriceGross: '', vatRatePct: 21, targetContributionPct: null } }, t(10)); const p = plan(c);
  assert.equal(p.status, NO_TARGET); assert.equal(p.target.status, NO_TARGET); assert.equal(p.walkAway.status, NO_TARGET); assert.ok(p.missingForTarget.some((m) => /selling price/.test(m)) && p.missingForTarget.some((m) => /target margin/.test(m)));
  assert.equal(p.target.minor, undefined); assert.ok(p.askNow.length > 0);
  const noStep = plan(dear(tumbler('C')), null); assert.equal(noStep.target.status, NO_TARGET); assert.equal(noStep.walkAway.status, 'COMPLETE' === noStep.walkAway.status ? 'COMPLETE' : noStep.walkAway.status); assert.ok(noStep.walkAway.minor > 0, 'the walk-away exists even without a configured opening step');
});

test('negotiation levers: EXW -> ask FOB; MOQ above the planned quantity; sample cost not refundable; documents before any deposit; nothing asked that is already answered', () => {
  const c = dear(tumbler('C', { qty: 1000 })); const p = plan(c); const dims = p.askNow.map((l) => l.dimension);
  assert.ok(dims.includes('INCOTERM')); assert.match(p.askNow.find((l) => l.dimension === 'INCOTERM').ask, /FOB price/);
  const moq = p.askNow.find((l) => l.dimension === 'MOQ'); assert.ok(moq); assert.deepEqual([moq.current, moq.desired], ['2000', '1000']);
  const smp = p.askNow.find((l) => l.dimension === 'SAMPLE_COST'); assert.match(smp.ask, /deducted from the first order/); assert.equal(smp.desired, 'refundable on the first order');
  assert.ok(dims.includes('DOCUMENTS'), 'food-contact documents are missing: no deposit before them');
  const refundable = offer(tumbler('R', { qty: 1000 }), 'TB-500. USD3.45 for 1000 pcs. MOQ 500. FOB Ningbo. Sample USD15, refundable. Packing: opp bag. OEM logo.'); const q2 = plan(refundable).askNow.map((l) => l.dimension);
  assert.ok(!q2.includes('SAMPLE_COST') && !q2.includes('PACKAGING') && !q2.includes('CUSTOMIZATION') && !q2.includes('INCOTERM') && !q2.includes('MOQ'));
});

test('negotiation: a lead time that moved between two offers is asked back to its earlier value; what to trade if the price is refused excludes price and documents', () => {
  let c = tumbler('C', { qty: 1000 }); c = offer(c, 'TB-500. USD3.45 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 15 days.', 9); c = offer(c, 'TB-500. USD3.45 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 22 days.', 11);
  const p = plan(c); const lt = p.askNow.find((l) => l.dimension === 'LEAD_TIME_HELD'); assert.ok(lt); assert.deepEqual([lt.current, lt.desired], ['22', '15']); assert.match(lt.basis, /offer 1 -> offer 2/);
  assert.ok(p.ifPriceRefused.length > 0 && p.ifPriceRefused.length <= 3); assert.ok(p.ifPriceRefused.every((x) => !['PRICE', 'DOCUMENTS'].includes(x.dimension)));
});

test('negotiation: a lever with a Chinese sentence carries it; one without says none exists - no Chinese is invented', () => {
  const p = plan(dear(tumbler('C'))); const withZh = p.askNow.filter((l) => l.zh); const without = p.askNow.filter((l) => !l.zh);
  assert.ok(without.length > 0 && without.every((l) => /No Chinese sentence exists/.test(l.zhNote))); assert.ok(withZh.every((l) => typeof l.zh === 'string' && l.zh.length > 0 && l.zhNote === null));
});

test('negotiation: without a usable price the plan is NO_TARGET and the first lever is to get a price', () => {
  const p = plan(tumbler('C')); assert.equal(p.status, NO_TARGET); assert.equal(p.askNow[0].dimension, 'PRICE'); assert.match(p.askNow[0].ask, /clear unit price/);
});
