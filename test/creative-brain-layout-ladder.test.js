import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApprovedCopyAgent, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, describeStop, recipesForIntent, runProductPreservingCreative,
  selectLayoutRecipe,
} from '../src/creative-runtime/index.js';
import {
  composeLayout, CompositionNotRealizable, createCreativeBrain, directionFromPlan, normalizeCompositionPlan, normalizeConceptSet, synthesizeRecipe, synthesizeRecipeLadder,
} from '../src/creative-brain/index.js';
import {
  BRAND, buildBrief, fakeEnvironmentPort, fonts, GUARDIAN_PASS,
} from './runtime-world.js';
import {
  artDirectionAnswer, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// THE LAYOUT LADDER (`// LL-N` markers). Regression of the first live benchmark, which stopped with NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT: the relational plan WAS synthesized, but its first
// proportions did not fit the real approved words, the preset lookup then had nothing for an END-anchored intent, and the record only kept the preset's reason. The structure below is the failed
// plan's (a dominant product anchored to the end, text beside it, start-aligned); the words are the test world's.

const AT = '2026-10-12T12:00:00.000Z';
const PALE = artDirectionAnswer({
  narrative_elements: [{ element: 'a pair of worn tools laid aside at the edge of the bench', reason: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' }],
});
const END_BESIDE = {
  hero_relationship: 'PRODUCT_DOMINATES',
  product_anchor: { horizontal: 'END', vertical: 'MIDDLE' },
  text_adjacency: 'BESIDE',
  alignment_family: 'START',
  visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRODUCT: 'DOMINANT', PRICE: 'QUIET' },
  grouping: [['HEADLINE', 'SUBHEADLINE'], ['PRICE']],
  overlap_permission: 'NONE',
  negative_space_reservation: [{ region: 'TOP', extent: 'MEDIUM' }, { region: 'START', extent: 'SMALL' }, { region: 'SURROUNDING', extent: 'LARGE' }],
  narrative_flow: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'],
  rationale: 'The product anchors to the end and dominates; the words enter first from the start.',
};
const planOf = (over = {}) => normalizeCompositionPlan({ ...END_BESIDE, ...over });

async function brainPlan(compose, brief = buildBrief()) {
  const port = scriptedPort({
    frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [evaluationsAnswer(normalizeConceptSet(CONCEPTS), [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }])], art_direct: [PALE], compose: [compose],
  });
  const out = await createCreativeBrain({ complete: port.complete }).plan({ brief });
  assert.equal(out.status, 'PLANNED');
  return out.plan;
}

function runtime(brief = buildBrief()) {
  const ledger = createDecisionLedger(); const environment = fakeEnvironmentPort();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: { invoke: async () => { throw new Error('the Creative Director must not be consulted'); } },
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  return { ledger, environment, run: (extra) => runProductPreservingCreative({ at: AT, brief, fonts, ledger, guardian: GUARDIAN_PASS, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, ...extra }) };
}

test('LL-1 a plan has a deterministic ladder of recipes: every rung keeps every relation and flexes only the text proportion', () => {
  const plan = planOf();
  const ladder = synthesizeRecipeLadder(plan);
  assert.ok(ladder.length >= 5);
  assert.deepEqual(synthesizeRecipeLadder(plan).map((r) => r.recipe.recipe_id), ladder.map((r) => r.recipe.recipe_id));
  assert.equal(ladder[0].relaxation, 'NONE');
  assert.equal(ladder[0].recipe.recipe_id, synthesizeRecipe(plan).recipe_id);
  let previousWidth = Infinity;
  for (const [i, rung] of ladder.entries()) {
    assert.equal(rung.step, i);
    const product = rung.recipe.slots.find((s) => s.role === 'PRODUCT');
    assert.equal(product.align, 'END'); // the anchor never changes
    assert.ok(Math.abs(product.x + product.w - 1) < 1e-9);
    assert.ok(product.w < previousWidth); previousWidth = product.w;
    const largestText = Math.max(...rung.recipe.slots.filter((s) => s.role !== 'PRODUCT').map((s) => s.w * s.h));
    assert.ok(i === 0 || product.w * product.h >= 2.5 * largestText - 1e-9, 'a dominant product stays dominant BY AREA on every relaxed rung');
    assert.equal(rung.recipe.text_alignment, 'START');
    assert.deepEqual(rung.recipe.slots.map((s) => s.role).sort(), ['HEADLINE', 'PRICE', 'PRODUCT', 'SUBHEADLINE']);
    const text = rung.recipe.slots.filter((s) => s.role !== 'PRODUCT');
    assert.ok(text.every((s) => s.x + s.w <= product.x + 1e-9), 'the text stays beside the product');
  }
  // a column cannot be relaxed below the floor of its weight: the ladder ends instead of changing the relations
  assert.throws(() => synthesizeRecipe(plan, { step: 99 }), (e) => e instanceof CompositionNotRealizable && e.problem === 'NO_FURTHER_RELAXATION_PRESERVES_THE_RELATIONS');
  // a centred stack has nothing to relax
  const centred = synthesizeRecipeLadder(planOf({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'CENTER' }));
  assert.equal(centred.length, 1);
  const stacked = synthesizeRecipeLadder(planOf({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' }));
  assert.equal(stacked.length, 2); // a dominant product stops the widening of the text block as soon as it would lose its weight by area
  const quiet = synthesizeRecipeLadder(planOf({ hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE', visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRODUCT: 'QUIET', PRICE: 'QUIET' }, text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' }));
  assert.equal(quiet.length, 5); // 0.72, 0.79, 0.86, 0.93, then the full width: the ladder ends where the text block cannot grow
  assert.ok(stacked[1].recipe.slots.find((s) => s.role === 'HEADLINE').w > stacked[0].recipe.slots.find((s) => s.role === 'HEADLINE').w);
  assert.ok(Object.isFrozen(ladder) && Object.isFrozen(ladder[0]));
});

test('LL-2 the relational plan is attempted BEFORE any preset: it lays out an intent that NO preset maps, deterministically', async () => {
  const plan = await brainPlan(END_BESIDE);
  const brief = buildBrief();
  const direction = directionFromPlan({ plan, ids: brief.ids, assetRef: brief.asset.ref, claimRefs: brief.claims.map((c) => c.ref) });
  assert.equal(direction.spatial_intent, 'PRODUCT_END_TEXT_START');
  assert.deepEqual(recipesForIntent(direction), []);
  assert.equal(selectLayoutRecipe(direction, ['HEADLINE', 'SUBHEADLINE', 'PRICE']).recipe_id, null);
  assert.equal(plan.layout_choice.source, 'SYNTHESIZED');
  const s = runtime();
  const result = await s.run({ creativePlan: plan });
  assert.equal(result.status, 'READY_FOR_REVIEW');
  const row = s.ledger.of('LAYOUT_RECIPE')[0];
  assert.equal(row.outcome.source, 'SYNTHESIZED');
  assert.match(row.outcome.recipe_id, /^SYNTH_/);
  assert.equal(row.outcome.spatial_intent, 'PRODUCT_END_TEXT_START');
  assert.ok(row.outcome.attempts.length >= 1 && row.outcome.attempts.at(-1).outcome === 'SOLVED');
  // the same plan lays out the same way
  const again = runtime();
  await again.run({ creativePlan: plan });
  assert.equal(again.ledger.of('LAYOUT_RECIPE')[0].outcome.recipe_id, row.outcome.recipe_id);
  assert.equal(s.environment.calls.length, 1);
});

test('LL-3 an unsupported relation fails with a precise reason, and a missing preset is reported WITH it (never alone)', async () => {
  const plan = await brainPlan({ ...END_BESIDE, overlap_permission: 'PRODUCT_OVERLAPS_TEXT_FRAME' });
  assert.equal(plan.layout_choice.source, 'NONE');
  assert.equal(plan.layout_choice.reason, 'OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER');
  const s = runtime();
  const result = await s.run({ creativePlan: plan });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'NO_EXECUTABLE_LAYOUT_FOR_THE_COMPOSITION');
  assert.deepEqual(result.layout_attempts, []);
  assert.deepEqual(result.preset_fallback, { attempted: true, reason: 'NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT', spatial_intent: 'PRODUCT_END_TEXT_START' });
  assert.equal(result.before_environment_call, true);
  const row = s.ledger.of('LAYOUT_RECIPE')[0];
  assert.equal(row.rule, 'NO_EXECUTABLE_LAYOUT_FOR_THE_COMPOSITION');
  assert.equal(row.outcome.source, 'NONE');
  assert.equal(describeStop({ result }).cause, 'LAYOUT_CAPABILITY_LIMIT');
  assert.equal(result.steering.manual_creative_steering, 'NONE');
  // no provider call happened before an executable layout existed
  assert.equal(s.environment.calls.length, 0);
});

test('LL-4 the preset fallback comes ONLY after every rung of the relational ladder failed, and the whole attempt is recorded', async () => {
  const long = buildBrief();
  long.claims = long.claims.map((c) => (c.role === 'SUBHEADLINE' ? { ...c, wording: 'Coque personnalisée avec votre photo préférée imprimée en quelques minutes seulement dans notre atelier de Namur et livrée aussitôt' } : c));
  const plan = await brainPlan({ ...END_BESIDE, product_anchor: { horizontal: 'START', vertical: 'MIDDLE' } }, long);
  assert.equal(plan.layout_choice.source, 'SYNTHESIZED');
  const s = runtime(long);
  const result = await s.run({ creativePlan: plan });
  const rows = s.ledger.of('LAYOUT_RECIPE');
  assert.equal(rows.length, 1);
  const outcome = rows[0].outcome;
  assert.equal(outcome.source, 'PRESET_FALLBACK');
  assert.equal(outcome.fallback_reason, 'THE_SYNTHESIZED_RECIPE_DID_NOT_SOLVE_FOR_THE_APPROVED_TEXTS');
  assert.ok(outcome.attempts.length === plan.layout_choice.ladder.length);
  assert.ok(outcome.attempts.every((a) => a.outcome === 'NOT_SOLVED' && a.violations.some((v) => v.code === 'TEXT_DOES_NOT_FIT')));
  assert.ok(!/^SYNTH_/.test(outcome.recipe_id));
  // the preset cannot carry such a text either: nothing is paid for
  assert.equal(result.status, 'BLOCKED');
  assert.equal(s.environment.calls.length, 0);
});

test('LL-5 composeLayout keeps its explicit contract: the first rung, the ladder, or a named reason', () => {
  const ok = composeLayout({ plan: planOf(), fallbackRecipeId: 'EDITORIAL_SPLIT' });
  assert.equal(ok.source, 'SYNTHESIZED');
  assert.equal(ok.recipe.recipe_id, ok.ladder[0].recipe.recipe_id);
  const bad = composeLayout({ plan: planOf({ overlap_permission: 'PRODUCT_OVERLAPS_TEXT_FRAME' }), fallbackRecipeId: 'EDITORIAL_SPLIT' });
  assert.deepEqual({ source: bad.source, recipe_id: bad.recipe_id, reason: bad.reason, ladder: bad.ladder }, { source: 'PRESET_FALLBACK', recipe_id: 'EDITORIAL_SPLIT', reason: 'OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER', ladder: undefined });
});
