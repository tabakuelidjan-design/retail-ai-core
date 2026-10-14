// Field V1 - dependency-aware derived state: a change recomputes only what depends on it; the incremental result is ALWAYS identical to a recompute from scratch; the old result is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { compareCases } from '../src/sourcing/core/comparison.js';
import { createDerivedCache, refreshDerived, cachedAssessFn, NODE_NAMES, HISTORY_MAX, NODES } from '../src/sourcing/core/field/derived.js';
import { tumbler, importAndConfirm, withDocs, docsFor, NOW, EXT, PROFILE, t } from './sourcing-field-v1-fixtures.js';

const opts = { now: NOW, externals: EXT, profile: PROFILE };
const O1 = 'Model TB-500. Material: stainless steel 304. USD3.40 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 25 days. T/T 30% deposit. Packing: opp bag. CE available.';
const O2 = 'Model TB-500. Material: stainless steel 304. USD3.20 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 25 days. T/T 30% deposit. Packing: opp bag. CE available.';

test('first refresh computes everything; an identical second refresh recomputes nothing', () => {
  const c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const cache = createDerivedCache();
  const r1 = refreshDerived(c, cache, opts); assert.deepEqual(r1.recomputed, [...NODE_NAMES]); assert.deepEqual(r1.reused, []);
  const r2 = refreshDerived(c, cache, opts); assert.deepEqual(r2.recomputed, []); assert.deepEqual(r2.reused, [...NODE_NAMES]);
});

test('a new price recomputes the economics side (deal, fit, truth card, negotiation, evidence...) and leaves the question list and the compliance-driven parts alone', () => {
  let c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const cache = createDerivedCache(); refreshDerived(c, cache, opts);
  c = dispatch(c, { type: 'QUOTE', quote: { ...c.quotes.at(-1), unitPrice: '3.10', tiers: undefined } }, t(10)); const r = refreshDerived(c, cache, opts);
  assert.ok(r.recomputed.includes('assessment') && r.recomputed.includes('deal') && r.recomputed.includes('negotiation'), r.recomputed.join(','));
  assert.ok(r.reused.includes('askNow'), `the ask list does not depend on the price value: ${r.recomputed}`);
});

test('a new supplier price through a revised offer: the ask list is reused when the questions did not change', () => {
  let c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const cache = createDerivedCache(); refreshDerived(c, cache, opts);
  c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: O2 }, t(11)); const r = refreshDerived(c, cache, opts);
  assert.ok(r.recomputed.includes('deal') && r.recomputed.includes('whatChanged') && r.recomputed.includes('memory')); assert.ok(r.reused.includes('askNow'), r.recomputed.join(','));
});

test('a new certificate / document recomputes the compliance-driven parts and leaves the deal alone', () => {
  let c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const cache = createDerivedCache(); refreshDerived(c, cache, opts);
  c = withDocs(c, 'TB-500', t(10)); const r = refreshDerived(c, cache, opts);
  assert.ok(r.recomputed.includes('assessment') && r.recomputed.includes('truthCard') && r.recomputed.includes('evidenceStatus') && r.recomputed.includes('recommendation'), r.recomputed.join(','));
  assert.ok(r.reused.includes('deal'), `a certificate does not change the money: ${r.recomputed}`); assert.ok(r.reused.includes('whatChanged'));
});

test('selling price / margin edits recompute the money; a note recomputes almost nothing', () => {
  let c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const cache = createDerivedCache(); refreshDerived(c, cache, opts);
  c = dispatch(c, { type: 'NOTE', text: 'met the owner, friendly' }, t(10)); let r = refreshDerived(c, cache, opts); assert.ok(r.reused.includes('deal') && r.reused.includes('truthCard') && r.reused.includes('askNow') && r.reused.includes('negotiation'), r.recomputed.join(','));
  c = dispatch(c, { type: 'SALE', sale: { ...c.sale, sellingPriceGross: 22.9 } }, t(11)); r = refreshDerived(c, cache, opts); assert.ok(r.recomputed.includes('deal') && r.recomputed.includes('merchantFit'));
});

test('SAFETY NET: after every event of a long sequence the incremental result equals a recompute from scratch', () => {
  let c = tumbler('C', { supplier: 'Yongkang' }); const cache = createDerivedCache(); const fresh = () => { const f = createDerivedCache(); return refreshDerived(c, f, { ...opts, force: true }).results; };
  const check = (label) => { const inc = refreshDerived(c, cache, opts).results; const ref = fresh(); for (const n of NODE_NAMES) assert.equal(JSON.stringify(inc[n]), JSON.stringify(ref[n]), `${label}: node ${n} differs from a full recompute`); };
  check('start');
  const steps = [
    ['import', () => dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: O1 }, t(9))],
    ...Array.from({ length: 6 }, (_, i) => [`confirm ${i}`, () => { const p = c.candidates.find((x) => x.state === 'PROPOSED' && !x.needsCorrection); return p ? dispatch(c, { type: 'CANDIDATE_CONFIRM', id: p.id }, t(9, i + 1)) : c; }]),
    ['sale', () => dispatch(c, { type: 'SALE', sale: { ...c.sale, sellingPriceGross: 24.5, targetContributionPct: 50 } }, t(9, 59))],
    ['costs', () => dispatch(c, { type: 'COSTS', costs: { ...c.costs, costs: { ...c.costs.costs, freight: { total: 700, status: 'ESTIMATED' } } } }, t(10))],
    ['revision', () => dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'TB-500. Material: aluminium alloy. USD3.00 for 1000 pcs. MOQ 800. FOB Ningbo. Lead time 30 days. CE reports available.' }, t(11))],
    ...Array.from({ length: 5 }, (_, i) => [`confirm2 ${i}`, () => { const p = c.candidates.find((x) => x.state === 'PROPOSED' && !x.needsCorrection); return p ? dispatch(c, { type: 'CANDIDATE_CONFIRM', id: p.id }, t(11, i + 1)) : c; }]),
    ['docs', () => withDocs(c, 'TB-500', t(12))], ['sample', () => dispatch(c, { type: 'SAMPLE_RECORD', status: 'RECEIVED' }, t(12, 5))], ['question', () => dispatch(c, { type: 'QUESTION_SHOWN', questionId: 'manufacturer' }, t(12, 6))],
    ['conflict resolve', () => { const o = c.conflicts.find((x) => x.state === 'OPEN'); return o ? dispatch(c, { type: 'CONFLICT_RESOLVE', id: o.id, choice: 'NEW' }, t(13)) : c; }], ['plan qty', () => dispatch(c, { type: 'PLAN_QTY', qty: 2000 }, t(13, 1))], ['note', () => dispatch(c, { type: 'NOTE', text: 'x' }, t(13, 2))],
  ];
  for (const [label, step] of steps) { c = step(); check(label); }
});

test('the previous result is never lost: it moves to a bounded history', () => {
  let c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const cache = createDerivedCache(); const first = refreshDerived(c, cache, opts).results.deal;
  for (let i = 0; i < HISTORY_MAX + 3; i += 1) { c = dispatch(c, { type: 'SALE', sale: { ...c.sale, sellingPriceGross: 20 + i } }, t(10, i)); refreshDerived(c, cache, opts); }
  const h = cache.history('C', 'deal'); assert.equal(h.length, HISTORY_MAX); assert.ok(h.every((x) => x.fp && x.result?.type === 'DealIntelligence')); assert.notEqual(JSON.stringify(h[0].result), JSON.stringify(cache.entry('C', 'deal').result));
  assert.equal(first.type, 'DealIntelligence');
});

test('the cache is plain JSON: exported and reloaded (after closing the app) it reuses everything and gives the same answers', () => {
  const c = importAndConfirm(tumbler('C'), { source: 'PASTED_QUOTE', text: O1 }, t(9)); const a = createDerivedCache(); const r1 = refreshDerived(c, a, opts);
  const b = createDerivedCache(JSON.parse(JSON.stringify(a.export()))); const r2 = refreshDerived(c, b, opts); assert.deepEqual(r2.recomputed, []); for (const n of NODE_NAMES) assert.equal(JSON.stringify(r2.results[n]), JSON.stringify(r1.results[n]));
});

test('a comparison of five cases re-assesses only the case that changed', () => {
  const cases = ['A', 'B', 'C', 'D', 'E'].map((id, i) => importAndConfirm(tumbler(id, { supplier: `S${id}` }), { source: 'PASTED_QUOTE', text: `Model TB-500. USD${(3 + i / 10).toFixed(2)} for 1000 pcs. MOQ 500. FOB Ningbo. Lead time ${20 + i} days.` }, t(9)));
  const cache = createDerivedCache(); const counter = { n: 0 }; const fn = cachedAssessFn(cache, { counter });
  const s1 = compareCases(cases, { now: NOW, externals: EXT, assessFn: fn }); assert.equal(counter.n, 5);
  const s2 = compareCases(cases, { now: NOW, externals: EXT, assessFn: fn }); assert.equal(counter.n, 5, 'nothing changed: nothing re-assessed'); assert.equal(JSON.stringify(s1), JSON.stringify(s2));
  const changed = cases.slice(); changed[2] = dispatch(changed[2], { type: 'NOTE', text: 'n' }, t(10)); changed[3] = importAndConfirm(changed[3], { source: 'PASTED_QUOTE', text: 'USD2.95 for 1000 pcs. MOQ 500. FOB Ningbo.' }, t(10));
  const s3 = compareCases(changed, { now: NOW, externals: EXT, assessFn: fn }); assert.equal(counter.n, 6, 'only the case whose quote changed was re-assessed (a note does not affect the assessment)');
  const ref = compareCases(changed, { now: NOW, externals: EXT }); assert.equal(JSON.stringify(s3), JSON.stringify(ref), 'identical to a comparison computed without the cache');
});

test('every node declares what it reads (nothing is derived from "everything")', () => {
  for (const [name, def] of Object.entries(NODES)) { assert.ok(Array.isArray(def.slices), name); assert.equal(typeof def.run, 'function', name); }
  assert.deepEqual(NODE_NAMES.slice(0, 1), ['assessment']);
});
