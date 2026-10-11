import test from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  askAndNormalize, createCreativeBrain, normalizeConceptSet, repairNearMissKeys,
} from '../src/creative-brain/index.js';
import { BRAIN_FAILURE, classifyBrainFailure } from '../src/creative-brain-benchmark/index.js';
import {
  artDirectionAnswer, brief as makeBrief, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, OTHER_CONCEPTS, scriptedPort,
} from './creative-brain-world.js';

// STAGE FAILURES AND NEAR-MISS KEYS (`// SF-N` markers). Regression of the third live attempt: the concept director returned a concept with the key "risisks" instead of "risks", the closed contract refused it,
// and the run stopped with "STOPPED_AT_CREATIVE_BRAIN_PLAN" (no stage, no cause, the answer lost). The structure below is that failure's; the words are the test world's.

const PICKS = [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }];
const select = () => evaluationsAnswer(normalizeConceptSet(CONCEPTS), PICKS);
const withTypo = (list, from = 'risks', to = 'risisks') => list.map((c, i) => (i === 0 ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k === from ? to : k, v])) : c));
const script = (extra = {}) => scriptedPort({
  frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [select()], art_direct: [artDirectionAnswer({ narrative_elements: [] })], compose: [compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' })], ...extra,
});
const run = async (port, ledger = createDecisionLedger()) => {
  const out = await createCreativeBrain({ complete: port.complete, ledger, bounds: { concept_rounds: 2, concepts_per_round: 3 } }).plan({ brief: makeBrief() }).then((r) => ({ r }), (error) => ({ error }));
  return { ...out, ledger };
};

test('SF-1 only an UNAMBIGUOUS near-miss key is repaired, locally, and every repair is recorded', () => {
  const schema = { keys: ['central_idea', 'risks', 'story'], children: { nested: { keys: ['alpha', 'beta'] }, list: { items: { keys: ['one', 'two'] } } } };
  const fix = (value) => { const repairs = []; return { out: repairNearMissKeys(value, schema, repairs, 'x'), repairs }; };
  assert.deepEqual(fix({ central_idea: 'a', risisks: ['r'], story: 's' }), { out: { central_idea: 'a', story: 's', risks: ['r'] }, repairs: [{ path: 'x', from: 'risisks', to: 'risks' }] });
  // nested objects and list items, with their paths
  const nested = fix({ central_idea: 'a', risks: [], story: 's', nested: { alpah: 1, beta: 2 }, list: [{ one: 1, tow: 2 }] });
  assert.deepEqual(nested.repairs, [{ path: 'x.nested', from: 'alpah', to: 'alpha' }, { path: 'x.list[0]', from: 'tow', to: 'two' }]);
  // not repaired: two unknown keys, a key too far from the missing one, an unknown key with nothing missing, two keys missing
  assert.equal(fix({ central_idea: 'a', risisks: [], extra: 1, story: 's' }).repairs.length, 0);
  assert.equal(fix({ central_idea: 'a', hazards: [], story: 's' }).repairs.length, 0);
  assert.equal(fix({ central_idea: 'a', risks: [], story: 's', bonus: 1 }).repairs.length, 0);
  assert.equal(fix({ central_idea: 'a', risisks: [] }).repairs.length, 0);
  // a key that is already there is never overwritten, and the input is never mutated
  const input = { central_idea: 'a', risisks: ['r'], story: 's' };
  fix(input);
  assert.deepEqual(Object.keys(input), ['central_idea', 'risisks', 'story']);
  // optional keys are not "missing"
  const optional = { keys: ['criterion', 'outcome', 'evidence', 'refinement'], required: ['criterion', 'outcome', 'evidence'] };
  assert.deepEqual(repairNearMissKeys({ criterion: 'c', outcome: 'o', evidnce: 'e' }, optional, []), { criterion: 'c', outcome: 'o', evidence: 'e' });
});

test('SF-2 the failed structure: a misspelled key no longer stops the plan; the concept is the same concept, and the repair is evidence', async () => {
  const typo = script({ ideate: [{ concepts: withTypo(CONCEPTS) }] });
  const { r, ledger } = await run(typo);
  assert.equal(r.status, 'PLANNED');
  const plain = await run(script());
  assert.deepEqual(r.plan.concept, plain.r.plan.concept); // a content-derived id: the repaired concept IS the concept
  const row = ledger.of('CONCEPT_ROUND')[0].outcome;
  assert.deepEqual(row.key_repairs, [{ path: 'IDEATE.concepts[0]', from: 'risisks', to: 'risks' }]);
  assert.deepEqual(plain.ledger.of('CONCEPT_ROUND')[0].outcome.key_repairs, []);
});

test('SF-3 an answer that cannot be repaired is still refused, and the refusal carries the stage, the round and the evidence of the answer', async () => {
  const bad = withTypo(CONCEPTS, 'risks', 'hazards');
  const answer = JSON.stringify({ concepts: bad });
  const { error } = await run(script({ ideate: [answer] }));
  assert.equal(error.code, 'BRAIN_UNKNOWN_KEY');
  assert.equal(error.field, 'concepts[0].hazards');
  assert.equal(error.brain_stage, 'IDEATE');
  assert.equal(error.brain_round, 1);
  assert.equal(error.evidence.stage, 'IDEATE');
  assert.equal(error.evidence.request_id, 'req-ideate-2');
  assert.equal(error.evidence.raw_answer, answer);
  assert.deepEqual(error.evidence.key_repairs, []);
  // the evidence is bounded
  const huge = await askAndNormalize({ complete: async () => ({ text: JSON.stringify({ a: 'x'.repeat(20000) }) }), instruction: { system: 's', user: 'u' }, stage: 'IDEATE', normalize: () => { throw new Error('refused'); } }).catch((e) => e);
  assert.equal(huge.evidence.raw_answer.length, 8000);
});

test('SF-4 every stage names itself when it fails: model refusals, provider failures and missing answers', async () => {
  const cases = [
    ['FRAME', { frame: [{ ...frameAnswer(), bonus: 'x' }] }, 'BRAIN_UNKNOWN_KEY'],
    ['IDEATE', { ideate: [{ concepts: CONCEPTS.slice(0, 2) }] }, 'BRAIN_LIST_INVALID'],
    ['SELECT_CONCEPT', { select: [{ evaluations: [] }] }, 'BRAIN_LIST_INVALID'],
    ['ART_DIRECT', { art_direct: [artDirectionAnswer({ depth_model: 'NOWHERE' })] }, 'BRAIN_ENUM_INVALID'],
    ['COMPOSE', { compose: [compositionAnswer({ hero_relationship: 'BIGGEST' })] }, 'BRAIN_ENUM_INVALID'],
    ['FRAME', { frame: [] }, 'BRAIN_PORT_FAILED'],
    ['IDEATE', { ideate: [] }, 'BRAIN_PORT_FAILED'],
    ['SELECT_CONCEPT', { select: [] }, 'BRAIN_PORT_FAILED'],
    ['ART_DIRECT', { art_direct: [] }, 'BRAIN_PORT_FAILED'],
    ['COMPOSE', { compose: [] }, 'BRAIN_PORT_FAILED'],
  ];
  for (const [stage, extra, code] of cases) {
    const { error } = await run(script(extra));
    assert.equal(error?.brain_stage, stage, `${stage} ${code}`);
    assert.equal(error.code, code, `${stage} ${code}`);
  }
  // a rejected concept round is not a failure: no error, no stage
  const rejectAll = [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }];
  const none = await run(script({ select: [evaluationsAnswer(normalizeConceptSet(CONCEPTS), rejectAll), evaluationsAnswer(normalizeConceptSet(OTHER_CONCEPTS), rejectAll)], ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }] }));
  assert.equal(none.error, undefined);
});

test('SF-5 the stopping cause is one name of a closed list, by stage and code', () => {
  const c = (stage, code, name = 'BrainError', problem = null) => classifyBrainFailure({ stage, name, code, problem });
  assert.equal(c('FRAME', 'BRAIN_UNKNOWN_KEY'), BRAIN_FAILURE.PROBLEM_FRAME_INVALID);
  assert.equal(c('IDEATE', 'BRAIN_PORT_FAILED'), BRAIN_FAILURE.IDEATION_PROVIDER_FAILURE);
  assert.equal(c('IDEATE', 'BRAIN_UNKNOWN_KEY'), BRAIN_FAILURE.CONCEPT_OUTPUT_INVALID);
  assert.equal(c('IDEATE', 'BRAIN_NOT_DISTINCT', 'BrainError', 'CONCEPTS_NOT_DISTINCT'), BRAIN_FAILURE.CONCEPTS_NOT_DISTINCT);
  assert.equal(c('IDEATE', 'BRAIN_NOT_DISTINCT', 'BrainError', 'CONCEPT_IS_A_LAYOUT_VARIANT'), BRAIN_FAILURE.CONCEPT_OUTPUT_INVALID);
  assert.equal(c('SELECT_CONCEPT', 'BRAIN_PORT_FAILED'), BRAIN_FAILURE.CONCEPT_SELECTION_PROVIDER_FAILURE);
  assert.equal(c('SELECT_CONCEPT', 'BRAIN_ENUM_INVALID'), BRAIN_FAILURE.CONCEPT_SELECTION_INVALID);
  assert.equal(c('ART_DIRECT', 'BRAIN_PORT_FAILED'), BRAIN_FAILURE.ART_DIRECTION_PROVIDER_FAILURE);
  assert.equal(c('ART_DIRECT', 'BRAIN_FORBIDDEN_CONTENT'), BRAIN_FAILURE.ART_DIRECTION_INVALID);
  assert.equal(c('SCENE', 'BRAIN_FORBIDDEN_CONTENT'), BRAIN_FAILURE.ART_DIRECTION_INVALID);
  for (const stage of ['COMPOSE', 'PRODUCTION_STRATEGY', 'PLAN_COHERENCE']) assert.equal(c(stage, 'BRAIN_RULE_VIOLATION'), BRAIN_FAILURE.COMPOSITION_PLAN_INVALID);
  // anything that is not the Brain's own contract speaking, or a stage nobody tagged, is a wiring defect
  assert.equal(c('IDEATE', null, 'TypeError'), BRAIN_FAILURE.CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT);
  assert.equal(c(null, 'BRAIN_UNKNOWN_KEY'), BRAIN_FAILURE.CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT);
  assert.equal(c('OBSERVE', 'BRAIN_MALFORMED'), BRAIN_FAILURE.CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT);
  assert.equal(Object.keys(BRAIN_FAILURE).length, 12);
});
