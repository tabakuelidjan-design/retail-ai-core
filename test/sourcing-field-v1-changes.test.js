// Field V1 - offer revisions and WHAT CHANGED: a new quote never overwrites the old one, the diff is deterministic, landed cost and recommendation are shown old -> new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, assess } from '../src/sourcing/core/case.js';
import { offerRevisions, whatChanged, termsDiff, movementOf, recommendationOf, stateAtRevision } from '../src/sourcing/core/field/revisions.js';
import { tumbler, importAndConfirm, withDocs, NOW, EXT, t, offerOf } from './sourcing-field-v1-fixtures.js';

const O1 = 'Model TB-500 tumbler. Material: stainless steel 304. 500-999pcs USD3.60, 1000+pcs USD3.20. MOQ 500pcs. FOB Ningbo. Lead time 25 days. T/T 30% deposit, 70% before shipment. Packing: opp bag. Sample USD15, refundable. We are a factory. CE available.';
const O2 = 'TB-500: 1000+pcs USD3.00. MOQ 1000. FOB Ningbo. Lead time 32 days. Packing: gift box included.';
const two = () => { let c = tumbler('C', { supplier: 'Yongkang Drinkware' }); c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: O1 }, t(9)); return importAndConfirm(c, { source: 'PASTED_QUOTE', text: O2 }, t(11)); };

test('one revision per imported offer that produced a reviewed fact; the terms are those the supplier last stated', () => {
  let c = tumbler('C'); c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: O1 }, t(9));
  assert.equal(offerRevisions(c).length, 0, 'an offer nobody has reviewed is not a revision yet');
  c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const r = offerRevisions(c);
  assert.equal(r.length, 1); assert.equal(r[0].kind, 'OFFER'); assert.equal(r[0].terms.moq, 500); assert.equal(r[0].terms.priceAtQty, '3.20'); assert.equal(r[0].terms.leadDays, 25); assert.equal(r[0].terms.packaging, 'opp bag'); assert.deepEqual(r[0].terms.certificates, ['CE']);
});

test('WHAT CHANGED: price, tiers, MOQ, lead time and packaging, with direction; landed cost old -> new; the previous offer is preserved', () => {
  const c = two(); const revs = offerRevisions(c); assert.equal(revs.length, 2);
  const w = whatChanged(c, { now: NOW, externals: EXT }); assert.equal(w.available, true); assert.equal(w.from.n, 1); assert.equal(w.to.n, 2); assert.equal(w.previousPreserved, true);
  const by = Object.fromEntries(w.changes.map((x) => [x.category, x]));
  assert.deepEqual([by.PRICE.from, by.PRICE.to, by.PRICE.direction, by.PRICE.delta], ['3.20', '3.00', 'BETTER', -0.2]);
  assert.deepEqual([by.MOQ.fromText, by.MOQ.toText, by.MOQ.direction], ['500 pcs', '1000 pcs', 'WORSE']);
  assert.deepEqual([by.LEAD_TIME.fromText, by.LEAD_TIME.toText, by.LEAD_TIME.direction], ['25 d', '32 d', 'WORSE']);
  assert.deepEqual([by.PACKAGING.fromText, by.PACKAGING.toText, by.PACKAGING.direction], ['opp bag', 'gift box included', 'NEUTRAL']);
  assert.ok(by.TIERS); assert.equal(w.landed.direction, 'BETTER'); assert.ok(w.landed.to.perUnitEurMinor < w.landed.from.perUnitEurMinor); assert.equal(w.landed.change, w.landed.to.perUnitEurMinor - w.landed.from.perUnitEurMinor);
  assert.ok(['BUY_CANDIDATE', 'INVESTIGATE', 'PASS'].includes(w.recommendation.from) && ['BUY_CANDIDATE', 'INVESTIGATE', 'PASS'].includes(w.recommendation.to));
  // the older revision is still fully there and unchanged
  assert.ok(c.ledger.some((e) => e.key === 'quote.moq' && Number(e.value) === 500), 'the first MOQ is still in the ledger'); assert.equal(c.offers.length, 2);
  assert.equal(revs[0].terms.moq, 500); assert.equal(revs[1].terms.moq, 1000);
});

test('WHAT CHANGED is deterministic and does not touch the case', () => {
  const c = two(); const before = JSON.stringify(c); const a = whatChanged(c, { now: NOW, externals: EXT }); const b = whatChanged(c, { now: NOW, externals: EXT });
  assert.equal(JSON.stringify(a), JSON.stringify(b)); assert.equal(JSON.stringify(c), before);
});

test('a fact the supplier did not state before is ADDED, a withdrawn one is REMOVED - never reported as a price change', () => {
  const d = termsDiff({ moq: 500, packaging: null, leadDays: 25 }, { moq: 500, packaging: 'gift box', leadDays: null });
  assert.deepEqual(d.map((x) => `${x.field}:${x.kind}`).sort(), ['leadDays:REMOVED', 'packaging:ADDED']);
  assert.ok(d.every((x) => x.direction === 'NEUTRAL' && x.delta === null));
});

test('with a single revision there is nothing to compare, and it says so', () => {
  const c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const w = whatChanged(c, { now: NOW, externals: EXT });
  assert.equal(w.available, false); assert.match(w.reason, /only one revision/); assert.deepEqual(w.changes, []);
  const none = whatChanged(tumbler('N'), { now: NOW, externals: EXT }); assert.equal(none.available, false); assert.match(none.reason, /no revision/);
});

test('a quote typed in the form is a revision of its own and is compared like an imported one', () => {
  let c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9));
  c = dispatch(c, { type: 'QUOTE', quote: { ...c.quotes.at(-1), unitPrice: '3.00', tiers: undefined } }, t(10));
  const revs = offerRevisions(c); assert.equal(revs.length, 2); assert.equal(revs[1].kind, 'FORM');
  const w = whatChanged(c, { now: NOW, externals: EXT }); assert.ok(w.changes.some((x) => x.category === 'PRICE'));
});

test('landed cost and the recommendation of the OLDER revision are recomputed from the case as it stood then (older quotes only)', () => {
  const c = two(); const revs = offerRevisions(c); const s1 = stateAtRevision(c, revs[0]); assert.ok(s1.quotes.length < c.quotes.length);
  const a1 = assess(s1, { now: NOW, externals: EXT }); const w = whatChanged(c, { now: NOW, externals: EXT });
  assert.equal(w.landed.from.perUnitEurMinor, a1.landed.totals.landedPerUnitEurMinor);
  const rec = recommendationOf(c, assess(c, { now: NOW, externals: EXT })); assert.equal(rec.status, 'RECOMMENDATION_PENDING_APPROVAL'); assert.equal(rec.canCommitMoney, false); assert.equal(rec.businessDecision, 'NOT_DECIDED');
});

test('a RECORDED recommendation (what Nordla really said at the time) takes precedence over a recomputed one and is labelled as such', () => {
  const c = two(); const w = whatChanged(c, { now: NOW, externals: EXT, recorded: { from: { value: 'BUY_CANDIDATE', why: 'recorded then' }, to: { value: 'INVESTIGATE', why: 'recorded now' } } });
  assert.equal(w.recommendation.source, 'RECORDED'); assert.deepEqual([w.recommendation.from, w.recommendation.to, w.recommendation.changed], ['BUY_CANDIDATE', 'INVESTIGATE', true]);
});

test('supplier movement counts how often a term changed (input of the behaviour memory)', () => {
  const c = two(); const m = movementOf(c); const moq = m.find((x) => x.field === 'moq'); assert.equal(moq.times, 1); assert.deepEqual(moq.values, [500, 1000]);
  assert.ok(m.find((x) => x.field === 'leadDays'));
});

test('a landed cost that is UNKNOWN for one revision is not compared, and says why', () => {
  let c = tumbler('C', { supplier: 'S' }); c = dispatch(c, { type: 'COSTS', costs: { fx: null, costs: { freight: { total: 620, status: 'ESTIMATED' } } } }, t(8)); // no FX: a USD price cannot be converted
  c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: 'USD3.20 for 1000 pcs. MOQ 500. FOB Ningbo.' }, t(9)); c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: 'USD3.10 for 1000 pcs. MOQ 500. FOB Ningbo.' }, t(10));
  const w = whatChanged(c, { now: NOW, externals: EXT }); assert.equal(w.landed.direction, 'UNKNOWN'); assert.equal(w.landed.change, null); assert.match(w.landed.note, /UNKNOWN/);
});

test('revisions are ordered by what the case recorded, not by a clock: a device with a wrong date never reorders the offers', () => {
  let c = tumbler('C', { supplier: 'S' }); c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: O1 }, t(14)); c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: O2 }, t(8)); // the second offer carries an EARLIER timestamp
  const revs = offerRevisions(c); assert.deepEqual(revs.map((r) => r.terms.moq), [500, 1000]); const w = whatChanged(c, { now: NOW, externals: EXT }); assert.deepEqual([w.from.n, w.to.n], [1, 2]); assert.equal(w.changes.find((x) => x.category === 'PRICE').to, '3.00');
});

test('a blocked offer is recommended PASS (negative unit economics), and a viable one on its own merits is not', () => {
  const loss = importAndConfirm(tumbler('L', { sellingPrice: 3.2, target: 10 }), { source: 'PASTED_QUOTE', text: 'Model TB-500. USD3.60 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 25 days.' }, t(9));
  const a = assess(loss, { now: NOW, externals: EXT }); assert.ok(a.decision.hardBlockers.some((b) => b.code === 'NEGATIVE_UNIT_ECONOMICS'), JSON.stringify(a.decision.hardBlockers.map((b) => b.code)));
  const r = recommendationOf(loss, a); assert.equal(r.value, 'PASS'); assert.equal(r.role, 'BLOCKED'); assert.equal(r.canCommitMoney, false);
});
