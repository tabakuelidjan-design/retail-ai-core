import test from 'node:test';
import assert from 'node:assert/strict';

import { DIMENSIONS, normalizeCritique } from '../src/creative-critic/index.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  assertPlanCoherent, CONCEPT_DIMENSIONS, createCreativeBrain, normalizeConceptCritique, toDirectionFields,
} from '../src/creative-brain/index.js';
import {
  artDirectionAnswer, brief as makeBrief, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, OTHER_CONCEPTS as OTHER, scriptedPort,
} from './creative-brain-world.js';

// THE BRAIN (`// BR-N` markers): the stages run in order, each answers the one before, rejected concepts never come back, recovery redoes only what the failure calls for.

const SHA = 'b'.repeat(64);
const ctx = { candidate_ref: 'cand-1', candidate_sha256: SHA };
const critique14 = (outcomes = {}) => normalizeCritique({
  dimensions: DIMENSIONS.map((dimension) => {
    const outcome = outcomes[dimension] ?? 'PASS';
    return { dimension, outcome, evidence: 'Concrete visible evidence for this judgment.', ...(outcome === 'FAIL' || outcome === 'REVIEW_REQUIRED' ? { revision_hint: 'Make the point clearer in plain words.' } : {}) };
  }),
}, ctx);
const conceptCritique = (outcomes = {}) => normalizeConceptCritique({
  dimensions: CONCEPT_DIMENSIONS.map((dimension) => {
    const outcome = outcomes[dimension] ?? 'PASS';
    return { dimension, outcome, evidence: 'Concrete visible evidence for this judgment.', ...(outcome === 'FAIL' || outcome === 'REVIEW_REQUIRED' ? { revision_hint: 'Give the idea more presence in plain words.' } : {}) };
  }),
}, ctx);

// concept sets: the first is the shared fixture; a second round needs three NEW distinct concepts

const withIds = async (list) => {
  const { normalizeConceptSet } = await import('../src/creative-brain/index.js');
  return normalizeConceptSet(list);
};

const goodRound = async (list, picks) => ({
  ideate: { concepts: list },
  select: evaluationsAnswer(await withIds(list), picks),
});

async function script(extra = {}) {
  const first = await goodRound(CONCEPTS, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }]);
  return scriptedPort({
    frame: [frameAnswer()], ideate: [first.ideate], select: [first.select], art_direct: [artDirectionAnswer()], compose: [compositionAnswer()], ...extra,
  });
}

const brain = (port, ledger = createDecisionLedger()) => ({ brain: createCreativeBrain({ complete: port.complete, ledger }), ledger });

test('BR-1 the stages run in order and each makes exactly one model call; the plan is coherent and has an id from its parts', async () => {
  const port = await script();
  const { brain: b, ledger } = brain(port);
  const out = await b.plan({ brief: makeBrief() });
  assert.equal(out.status, 'PLANNED');
  assert.deepEqual(port.calls.map((c) => c.stage), ['frame', 'ideate', 'select', 'art_direct', 'compose']);
  const p = out.plan;
  assert.match(p.plan_id, /^plan_/);
  assert.equal(p.concept.concept_id, p.art_direction.concept_id);
  assert.equal(p.scene.art_direction_id, p.art_direction.art_direction_id);
  assert.equal(p.production_plan.composition_id, p.composition.composition_id);
  assert.equal(p.layout_choice.source, 'SYNTHESIZED');
  assert.equal(p.scene.integration_zone.reservation, 'REQUIRED');
  assert.equal(p.production_plan.executable, true);
  assert.ok(Object.isFrozen(p));
  // the ledger attributes every stage to a Nordla component, with a concise rationale
  const attribution = ledger.attribution();
  for (const d of ['OBSERVATION', 'PROBLEM_FRAME', 'CONCEPT_ROUND', 'CONCEPT_SELECTION', 'ART_DIRECTION', 'COMPOSITION_PLAN', 'SCENE_SPEC', 'PRODUCTION_PLAN']) assert.ok(attribution[d]?.length === 1, d);
  assert.equal(ledger.of('PROBLEM_FRAME')[0].outcome.request_id, 'req-frame-1');
  assert.ok(ledger.of('ART_DIRECTION')[0].outcome.rationale.length > 10);
  // the same inputs give the same plan
  const again = await (await script()).complete && (await brain(await script()).brain.plan({ brief: makeBrief() }));
  assert.equal(again.plan.plan_id, p.plan_id);
});

test('BR-2 no stage asks for, stores or depends on private reasoning', async () => {
  const port = await script();
  const { brain: b, ledger } = brain(port);
  const out = await b.plan({ brief: makeBrief() });
  for (const c of port.calls) {
    assert.doesNotMatch(c.instruction.system, /chain[- ]of[- ]thought|think (out loud|step)|step[- ]by[- ]step|show your (work|reasoning)|explain your reasoning/i);
    assert.match(c.instruction.system, /Return ONLY one JSON object|ONE JSON object|only one JSON/i);
  }
  assert.doesNotMatch(JSON.stringify(out.plan) + JSON.stringify(ledger.entries()), /chain.of.thought|reasoning_content|thinking/i);
});

test('BR-3 a round that selects nothing never produces anything; the next round excludes everything that was judged weak', async () => {
  const bad = await goodRound(CONCEPTS, [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }]);
  const second = await goodRound(OTHER, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }]);
  const port = scriptedPort({ frame: [frameAnswer()], ideate: [bad.ideate, second.ideate], select: [bad.select, second.select], art_direct: [artDirectionAnswer({ narrative_elements: [] })], compose: [compositionAnswer()] });
  const { brain: b } = brain(port);
  const out = await b.plan({ brief: makeBrief() });
  assert.equal(out.status, 'PLANNED');
  assert.equal(port.calls.filter((c) => c.stage === 'ideate').length, 2);
  const secondIdeate = port.calls.filter((c) => c.stage === 'ideate')[1].instruction.system;
  assert.match(secondIdeate, /Concepts already rejected/);
  for (const c of CONCEPTS) assert.ok(secondIdeate.includes(c.central_idea), c.central_idea);
  assert.ok(out.plan.rounds.length === 2 && out.plan.rounds[0].selection.outcome === 'REJECT_CONCEPT');
  // two rounds without a selection: the brain stops, and calls neither the art director nor the composition planner
  const none = scriptedPort({ frame: [frameAnswer()], ideate: [bad.ideate, second.ideate], select: [bad.select, await (async () => evaluationsAnswer(await withIds(OTHER), [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }]))()] });
  const stop = await brain(none).brain.plan({ brief: makeBrief() });
  assert.equal(stop.status, 'NO_CONCEPT_SELECTED');
  assert.equal(stop.plan, undefined);
  assert.ok(!none.calls.some((c) => ['art_direct', 'compose'].includes(c.stage)));
});

test('BR-4 a promising concept is refined in the next round, with its own refinements, not discarded', async () => {
  const r1 = await goodRound(CONCEPTS, [{ CONCEPT_STRENGTH: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }, { DISTINCTIVENESS: 'FAILS' }]);
  const r2 = await goodRound(CONCEPTS, [{}, { GENERIC_RISK: 'FAILS' }, { DISTINCTIVENESS: 'FAILS' }]);
  const port = scriptedPort({ frame: [frameAnswer()], ideate: [r1.ideate, { concepts: [CONCEPTS[0], ...OTHER.slice(0, 2)] }], select: [r1.select, evaluationsAnswer(await withIds([CONCEPTS[0], ...OTHER.slice(0, 2)]), [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }])], art_direct: [artDirectionAnswer()], compose: [compositionAnswer()] });
  const out = await brain(port).brain.plan({ brief: makeBrief() });
  assert.equal(out.status, 'PLANNED');
  const second = port.calls.filter((c) => c.stage === 'ideate')[1].instruction.system;
  assert.match(second, /One concept is to be REFINED, not replaced/);
  assert.ok(second.includes(CONCEPTS[0].central_idea));
  assert.match(second, /Concepts already rejected/);
  assert.ok(second.includes(CONCEPTS[1].central_idea) && second.includes(CONCEPTS[2].central_idea));
  void r2;
});

test('BR-5 a composition that drops an approved text, or invents one, makes the plan incoherent', async () => {
  const port = await script({ compose: [compositionAnswer({ narrative_flow: ['HEADLINE', 'PRODUCT', 'PRICE'], visual_weight: { HEADLINE: 'STRONG', PRODUCT: 'STRONG', PRICE: 'QUIET' }, grouping: [['HEADLINE'], ['PRICE']] })] });
  const e = await brain(port).brain.plan({ brief: makeBrief() }).catch((x) => x);
  assert.equal(e.code, 'BRAIN_RULE_VIOLATION');
  assert.equal(e.detail.problem, 'COMPOSITION_DROPS_OR_INVENTS_A_TEXT_ROLE');
  const ok = (await brain(await script()).brain.plan({ brief: makeBrief() })).plan;
  const broken = { ...ok, art_direction: { ...ok.art_direction, concept_id: 'cnc_other' } };
  assert.throws(() => assertPlanCoherent(broken), (x) => x.detail?.problem === 'ART_DIRECTION_IS_NOT_OF_THE_SELECTED_CONCEPT');
  assert.throws(() => assertPlanCoherent({ ...ok, scene: { ...ok.scene, art_direction_id: 'art_other' } }), (x) => x.detail?.problem === 'SCENE_IS_NOT_OF_THE_ART_DIRECTION');
  assert.throws(() => assertPlanCoherent({ ...ok, production_plan: { ...ok.production_plan, composition_id: 'cmp_other' } }), (x) => x.detail?.problem === 'PRODUCTION_PLAN_IS_NOT_OF_THE_COMPOSITION');
});

test('BR-6 the plan feeds the canonical Creative Direction fields; it does not bypass the existing contracts', async () => {
  const { plan } = await brain(await script()).brain.plan({ brief: makeBrief() });
  const f = toDirectionFields(plan);
  assert.deepEqual(Object.keys(f).sort(), ['concept', 'copy_intent', 'hierarchy', 'negative_space_intent', 'product_role', 'scene_ref', 'spatial_intent', 'visual_intent']);
  assert.equal(f.concept, plan.concept.central_idea.slice(0, 300));
  assert.equal(f.product_role, 'HERO');
  assert.equal(f.spatial_intent, 'PRODUCT_START_TEXT_END');
  assert.equal(f.negative_space_intent, 'SURROUNDING');
  assert.deepEqual(f.hierarchy, plan.composition.narrative_flow);
  for (const k of ['concept', 'copy_intent', 'visual_intent']) assert.ok(f[k].length >= 1 && f[k].length <= 300, k);
  assert.doesNotMatch(JSON.stringify(f), /[0-9]\.[0-9]|\bx\b.*\by\b/);
});

test('BR-7 recovery: REFINE keeps the composition, RECOMPOSE keeps the art direction, RECONCEPT keeps only the frame; each is ledgered', async () => {
  const base = await brain(await script()).brain.plan({ brief: makeBrief() });
  const plan = base.plan;
  // NOTHING
  const nothing = await brain(await script()).brain.replan({ brief: makeBrief(), plan, critique: critique14({}), conceptCritique: conceptCritique({}) });
  assert.equal(nothing.status, 'NOTHING_TO_RECOVER');
  // REFINE: a new art direction (with the critic's hints), the same composition
  const refinePort = scriptedPort({ art_direct: [artDirectionAnswer({ lighting_intent: 'A low light raking from the side, with a deeper shadow beyond.' })] });
  const { brain: rb, ledger: rl } = brain(refinePort);
  const refined = await rb.replan({ brief: makeBrief(), plan, critique: critique14({ PRICE_INTEGRATION: 'FAIL' }), conceptCritique: conceptCritique({}) });
  assert.equal(refined.status, 'REPLANNED');
  assert.equal(refined.diagnosis.action, 'REFINE');
  assert.deepEqual(refinePort.calls.map((c) => c.stage), ['art_direct']);
  assert.match(refinePort.calls[0].instruction.system, /REVISION of an earlier art direction/);
  assert.equal(refined.plan.composition.composition_id, plan.composition.composition_id);
  assert.notEqual(refined.plan.art_direction.art_direction_id, plan.art_direction.art_direction_id);
  assert.equal(refined.plan.concept.concept_id, plan.concept.concept_id);
  assert.ok(refined.plan.production_plan.required.some((r) => r.capability === 'LOCAL_REFINEMENT'));
  assert.deepEqual(refined.plan.production_plan.degradations, ['REGENERATE_THE_SCENE_ONLY_WITH_THE_SAME_CONCEPT_AND_COMPOSITION']);
  assert.equal(rl.of('RECOVERY_DECISION')[0].outcome.action, 'REFINE');
  // RECOMPOSE: the same art direction, a new composition
  const recomposePort = scriptedPort({ compose: [compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'MIDDLE' }, alignment_family: 'CENTER' })] });
  const recomposed = await brain(recomposePort).brain.replan({ brief: makeBrief(), plan, critique: critique14({ VISUAL_HIERARCHY: 'FAIL' }), conceptCritique: conceptCritique({}) });
  assert.equal(recomposed.diagnosis.action, 'RECOMPOSE');
  assert.deepEqual(recomposePort.calls.map((c) => c.stage), ['compose']);
  assert.match(recomposePort.calls[0].instruction.system, /RE-COMPOSITION/);
  assert.equal(recomposed.plan.art_direction.art_direction_id, plan.art_direction.art_direction_id);
  assert.notEqual(recomposed.plan.composition.composition_id, plan.composition.composition_id);
  // RECONCEPT: new concepts that exclude the failed one, then a new art direction and composition
  const r = await goodRound(OTHER, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }]);
  const reconceptPort = scriptedPort({ ideate: [r.ideate], select: [r.select], art_direct: [artDirectionAnswer({ narrative_elements: [] })], compose: [compositionAnswer()] });
  const reconcepted = await brain(reconceptPort).brain.replan({ brief: makeBrief(), plan, critique: critique14({}), conceptCritique: conceptCritique({ CONCEPT_STRENGTH: 'FAIL' }) });
  assert.equal(reconcepted.diagnosis.action, 'RECONCEPT');
  assert.deepEqual(reconceptPort.calls.map((c) => c.stage), ['ideate', 'select', 'art_direct', 'compose']);
  assert.ok(reconceptPort.calls[0].instruction.system.includes(plan.concept.central_idea));
  assert.notEqual(reconcepted.plan.concept.concept_id, plan.concept.concept_id);
  assert.ok(!reconcepted.plan.production_plan.required.some((x) => x.capability === 'LOCAL_REFINEMENT'));
});

test('BR-8 every ledger decision of the Brain belongs to a Nordla component: manual creative steering stays NONE', async () => {
  const { manualSteeringReport } = await import('../src/creative-runtime/ledger.js');
  const { brain: b, ledger } = brain(await script());
  await b.plan({ brief: makeBrief() });
  const report = manualSteeringReport(ledger);
  assert.equal(report.manual_creative_steering, 'NONE');
  assert.ok(Object.values(report.attribution).every((components) => components.every((c) => /^nordla:[a-z-]+@1$/.test(c))));
  assert.throws(() => ledger.record({ decision: 'CONCEPT_SELECTION', decided_by: 'THE_OWNER' }), (e) => e.code === 'DECISION_NOT_ATTRIBUTABLE_TO_A_NORDLA_COMPONENT');
});

test('BR-9 with bounds, the concept rounds are a budget for the whole life of the brain: a re-conception gets only what planning left', async () => {
  const first = await goodRound(CONCEPTS, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }]);
  const rejectAll = await goodRound(OTHER, [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }]);
  const port = scriptedPort({
    frame: [frameAnswer()], ideate: [first.ideate, rejectAll.ideate, first.ideate], select: [first.select, rejectAll.select, first.select], art_direct: [artDirectionAnswer()], compose: [compositionAnswer()],
  });
  const brain = createCreativeBrain({ complete: port.complete, bounds: { concept_rounds: 2, concepts_per_round: 3 } });
  assert.equal(brain.remainingConceptRounds(), 2);
  const planned = await brain.plan({ brief: makeBrief() });
  assert.equal(planned.status, 'PLANNED');
  assert.equal(brain.remainingConceptRounds(), 1);
  const out = await brain.replan({ brief: makeBrief(), plan: planned.plan, critique: critique14({}), conceptCritique: conceptCritique({ CONCEPT_STRENGTH: 'FAIL' }) });
  assert.equal(out.status, 'NO_CONCEPT_SELECTED');
  assert.equal(port.calls.filter((c) => c.stage === 'ideate').length, 2);
  assert.equal(brain.remainingConceptRounds(), 0);
  // nothing is left: a second re-conception makes no model call at all
  const before = port.calls.length;
  const again = await brain.replan({ brief: makeBrief(), plan: planned.plan, critique: critique14({}), conceptCritique: conceptCritique({ CONCEPT_STRENGTH: 'FAIL' }) });
  assert.equal(again.status, 'NO_CONCEPT_SELECTED');
  assert.equal(port.calls.length, before);
  // the concepts per round are bounded too
  assert.match(port.calls.find((c) => c.stage === 'ideate').instruction.system, /exactly 3 concepts/);
});
