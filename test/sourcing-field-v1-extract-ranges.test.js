// Field V1 - extractor correction found while building OfferImport: a supplier price table written with RANGES ("100-299pcs USD7.20, 300-499pcs USD6.80, 500+pcs USD6.40")
// used to yield minQty 299 / 499 / 500 (the UPPER bound of each range), so 300 pieces were priced at 7.20 instead of 6.80. The lower bound of a range is the tier threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from '../src/sourcing/core/extract/index.js';
import { resolveUnitPrice } from '../src/sourcing/core/offers.js';

const tiersOf = (text) => extractFacts({ text }).candidates.find((c) => c.key === 'quote.tiers');

test('range tiers use the LOWER bound of each range as the threshold', () => {
  const c = tiersOf('Model GB-220: 100-299pcs USD7.20/pc, 300-499pcs USD6.80/pc, 500+pcs USD6.40/pc. MOQ 100pcs. EXW Ningbo.');
  assert.deepEqual(c.value, [{ minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }]);
  const q = { tiers: c.value };
  assert.equal(resolveUnitPrice(q, 300).unitPrice, '6.80', '300 pieces fall in the 300-499 tier');
  assert.equal(resolveUnitPrice(q, 299).unitPrice, '7.20');
  assert.equal(resolveUnitPrice(q, 499).unitPrice, '6.80');
});

test('range tiers with an en dash, a tilde or "to" and a separator are read the same way', () => {
  for (const t of ['100–299 pcs: $7.20; 300–499 pcs: $6.80; 500+ pcs: $6.40', '100~299pcs USD 7.20, 300~499pcs USD 6.80, 500pcs+ USD 6.40', '100 to 299 pcs USD 7.20, 300 to 499 pcs USD 6.80, 500 pcs USD 6.40']) {
    const c = tiersOf(t); assert.ok(c, t); assert.deepEqual(c.value.map((r) => r.minQty), ['100', '300', '500'], t);
  }
});

test('plain (non range) tiers are unchanged', () => {
  assert.deepEqual(tiersOf('500 pcs: USD 6.80, 1000 pcs: USD 6.40').value, [{ minQty: '500', unitPrice: '6.80' }, { minQty: '1000', unitPrice: '6.40' }]);
  assert.deepEqual(tiersOf('USD 8 for 50 pcs, USD 7.20 for 100 pcs').value, [{ minQty: '50', unitPrice: '8' }, { minQty: '100', unitPrice: '7.20' }]);
});

test('a range whose upper bound is below its lower bound is not guessed: it needs a correction', () => {
  const c = tiersOf('299-100pcs USD7.20, 300pcs USD6.80');
  assert.ok(!c || c.needsCorrection === true || c.value.every((r) => r.minQty !== '299'));
});

// Material statements: the extractor used to cut "aluminium alloy" to "aluminium" and "ABS plastic" to "abs" - two different statements ("aluminium alloy" vs "stainless steel") must stay comparable
test('a material keeps its qualifier (alloy, plastic...) and the wider common materials are read', () => {
  const mat = (t) => extractFacts({ text: t }).candidates.filter((c) => c.key === 'spec.material').map((c) => c.value);
  assert.deepEqual(mat('Material: aluminium alloy, anodised.'), ['aluminium alloy']);
  assert.deepEqual(mat('Material: ABS plastic'), ['abs plastic']);
  assert.deepEqual(mat('Material is zinc alloy'), ['zinc alloy']);
  assert.deepEqual(mat('made of stainless steel 304'), ['stainless steel 304']);
  assert.deepEqual(mat('Material: nylon'), ['nylon']);
  assert.deepEqual(mat('Material: brass'), ['brass']);
  assert.deepEqual(mat('made from PU leather'), ['pu leather']);
  assert.deepEqual(mat('Made in China, shipped from Ningbo'), [], '"made in" is a place, never a material');
});

// A comma that FOLLOWS a number is punctuation, not a thousands separator: "MOQ 300, FOB Shenzhen" used to be read as the ambiguous number "300," and the MOQ was lost (needs correction)
test('MOQ followed by a comma and more words is read correctly; thousands commas still work', () => {
  const moq = (t) => extractFacts({ text: t }).candidates.filter((c) => c.key === 'quote.moq').map((c) => ({ v: c.value, fix: c.needsCorrection === true }));
  assert.deepEqual(moq('MOQ 300, FOB Shenzhen'), [{ v: '300', fix: false }]);
  assert.deepEqual(moq('MOQ: 500, lead time 20 days'), [{ v: '500', fix: false }]);
  assert.deepEqual(moq('minimum order 1,000 pcs, EXW Ningbo'), [{ v: '1000', fix: false }]);
  assert.deepEqual(moq('MOQ 300 pcs, FOB Shenzhen'), [{ v: '300', fix: false }]);
  assert.deepEqual(moq('300 pcs MOQ, FOB Shenzhen'), [{ v: '300', fix: false }]);
});
