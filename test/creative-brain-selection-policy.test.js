import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvaluationInstruction, CRITERIA, decideConcept, dominates, normalizeConceptSet, normalizeEvaluation, SELECTION, selectConcept,
} from '../src/creative-brain/index.js';
import { buildProblemFrame, observeBrief } from '../src/creative-brain/index.js';
import { auditContractParity } from '../src/creative-brain/parity.js';
import { buildBrief } from './runtime-world.js';
import { CONCEPTS, frameAnswer } from './creative-brain-world.js';

// THE SELECTION POLICY AFTER THE FIRST DECIDED LIVE ROUND (`// SP-N` markers). The selector was given no brand rules and no layout, left BRAND_COMPATIBILITY and COMMERCIAL_CLARITY unjudged on every concept, and both
// were BLOCKING-when-unjudged: no concept could ever be selected. The bar is not lowered: a judged failure still blocks, a judged PARTIAL still counts, every judgeable blocking criterion still blocks when unjudged.

const concepts = normalizeConceptSet(CONCEPTS);
const evalOf = (concept, outcomes = {}, omit = []) => normalizeEvaluation({
  concept_id: concept.concept_id,
  criteria: CRITERIA.filter((c) => !omit.includes(c)).map((criterion) => ({ criterion, outcome: outcomes[criterion] ?? 'MEETS', evidence: `Concrete evidence for ${criterion}.`, ...((outcomes[criterion] ?? 'MEETS') === 'NOT_ASSESSED' ? {} : {}) })),
});
const decide = (outcomes, omit) => decideConcept(evalOf(concepts[0], outcomes, omit));

test('SP-1 the shape of the live round: a concept strong on every criterion the selector could judge, with brand and commercial clarity left unjudged, is SELECTED', () => {
  // round 2 of the live run, in words: strength, relevance, emotion, product, distinctiveness, narrative, generic = MEETS; feasibility = PARTIAL; brand, commercial clarity = not judged
  assert.equal(decide({ FEASIBILITY: 'PARTIAL' }, ['BRAND_COMPATIBILITY', 'COMMERCIAL_CLARITY']), 'SELECT');
  assert.equal(decide({ FEASIBILITY: 'PARTIAL', BRAND_COMPATIBILITY: 'NOT_ASSESSED', COMMERCIAL_CLARITY: 'NOT_ASSESSED', NARRATIVE_COHESION: 'NOT_ASSESSED' }), 'SELECT');
  assert.equal(decide({}, ['BRAND_COMPATIBILITY', 'COMMERCIAL_CLARITY', 'NARRATIVE_COHESION']), 'SELECT');
});

test('SP-2 the bar is NOT lowered: a judged failure of brand or commercial clarity still rejects, a judged PARTIAL still counts toward the limit, and the judgeable blocking criteria still block when unjudged', () => {
  assert.equal(decide({ BRAND_COMPATIBILITY: 'FAILS' }), 'REJECT_CONCEPT');
  assert.equal(decide({ COMMERCIAL_CLARITY: 'FAILS' }), 'REJECT_CONCEPT');
  assert.equal(decide({ BRAND_COMPATIBILITY: 'PARTIAL', COMMERCIAL_CLARITY: 'PARTIAL', FEASIBILITY: 'PARTIAL' }), 'REFINE_CONCEPT'); // three partials
  assert.equal(decide({ BRAND_COMPATIBILITY: 'PARTIAL', COMMERCIAL_CLARITY: 'PARTIAL' }), 'SELECT'); // two are tolerated, as before
  for (const judgeable of ['RELEVANCE_TO_BRIEF', 'FEASIBILITY', 'PRODUCT_RELATIONSHIP']) {
    assert.equal(decide({}, [judgeable]), 'REFINE_CONCEPT', `${judgeable} omitted`);
    assert.equal(decide({ [judgeable]: 'NOT_ASSESSED' }), 'REFINE_CONCEPT', `${judgeable} not assessed`);
    assert.equal(decide({ [judgeable]: 'FAILS' }), 'REJECT_CONCEPT', judgeable);
  }
  assert.equal(decide({ CONCEPT_STRENGTH: 'PARTIAL' }, ['BRAND_COMPATIBILITY']), 'REFINE_CONCEPT'); // the creative bar is untouched
  assert.equal(decide({ DISTINCTIVENESS: 'PARTIAL' }, ['COMMERCIAL_CLARITY']), 'REFINE_CONCEPT');
  for (const decisive of ['CONCEPT_STRENGTH', 'DISTINCTIVENESS', 'GENERIC_RISK']) assert.equal(decide({ [decisive]: 'FAILS' }, ['BRAND_COMPATIBILITY']), 'REJECT_CONCEPT', decisive);
  assert.equal(decide({ CONCEPT_STRENGTH: 'NOT_ASSESSED' }, ['BRAND_COMPATIBILITY']), 'REFINE_CONCEPT'); // an unjudged central idea is not a pass
});

test('SP-3 a round is decided on the same grounds: one selectable concept wins, one that dominates the other selectable wins, incomparable selectable concepts stay NO_CLEAR_WINNER (documented, unchanged)', () => {
  const [a, b, c] = concepts;
  const hide = ['BRAND_COMPATIBILITY', 'COMMERCIAL_CLARITY'];
  const round = (perConcept) => selectConcept({ concepts: [a, b, c], evaluations: [a, b, c].map((x, i) => evalOf(x, perConcept[i], hide)) });
  const live = round([{ FEASIBILITY: 'PARTIAL' }, { FEASIBILITY: 'PARTIAL', RELEVANCE_TO_BRIEF: 'PARTIAL', NARRATIVE_COHESION: 'NOT_ASSESSED' }, { FEASIBILITY: 'PARTIAL', EMOTIONAL_RESONANCE: 'PARTIAL', DISTINCTIVENESS: 'PARTIAL', GENERIC_RISK: 'PARTIAL', RELEVANCE_TO_BRIEF: 'PARTIAL' }]);
  assert.deepEqual([live.outcome, live.concept_id], [SELECTION.SELECT, a.concept_id]);
  assert.deepEqual(live.decisions.map((d) => d.decision), ['SELECT', 'SELECT', 'REFINE_CONCEPT']);
  assert.equal(dominates(evalOf(a, { FEASIBILITY: 'PARTIAL' }, hide), evalOf(b, { FEASIBILITY: 'PARTIAL', RELEVANCE_TO_BRIEF: 'PARTIAL', NARRATIVE_COHESION: 'NOT_ASSESSED' }, hide)), true);
  const tradeoff = round([{ FEASIBILITY: 'PARTIAL' }, { RELEVANCE_TO_BRIEF: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }]); // a is worse on relevance, b worse on feasibility
  assert.deepEqual([tradeoff.outcome, tradeoff.concept_id], [SELECTION.NO_CLEAR_WINNER, null]); // each is better somewhere: still no arbitrary pick
  const none = round([{ CONCEPT_STRENGTH: 'PARTIAL' }, { CONCEPT_STRENGTH: 'PARTIAL', EMOTIONAL_RESONANCE: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }]);
  assert.equal(none.outcome, SELECTION.REFINE_CONCEPT);
});

test('SP-4 property: SELECT always means a strong, distinct, non-failing concept with every judgeable blocking criterion judged and at most two partials; improving a criterion never loses a SELECT', () => {
  let s = 99; const random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const RANK = { NOT_ASSESSED: 0, FAILS: 0, PARTIAL: 1, MEETS: 2 }; const WORDS = ['MEETS', 'PARTIAL', 'FAILS', 'NOT_ASSESSED'];
  let selected = 0;
  for (let i = 0; i < 6000; i += 1) {
    const outcomes = Object.fromEntries(CRITERIA.map((c) => [c, WORDS[Math.floor(random() ** 1.6 * 4)]]));
    const decision = decideConcept(evalOf(concepts[0], outcomes));
    if (decision === 'SELECT') {
      selected += 1;
      const v = Object.values(outcomes);
      assert.equal(outcomes.CONCEPT_STRENGTH, 'MEETS'); assert.equal(outcomes.DISTINCTIVENESS, 'MEETS');
      assert.ok(!v.includes('FAILS')); assert.ok(v.filter((o) => o === 'PARTIAL').length <= 2);
      for (const c of ['RELEVANCE_TO_BRIEF', 'FEASIBILITY', 'PRODUCT_RELATIONSHIP']) assert.notEqual(outcomes[c], 'NOT_ASSESSED', c);
      // monotonic: raising any PARTIAL to MEETS keeps it selectable
      for (const c of CRITERIA) if (outcomes[c] === 'PARTIAL') assert.equal(decideConcept(evalOf(concepts[0], { ...outcomes, [c]: 'MEETS' })), 'SELECT');
    }
    if (outcomes.CONCEPT_STRENGTH === 'FAILS' || outcomes.DISTINCTIVENESS === 'FAILS' || outcomes.GENERIC_RISK === 'FAILS') assert.equal(decision, 'REJECT_CONCEPT');
    // a judged FAILS on any blocking criterion rejects, whatever else was said
    if (['RELEVANCE_TO_BRIEF', 'BRAND_COMPATIBILITY', 'FEASIBILITY', 'COMMERCIAL_CLARITY', 'PRODUCT_RELATIONSHIP'].some((c) => outcomes[c] === 'FAILS')) assert.equal(decision, 'REJECT_CONCEPT');
  }
  assert.ok(selected > 20, `the property saw ${selected} selectable concepts`);
  void RANK;
});

test('SP-5 the selector is told, in its instruction, to judge only what it is given (brand and commercial clarity are verified later); the contract parity audit still passes', () => {
  const observation = observeBrief({ brief: buildBrief() });
  const frame = buildProblemFrame({ observation, model: frameAnswer() });
  const { system } = buildEvaluationInstruction({ frame, concepts });
  assert.match(system, /Judge only from what you are given\. BRAND_COMPATIBILITY depends on brand rules you do not have/);
  assert.match(system, /otherwise answer NOT_ASSESSED rather than guess/);
  assert.equal(auditContractParity().ready, true);
});
