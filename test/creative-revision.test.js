import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import * as C from '../src/creative-critic/index.js';
import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import {
  buildCandidateEvidence, buildRevisionInstruction, COMPONENT, createApprovedCopyAgent, createBrandGuardianGate, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter,
  createProductAssetAnalyst, createRevisionDirector, createVisualProductionDirector, DECISION, directionDelta, DIRECTOR_CONSTANTS, normalizeRevisionEvidence, REQUIRED_DECISIONS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from '../scripts/benchmark-resources.mjs';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts, GUARDIAN_PASS,
} from './runtime-world.js';

// C3 Revision Cycle 1 preparation (`// RV-N` markers): the revision-side Creative Director and the Brand Guardian gate in the runtime. Fakes only: no network, no provider, no cost.

const AT = '2026-10-10T12:00:00.000Z';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

const REVISED = (over = {}) => directorAnswer({
  concept: 'The real case leads, with the approved message set quietly beneath it on a calm surface.',
  spatial_intent: 'PRODUCT_CENTER_TEXT_BELOW',
  negative_space_intent: 'TOP',
  hierarchy: ['PRODUCT', 'HEADLINE', 'SUBHEADLINE', 'PRICE'],
  visual_intent: 'a matte pale surface with a long soft raking light and a faint, believable contact shadow',
  ...over,
});

function setup({ answer = directorAnswer(), revisionAnswer = REVISED(), guardian = GUARDIAN_PASS, environment = fakeEnvironmentPort() } = {}) {
  const ledger = createDecisionLedger();
  const prompts = [];
  const revisionPrompts = [];
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: createCreativeDirector({ ledger, complete: async (p) => { prompts.push(p); return { text: answer, model: 'fake', request_id: 'd1' }; }, constants: DIRECTOR_CONSTANTS }),
    revision_director: createRevisionDirector({ ledger, complete: async (p) => { revisionPrompts.push(p); return { text: typeof revisionAnswer === 'function' ? revisionAnswer(revisionPrompts.length) : revisionAnswer, model: 'fake', request_id: 'r1' }; }, constants: DIRECTOR_CONSTANTS }),
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  const ports = { segmenter: createLocalProductSegmenter({ ledger }), environment };
  return {
    ledger, agents, ports, prompts, revisionPrompts, environment,
    run: (extra = {}) => runProductPreservingCreative({ at: AT, brief: buildBrief(), fonts, agents, ports, ledger, guardian, ...extra }),
  };
}

// the synthetic runs are the slow part: the first candidate and its revision are produced ONCE and shared by the tests (each test still asserts on them)
const guardianCalls = [];
const COUNTING_GUARDIAN = Object.freeze({ evaluate: (input) => { guardianCalls.push(input); return GUARDIAN_PASS.evaluate(input); } });
const shared = {};
const base = () => (shared.base ??= (async () => { const s = setup({ guardian: COUNTING_GUARDIAN }); return { s, ...(await firstCandidate(s)) }; })());
const revisedRun = () => (shared.revised ??= (async () => { const { revision } = await base(); const s2 = setup({ answer: 'must not be used', guardian: COUNTING_GUARDIAN }); const revised = await s2.run({ revision }); return { s2, revised }; })());

const failing = (dimension, hint) => ({ dimension, outcome: 'FAIL', evidence: 'The element visibly competes with the product for attention.', revision_hint: hint });
const critiqueFor = (result, dims = []) => C.normalizeCritique({
  dimensions: [
    ...dims,
    ...C.DIMENSIONS.filter((d) => !dims.some((x) => x.dimension === d)).map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' })),
  ],
}, { candidate_ref: 'candidate:test-1', candidate_sha256: result.png_sha256 });
const DEFAULT_FAILS = [
  failing('PRICE_INTEGRATION', 'Integrate the price more subtly into the composition.'),
  failing('TEMPLATE_LIKE_APPEARANCE', 'Make the layout feel bespoke rather than a standard template fill.'),
  failing('VISUAL_HIERARCHY', 'Reduce the visual weight of the text containers so the product leads.'),
];
async function firstCandidate(s) {
  const result = await s.run();
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.fidelity?.failed, result.preflight]));
  const critique = critiqueFor(result, DEFAULT_FAILS);
  const revisionRequest = C.buildRevisionRequest({ critique, iteration: 1 });
  const revision = { previous_direction: result.direction, candidate_evidence: buildCandidateEvidence({ result, candidate_sha256: result.png_sha256 }), critique, revision_request: revisionRequest };
  return { result, critique, revisionRequest, revision };
}

test('RV-1 the revision Director receives only canonical evidence and the semantic intents (and the revised run is attributed to Nordla components)', async () => {
  const { revision, revisionRequest } = await base();
  const { s2, revised } = await revisedRun();
  assert.equal(revised.status, 'READY_FOR_REVIEW', JSON.stringify([revised.reason, revised.preflight, revised.fidelity?.failed]));
  assert.equal(s2.prompts.length, 0, 'the initial Director is not consulted during a revision');
  assert.equal(s2.revisionPrompts.length, 1);
  const payload = JSON.parse(s2.revisionPrompts[0].user);
  assert.deepEqual(Object.keys(payload).sort(), ['approved_text_roles', 'brand_expression', 'brief', 'critique', 'format', 'previous_candidate', 'previous_direction', 'revision_intents']);
  assert.deepEqual(payload.revision_intents.map((i) => i.intent), revisionRequest.intents.map((i) => i.intent));
  assert.ok(payload.revision_intents.every((i) => Object.values(C.REVISION_INTENT).includes(i.intent)));
  assert.deepEqual(Object.keys(payload.previous_candidate).sort(), ['candidate_sha256', 'fidelity', 'guardian', 'plate_used', 'preflight', 'product_height_share', 'recipe_id', 'spatial_intent', 'text_roles']);
  assert.deepEqual(Object.keys(payload.previous_direction).sort(), ['concept', 'copy_intent', 'hierarchy', 'negative_space_intent', 'product_role', 'spatial_intent', 'visual_intent']);
  assert.equal(payload.critique.dimensions.length, 14);
  assert.ok(payload.critique.dimensions.every((d) => Object.keys(d).sort().join() === 'dimension,evidence,outcome,revision_hint'));
  // the instruction says what it is: a revision from intents, never how
  assert.match(s2.revisionPrompts[0].system, /REVISING a previous creative direction/);
  assert.match(s2.revisionPrompts[0].system, /Never use coordinates, sizes/);
  // every decision of the revised run belongs to a Nordla component, the revision Director's included
  assert.equal(revised.steering.manual_creative_steering, 'NONE');
  assert.deepEqual(revised.ledger.filter((e) => e.decision === DECISION.REVISION_DIRECTION).map((e) => e.decided_by), [COMPONENT.REVISION_DIRECTOR]);
  assert.deepEqual(revised.ledger.filter((e) => e.decision === DECISION.CREATIVE_DIRECTION).map((e) => e.decided_by), [COMPONENT.REVISION_DIRECTOR]);
  for (const decision of REQUIRED_DECISIONS) assert.ok(revised.steering.attribution[decision], decision);
});

test('RV-2 the owner review is not visible to the revision Director: foreign keys are refused and its words never reach the model', async () => {
  const { revision } = await base();
  const review = JSON.parse(await readFile(new URL('../benchmarks/creative-intelligence/habb-c2-owner-review-001.json', import.meta.url), 'utf8'));
  // an owner review (or any foreign evidence) cannot be added at any level of the revision evidence
  for (const [path, mutate] of [
    ['revision.owner_review', (r) => ({ ...r, owner_review: review })],
    ['revision.owner_words', (r) => ({ ...r, owner_words: review.owner_words })],
    ['critique.owner_status', (r) => ({ ...r, critique: { ...r.critique, owner_status: 'OWNER_REJECTED' } })],
    ['candidate_evidence.owner_note', (r) => ({ ...r, candidate_evidence: { ...r.candidate_evidence, owner_note: 'x' } })],
    ['revision_request.review', (r) => ({ ...r, revision_request: { ...r.revision_request, review } })],
  ]) throwsCode(() => normalizeRevisionEvidence(mutate(revision)), 'REVISION_INPUT_KEY_NOT_ALLOWED');
  // through the agent as well: nothing is sent to the model
  const s2 = setup();
  const error = await s2.run({ revision: { ...revision, owner_review: review } }).catch((e) => e);
  assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
  assert.equal(s2.revisionPrompts.length, 0);
  // and in a valid revision, none of the owner's words is in the instruction
  const { s2: s3 } = await revisedRun();
  const wire = `${s3.revisionPrompts[0].system}\n${s3.revisionPrompts[0].user}`;
  for (const note of [review.owner_words, ...review.dimensions.map((d) => d.note).filter(Boolean)]) assert.ok(!wire.includes(note), note);
  assert.doesNotMatch(wire, /OWNER_REJECTED|owner[_ ]review|NOT_SHIPPABLE/i);
});

test('RV-3 the modules of the revision path never import the owner review', async () => {
  for (const file of ['src/creative-runtime/revision-director.js', 'src/creative-runtime/runtime.js', 'src/creative-runtime/agents.js', 'src/creative-runtime/guardian-gate.js', 'src/creative-runtime/index.js', 'src/creative-critic/revision.js', 'src/creative-critic/loop.js', 'scripts/run-c3-revision.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /owner-review/, file);
  }
  const script = await readFile(new URL('../scripts/run-c3-revision.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script.replace(/\/\/.*$/gm, ''), /process\.exit\(/);
});

test('RV-4 no coordinate, size, font or colour literal can enter a revision instruction, from any source', async () => {
  const { revision } = await base();
  const withCritique = (idx, patch) => ({ ...revision, critique: { ...revision.critique, dimensions: revision.critique.dimensions.map((d, i) => (i === idx ? { ...d, ...patch } : d)) } });
  for (const evidence of ['The title sits at x = 132 on the canvas.', 'The headline is set at font-size 53 here.', 'It is 20% too large for its role.', 'The plate is drawn in #c0392b here.', 'Shifted by 40px to the left.']) {
    throwsCode(() => normalizeRevisionEvidence(withCritique(0, { evidence })), 'REVISION_INPUT_NOT_SEMANTIC');
  }
  throwsCode(() => normalizeRevisionEvidence(withCritique(2, { revision_hint: 'Set the margin to 40px on every side.' })), 'REVISION_INPUT_NOT_SEMANTIC');
  throwsCode(() => normalizeRevisionEvidence({ ...revision, previous_direction: { ...revision.previous_direction, visual_intent: 'a pale surface lit by #fbf8f3 light' } }), 'REVISION_INPUT_NOT_SEMANTIC');
  throwsCode(() => normalizeRevisionEvidence({ ...revision, revision_request: { ...revision.revision_request, intents: [{ ...revision.revision_request.intents[0], hint: 'Make the price 20% smaller than now.' }] } }), 'REVISION_INPUT_NOT_SEMANTIC');
  throwsCode(() => normalizeRevisionEvidence({ ...revision, revision_request: { ...revision.revision_request, intents: [{ ...revision.revision_request.intents[0], intent: 'MOVE_TITLE_TO_X_132' }] } }), 'REVISION_INTENT_UNKNOWN');
  // the evidence must be about ONE candidate and ONE critique: a critique of another image, or a request derived from another critique, is refused
  throwsCode(() => normalizeRevisionEvidence({ ...revision, critique: { ...revision.critique, candidate_sha256: 'f'.repeat(64) } }), 'REVISION_INPUT_MISMATCH');
  throwsCode(() => normalizeRevisionEvidence({ ...revision, revision_request: { ...revision.revision_request, from_critique_id: 'ccq_another' } }), 'REVISION_INPUT_MISMATCH');
  // a layout / colour / font channel does not exist: any such key is refused
  for (const key of ['layout', 'geometry', 'coordinates', 'colors', 'font_size', 'positions']) throwsCode(() => normalizeRevisionEvidence({ ...revision, [key]: {} }), 'REVISION_INPUT_KEY_NOT_ALLOWED');
  throwsCode(() => normalizeRevisionEvidence({ ...revision, candidate_evidence: { ...revision.candidate_evidence, geometry: { x: 1 } } }), 'REVISION_INPUT_KEY_NOT_ALLOWED');
  // the instruction a valid revision produces carries none of them
  const evidence = normalizeRevisionEvidence(revision);
  const { user } = buildRevisionInstruction({ brief: { public_facts: {}, approved_text_roles: [], format: {}, expression: {} }, evidence, constants: DIRECTOR_CONSTANTS });
  assert.doesNotMatch(user, /\b\d+(\.\d+)?\s*(px|pt|em|rem|%)|\b[xy]\s*=\s*\d|font-size|#[0-9a-f]{3,8}\b/i);
  // the model cannot smuggle one back either: a revised direction with a literal is refused
  const s2 = setup({ revisionAnswer: REVISED({ visual_intent: 'a pale surface, lit at 45% intensity from the left' }) });
  const error = await s2.run({ revision }).catch((e) => e);
  assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
  assert.equal(error.detail.cause.code, 'REVISION_INPUT_NOT_SEMANTIC');
  // nor can it add a channel the direction does not have (a layout, a colour, a position)
  const s3 = setup({ revisionAnswer: JSON.stringify({ ...JSON.parse(REVISED()), layout: 'title at the top' }) });
  const extra = await s3.run({ revision }).catch((e) => e);
  assert.equal(extra.code, CI.CI_ERROR.AGENT_FAILED);
  assert.equal(s3.environment.calls.length, 0);
});

test('RV-5 a revised direction must differ meaningfully from the previous one', async () => {
  const same = JSON.parse(directorAnswer());
  assert.equal(directionDelta(same, same).meaningful, false);
  assert.equal(directionDelta(same, { ...same, spatial_intent: 'PRODUCT_START_TEXT_END' }).meaningful, true);
  assert.deepEqual(directionDelta(same, { ...same, hierarchy: [...same.hierarchy].reverse() }).structural, ['hierarchy']);
  assert.equal(directionDelta(same, { ...same, concept: 'An entirely different idea about another subject and composition.' }).meaningful, false); // one descriptive field alone is not enough
  assert.equal(directionDelta(same, { ...same, concept: 'An entirely different idea about another subject and composition.', visual_intent: 'a warm wooden counter in raking late light with grain' }).meaningful, true);
  // through the agent: the identical direction (and a re-worded copy of it) stops the run with a classified reason; nothing is composed
  const { revision } = await base();
  for (const answer of [directorAnswer(), directorAnswer({ concept: 'A single real case, clearly the hero, in a calm studio setting.' })]) {
    const s2 = setup({ revisionAnswer: answer });
    const error = await s2.run({ revision }).catch((e) => e);
    assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
    assert.equal(error.detail.cause.code, 'REVISED_DIRECTION_NOT_DIFFERENT');
    assert.equal(s2.environment.calls.length, 0);
  }
});

test('RV-6 Brand Guardian runs on every produced candidate (initial and revised) and is recorded', async () => {
  const { result } = await base();
  const { revised } = await revisedRun();
  // the gate was called once per produced candidate, with the document, the fonts and the PASSING Fidelity gate it consumes
  assert.equal(guardianCalls.length, 2);
  assert.ok(guardianCalls.every((input) => input.document && input.fonts && input.fidelityGate?.outcome === 'PASS'));
  assert.equal(result.guardian.outcome, 'PASS');
  assert.equal(revised.guardian.outcome, 'PASS');
  assert.deepEqual(revised.ledger.filter((e) => e.decision === DECISION.BRAND_GUARDIAN).map((e) => [e.decided_by, e.outcome.outcome]), [[COMPONENT.BRAND_GUARDIAN, 'PASS']]);
  // no Guardian configured: the candidate exists but can never be READY_FOR_REVIEW
  const none = await setup({ guardian: null }).run();
  assert.equal(none.status, 'BLOCKED');
  assert.equal(none.reason, 'BRAND_GUARDIAN_NOT_CONFIGURED');
  assert.equal(none.guardian, null);
});

test('RV-7 a Guardian FAIL blocks owner review, and the critic can never override it', async () => {
  const guardian = { evaluate: () => ({ report_id: 'gr_f', outcome: 'FAIL', hard_outcome: 'FAIL', rule_results: [{ rule_id: 'habb-palette-closed', outcome: 'FAIL' }] }) };
  const result = await setup({ guardian }).run();
  assert.equal(result.status, 'GUARDIAN_FAIL');
  assert.notEqual(result.status, 'READY_FOR_REVIEW');
  assert.equal(result.guardian.outcome, 'FAIL');
  // anything but PASS blocks: a Guardian that asks for a review does not let the candidate through either
  const inReview = await setup({ guardian: { evaluate: () => ({ report_id: 'gr_r', outcome: 'REVIEW_REQUIRED', hard_outcome: 'PASS', rule_results: [] }) } }).run();
  assert.equal(inReview.status, 'GUARDIAN_FAIL');
  // the verdict: whatever the critic concludes, a failing or missing Guardian means the candidate is not ready for the owner
  const allPass = C.normalizeCritique({ dimensions: C.DIMENSIONS.map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' })) }, { candidate_ref: 'c', candidate_sha256: result.png_sha256 });
  const ok = { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' };
  assert.equal(C.finalizeVerdict({ critique: allPass, deterministic: ok }).ready_for_owner_review, true);
  for (const bad of ['FAIL', 'REVIEW_REQUIRED', 'NOT_MEASURABLE', null]) {
    const v = C.finalizeVerdict({ critique: allPass, deterministic: { ...ok, guardian: bad } });
    assert.equal(v.ready_for_owner_review, false, String(bad));
    assert.equal(v.production_status, 'BLOCKED_BY_A_DETERMINISTIC_GATE');
  }
  for (const gate of ['preflight', 'fidelity']) assert.equal(C.finalizeVerdict({ critique: allPass, deterministic: { ...ok, [gate]: 'FAIL' } }).ready_for_owner_review, false, gate);
  // a CREATIVE_FAIL also blocks owner review, even with every gate passing; a non-FAIL critic with every gate passing does not
  const failed = C.normalizeCritique({ dimensions: [failing('PRICE_INTEGRATION', 'Integrate the price more subtly.'), ...C.DIMENSIONS.filter((d) => d !== 'PRICE_INTEGRATION').map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' }))] }, { candidate_ref: 'c', candidate_sha256: result.png_sha256 });
  const vf = C.finalizeVerdict({ critique: failed, deterministic: ok });
  assert.equal(vf.ready_for_owner_review, false);
  assert.deepEqual(vf.owner_review_blockers, ['CREATIVE_FAIL']);
  const review = C.normalizeCritique({ dimensions: [{ dimension: 'PRICE_INTEGRATION', outcome: 'REVIEW_REQUIRED', evidence: 'The price weight is arguable here.', revision_hint: 'Integrate the price more subtly.' }, ...C.DIMENSIONS.filter((d) => d !== 'PRICE_INTEGRATION').map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' }))] }, { candidate_ref: 'c', candidate_sha256: result.png_sha256 });
  assert.equal(C.finalizeVerdict({ critique: review, deterministic: ok }).ready_for_owner_review, true);
  assert.equal(C.finalizeVerdict({ critique: review, deterministic: ok }).owner_approval, 'PENDING');
});

test('RV-8 the real Brand Guardian gate runs on the runtime candidate and its hard rules decide (typography family not approved => GUARDIAN_FAIL)', async () => {
  const json = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), 'utf8'));
  const pkg = await json('benchmarks/creative-intelligence/habb-brand-canonical-v1.json');
  const expression = (await json(pkg.inputs.expression_file)).expression_system;
  const brand = buildBrandPackage(pkg.inputs, expression);
  const gate = createBrandGuardianGate({ tenant: brand.tenant, brandContext: brand.context, evaluatedAt: AT, targetRef: 'candidate:test' });
  // the synthetic world types in DejaVu Sans, which the approved Brand Memory does not allow: the REAL Guardian fails the candidate, deterministically
  const result = await setup({ guardian: gate }).run();
  assert.equal(result.fidelity.gate, 'PASS');
  assert.equal(result.status, 'GUARDIAN_FAIL');
  const rules = Object.fromEntries(result.guardian.rule_results.map((r) => [r.rule_id, r.outcome]));
  assert.equal(rules['habb-typography-two-families'], 'FAIL');
  assert.equal(rules['habb-palette-closed'], 'PASS');
  assert.equal(rules['habb-product-fidelity-gate'], 'PASS');
});

test('RV-9 at most 3 candidates in a revision loop, with each revision produced by the runtime from the previous record', async () => {
  const answers = [REVISED(), REVISED({ spatial_intent: 'PRODUCT_CENTER_TEXT_ABOVE', hierarchy: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'], concept: 'The case sits low in the frame with the message above it, lit softly.', visual_intent: 'a pale concrete surface with a gentle gradient of window light and visible fine grain' })];
  const s = null;
  const { result: first } = await base();
  void s;
  const criticOf = () => C.createCreativeCritic({
    vlm: { invoke: async () => ({ text: JSON.stringify({ dimensions: C.DIMENSIONS.map((dimension) => (dimension === 'PRICE_INTEGRATION' ? failing(dimension, 'Integrate the price more subtly into the composition.') : { dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' })) }) }) },
  });
  let produced = 0;
  let lastResult = first;
  const gates = (r) => ({ preflight: r.preflight.status, fidelity: r.fidelity.gate, guardian: r.guardian.outcome });
  const loop = (maxCandidates) => C.runCreativeLoop({
    critic: criticOf(), brief: { public_facts: {}, brand_principles: {}, verified_elsewhere: [] }, maxCandidates,
    initial: { ref: 'c1', png_bytes: first.png_bytes, deterministic: gates(first) },
    authorizeRevision: async () => true,
    produce: async ({ revision_request: request, iteration, previous }) => {
      produced += 1;
      const critique = critiqueFor(lastResult, [failing('PRICE_INTEGRATION', 'Integrate the price more subtly.')]);
      const next = await setup({ revisionAnswer: answers[(iteration - 2) % answers.length] }).run({
        revision: { previous_direction: lastResult.direction, candidate_evidence: buildCandidateEvidence({ result: lastResult, candidate_sha256: lastResult.png_sha256 }), critique, revision_request: C.buildRevisionRequest({ critique, iteration: 1 }) },
      });
      void request; void previous;
      lastResult = next;
      return { ref: `c${iteration}`, png_bytes: next.png_bytes, deterministic: gates(next) };
    },
  });
  await assert.rejects(() => loop(4), RangeError);
  assert.equal(produced, 0);
  const result = await loop(3);
  assert.equal(result.candidates_produced, 3);
  assert.equal(produced, 2);
  assert.equal(result.stop_reason, 'MAX_CANDIDATES_REACHED');
  assert.equal(result.owner_approval, 'PENDING');
  assert.ok(result.iterations.every((i) => i.verdict.production_status === 'AWAITING_OWNER_APPROVAL'));
});

test('RV-10 there is no manual creative steering path: a revision needs its Director, takes only the allow-listed evidence and decides nothing by hand', async () => {
  const { revision, result } = await base();
  // a revision without a revision Director stops (it never falls back to the initial Director or to a hand-made choice)
  const bare = setup();
  delete bare.agents.revision_director;
  const stopped = await runProductPreservingCreative({ at: AT, brief: buildBrief(), fonts, agents: bare.agents, ports: bare.ports, ledger: bare.ledger, guardian: GUARDIAN_PASS, revision });
  assert.equal(stopped.status, 'BLOCKED');
  assert.equal(stopped.reason, 'A_REVISION_NEEDS_A_REVISION_DIRECTOR');
  assert.equal(bare.prompts.length, 0);
  // the runtime accepts no layout, colour or size override: its parameters are the brief, the agents, the ports and the evidence
  const source = await readFile(new URL('../src/creative-runtime/runtime.js', import.meta.url), 'utf8');
  const params = source.slice(source.indexOf('runProductPreservingCreative({') + 'runProductPreservingCreative({'.length, source.indexOf('}) {')).split(',').map((p) => p.trim().split('=')[0].trim()).filter(Boolean);
  assert.deepEqual(params, ['at', 'brief', 'fonts', 'agents', 'ports', 'ledger', 'guardian', 'revision']);
  // the candidate evidence holds facts, never geometry
  const evidence = buildCandidateEvidence({ result, candidate_sha256: result.png_sha256 });
  assert.doesNotMatch(JSON.stringify(evidence), /"(x|y|width|height|box|geometry|font_size|color)"/);
  assert.ok(Object.isFrozen(evidence));
  // the ledger of a revised run holds no foreign decision
  const { revised } = await revisedRun();
  assert.equal(revised.steering.manual_creative_steering, 'NONE');
  assert.equal(revised.steering.run_complete, true);
  void sha; void P;
});
