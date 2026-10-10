import { createHash } from 'node:crypto';

import { DIMENSION, DIMENSIONS, OUTCOME } from './dimensions.js';
import { assertSemanticHint } from './critique.js';

// From a critique to a REVISION REQUEST: semantic intent, never pixel micromanagement. A revision request says WHAT QUALITY must improve (a closed vocabulary of intents, each
// tied to the dimension that failed) and carries the critic's own plain-words hints as guidance; HOW to realize it (the direction, the recipe, the type scale, the environment) is
// decided by the Creative Director and the layout / typography runtime, so the request holds no coordinate, size, font or colour. The intents are about qualities every creative
// has, not about any product or campaign.

export const REVISION_INTENT = Object.freeze({
  INCREASE_PRODUCT_DOMINANCE: 'INCREASE_PRODUCT_DOMINANCE',
  IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION: 'IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION',
  CLARIFY_VISUAL_HIERARCHY: 'CLARIFY_VISUAL_HIERARCHY',
  CLARIFY_TEXT_HIERARCHY: 'CLARIFY_TEXT_HIERARCHY',
  REFINE_TYPOGRAPHIC_COMPOSITION: 'REFINE_TYPOGRAPHIC_COMPOSITION',
  ADJUST_CLAIM_PRESENTATION: 'ADJUST_CLAIM_PRESENTATION',
  INTEGRATE_PRICE_WITH_THE_COMPOSITION: 'INTEGRATE_PRICE_WITH_THE_COMPOSITION',
  REBALANCE_WHITESPACE: 'REBALANCE_WHITESPACE',
  REBALANCE_COMPOSITION: 'REBALANCE_COMPOSITION',
  STRENGTHEN_BRAND_EXPRESSION: 'STRENGTHEN_BRAND_EXPRESSION',
  ELEVATE_RETAIL_QUALITY: 'ELEVATE_RETAIL_QUALITY',
  REDUCE_TEMPLATE_FEEL: 'REDUCE_TEMPLATE_FEEL',
  REGENERATE_CLEANER_ENVIRONMENT: 'REGENERATE_CLEANER_ENVIRONMENT',
  RECONSIDER_THE_OVERALL_CONCEPT: 'RECONSIDER_THE_OVERALL_CONCEPT',
});

export const INTENT_FOR_DIMENSION = Object.freeze({
  [DIMENSION.PRODUCT_PROMINENCE]: REVISION_INTENT.INCREASE_PRODUCT_DOMINANCE,
  [DIMENSION.PRODUCT_INTEGRATION]: REVISION_INTENT.IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION,
  [DIMENSION.VISUAL_HIERARCHY]: REVISION_INTENT.CLARIFY_VISUAL_HIERARCHY,
  [DIMENSION.TEXT_HIERARCHY]: REVISION_INTENT.CLARIFY_TEXT_HIERARCHY,
  [DIMENSION.TYPOGRAPHY_COMPOSITION]: REVISION_INTENT.REFINE_TYPOGRAPHIC_COMPOSITION,
  [DIMENSION.CLAIM_VISIBILITY]: REVISION_INTENT.ADJUST_CLAIM_PRESENTATION,
  [DIMENSION.PRICE_INTEGRATION]: REVISION_INTENT.INTEGRATE_PRICE_WITH_THE_COMPOSITION,
  [DIMENSION.WHITESPACE_BALANCE]: REVISION_INTENT.REBALANCE_WHITESPACE,
  [DIMENSION.COMPOSITION_BALANCE]: REVISION_INTENT.REBALANCE_COMPOSITION,
  [DIMENSION.BRAND_EXPRESSION]: REVISION_INTENT.STRENGTHEN_BRAND_EXPRESSION,
  [DIMENSION.PREMIUM_RETAIL_FEEL]: REVISION_INTENT.ELEVATE_RETAIL_QUALITY,
  [DIMENSION.TEMPLATE_LIKE_APPEARANCE]: REVISION_INTENT.REDUCE_TEMPLATE_FEEL,
  [DIMENSION.AI_ARTIFACTS]: REVISION_INTENT.REGENERATE_CLEANER_ENVIRONMENT,
  [DIMENSION.OVERALL_SHIPPABILITY]: REVISION_INTENT.RECONSIDER_THE_OVERALL_CONCEPT,
});

const MAX_INTENTS = 8;

/**
 * @returns {object|null} a revision request, or null when no dimension asks for one (a CREATIVE_PASS, or nothing measurable). FAIL dimensions come before REVIEW_REQUIRED ones; the
 * overall-shippability intent is used only when no other dimension carries the revision.
 */
export function buildRevisionRequest({ critique, iteration }) {
  if (!Number.isInteger(iteration) || iteration < 1) throw new TypeError('iteration must be a positive integer');
  const asking = critique.dimensions.filter((d) => d.outcome === OUTCOME.FAIL || d.outcome === OUTCOME.REVIEW_REQUIRED);
  const specific = asking.filter((d) => d.dimension !== DIMENSION.OVERALL_SHIPPABILITY);
  const chosen = (specific.length ? specific : asking)
    .sort((a, b) => (a.outcome === b.outcome ? DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension) : (a.outcome === OUTCOME.FAIL ? -1 : 1)))
    .slice(0, MAX_INTENTS);
  if (!chosen.length) return null;
  const intents = chosen.map((d) => ({
    intent: INTENT_FOR_DIMENSION[d.dimension],
    dimension: d.dimension,
    outcome: d.outcome,
    // the critic's own hint is re-checked here: a revision request never carries anything a hint may not
    hint: d.revision_hint ? assertSemanticHint(d.revision_hint, `intents.${d.dimension}.hint`) : null,
  }));
  const body = { from_candidate_ref: critique.candidate_ref, from_critique_id: critique.critique_id, iteration, intents };
  const id = `crv_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}`;
  return Object.freeze({ revision_id: id, ...body, intents: Object.freeze(intents.map((i) => Object.freeze(i))) });
}
