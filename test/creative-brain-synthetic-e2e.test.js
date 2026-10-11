import test from 'node:test';
import assert from 'node:assert/strict';

import { RESULT_STATE, runExplain } from '../src/creative-brain-benchmark/index.js';
import { artDirectionAnswer, compositionAnswer, CONCEPTS, frameAnswer, OTHER_CONCEPTS } from './creative-brain-world.js';
import { BELOW, live, PALE, selectAnswer, world } from './creative-brain-benchmark-world.js';

// SYNTHETIC END TO END (`// SE-N` markers): the whole Brain, OBSERVE to recovery, with fake providers only. No network, no credential, no provider, no image. It proves the stages agree with each other: what one stage
// emits is what the next accepts, and every failure names stage, round, rule, evidence, calls and cost.

const FULL_TRACE = ['frame', 'ideate', 'select', 'art_direct', 'compose', 'environment', 'execution_critic', 'concept_critic'];
const REJECT_ALL = [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }];

test('SE-1 the happy path crosses every stage and ends READY_FOR_OWNER_REVIEW with the owner approval still pending', async () => {
  const w = world();
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.deepEqual(w.trace, FULL_TRACE);
  const s = await w.store.readJson('summary.json');
  assert.equal(s.final.state, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal(s.final.owner_approval, 'PENDING');
  assert.deepEqual(s.provider_calls, { text: 5, image: 1, vision: 2, total: 8 });
  assert.deepEqual(s.final.provider_calls, s.provider_calls);
  assert.ok(s.final.cost && typeof s.final.cost === 'object');
  const explained = await runExplain({ store: w.store });
  assert.equal(explained.final.state, RESULT_STATE.READY_FOR_OWNER_REVIEW);
});

test('SE-2 a legitimate concept rejection starts round 2 on its own and the bar is not lowered', async () => {
  const w = world({ answers: { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS, REJECT_ALL), selectAnswer(OTHER_CONCEPTS)], art_direct: [artDirectionAnswer({ narrative_elements: [] })] } });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.deepEqual(w.trace, ['frame', 'ideate', 'select', 'ideate', 'select', ...FULL_TRACE.slice(3)]);
  const s = await w.store.readJson('summary.json');
  assert.equal(s.provider_calls.text, 7);
});

test('SE-3 a concept that fails its critic is re-conceived once, then the recovery bound holds', async () => {
  const w = world({
    answers: { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS), selectAnswer(OTHER_CONCEPTS)], art_direct: [PALE, artDirectionAnswer({ narrative_elements: [] })], compose: [BELOW, BELOW] },
    concept: [{ CONCEPT_STRENGTH: 'FAIL', WOW_FACTOR: 'FAIL' }, {}],
  });
  const r = await live(w);
  assert.ok([RESULT_STATE.READY_FOR_OWNER_REVIEW, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT].includes(r.status));
  const s = await w.store.readJson('summary.json');
  assert.equal(s.candidates[0].recovery.diagnosis.action, 'RECONCEPT');
  assert.equal(s.candidates[0].recovery.executed, true);
  assert.equal(s.candidates.length, 2);
  assert.notEqual(s.candidates[0].concept_id, s.candidates[1].concept_id);
});

test('SE-4 REFINE and RECOMPOSE are diagnosed from the execution critic, recorded, and never executed twice', async () => {
  for (const execution of [[{ PRICE_INTEGRATION: 'FAIL' }], [{ VISUAL_HIERARCHY: 'FAIL' }]]) {
    const w = world({ execution });
    const r = await live(w);
    assert.equal(r.status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT);
    const s = await w.store.readJson('summary.json');
    const got = s.candidates[0].recovery.diagnosis.action;
    assert.ok(['REFINE', 'RECOMPOSE'].includes(got), got);
    assert.equal(s.candidates[0].recovery.executed, false);
    assert.equal(w.envRequests.length, 1);
  }
});

// one malformed answer per model stage. Each: the exact stage, round, canonical code and cause, the raw answer kept as evidence, and the calls and the cost state of the stop.
const MALFORMED = [
  { stage: 'frame', brain: 'FRAME', answer: () => JSON.stringify({ ...frameAnswer(), surprise_key_that_is_not_in_the_contract: 'x' }), calls: 1 },
  { stage: 'frame', brain: 'FRAME', answer: () => 'this is not json at all', calls: 1 },
  { stage: 'ideate', brain: 'IDEATE', answer: () => JSON.stringify({ concepts: CONCEPTS.slice(0, 2) }), calls: 2 },
  { stage: 'ideate', brain: 'IDEATE', answer: () => JSON.stringify({ concepts: [{ ...CONCEPTS[0], unknown_extra: 'x' }, CONCEPTS[1], CONCEPTS[2]] }), calls: 2 },
  { stage: 'select', brain: 'SELECT_CONCEPT', answer: () => JSON.stringify({ evaluations: [] }), calls: 3 },
  { stage: 'select', brain: 'SELECT_CONCEPT', answer: () => '{"evaluations": [', calls: 3 },
  { stage: 'art_direct', brain: 'ART_DIRECT', answer: () => JSON.stringify({ ...PALE, composition_geometry: 'x' }), calls: 4 },
  { stage: 'art_direct', brain: 'ART_DIRECT', answer: () => '[]', calls: 4 },
  { stage: 'compose', brain: 'COMPOSE', answer: () => JSON.stringify({ ...compositionAnswer(), mystery: 1 }), calls: 5 },
  { stage: 'compose', brain: 'COMPOSE', answer: () => 'not json either', calls: 5 },
];

test('SE-5 a malformed provider answer at EACH model stage names the stage, the round, the code, keeps the raw answer, and reports calls and cost', async () => {
  for (const c of MALFORMED) {
    const answer = c.answer();
    const w = world({ answers: { [c.stage]: [answer] } });
    const r = await live(w);
    const label = `${c.stage} ${answer.slice(0, 30)}`;
    assert.equal(r.status, RESULT_STATE.BLOCKED, label);
    const s = await w.store.readJson('summary.json');
    assert.equal(s.error.stage, 'CREATIVE_BRAIN_PLAN', label);
    assert.equal(s.error.brain_stage, c.brain, label);
    assert.equal(s.error.brain_round, ['IDEATE', 'SELECT_CONCEPT'].includes(c.brain) ? 1 : null, label); // concept rounds belong to the two concept stages
    assert.ok(s.error.cause && s.error.cause !== 'STOPPED_AT_CREATIVE_BRAIN_PLAN', `${label}: ${s.error.cause}`);
    assert.ok(s.error.code && s.error.code !== 'STOPPED_AT_CREATIVE_BRAIN_PLAN', `${label}: ${s.error.code}`);
    assert.equal(s.error.evidence.raw_answer, answer, label);
    assert.ok(s.error.evidence.request_id, label);
    assert.equal(s.error.provider_calls.text, c.calls, `${label} text calls`);
    assert.equal(s.error.provider_calls.image, 0, label);
    assert.ok(s.error.cost && typeof s.error.cost === 'object', label);
    assert.equal(s.final.stopped_at, c.brain, label);
    assert.equal(s.final.provider_calls.total, c.calls, label);
    assert.equal(w.envRequests.length, 0, `no image after a refused ${label}`);
    const explained = await runExplain({ store: w.store });
    assert.equal(explained.final.stopped_at, c.brain, label);
    assert.notEqual(explained.error.cause, 'STOPPED_AT_CREATIVE_BRAIN_PLAN', label);
  }
});

test('SE-6 malformed critic answers are never a pass, and the run still ends in a named state', async () => {
  for (const marker of ['execution', 'concept']) {
    const w = world();
    const original = w.deps.ports.vlm;
    w.deps.ports.vlm = (args) => {
      const real = original(args);
      return { invoke: async (req) => (((marker === 'concept') === /concept critic/.test(req.system)) ? { text: 'definitely not json', model: 'fake-vlm', request_id: 'bad-1' } : real.invoke(req)) };
    };
    const r = await live(w);
    assert.equal(r.status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT, marker);
    const s = await w.store.readJson('summary.json');
    assert.equal(s.final.owner_approval, 'PENDING', marker);
    const critique = s.candidates[0][marker === 'concept' ? 'concept_critique' : 'critique'];
    assert.ok(critique.dimensions.length > 0 && critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'), `${marker}: a malformed critic answer measures nothing`);
  }
});

test('SE-7 no stop is the generic STOPPED_AT_CREATIVE_BRAIN_PLAN', async () => {
  const w = world({ answers: { compose: [] } });
  await live(w);
  const s = await w.store.readJson('summary.json');
  assert.notEqual(s.final.reason, 'STOPPED_AT_CREATIVE_BRAIN_PLAN');
  assert.notEqual(s.error.cause, 'STOPPED_AT_CREATIVE_BRAIN_PLAN');
});
