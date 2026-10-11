import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApprovedCopyAgent, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { createCreativeBrain, directionFromPlan, normalizeConceptSet } from '../src/creative-brain/index.js';
import {
  BRAND, buildBrief, fakeEnvironmentPort, fonts, GUARDIAN_PASS,
} from './runtime-world.js';
import {
  artDirectionAnswer, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// RUNTIME INTEGRATION (`// RI-N` markers): a Creative Brain plan directs the production runtime without bypassing any of its gates.

const AT = '2026-10-10T12:00:00.000Z';

const PALE_WINDOW = artDirectionAnswer({
  narrative_elements: [
    { element: 'a pair of worn tools laid aside at the edge of the bench', reason: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' },
    { element: 'a pale window far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' },
  ],
});

async function planWith(compose = compositionAnswer(), art = PALE_WINDOW) {
  const port = scriptedPort({
    frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [evaluationsAnswer(normalizeConceptSet(CONCEPTS), [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }])],
    art_direct: [art], compose: [compose],
  });
  const out = await createCreativeBrain({ complete: port.complete }).plan({ brief: buildBrief() });
  assert.equal(out.status, 'PLANNED');
  return out.plan;
}

function runtime() {
  const ledger = createDecisionLedger(); const environment = fakeEnvironmentPort();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: { invoke: async () => { throw new Error('the Creative Director must not be consulted when a plan directs the run'); } },
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  return { ledger, environment, run: (extra) => runProductPreservingCreative({ at: AT, brief: buildBrief(), fonts, ledger, guardian: GUARDIAN_PASS, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, ...extra }) };
}

test('RI-1 the plan becomes a canonical CreativeDirection through the C1 contract itself', async () => {
  const plan = await planWith();
  const brief = buildBrief();
  const d = directionFromPlan({ plan, ids: brief.ids, assetRef: brief.asset.ref, claimRefs: brief.claims.map((c) => c.ref) });
  assert.match(d.direction_id, /^cdr_/);
  assert.equal(d.spatial_intent, 'PRODUCT_START_TEXT_END');
  assert.deepEqual(d.hierarchy, plan.composition.narrative_flow);
  assert.deepEqual(d.required_asset_refs, [brief.asset.ref]);
  assert.throws(() => directionFromPlan({ plan, ids: { ...brief.ids, merchant_id: 'not-a-uuid' }, assetRef: brief.asset.ref }));
});

test('RI-2 a synthesized recipe lays out the creative: the Director is not consulted, the scene request carries the reserved zone, and every existing gate still runs', async () => {
  const plan = await planWith(compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' }));
  assert.equal(plan.layout_choice.source, 'SYNTHESIZED');
  const s = runtime();
  const result = await s.run({ creativePlan: plan });
  assert.notEqual(result.status, 'BLOCKED', JSON.stringify({ reason: result.reason, ...result.violations ? { v: result.violations } : {} }));
  assert.equal(result.status, 'READY_FOR_REVIEW');
  // the provider got a text-only scene request projected from the scene spec
  assert.equal(s.environment.calls.length, 1);
  const request = s.environment.calls[0];
  assert.deepEqual(request.input_asset_refs, []);
  assert.match(request.prompt, /^A photograph of /);
  assert.match(request.prompt, /completely calm and empty/);
  assert.match(request.prompt, /in the upper part of the frame, in the centre, completely calm/); // the product is placed at the top centre by the synthesized recipe
  assert.doesNotMatch(request.prompt, /phone|case|product/i);
  // the ledger shows the plan, the synthesized recipe and the zone; the gates ran
  const rows = Object.fromEntries(s.ledger.entries().map((e) => [e.decision, e]));
  assert.equal(rows.CREATIVE_DIRECTION.rule, 'CREATIVE_BRAIN_PLAN_PROJECTED_TO_THE_CANONICAL_DIRECTION');
  assert.equal(rows.CREATIVE_DIRECTION.outcome.scene_id, plan.scene.scene_id);
  assert.equal(rows.LAYOUT_RECIPE.outcome.source, 'SYNTHESIZED');
  assert.match(rows.LAYOUT_RECIPE.outcome.recipe_id, /^SYNTH_/);
  assert.equal(rows.PROVIDER_REQUEST_CONSTRUCTION.rule, 'SCENE_SPEC_PROJECTED_WITH_A_RESERVED_INTEGRATION_ZONE');
  assert.equal(rows.PROVIDER_REQUEST_CONSTRUCTION.outcome.integration_zone.horizontal, 'CENTER');
  for (const d of ['ENVIRONMENT_SUITABILITY', 'TYPOGRAPHY_PLACEMENT', 'PREFLIGHT']) assert.ok(rows[d], d);
  assert.equal(result.steering.manual_creative_steering, 'NONE');
});

test('RI-3 when the plan has no synthesizable layout, the run falls back to the named preset, explicitly', async () => {
  const plan = await planWith(compositionAnswer({ overlap_permission: 'PRODUCT_OVERLAPS_TEXT_FRAME' }));
  assert.equal(plan.layout_choice.source, 'NONE'); // the brain itself had no preset to name
  const s = runtime();
  const result = await s.run({ creativePlan: plan });
  assert.notEqual(result.status, undefined);
  const row = s.ledger.of('LAYOUT_RECIPE')[0];
  assert.equal(row.outcome.source, 'PRESET_FALLBACK');
  assert.equal(row.outcome.fallback_reason, 'OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER');
});

test('RI-4 a run without a plan is unchanged: the Director is consulted and no Brain decision is recorded', async () => {
  const s = runtime();
  const e = await s.run({}).catch((x) => x);
  assert.match(e.message, /Creative Director must not be consulted/);
  assert.equal(s.ledger.of('CREATIVE_DIRECTION').length, 0);
});

test('RI-5 the brand rules stay authoritative over a rich scene: a scene that asks for what the brand forbids stops before any provider call', async () => {
  const plan = await planWith(compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' }), artDirectionAnswer());
  const s = runtime();
  const result = await s.run({ creativePlan: plan });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'SCENE_VIOLATES_BRAND_FORBIDDEN_VISUALS');
  assert.equal(s.environment.calls.length, 0);
});

test('RI-6 a synthesized recipe that the solver cannot realize for the real approved texts gives way to the named preset, with the reason recorded and no provider call wasted', async () => {
  const plan = await planWith(); // BESIDE: a narrow text column that the long approved supporting claim cannot fit
  assert.equal(plan.layout_choice.source, 'SYNTHESIZED');
  const s = runtime();
  const result = await s.run({ creativePlan: plan });
  const row = s.ledger.of('LAYOUT_RECIPE')[0];
  assert.equal(row.outcome.source, 'PRESET_FALLBACK');
  assert.equal(row.outcome.fallback_reason, 'THE_SYNTHESIZED_RECIPE_DID_NOT_SOLVE_FOR_THE_APPROVED_TEXTS');
  assert.ok(!/^SYNTH_/.test(row.outcome.recipe_id));
  if (result.status === 'BLOCKED') assert.equal(s.environment.calls.length, 0);
});

test('RI-7 a synthesized recipe without a slot for an approved text is not used: the preset takes over and says why', async () => {
  const plan = await planWith(compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' }));
  const recipe = plan.layout_choice.recipe;
  const without = { ...plan, layout_choice: { ...plan.layout_choice, recipe: { ...recipe, slots: recipe.slots.filter((slot) => slot.role !== 'PRICE') } } };
  const s = runtime();
  await s.run({ creativePlan: without });
  const row = s.ledger.of('LAYOUT_RECIPE')[0];
  assert.equal(row.outcome.source, 'PRESET_FALLBACK');
  assert.equal(row.outcome.fallback_reason, 'THE_SYNTHESIZED_RECIPE_HAS_NO_SLOT_FOR_AN_APPROVED_TEXT');
});
