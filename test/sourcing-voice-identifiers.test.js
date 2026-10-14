// IDENTIFIER RESOLUTION prototype (LAB, tools/voice-bench/identifiers.mjs): spoken product references become CANDIDATES with evidence; nothing is silently corrected, no SKU dictionary, quantities are not references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identifierCandidates, canon, editDistance } from '../tools/voice-bench/identifiers.mjs';

const top = (t, ctx) => identifierCandidates(t, ctx).candidates[0];

test('spoken letters and digit groups become the written reference, in every way a person says it', () => {
  for (const t of ['RB nine eighty H B', 'RB nine eight zero H B', 'R B nine eight zero H B', 'RB980 HB.', 'rb 980 hb', 'are be nine eighty age be']) assert.equal(canon(top(t).canonical), 'RB980HB', t);
  assert.equal(canon(top('ZF zero twenty four').canonical), 'ZF024'); assert.equal(canon(top('ZF zero four one').canonical), 'ZF041'); assert.equal(canon(top('eight seven five five C').canonical), '8755C'); assert.equal(canon(top('eight seven zero nine C').canonical), '8709C');
});

test('NEVER silently corrected: every candidate needs confirmation unless an independent source already agrees; a known identifier never replaces what was heard', () => {
  const c = identifierCandidates('The model is RB nine eighty H B and the MOQ is one hundred pieces.').candidates; assert.equal(c.length, 1); assert.equal(c[0].needsConfirmation, true); assert.ok(c[0].evidence[0].includes('spoken form'));
  const near = identifierCandidates('R B nine eight zero H P', { known: ['RB-980HB'] }).candidates; assert.ok(near.some((x) => x.canonical === 'RB980HP' && x.needsConfirmation), 'what was heard is kept'); assert.ok(near.some((x) => x.canonical === 'RB980HB' && x.needsConfirmation), 'the known one is offered, to be confirmed');
  const agree = identifierCandidates('RB nine eighty H B', { known: ['RB-980HB'] }).candidates[0]; assert.equal(agree.needsConfirmation, false); assert.equal(agree.confidence, 'HIGH'); assert.ok(agree.evidence.some((e) => /another source/.test(e)));
});

test('quantities and ordinary sentences are not references; common words are not letters of a reference', () => {
  for (const t of ['The minimum order quantity is one hundred pieces.', 'The minimum order quantity is 100 pieces', 'For five hundred pieces the price is six dollars.', 'We have black, white, blue and pink.', 'this is a test for the price']) assert.deepEqual(identifierCandidates(t).candidates, [], t);
});

test('a fragment never outranks the longer reference it belongs to; the edit distance helper is exact', () => {
  assert.equal(canon(top('RB980 HB and the MOQ').canonical), 'RB980HB'); assert.equal(identifierCandidates('RB980 HB').candidates.length, 1); assert.equal(editDistance('RB980HB', 'RB980HP'), 1); assert.equal(editDistance('abc', 'abc'), 0);
});
