import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvaluationInstruction, buildProblemFrame, CRITERIA, CRITERION, createConceptSelector, decideConcept, dominates, normalizeConceptSet, normalizeEvaluation, observeBrief, selectConcept, SELECTION,
} from '../src/creative-brain/index.js';
import {
  brief as makeBrief, CONCEPTS, criteriaOf, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// CONCEPT SELECTION (`// CS-N` markers): concepts are compared in words on named criteria; Nordla derives every decision; there is no score.

const concepts = () => normalizeConceptSet(CONCEPTS);
const evalOf = (concept, outcomes) => normalizeEvaluation({ concept_id: concept.concept_id, criteria: criteriaOf(outcomes) });
const code = (fn, c) => assert.throws(fn, (e) => e.code === c, c);

test('CS-1 an evaluation has every criterion exactly once, in words with evidence; an unjudged criterion is NOT_ASSESSED, never a guessed pass', () => {
  const [a] = concepts();
  const ev = evalOf(a, {});
  assert.deepEqual(ev.criteria.map((c) => c.criterion), [...CRITERIA]);
  assert.ok(ev.criteria.every((c) => c.outcome === 'MEETS' && c.evidence.length > 12));
  const partial = normalizeEvaluation({ concept_id: a.concept_id, criteria: [{ criterion: 'CONCEPT_STRENGTH', outcome: 'MEETS', evidence: 'The central idea is clear and singular.' }] });
  assert.equal(partial.criteria.filter((c) => c.outcome === 'NOT_ASSESSED').length, 9);
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [{ criterion: 'BEAUTY', outcome: 'MEETS', evidence: 'A judgment with evidence.' }] }), 'BRAIN_ENUM_INVALID');
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [{ criterion: 'GENERIC_RISK', outcome: 'GREAT', evidence: 'A judgment with evidence.' }] }), 'BRAIN_ENUM_INVALID');
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [{ criterion: 'GENERIC_RISK', outcome: 'MEETS', evidence: 'ok' }] }), 'BRAIN_TEXT_INVALID');
  const dup = { criterion: 'GENERIC_RISK', outcome: 'MEETS', evidence: 'A judgment with evidence.' };
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [dup, dup] }), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [{ ...dup, score: 8 }] }), 'BRAIN_NUMERIC_VALUE');
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [{ ...dup, rank: 'first' }] }), 'BRAIN_UNKNOWN_KEY');
  code(() => normalizeEvaluation({ concept_id: a.concept_id, criteria: [], winner: 'x' }), 'BRAIN_UNKNOWN_KEY');
  assert.ok(Object.isFrozen(ev) && Object.isFrozen(ev.criteria[0]));
  assert.equal(CRITERIA.length, 10);
});

test('CS-2 the decision of one concept is a fixed function of its words', () => {
  const [a] = concepts();
  const decide = (outcomes) => decideConcept(evalOf(a, outcomes));
  assert.equal(decide({}), 'SELECT');
  assert.equal(decide({ EMOTIONAL_RESONANCE: 'PARTIAL', NARRATIVE_COHESION: 'PARTIAL' }), 'SELECT'); // two partials are tolerated
  assert.equal(decide({ EMOTIONAL_RESONANCE: 'PARTIAL', NARRATIVE_COHESION: 'PARTIAL', FEASIBILITY: 'PARTIAL' }), 'REFINE_CONCEPT'); // three are not
  assert.equal(decide({ CONCEPT_STRENGTH: 'PARTIAL' }), 'REFINE_CONCEPT'); // a strong, distinct idea is the bar
  assert.equal(decide({ DISTINCTIVENESS: 'PARTIAL' }), 'REFINE_CONCEPT');
  for (const blocking of ['RELEVANCE_TO_BRIEF', 'BRAND_COMPATIBILITY', 'FEASIBILITY', 'COMMERCIAL_CLARITY', 'PRODUCT_RELATIONSHIP']) assert.equal(decide({ [blocking]: 'FAILS' }), 'REJECT_CONCEPT', blocking);
  for (const decisive of ['CONCEPT_STRENGTH', 'DISTINCTIVENESS', 'GENERIC_RISK']) assert.equal(decide({ [decisive]: 'FAILS' }), 'REJECT_CONCEPT', decisive);
  assert.equal(decide({ EMOTIONAL_RESONANCE: 'FAILS', NARRATIVE_COHESION: 'FAILS' }), 'REFINE_CONCEPT'); // two ordinary failures can be refined
  assert.equal(decide({ EMOTIONAL_RESONANCE: 'FAILS', NARRATIVE_COHESION: 'FAILS', COMMERCIAL_CLARITY: 'PARTIAL' }), 'REFINE_CONCEPT');
  assert.equal(decide({ EMOTIONAL_RESONANCE: 'FAILS', NARRATIVE_COHESION: 'FAILS', FEASIBILITY: 'FAILS' }), 'REJECT_CONCEPT'); // three failures reject
  assert.equal(decide({ FEASIBILITY: 'NOT_ASSESSED' }), 'REFINE_CONCEPT'); // an unjudged blocking criterion can never be selected
  assert.equal(decide({ EMOTIONAL_RESONANCE: 'NOT_ASSESSED' }), 'SELECT');
});

test('CS-3 the outcome of a round: SELECT, REFINE_CONCEPT, REJECT_CONCEPT or NO_CLEAR_WINNER, derived by Nordla with no score', () => {
  const [a, b, c] = concepts();
  const run = (perConcept) => selectConcept({ concepts: [a, b, c], evaluations: [a, b, c].map((x, i) => evalOf(x, perConcept[i])) });
  // one concept clearly meets the bar and dominates the others
  const select = run([{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }]);
  assert.equal(select.outcome, SELECTION.SELECT);
  assert.equal(select.concept_id, a.concept_id);
  assert.deepEqual(select.decisions.map((d) => d.decision), ['SELECT', 'REFINE_CONCEPT', 'REJECT_CONCEPT']);
  assert.ok(select.decisions.every((d) => d.evidence.length > 20 && d.evidence.length <= 300));
  // two selectable concepts, one better on every criterion and equal elsewhere: the dominating one wins
  const better = run([{ EMOTIONAL_RESONANCE: 'PARTIAL' }, {}, { GENERIC_RISK: 'FAILS' }]);
  assert.equal(better.outcome, SELECTION.SELECT);
  assert.equal(better.concept_id, b.concept_id);
  // two selectable concepts that trade off (each better somewhere): no clear winner
  const trade = run([{ EMOTIONAL_RESONANCE: 'PARTIAL' }, { NARRATIVE_COHESION: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }]);
  assert.equal(trade.outcome, SELECTION.NO_CLEAR_WINNER);
  assert.equal(trade.concept_id, null);
  // two identical selectable concepts: no one dominates
  assert.equal(run([{}, {}, { GENERIC_RISK: 'FAILS' }]).outcome, SELECTION.NO_CLEAR_WINNER);
  // nothing meets the bar but one is promising: refine it
  const refine = run([{ CONCEPT_STRENGTH: 'PARTIAL' }, { CONCEPT_STRENGTH: 'PARTIAL', EMOTIONAL_RESONANCE: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }]);
  assert.equal(refine.outcome, SELECTION.REFINE_CONCEPT);
  assert.equal(refine.concept_id, a.concept_id);
  // several refinable concepts and none dominates
  assert.equal(run([{ CONCEPT_STRENGTH: 'PARTIAL', EMOTIONAL_RESONANCE: 'PARTIAL' }, { CONCEPT_STRENGTH: 'PARTIAL', NARRATIVE_COHESION: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }]).outcome, SELECTION.NO_CLEAR_WINNER);
  // every concept fails a decisive criterion
  const reject = run([{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }]);
  assert.equal(reject.outcome, SELECTION.REJECT_CONCEPT);
  assert.equal(reject.concept_id, null);
  assert.ok(Object.isFrozen(select) && Object.isFrozen(select.decisions[0]));
  assert.doesNotMatch(JSON.stringify(select), /score|rank|rating|winner_score/i);
});

test('CS-4 dominance is per criterion, with no weight and no sum', () => {
  const [a, b] = concepts();
  const eb = evalOf(b, { EMOTIONAL_RESONANCE: 'PARTIAL' });
  const ea = evalOf(a, {});
  assert.equal(dominates(ea, eb), true);
  assert.equal(dominates(eb, ea), false);
  assert.equal(dominates(ea, ea), false); // equal is not better
  const tradeoff = evalOf(a, { EMOTIONAL_RESONANCE: 'PARTIAL' });
  const other = evalOf(b, { NARRATIVE_COHESION: 'PARTIAL' });
  assert.equal(dominates(tradeoff, other) || dominates(other, tradeoff), false);
});

test('CS-5 a round must evaluate exactly its concepts', () => {
  const [a, b, c] = concepts();
  const ev = (x) => evalOf(x, {});
  code(() => selectConcept({ concepts: [a, b, c], evaluations: [ev(a), ev(b)] }), 'BRAIN_RULE_VIOLATION');
  code(() => selectConcept({ concepts: [a, b], evaluations: [ev(a), ev(b), ev(c)] }), 'BRAIN_RULE_VIOLATION');
  code(() => selectConcept({ concepts: [a, b], evaluations: [ev(a), { ...ev(b), concept_id: 'cnc_unknown' }] }), 'BRAIN_RULE_VIOLATION');
});

test('CS-6 the selector asks the model for judgments only; the outcome is Nordla\'s even if the model names a winner', async () => {
  const set = concepts();
  const frame = buildProblemFrame({ observation: observeBrief({ brief: makeBrief() }), model: frameAnswer() });
  const { system, user } = buildEvaluationInstruction({ frame, concepts: set });
  for (const criterion of CRITERIA) assert.ok(system.includes(`- ${criterion}:`), criterion);
  assert.match(system, /Never give a score, a number, a rank or a winner: Nordla derives the decision/);
  assert.match(system, /a clean idea that any competitor could publish is not distinctive/);
  assert.deepEqual(Object.keys(JSON.parse(user)), ['problem_frame', 'concepts']);
  const answer = evaluationsAnswer(set, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }]);
  const port = scriptedPort({ select: [answer] });
  const { selection, evaluations } = await createConceptSelector({ complete: port.complete }).select({ frame, concepts: set });
  assert.equal(selection.outcome, 'SELECT');
  assert.equal(evaluations.length, 3);
  // the model cannot state the outcome, a winner or a score
  for (const extra of [{ outcome: 'SELECT' }, { winner: set[2].concept_id }, { score: 9 }]) {
    const e = await createConceptSelector({ complete: async () => ({ text: JSON.stringify({ ...answer, ...extra }) }) }).select({ frame, concepts: set }).catch((x) => x);
    assert.ok(['BRAIN_UNKNOWN_KEY', 'BRAIN_NUMERIC_VALUE'].includes(e.code), e.code);
  }
  // a model that judges only some of the concepts leaves the others without an evaluation: the round cannot be decided
  const short = await createConceptSelector({ complete: async () => ({ text: JSON.stringify({ evaluations: answer.evaluations.slice(0, 2) }) }) }).select({ frame, concepts: set }).catch((x) => x);
  assert.equal(short.code, 'BRAIN_RULE_VIOLATION');
  void CRITERION;
});
