// REAL PHONE FIX #1 - the first physical-phone test: a trade-show note (short fragments, mixed French/English, no punctuation, compact units) was understood only for its MOQ.
// Everything else landed under "Texte non compris". These tests pin the deterministic extractor on that wording. Nothing here may become VERIFIED: it is all SUPPLIER_CLAIM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from '../src/sourcing/core/extract/index.js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { offerDraft } from '../src/sourcing/core/field/offer-import.js';
import { describeCandidate } from '../src/sourcing/core/candidate-view.js';

import { REAL_PHONE_TEXT } from './sourcing-field-v1-phone-fixture.js';
const facts = (text) => extractFacts({ text }).candidates;
const one = (text, key, context) => { const l = facts(text).filter((c) => c.key === key && (context === undefined || c.context === context)); return l.length ? l[0] : null; };
const val = (text, key) => one(text, key)?.value;

test('1. the exact real-phone fixture: price, currency, power, capacity, outputs, colours, stock and MOQ are all read', () => {
  assert.equal(val(REAL_PHONE_TEXT, 'quote.unitPrice'), '11');
  assert.equal(val(REAL_PHONE_TEXT, 'quote.currency'), 'USD');
  assert.deepEqual(val(REAL_PHONE_TEXT, 'spec.power'), { amount: 45, unit: 'W' });
  assert.deepEqual(val(REAL_PHONE_TEXT, 'spec.capacity'), { amount: 20000, unit: 'mAh' });
  assert.equal(val(REAL_PHONE_TEXT, 'spec.outputCount'), '4');
  assert.deepEqual(val(REAL_PHONE_TEXT, 'variant.colours'), ['blue', 'white', 'black']);
  assert.equal(val(REAL_PHONE_TEXT, 'variant.colourCount'), '3');
  assert.equal(val(REAL_PHONE_TEXT, 'offer.stockStatus'), 'IN_STOCK');
  assert.equal(val(REAL_PHONE_TEXT, 'quote.moq'), '24');
  assert.equal(extractFacts({ text: REAL_PHONE_TEXT }).unparsed.length, 0, `nothing left under "Texte non compris": ${JSON.stringify(extractFacts({ text: REAL_PHONE_TEXT }).unparsed)}`);
  assert.equal(facts(REAL_PHONE_TEXT).some((c) => c.key === 'quote.tiers'), false, 'one price and one MOQ are not a price table');
  for (const c of facts(REAL_PHONE_TEXT)) assert.equal(REAL_PHONE_TEXT.slice(c.span[0], c.span[1]), c.rawText, `${c.key} points at the exact characters`);
});

test('2. compact text without punctuation', () => {
  const t = 'prix 11 usd moq 24pcs 45w 20000mah 4 outputs';
  assert.equal(val(t, 'quote.unitPrice'), '11'); assert.equal(val(t, 'quote.currency'), 'USD'); assert.equal(val(t, 'quote.moq'), '24');
  assert.deepEqual(val(t, 'spec.power'), { amount: 45, unit: 'W' }); assert.deepEqual(val(t, 'spec.capacity'), { amount: 20000, unit: 'mAh' }); assert.equal(val(t, 'spec.outputCount'), '4');
  assert.equal(extractFacts({ text: t }).unparsed.length, 0);
  const u = '11$ 3 colors blue white black stock ready';
  assert.equal(val(u, 'quote.unitPrice'), '11'); assert.equal(val(u, 'quote.currency'), 'USD'); assert.deepEqual(val(u, 'variant.colours'), ['blue', 'white', 'black']); assert.equal(val(u, 'variant.colourCount'), '3'); assert.equal(val(u, 'offer.stockStatus'), 'IN_STOCK');
  assert.equal(extractFacts({ text: u }).unparsed.length, 0);
});

test('3. French / English mixed text', () => {
  const t = 'puissance 65w capacity 30000mah en stock';
  assert.deepEqual(val(t, 'spec.power'), { amount: 65, unit: 'W' }); assert.deepEqual(val(t, 'spec.capacity'), { amount: 30000, unit: 'mAh' }); assert.equal(val(t, 'offer.stockStatus'), 'IN_STOCK');
  assert.equal(extractFacts({ text: t }).unparsed.length, 0);
  const u = 'moq 50 pcs, sample 15usd, lead time 12 days';
  assert.equal(val(u, 'quote.moq'), '50'); assert.equal(val(u, 'quote.samplePrice'), '15'); assert.deepEqual(val(u, 'quote.leadTime'), { min: '12', max: '12', unit: 'days' });
  assert.equal(extractFacts({ text: u }).unparsed.length, 0, JSON.stringify(extractFacts({ text: u }).unparsed));
  const w = 'price 8.5 usd exw guangzhou moq300';
  assert.equal(val(w, 'quote.unitPrice'), '8.5'); assert.equal(val(w, 'quote.currency'), 'USD'); assert.equal(val(w, 'quote.incoterm'), 'EXW'); assert.equal(val(w, 'quote.port'), 'Guangzhou'); assert.equal(val(w, 'quote.moq'), '300');
  assert.equal(extractFacts({ text: w }).unparsed.length, 0);
});

test('4. a price without a currency stays a price; the currency is NOT guessed', () => {
  for (const t of ['price 11', 'prix 11', 'prix: 11']) {
    assert.equal(val(t, 'quote.unitPrice'), '11', t); assert.equal(one(t, 'quote.currency'), null, `${t}: no currency invented`);
    assert.ok(one(t, 'quote.unitPrice').flags.includes('CURRENCY_NOT_STATED'), t);
  }
  const d = (() => { let c = newCase({ id: 'c', name: 'x', now: new Date('2026-10-20T08:00:00Z') }); c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'price 11' }, new Date('2026-10-20T08:00:00Z')); return offerDraft(c, c.offers[0].id); })();
  assert.ok(d.unknown.some((u) => u.key === 'quote.currency'), 'the currency is an explicit UNKNOWN row');
});

test('5. several numeric fields in one sentence', () => {
  const t = 'Power bank 45W 20000mAh 4 ports blue white black $11 moq 24pcs';
  assert.deepEqual(val(t, 'spec.power'), { amount: 45, unit: 'W' }); assert.deepEqual(val(t, 'spec.capacity'), { amount: 20000, unit: 'mAh' }); assert.equal(val(t, 'spec.outputCount'), '4');
  assert.equal(val(t, 'quote.unitPrice'), '11'); assert.equal(val(t, 'quote.moq'), '24'); assert.deepEqual(val(t, 'variant.colours'), ['blue', 'white', 'black']);
});

test('6. price and MOQ are never confused (either order, any separator)', () => {
  for (const t of ['11 usd moq 24pcs', 'moq 24pcs 11 usd', 'MOQ: 24 pcs, USD 11', '$11 / pc MOQ 24 pcs', 'prix 11 $ moq 24']) {
    assert.equal(val(t, 'quote.unitPrice'), '11', t); assert.equal(val(t, 'quote.moq'), '24', t);
    assert.equal(facts(t).some((c) => c.key === 'quote.tiers'), false, `${t}: a single price next to a single MOQ is a unit price, not a table`);
  }
  assert.equal(val('11 usd moq 24pcs', 'quote.moq'), '24'); assert.notEqual(val('moq 11 pcs prix 24 usd', 'quote.unitPrice'), '11');
  assert.equal(val('moq 11 pcs prix 24 usd', 'quote.moq'), '11');
});

test('7. mAh is a capacity, never a quantity or a price', () => {
  const t = 'MOQ 20 pcs 20000mAh'; assert.equal(val(t, 'quote.moq'), '20'); assert.deepEqual(val(t, 'spec.capacity'), { amount: 20000, unit: 'mAh' });
  assert.equal(one('20000mAh', 'quote.moq'), null); assert.equal(one('20000mAh', 'quote.unitPrice'), null); assert.notEqual(one('20 000 mAh', 'spec.capacity')?.value?.amount, 20, 'a space-grouped thousand is never cut into a wrong number'); assert.ok(extractFacts({ text: '20 000 mAh' }).unparsed.length > 0, 'what is not understood stays visible');
  assert.deepEqual(val('20,000 mAh', 'spec.capacity'), { amount: 20000, unit: 'mAh' });
  const c = one('capacité 20000', 'spec.capacity'); assert.ok(c && c.value === null && c.needsCorrection && c.flags.includes('UNIT_NOT_STATED'), 'a capacity without a unit is flagged, no unit is guessed');
  assert.equal(one('capacité 20000', 'quote.moq'), null);
});

test('8. W is power, never a price (and Wh stays energy)', () => {
  const t = '45W'; assert.deepEqual(val(t, 'spec.power'), { amount: 45, unit: 'W' }); assert.equal(one(t, 'quote.unitPrice'), null);
  for (const [s, a] of [['45 W', 45], ['puissance 45W', 45], ['power 45 watts', 45], ['65w', 65], ['20W max', 20]]) assert.equal(val(s, 'spec.power')?.amount, a, s);
  assert.equal(one('37Wh', 'spec.power'), null); assert.deepEqual(val('37Wh', 'spec.capacity'), { amount: 37, unit: 'Wh' });
  assert.equal(one('2 pcs w/ logo', 'spec.power'), null); assert.equal(one('5 w/ logo', 'spec.power'), null, 'w/ is "with", not watts'); assert.equal(one('$ 45W', 'quote.unitPrice'), null, 'a rating after a symbol is not a price'); assert.equal(one('$ 3 colors blue white', 'quote.unitPrice'), null, 'a count after a symbol is not a price');
});

test('price notations', () => {
  for (const [t, p, c] of [['11 $', '11', 'USD'], ['$11', '11', 'USD'], ['USD 11', '11', 'USD'], ['11 USD', '11', 'USD'], ['prix 11', '11', null], ['price 11 usd', '11', 'USD'], ['prix 11,5 $', null, 'USD'], ['11$', '11', 'USD']]) {
    assert.equal(one(t, 'quote.unitPrice')?.value ?? null, p, t); assert.equal(one(t, 'quote.currency')?.value ?? null, c, t);
  }
  assert.equal(one('prix 11,5 $', 'quote.unitPrice').needsCorrection, true, 'a decimal comma is still a question for a person');
  assert.equal(val('45W 11$', 'quote.unitPrice'), '11');
  assert.equal(val('3 colors $11', 'quote.unitPrice'), '11');
});

test('output count', () => {
  for (const [t, n] of [['4 sortie', '4'], ['4 sorties', '4'], ['4 output', '4'], ['4 outputs', '4'], ['4 ports', '4'], ['sorties: 2', '2']]) assert.equal(val(t, 'spec.outputCount'), n, t);
  assert.equal(one('5V 3A output', 'spec.outputCount'), null, 'a current rating is not a count'); assert.equal(one('output 3A', 'spec.outputCount'), null);
  assert.equal(one('4 ports', 'quote.port'), null, 'a port count is not a shipping port');
});

test('9. colour lists, any separator, English or French', () => {
  for (const t of ['blue white black', 'bleu blanc noir', 'blue / white / black', 'blue, white and black', '3 colors blue white black', '3 couleurs blue white black', 'couleurs: bleu, blanc, noir']) assert.deepEqual(val(t, 'variant.colours'), ['blue', 'white', 'black'], t);
  assert.equal(val('3 couleurs blue white black', 'variant.colourCount'), '3');
  assert.equal(one('bluetooth speaker', 'variant.colours'), null, 'a colour word inside another word is not a colour');
  assert.equal(one('black', 'variant.colours'), null, 'a lone colour word is not proposed (too ambiguous)');
  assert.deepEqual(val('colour: black', 'variant.colours'), ['black']);
});

test('10. stock wording variants', () => {
  for (const t of ['in stock', 'en stock', 'already in stock', 'déjà en stock', 'déjà on stock', 'ready stock', 'stock available', 'stock ready', 'In-Stock', 'stock disponible']) assert.equal(val(t, 'offer.stockStatus'), 'IN_STOCK', t);
  for (const t of ['out of stock', 'not in stock', 'pas en stock', 'no stock', 'rupture de stock']) assert.equal(val(t, 'offer.stockStatus'), 'OUT_OF_STOCK', t);
  for (const t of ['not yet in stock', 'pas encore en stock', 'pas du tout en stock']) assert.notEqual(val(t, 'offer.stockStatus'), 'IN_STOCK', `${t}: a negation is never read as IN_STOCK`);
  for (const t of ['stock', 'stocks are growing', 'is it in stock?', 'si en stock']) assert.equal(one(t, 'offer.stockStatus'), null, `${t}: no claim`);
});

test('model: exact strings are kept, a category word is never a model', () => {
  assert.equal(val('model: PB-X200 45W', 'identifier.model'), 'PB-X200'); assert.equal(val('modèle GB-220/B 45W', 'identifier.model'), 'GB-220/B');
  assert.equal(one('power bank 45W 20000mAh', 'identifier.model'), null); assert.equal(one('type c 4 ports', 'identifier.model'), null);
});

test('11. correcting a fact keeps the supplier original auditable; the owner value is USER_PROVIDED', () => {
  const T = new Date('2026-10-20T08:00:00Z'); let c = newCase({ id: 'c', name: 'Power bank', now: T }); c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: REAL_PHONE_TEXT }, T);
  const d0 = offerDraft(c, c.offers[0].id); const moq = d0.fields.find((f) => f.key === 'quote.moq'); assert.equal(moq.value, '24'); assert.equal(moq.status, 'SUPPLIER_CLAIM'); assert.equal(moq.review.state, 'PENDING');
  c = dispatch(c, { type: 'CANDIDATE_CORRECT', id: moq.id, value: '11' }, new Date(T.getTime() + 60000));
  const m = offerDraft(c, c.offers[0].id).fields.find((f) => f.key === 'quote.moq');
  assert.equal(m.status, 'USER_PROVIDED'); assert.equal(m.review.state, 'CORRECTED'); assert.equal(m.review.reviewedValue, '11'); assert.equal(m.review.original.value, '24'); assert.equal(m.rawText, 'MOQ 24 pcs');
  const led = c.ledger.filter((e) => e.key === 'quote.moq'); assert.ok(led.length >= 1 && led.every((e) => e.status !== 'VERIFIED'));
});

test('nothing extracted from a supplier is VERIFIED; the new facts are reviewable SUPPLIER_CLAIMs', () => {
  const T = new Date('2026-10-20T08:00:00Z'); let c = newCase({ id: 'c', name: 'Power bank', now: T }); c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: REAL_PHONE_TEXT }, T);
  const d = offerDraft(c, c.offers[0].id); for (const k of ['quote.unitPrice', 'quote.currency', 'spec.power', 'spec.capacity', 'spec.outputCount', 'variant.colours', 'offer.stockStatus', 'quote.moq']) { const f = d.fields.find((x) => x.key === k); assert.ok(f, k); assert.equal(f.status, 'SUPPLIER_CLAIM', k); assert.equal(f.review.state, 'PENDING', k); for (const loc of ['fr', 'en']) { const v = describeCandidate(c.candidates.find((x) => x.id === f.id), loc); assert.ok(v.label && v.label !== k && v.valueText && !/undefined|\[object/.test(v.valueText), `${k}/${loc}: ${v.label} / ${v.valueText}`); } }
  assert.equal(d.noVerified, true);
  for (const k of ['spec.power', 'spec.outputCount', 'offer.stockStatus']) assert.notEqual(d.unknown.some((u) => u.key === k), true);
});

test('12. text that is not understood stays visible and is never discarded', () => {
  const t = 'prix 11 $ le patron dit demain ok 45W bonjour';
  const r = extractFacts({ text: t }); assert.ok(r.unparsed.join(' ').includes('le patron dit demain ok'), JSON.stringify(r.unparsed)); assert.ok(r.unparsed.join(' ').includes('bonjour'));
  assert.equal(val(t, 'quote.unitPrice'), '11'); assert.deepEqual(val(t, 'spec.power'), { amount: 45, unit: 'W' });
  const covered = new Set(); for (const c of r.candidates) for (let i = c.span[0]; i < c.span[1]; i += 1) covered.add(i);
  for (const piece of r.unparsed) assert.ok(t.includes(piece.trim()), 'every unparsed piece is a literal slice of the original');
});

test('regression: previous behaviour of the tier table, the labelled price and the MOQ is unchanged', () => {
  assert.deepEqual(val('USD 8 for 50 pcs, USD 7.20 for 100 pcs', 'quote.tiers'), [{ minQty: '50', unitPrice: '8' }, { minQty: '100', unitPrice: '7.20' }]);
  assert.deepEqual(val('50 pcs: $8; 100 pcs: $7.20', 'quote.tiers'), [{ minQty: '50', unitPrice: '8' }, { minQty: '100', unitPrice: '7.20' }]);
  assert.equal(val('MOQ 300, FOB Ningbo', 'quote.moq'), '300'); assert.equal(val('USD 6.80', 'quote.unitPrice'), '6.80');
});
