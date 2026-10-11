import test from 'node:test';
import assert from 'node:assert/strict';

import * as CI from '../src/creative-intelligence/index.js';
import {
  buildCompositionInstruction, composeLayout, CompositionNotRealizable, createCompositionPlanner, normalizeCompositionPlan, synthesizeRecipe,
} from '../src/creative-brain/index.js';
import {
  assetDims, demoDocument, fonts, LATER,
} from './creative-intelligence-fixtures.js';
import { compositionAnswer, scriptedPort } from './creative-brain-world.js';

// COMPOSITION INTELLIGENCE (`// CP-N` markers): relational plans, consistency, a deterministic synthesizer bound by the presets' invariants, and the real solver still deciding.

const plan = (over) => normalizeCompositionPlan(compositionAnswer(over));
const code = (fn, c) => assert.throws(fn, (e) => e.code === c, c);
const problem = (fn) => { try { fn(); } catch (e) { return e.detail?.problem ?? e.code; } return null; };
const FOUR = { HEADLINE: 'STRONG', SUBHEADLINE: 'QUIET', PRODUCT: 'STRONG', PRICE: 'QUIET' };
const ALL_FLOW = ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE', 'CTA'];
const withCta = (over = {}) => compositionAnswer({
  narrative_flow: ALL_FLOW, visual_weight: { ...FOUR, CTA: 'QUIET' }, grouping: [['HEADLINE', 'SUBHEADLINE'], ['PRICE', 'CTA']], ...over,
});

test('CP-1 a plan is closed, relational, numberless, with a content-derived id', () => {
  const p = plan();
  assert.match(p.composition_id, /^cmp_/);
  assert.equal(plan().composition_id, p.composition_id);
  assert.notEqual(plan({ alignment_family: 'END' }).composition_id, p.composition_id);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.visual_weight));
  code(() => plan({ extra: 'x' }), 'BRAIN_UNKNOWN_KEY');
  code(() => plan({ product_anchor: { horizontal: 'START', vertical: 'MIDDLE', x: 'x' } }), 'BRAIN_UNKNOWN_KEY');
  code(() => plan({ hero_relationship: 'BIGGEST' }), 'BRAIN_ENUM_INVALID');
  code(() => plan({ text_adjacency: 'DIAGONAL' }), 'BRAIN_ENUM_INVALID');
  code(() => plan({ product_anchor: { horizontal: 'START', vertical: 3 } }), 'BRAIN_NUMERIC_VALUE');
  code(() => plan({ negative_space_reservation: [{ region: 'SURROUNDING', extent: 'HUGE' }] }), 'BRAIN_ENUM_INVALID');
  code(() => plan({ negative_space_reservation: Array.from({ length: 4 }, () => ({ region: 'TOP', extent: 'SMALL' })) }), 'BRAIN_LIST_INVALID');
  code(() => plan({ composition_id: 'cmp_forged' }), 'BRAIN_RULE_VIOLATION');
  assert.equal(plan({ composition_id: p.composition_id }).composition_id, p.composition_id);
});

test('CP-2 the flow, weights and grouping describe the same roles, each once', () => {
  code(() => plan({ narrative_flow: ['HEADLINE', 'HEADLINE', 'PRODUCT'] }), 'BRAIN_RULE_VIOLATION');
  code(() => plan({ narrative_flow: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'QUIET', PRICE: 'QUIET' } }), 'BRAIN_RULE_VIOLATION'); // no product
  code(() => plan({ visual_weight: { HEADLINE: 'STRONG', PRODUCT: 'STRONG' } }), 'BRAIN_RULE_VIOLATION'); // weights miss roles
  code(() => plan({ visual_weight: { ...FOUR, PRODUCT: 'HUGE' } }), 'BRAIN_ENUM_INVALID');
  code(() => plan({ grouping: [['HEADLINE'], ['PRICE']] }), 'BRAIN_RULE_VIOLATION'); // a text role is missing
  code(() => plan({ grouping: [['HEADLINE', 'SUBHEADLINE'], ['PRICE', 'HEADLINE']] }), 'BRAIN_RULE_VIOLATION'); // a role twice
  code(() => plan({ grouping: [['HEADLINE', 'SUBHEADLINE', 'PRODUCT'], ['PRICE']] }), 'BRAIN_RULE_VIOLATION'); // the product is not text
  // a flow with no product is refused even when the other relations would allow it (a leading headline needs no strong product)
  const noProduct = (() => { try { plan({ hero_relationship: 'HEADLINE_LEADS_PRODUCT_ANSWERS', narrative_flow: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'QUIET', PRICE: 'QUIET' } }); } catch (e) { return e; } return null; })();
  assert.equal(noProduct?.code, 'BRAIN_RULE_VIOLATION');
  assert.equal(noProduct.field, 'composition.narrative_flow');
  assert.doesNotThrow(() => normalizeCompositionPlan(withCta()));
});

test('CP-3 the relations must agree with each other', () => {
  assert.equal(problem(() => plan({ hero_relationship: 'PRODUCT_DOMINATES' })), 'PRODUCT_DOMINATES_NEEDS_A_DOMINANT_PRODUCT');
  assert.doesNotThrow(() => plan({ hero_relationship: 'PRODUCT_DOMINATES', visual_weight: { ...FOUR, PRODUCT: 'DOMINANT' } }));
  assert.equal(problem(() => plan({ visual_weight: { ...FOUR, HEADLINE: 'QUIET' } })), 'SHARED_HERO_NEEDS_A_STRONG_PRODUCT_AND_A_STRONG_HEADLINE');
  assert.equal(problem(() => plan({ hero_relationship: 'HEADLINE_LEADS_PRODUCT_ANSWERS', visual_weight: { ...FOUR, HEADLINE: 'QUIET' } })), 'A_LEADING_HEADLINE_NEEDS_A_STRONGER_HEADLINE_THAN_PRODUCT');
  assert.equal(problem(() => plan({ hero_relationship: 'HEADLINE_LEADS_PRODUCT_ANSWERS', visual_weight: { ...FOUR, PRODUCT: 'DOMINANT' } })), 'A_LEADING_HEADLINE_NEEDS_A_STRONGER_HEADLINE_THAN_PRODUCT');
  assert.doesNotThrow(() => plan({ hero_relationship: 'HEADLINE_LEADS_PRODUCT_ANSWERS', visual_weight: { ...FOUR, HEADLINE: 'DOMINANT', PRODUCT: 'BALANCED' } }));
  assert.equal(problem(() => plan({ hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE' })), 'A_RECEDING_PRODUCT_IS_NOT_STRONG');
  assert.doesNotThrow(() => plan({ hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE', visual_weight: { ...FOUR, PRODUCT: 'QUIET' } }));
  assert.equal(problem(() => plan({ product_anchor: { horizontal: 'CENTER', vertical: 'MIDDLE' } })), 'A_TEXT_BESIDE_THE_PRODUCT_NEEDS_THE_PRODUCT_TO_ANCHOR_TO_A_SIDE');
  assert.equal(problem(() => plan({ text_adjacency: 'ABOVE', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' } })), 'TEXT_ABOVE_THE_PRODUCT_NEEDS_THE_PRODUCT_LOWER');
  assert.equal(problem(() => plan({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'LOWER' } })), 'TEXT_BELOW_THE_PRODUCT_NEEDS_THE_PRODUCT_HIGHER');
});

test('CP-4 the synthesizer is deterministic and always yields a recipe that satisfies the preset invariants', () => {
  const a = synthesizeRecipe(plan());
  assert.deepEqual(synthesizeRecipe(plan()), a);
  assert.match(a.recipe_id, /^SYNTH_[0-9a-f]{10}$/);
  assert.doesNotThrow(() => CI.assertValidLayoutRecipe(a));
  assert.deepEqual(a.slots.map((s) => s.role).sort(), ['HEADLINE', 'PRICE', 'PRODUCT', 'SUBHEADLINE']);
  assert.ok(Object.isFrozen(a));
  const cases = [];
  for (const adjacency of ['BESIDE', 'ABOVE', 'BELOW', 'STAGGERED']) {
    for (const horizontal of ['START', 'CENTER', 'END']) {
      for (const vertical of ['UPPER', 'MIDDLE', 'LOWER']) {
        for (const alignment of ['START', 'CENTER', 'END']) cases.push({ text_adjacency: adjacency, product_anchor: { horizontal, vertical }, alignment_family: alignment });
      }
    }
  }
  let built = 0; let planned = 0;
  for (const c of cases) {
    let p;
    try { p = plan(c); } catch (e) { assert.equal(e.code, 'BRAIN_RULE_VIOLATION'); continue; }
    planned += 1;
    try { const r = synthesizeRecipe(p); CI.assertValidLayoutRecipe(r); built += 1; } catch (e) { assert.ok(e instanceof CompositionNotRealizable, e.message); }
  }
  assert.ok(planned > 60 && built > 40, `${planned} planned, ${built} built`);
  // different relations give different geometry
  const ids = new Set(['BESIDE', 'ABOVE', 'BELOW', 'STAGGERED'].map((t) => {
    const anchor = { BESIDE: { horizontal: 'START', vertical: 'MIDDLE' }, STAGGERED: { horizontal: 'END', vertical: 'UPPER' }, ABOVE: { horizontal: 'CENTER', vertical: 'LOWER' }, BELOW: { horizontal: 'CENTER', vertical: 'MIDDLE' } }[t];
    return synthesizeRecipe(plan({ text_adjacency: t, product_anchor: anchor })).recipe_id;
  }));
  assert.equal(ids.size, 4);
});

test('CP-5 a relation the solver cannot guarantee is refused, never ignored', () => {
  const overlapping = plan({ overlap_permission: 'PRODUCT_OVERLAPS_TEXT_FRAME' });
  const e = (() => { try { synthesizeRecipe(overlapping); } catch (x) { return x; } return null; })();
  assert.ok(e instanceof CompositionNotRealizable);
  assert.equal(e.problem, 'OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER');
  // a stack that cannot fit its region at a legible proportion
  const crowded = normalizeCompositionPlan(withCta({
    text_adjacency: 'ABOVE', product_anchor: { horizontal: 'CENTER', vertical: 'MIDDLE' }, hero_relationship: 'PRODUCT_DOMINATES', visual_weight: { HEADLINE: 'DOMINANT', SUBHEADLINE: 'DOMINANT', PRODUCT: 'DOMINANT', PRICE: 'DOMINANT', CTA: 'DOMINANT' },
  }));
  const f = (() => { try { synthesizeRecipe(crowded); } catch (x) { return x; } return null; })();
  assert.ok(f instanceof CompositionNotRealizable);
  assert.match(f.problem, /NO_ROOM_FOR_THE_TEXT_BLOCK|THE_TEXT_STACK_DOES_NOT_FIT_ITS_REGION/);
});

test('CP-6 the layout comes from the plan or from an explicit, named preset fallback; never a silent substitution', () => {
  const ok = composeLayout({ plan: plan(), fallbackRecipeId: 'PRODUCT_HERO' });
  assert.equal(ok.source, 'SYNTHESIZED');
  assert.ok(ok.recipe && ok.recipe_id === null && ok.reason === null);
  const overlapping = plan({ overlap_permission: 'PRODUCT_OVERLAPS_TEXT_FRAME' });
  const fb = composeLayout({ plan: overlapping, fallbackRecipeId: 'PRODUCT_HERO' });
  assert.deepEqual({ source: fb.source, recipe: fb.recipe, recipe_id: fb.recipe_id, reason: fb.reason }, { source: 'PRESET_FALLBACK', recipe: null, recipe_id: 'PRODUCT_HERO', reason: 'OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER' });
  const none = composeLayout({ plan: overlapping });
  assert.equal(none.source, 'NONE');
  assert.equal(none.recipe_id, null);
  assert.ok(none.reason);
});

test('CP-7 the real solver accepts a synthesized recipe and still decides geometry; an invalid recipe never reaches placement', () => {
  const recipe = synthesizeRecipe(plan());
  const solve = (r) => CI.solveLayout({ document: demoDocument(), recipe: r, fonts: fonts(), assets: assetDims(), created_at: LATER });
  const result = solve(recipe);
  assert.equal(result.recipe_id, recipe.recipe_id);
  assert.ok(result.placements.length >= 4);
  assert.ok(result.usable_rect.width > 0);
  const product = result.placements.find((p) => /product/i.test(JSON.stringify(p)));
  assert.ok(product);
  // the same plan gives the same layout
  assert.deepEqual(solve(synthesizeRecipe(plan())).placements, result.placements);
  // a recipe with overlapping slots, or outside the area, or with no id is refused before placement
  const overlap = { ...recipe, slots: recipe.slots.map((s, i) => (i === 1 ? { ...s, x: recipe.slots[0].x, y: recipe.slots[0].y, w: recipe.slots[0].w, h: recipe.slots[0].h } : s)) };
  assert.throws(() => solve(overlap), (e) => e.code === 'LAYOUT_RECIPE_INVALID');
  assert.throws(() => solve({ ...recipe, slots: recipe.slots.map((s, i) => (i === 0 ? { ...s, w: 1.4 } : s)) }), (e) => e.code === 'LAYOUT_RECIPE_INVALID');
  assert.throws(() => solve({ ...recipe, slots: recipe.slots.map((s, i) => (i === 0 ? { ...s, w: 0 } : s)) }), (e) => e.code === 'LAYOUT_RECIPE_INVALID' && /positive size/.test(e.message));
  assert.throws(() => solve({ ...recipe, recipe_id: '' }), (e) => e.code === 'LAYOUT_RECIPE_INVALID');
  assert.throws(() => solve({ ...recipe, margin_ratio: 0.5 }), (e) => e.code === 'LAYOUT_RECIPE_INVALID');
  // the presets remain available and unchanged
  assert.equal(CI.solveLayout({ document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER }).recipe_id, 'PRODUCT_HERO');
});

test('CP-8 the planner instruction asks for relations only, carries the approved roles, and the model cannot return geometry', async () => {
  const { system, user } = buildCompositionInstruction({ frame: { f: 1 }, concept: { c: 1 }, artDirection: { a: 1 }, hints: ['give the product more room'], approvedRoles: ['HEADLINE', 'PRICE'] });
  assert.match(system, /you never give a coordinate, a size, a margin or any number/);
  assert.match(system, /RE-COMPOSITION/);
  assert.match(system, /give the product more room/);
  assert.match(system, /ALL of them must appear in the flow: HEADLINE, PRICE/);
  assert.deepEqual(Object.keys(JSON.parse(user)), ['problem_frame', 'concept', 'art_direction']);
  const port = scriptedPort({ compose: [compositionAnswer()] });
  const { composition } = await createCompositionPlanner({ complete: port.complete }).plan({ frame: {}, concept: {}, artDirection: {} });
  assert.match(composition.composition_id, /^cmp_/);
  const geometry = await createCompositionPlanner({ complete: async () => ({ text: JSON.stringify({ ...compositionAnswer(), x: 0.4 }) }) }).plan({ frame: {}, concept: {}, artDirection: {} }).catch((x) => x);
  assert.ok(['BRAIN_NUMERIC_VALUE', 'BRAIN_UNKNOWN_KEY'].includes(geometry.code));
});
