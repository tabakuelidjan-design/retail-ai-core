import { createHash } from 'node:crypto';

import { assertValidLayoutRecipe } from '../creative-intelligence/layout-recipes.js';
import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import { askAndNormalize } from './model-port.js';
import {
  BRAIN_ERROR, closed, deepFreeze, deriveId, enumOf, fail, listOf, noNumbers, oneLine,
} from './validation.js';

// COMPOSITION INTELLIGENCE. The five fixed recipes remain as safe presets and fallbacks, but a creative is no longer limited to them. A CompositionPlan states RELATIONS (the hero relationship, where
// the product anchors, how the text block stands to the product, the alignment family, the visual weight of every element, the grouping, the negative space to reserve, the reading flow); it holds
// no coordinate. A deterministic synthesizer turns the plan into a layout recipe (slots as fractions of the usable area) that must satisfy the very invariants of the presets (in bounds, one slot per
// role, no overlap), and the existing constraint solver still resolves the real geometry, text fitting, collisions and readability. A relation the solver cannot guarantee (a layer overlapping another)
// is declared unsupported and refused, never silently ignored. Whether the plan is realizable for the real approved texts is decided by solving it, not by hope.

export const HERO_RELATIONSHIP = Object.freeze({
  PRODUCT_DOMINATES: 'PRODUCT_DOMINATES', PRODUCT_AND_HEADLINE_SHARE: 'PRODUCT_AND_HEADLINE_SHARE', HEADLINE_LEADS_PRODUCT_ANSWERS: 'HEADLINE_LEADS_PRODUCT_ANSWERS', PRODUCT_RECEDES_INTO_SCENE: 'PRODUCT_RECEDES_INTO_SCENE',
});
export const WEIGHT = Object.freeze({ DOMINANT: 'DOMINANT', STRONG: 'STRONG', BALANCED: 'BALANCED', QUIET: 'QUIET' });
export const TEXT_ADJACENCY = Object.freeze({ BESIDE: 'BESIDE', ABOVE: 'ABOVE', BELOW: 'BELOW', STAGGERED: 'STAGGERED' });
export const ALIGNMENT_FAMILY = Object.freeze({ START: 'START', CENTER: 'CENTER', END: 'END' });
export const ANCHOR_HORIZONTAL = Object.freeze({ START: 'START', CENTER: 'CENTER', END: 'END' });
export const ANCHOR_VERTICAL = Object.freeze({ UPPER: 'UPPER', MIDDLE: 'MIDDLE', LOWER: 'LOWER' });
export const OVERLAP_PERMISSION = Object.freeze({ NONE: 'NONE', PRODUCT_OVERLAPS_TEXT_FRAME: 'PRODUCT_OVERLAPS_TEXT_FRAME' });
export const RESERVE_REGION = Object.freeze({ START: 'START', END: 'END', TOP: 'TOP', BOTTOM: 'BOTTOM', SURROUNDING: 'SURROUNDING' });
export const RESERVE_EXTENT = Object.freeze({ SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE' });
const FLOW_ROLE = Object.freeze({ HEADLINE: 'HEADLINE', SUBHEADLINE: 'SUBHEADLINE', PRICE: 'PRICE', CTA: 'CTA', PRODUCT: 'PRODUCT' });
const TEXT_ROLES = ['HEADLINE', 'SUBHEADLINE', 'PRICE', 'CTA'];

const MODEL_KEYS = ['hero_relationship', 'product_anchor', 'text_adjacency', 'alignment_family', 'visual_weight', 'grouping', 'overlap_permission', 'negative_space_reservation', 'narrative_flow', 'rationale'];
const PLAN_KEYS = ['composition_id', ...MODEL_KEYS];

const rank = (w) => ['QUIET', 'BALANCED', 'STRONG', 'DOMINANT'].indexOf(w);

/** A relational plan from a model's fields: closed, no figure, complete and consistent (the relations must not contradict each other). */
export function normalizeCompositionPlan(raw) {
  noNumbers(raw, 'composition');
  const { composition_id: givenId, ...fields } = raw;
  closed(fields, MODEL_KEYS, 'composition');
  closed(fields.product_anchor, ['horizontal', 'vertical'], 'composition.product_anchor');
  const flow = listOf(fields.narrative_flow, 'composition.narrative_flow', { min: 2, max: 5 }, (v, w) => enumOf(v, FLOW_ROLE, w));
  if (new Set(flow).size !== flow.length) fail(BRAIN_ERROR.RULE_VIOLATION, 'the narrative flow lists a role twice', 'composition.narrative_flow');
  if (!flow.includes('PRODUCT')) fail(BRAIN_ERROR.RULE_VIOLATION, 'the narrative flow includes the product', 'composition.narrative_flow');
  if (!isObject(fields.visual_weight)) fail(BRAIN_ERROR.MALFORMED, 'composition.visual_weight must be an object', 'composition.visual_weight');
  const weightKeys = Object.keys(fields.visual_weight).sort();
  if (JSON.stringify(weightKeys) !== JSON.stringify([...flow].sort())) fail(BRAIN_ERROR.RULE_VIOLATION, 'visual_weight names exactly the roles of the flow', 'composition.visual_weight');
  const visualWeight = Object.fromEntries(flow.map((role) => [role, enumOf(fields.visual_weight[role], WEIGHT, `composition.visual_weight.${role}`)]));
  const textRoles = flow.filter((r) => r !== 'PRODUCT');
  const grouping = listOf(fields.grouping, 'composition.grouping', { min: 1, max: 4 }, (g, w) => listOf(g, w, { min: 1, max: 4 }, (role, ww) => enumOf(role, FLOW_ROLE, ww)));
  const grouped = grouping.flat();
  if (JSON.stringify([...grouped].sort()) !== JSON.stringify([...textRoles].sort())) fail(BRAIN_ERROR.RULE_VIOLATION, 'the grouping partitions the text roles of the flow, each exactly once', 'composition.grouping');
  const body = {
    hero_relationship: enumOf(fields.hero_relationship, HERO_RELATIONSHIP, 'composition.hero_relationship'),
    product_anchor: { horizontal: enumOf(fields.product_anchor.horizontal, ANCHOR_HORIZONTAL, 'composition.product_anchor.horizontal'), vertical: enumOf(fields.product_anchor.vertical, ANCHOR_VERTICAL, 'composition.product_anchor.vertical') },
    text_adjacency: enumOf(fields.text_adjacency, TEXT_ADJACENCY, 'composition.text_adjacency'),
    alignment_family: enumOf(fields.alignment_family, ALIGNMENT_FAMILY, 'composition.alignment_family'),
    visual_weight: visualWeight,
    grouping,
    overlap_permission: enumOf(fields.overlap_permission, OVERLAP_PERMISSION, 'composition.overlap_permission'),
    negative_space_reservation: listOf(fields.negative_space_reservation, 'composition.negative_space_reservation', { min: 0, max: 3 }, (r, w) => {
      closed(r, ['region', 'extent'], w);
      return { region: enumOf(r.region, RESERVE_REGION, `${w}.region`), extent: enumOf(r.extent, RESERVE_EXTENT, `${w}.extent`) };
    }),
    narrative_flow: flow,
    rationale: oneLine(fields.rationale, 'composition.rationale'),
  };
  assertConsistent(body);
  const id = deriveId('cmp', body);
  if (givenId !== undefined && givenId !== id) fail(BRAIN_ERROR.RULE_VIOLATION, 'composition_id does not follow from the content', 'composition.composition_id');
  return deepFreeze({ composition_id: id, ...body });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The relations of a plan must agree with each other. */
function assertConsistent(plan) {
  const w = plan.visual_weight; const p = w.PRODUCT; const h = w.HEADLINE;
  const violation = (reason) => fail(BRAIN_ERROR.RULE_VIOLATION, 'the relations of the composition plan contradict each other', 'composition', { problem: reason });
  if (plan.hero_relationship === HERO_RELATIONSHIP.PRODUCT_DOMINATES && p !== WEIGHT.DOMINANT) violation('PRODUCT_DOMINATES_NEEDS_A_DOMINANT_PRODUCT');
  if (plan.hero_relationship === HERO_RELATIONSHIP.PRODUCT_AND_HEADLINE_SHARE && !(p === WEIGHT.STRONG && h === WEIGHT.STRONG)) violation('SHARED_HERO_NEEDS_A_STRONG_PRODUCT_AND_A_STRONG_HEADLINE');
  if (plan.hero_relationship === HERO_RELATIONSHIP.HEADLINE_LEADS_PRODUCT_ANSWERS && !(h && rank(h) >= rank(WEIGHT.STRONG) && rank(p) <= rank(WEIGHT.STRONG))) violation('A_LEADING_HEADLINE_NEEDS_A_STRONGER_HEADLINE_THAN_PRODUCT');
  if (plan.hero_relationship === HERO_RELATIONSHIP.PRODUCT_RECEDES_INTO_SCENE && rank(p) > rank(WEIGHT.BALANCED)) violation('A_RECEDING_PRODUCT_IS_NOT_STRONG');
  const { horizontal, vertical } = plan.product_anchor;
  if ([TEXT_ADJACENCY.BESIDE, TEXT_ADJACENCY.STAGGERED].includes(plan.text_adjacency) && horizontal === ANCHOR_HORIZONTAL.CENTER) violation('A_TEXT_BESIDE_THE_PRODUCT_NEEDS_THE_PRODUCT_TO_ANCHOR_TO_A_SIDE');
  if (plan.text_adjacency === TEXT_ADJACENCY.ABOVE && vertical === ANCHOR_VERTICAL.UPPER) violation('TEXT_ABOVE_THE_PRODUCT_NEEDS_THE_PRODUCT_LOWER');
  if (plan.text_adjacency === TEXT_ADJACENCY.BELOW && vertical === ANCHOR_VERTICAL.LOWER) violation('TEXT_BELOW_THE_PRODUCT_NEEDS_THE_PRODUCT_HIGHER');
}

// ---- the deterministic synthesizer
const PRODUCT_SIZE = Object.freeze({ DOMINANT: [0.6, 0.62], STRONG: [0.48, 0.52], BALANCED: [0.4, 0.42], QUIET: [0.3, 0.3] });
const TEXT_HEIGHT = Object.freeze({
  HEADLINE: { DOMINANT: 0.26, STRONG: 0.2, BALANCED: 0.14, QUIET: 0.09 },
  SUBHEADLINE: { DOMINANT: 0.16, STRONG: 0.13, BALANCED: 0.105, QUIET: 0.085 },
  PRICE: { DOMINANT: 0.16, STRONG: 0.12, BALANCED: 0.095, QUIET: 0.075 },
  CTA: { DOMINANT: 0.09, STRONG: 0.075, BALANCED: 0.065, QUIET: 0.055 },
});
const PRICE_WIDTH = Object.freeze({ DOMINANT: 0.9, STRONG: 0.75, BALANCED: 0.6, QUIET: 0.5 });
// the bounded relaxation ladder of a plan (a narrower product column or a wider text block, never a changed relation)
const COLUMN_STEP = 0.025; const BLOCK_STEP = 0.07; const MAX_RELAX_STEPS = 12;
// a relaxation may never change the visual weight the plan states: the product slot keeps this multiple of the area of the largest text slot (a dominant product stays dominant by area)
const DOMINANCE_RATIO = Object.freeze({ DOMINANT: 2.5, STRONG: 1.5, BALANCED: 1.0, QUIET: 0.5 });
const GAP = 0.04; const GAP_IN = 0.012; const MIN_SCALE = 0.55; const BLOCK_WIDTH = 0.72;
const r4 = (n) => Math.round(n * 10000) / 10000;

export class CompositionNotRealizable extends Error {
  constructor(problem, detail = {}) { super(`the composition plan is not realizable: ${problem}`); this.name = 'CompositionNotRealizable'; this.code = 'COMPOSITION_NOT_REALIZABLE'; this.problem = problem; this.detail = detail; }
}

/**
 * A layout recipe from a plan. Deterministic, pure. Throws CompositionNotRealizable for a relation the solver cannot guarantee (a layer overlapping another), for a text stack that cannot fit its region
 * at a legible proportion, or for a recipe that would break the invariants of the presets.
 */
export function synthesizeRecipe(plan, { step = 0 } = {}) {
  if (plan.overlap_permission !== OVERLAP_PERMISSION.NONE) throw new CompositionNotRealizable('OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER');
  const [pw, ph] = PRODUCT_SIZE[plan.visual_weight.PRODUCT];
  const adjacency = plan.text_adjacency; const { horizontal, vertical } = plan.product_anchor;
  const sideways = adjacency === TEXT_ADJACENCY.BESIDE || adjacency === TEXT_ADJACENCY.STAGGERED;
  // product slot
  let w = sideways ? Math.min(pw, 0.56) : Math.min(pw + 0.2, 0.9);
  // RELAXATION: the relations of the plan never change, only the measured proportion of the text column, one bounded step at a time, so that the REAL approved words can fit (the solver decides)
  if (step > 0) {
    if (sideways) w = r4(w - (COLUMN_STEP * step));
    else if (plan.alignment_family === 'CENTER' || BLOCK_WIDTH + (BLOCK_STEP * step) > 1 + 1e-9) throw new CompositionNotRealizable('NO_FURTHER_RELAXATION_PRESERVES_THE_RELATIONS', { step });
  }
  const h = sideways ? ph + 0.18 : Math.min(ph, 0.5);
  const px = horizontal === 'START' ? 0 : (horizontal === 'END' ? 1 - w : (1 - w) / 2);
  let py;
  if (adjacency === TEXT_ADJACENCY.ABOVE) py = vertical === 'LOWER' ? 1 - h : 1 - h - 0.06;
  else if (adjacency === TEXT_ADJACENCY.BELOW) py = vertical === 'UPPER' ? 0 : 0.06;
  else py = vertical === 'UPPER' ? 0.02 : (vertical === 'LOWER' ? 1 - h - 0.02 : (1 - h) / 2);
  const product = { role: 'PRODUCT', x: r4(px), y: r4(py), w: r4(w), h: r4(Math.min(h, 1 - py)), align: sideways ? horizontal : 'CENTER' };
  // text region
  let region;
  if (sideways) region = horizontal === 'START' ? { x: w + GAP, y: 0.04, w: 1 - w - GAP, h: 0.92 } : { x: 0, y: 0.04, w: 1 - w - GAP, h: 0.92 };
  else {
    const blockW = plan.alignment_family === 'CENTER' ? 1 : Math.min(1, r4(BLOCK_WIDTH + (BLOCK_STEP * step)));
    const x = plan.alignment_family === 'END' ? 1 - blockW : 0;
    region = adjacency === TEXT_ADJACENCY.ABOVE ? { x, y: 0.02, w: blockW, h: Math.max(0, py - GAP - 0.02) } : { x, y: product.y + product.h + GAP, w: blockW, h: Math.max(0, 0.98 - (product.y + product.h + GAP)) };
  }
  if (region.w < 0.25 || region.h < 0.2) throw new CompositionNotRealizable('NO_ROOM_FOR_THE_TEXT_BLOCK', { region });
  // text stack: groups in order, each role at the height of its weight, scaled down together if the region is short
  const textRoles = plan.narrative_flow.filter((r) => r !== 'PRODUCT');
  const orderedGroups = plan.grouping.map((g) => textRoles.filter((r) => g.includes(r))).filter((g) => g.length).sort((a, b) => plan.narrative_flow.indexOf(a[0]) - plan.narrative_flow.indexOf(b[0]));
  const heights = Object.fromEntries(textRoles.map((r) => [r, TEXT_HEIGHT[r][plan.visual_weight[r]]]));
  const gaps = orderedGroups.reduce((s, g, i) => s + (g.length - 1) * GAP_IN + (i ? GAP : 0), 0);
  const total = Object.values(heights).reduce((s, v) => s + v, 0) + gaps;
  const scale = total > region.h ? (region.h - gaps) / Object.values(heights).reduce((s, v) => s + v, 0) : 1;
  if (scale < MIN_SCALE) throw new CompositionNotRealizable('THE_TEXT_STACK_DOES_NOT_FIT_ITS_REGION', { region, needed: total });
  const stack = Object.values(heights).reduce((s, v) => s + v * scale, 0) + gaps;
  // vertical placement of the stack in its region: with the product (BESIDE), opposite to it (STAGGERED), at the product's side of the region (ABOVE / BELOW)
  const wanted = adjacency === TEXT_ADJACENCY.STAGGERED ? { UPPER: 'LOWER', LOWER: 'UPPER', MIDDLE: 'MIDDLE' }[vertical] : vertical;
  let y = adjacency === TEXT_ADJACENCY.ABOVE ? region.y + region.h - stack : (adjacency === TEXT_ADJACENCY.BELOW ? region.y
    : (wanted === 'UPPER' ? region.y : (wanted === 'LOWER' ? region.y + region.h - stack : region.y + (region.h - stack) / 2)));
  const slots = [product];
  orderedGroups.forEach((group, gi) => {
    if (gi) y += GAP;
    group.forEach((role, ri) => {
      if (ri) y += GAP_IN;
      const sh = heights[role] * scale;
      let sw = region.w; let sx = region.x;
      if (role === 'PRICE') {
        sw = region.w * PRICE_WIDTH[plan.visual_weight.PRICE];
        sx = plan.alignment_family === 'START' ? region.x : (plan.alignment_family === 'END' ? region.x + region.w - sw : region.x + (region.w - sw) / 2);
      }
      slots.push({ role, x: r4(sx), y: r4(y), w: r4(sw), h: r4(sh) });
      y += sh;
    });
  });
  if (step > 0) {
    const area = (slot) => slot.w * slot.h;
    const largestText = Math.max(...slots.filter((slot) => slot.role !== 'PRODUCT').map(area));
    if (area(slots[0]) < DOMINANCE_RATIO[plan.visual_weight.PRODUCT] * largestText) throw new CompositionNotRealizable('NO_FURTHER_RELAXATION_PRESERVES_THE_RELATIONS', { step, reason: 'THE_PRODUCT_WOULD_LOSE_THE_VISUAL_WEIGHT_THE_PLAN_STATES' });
  }
  const hash = createHash('sha256').update(JSON.stringify(slots)).digest('hex').slice(0, 10);
  const recipe = { recipe_id: `SYNTH_${hash}`, description: step ? `synthesized from a relational composition plan (text proportion relaxed by ${step} step${step > 1 ? 's' : ''})` : 'synthesized from a relational composition plan', margin_ratio: 0.06, mirror_on_rtl: false, text_alignment: plan.alignment_family, slots };
  try { assertValidLayoutRecipe(recipe); } catch (error) { throw new CompositionNotRealizable('THE_SYNTHESIZED_RECIPE_BREAKS_A_LAYOUT_INVARIANT', { reason: error.message }); }
  return deepFreeze(recipe);
}

/**
 * The deterministic ladder of recipes of a plan: step 0 is the plan as stated, each further step keeps every relation and flexes only the proportion of the text column, until no relaxation
 * can preserve the relations. The first step is required (it throws like synthesizeRecipe); the production runtime tries the steps in order against the REAL approved texts.
 */
export function synthesizeRecipeLadder(plan) {
  const ladder = [{ step: 0, relaxation: 'NONE', recipe: synthesizeRecipe(plan) }];
  for (let step = 1; step <= MAX_RELAX_STEPS; step += 1) {
    let recipe;
    try { recipe = synthesizeRecipe(plan, { step }); } catch (error) { if (error instanceof CompositionNotRealizable) break; throw error; }
    ladder.push({ step, relaxation: 'TEXT_PROPORTION_RELAXED', recipe });
  }
  return deepFreeze(ladder);
}

/** The recipe of a plan, or an EXPLICIT fallback to a preset (never silent): { recipe, ladder, source, reason }. */
export function composeLayout({ plan, fallbackRecipeId = null }) {
  try { const ladder = synthesizeRecipeLadder(plan); return { recipe: ladder[0].recipe, ladder, recipe_id: null, source: 'SYNTHESIZED', reason: null }; } catch (error) {
    if (!(error instanceof CompositionNotRealizable)) throw error;
    return { recipe: null, recipe_id: fallbackRecipeId, source: fallbackRecipeId ? 'PRESET_FALLBACK' : 'NONE', reason: error.problem };
  }
}

export function buildCompositionInstruction({ frame, concept, artDirection, hints = [], approvedRoles = null }) {
  const vocab = (e) => Object.values(e).join(' | ');
  const system = [
    'You are the Nordla composition planner. From the art direction you state the RELATIONS of the composition; you never give a coordinate, a size, a margin or any number: a deterministic solver finds the geometry.',
    `Return ONLY one JSON object with exactly these keys: ${MODEL_KEYS.join(', ')}.`,
    `hero_relationship: ${vocab(HERO_RELATIONSHIP)}. text_adjacency: ${vocab(TEXT_ADJACENCY)}. alignment_family: ${vocab(ALIGNMENT_FAMILY)}. overlap_permission: ${vocab(OVERLAP_PERMISSION)}.`,
    `product_anchor is { horizontal: ${vocab(ANCHOR_HORIZONTAL)}, vertical: ${vocab(ANCHOR_VERTICAL)} }. visual_weight maps every role of the flow to ${vocab(WEIGHT)}.`,
    `narrative_flow is the reading order, a list of ${vocab(FLOW_ROLE)} that includes PRODUCT once. grouping is a list of groups (lists of text roles) that partitions the text roles of the flow. negative_space_reservation is a list (at most three) of { region: ${vocab(RESERVE_REGION)}, extent: ${vocab(RESERVE_EXTENT)} }.`,
    'The relations must agree with each other (a dominant product for PRODUCT_DOMINATES, a product anchored to a side when the text is beside it, text above only when the product is lower). Avoid the default centred stack unless the concept needs it.',
    'rationale is one concise sentence of why, for the record.',
    approvedRoles ? `The approved copy provides exactly these text roles, and ALL of them must appear in the flow: ${approvedRoles.join(', ')}.` : 'Use only the text roles the approved copy provides.',
    ...(hints.length ? ['This is a RE-COMPOSITION of an earlier plan for the same concept and art direction. Plan the relations again to answer these points (intents only):', ...hints.map((h) => `- ${h}`)] : []),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.COMPOSE })),
  ].join('\n');
  return { system, user: JSON.stringify({ problem_frame: frame, concept, art_direction: artDirection }) };
}

/** The COMPOSE stage: one model completion, then the closed contract and the consistency check. */
export function createCompositionPlanner({ complete }) {
  return Object.freeze({
    async plan({ frame, concept, artDirection, hints = [], approvedRoles = null }) {
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildCompositionInstruction({ frame, concept, artDirection, hints, approvedRoles }), stage: 'COMPOSE',
        schema: { keys: MODEL_KEYS, children: { product_anchor: { keys: ['horizontal', 'vertical'] }, negative_space_reservation: { items: { keys: ['region', 'extent'] } } } }, normalize: (raw) => normalizeCompositionPlan(raw),
      });
      return { composition: value, meta };
    },
  });
}

export { TEXT_ROLES };
