// The vocabulary of the Creative Critic: closed, reusable, with no merchant, product or campaign in it. A dimension is a perceptual / creative judgment about the
// RENDERED candidate; everything a deterministic gate owns (approved claims, price truth, product identity, camera geometry, printed artwork, fonts, bounds, collisions,
// Fidelity, Brand Guardian, Preflight) is NOT a dimension here and is never re-judged by a model.

export const DIMENSION = Object.freeze({
  PRODUCT_PROMINENCE: 'PRODUCT_PROMINENCE',
  PRODUCT_INTEGRATION: 'PRODUCT_INTEGRATION',
  VISUAL_HIERARCHY: 'VISUAL_HIERARCHY',
  TEXT_HIERARCHY: 'TEXT_HIERARCHY',
  TYPOGRAPHY_COMPOSITION: 'TYPOGRAPHY_COMPOSITION',
  CLAIM_VISIBILITY: 'CLAIM_VISIBILITY',
  PRICE_INTEGRATION: 'PRICE_INTEGRATION',
  WHITESPACE_BALANCE: 'WHITESPACE_BALANCE',
  COMPOSITION_BALANCE: 'COMPOSITION_BALANCE',
  BRAND_EXPRESSION: 'BRAND_EXPRESSION',
  PREMIUM_RETAIL_FEEL: 'PREMIUM_RETAIL_FEEL',
  TEMPLATE_LIKE_APPEARANCE: 'TEMPLATE_LIKE_APPEARANCE',
  AI_ARTIFACTS: 'AI_ARTIFACTS',
  OVERALL_SHIPPABILITY: 'OVERALL_SHIPPABILITY',
});
export const DIMENSIONS = Object.freeze(Object.values(DIMENSION));

/** Every outcome means the same thing in every dimension: PASS = the candidate meets the expectation named by the question (for the two "absence" dimensions, the problem is absent). */
export const OUTCOME = Object.freeze({
  PASS: 'PASS', FAIL: 'FAIL', REVIEW_REQUIRED: 'REVIEW_REQUIRED', NOT_MEASURABLE: 'NOT_MEASURABLE',
});

export const CREATIVE_STATUS = Object.freeze({
  CREATIVE_PASS: 'CREATIVE_PASS', CREATIVE_FAIL: 'CREATIVE_FAIL', REVIEW_REQUIRED: 'REVIEW_REQUIRED', NOT_MEASURABLE: 'NOT_MEASURABLE',
});

/** The question each dimension answers. PASS means "yes, this is met"; for TEMPLATE_LIKE_APPEARANCE and AI_ARTIFACTS PASS means "no, the problem is absent". */
export const DIMENSION_QUESTIONS = Object.freeze({
  PRODUCT_PROMINENCE: 'Is the product clearly the hero: immediately visible, and large and present enough for its role in the message?',
  PRODUCT_INTEGRATION: 'Does the product look naturally part of its surroundings (light, scale, grounding, contact), not pasted onto a background?',
  VISUAL_HIERARCHY: 'Is there BOTH a clear order (one focal point, then a second, then a third) AND an appropriate relative visual weight: does the hero subject lead, with no other element (a text block, a price, a graphic panel) overpowering it or competing with it for first attention? An order that exists but is led by the wrong element, or several elements of similar heavy weight competing, is not a pass.',
  TEXT_HIERARCHY: 'Among the texts, is there BOTH a clear order of importance AND a weight proportionate to each text\'s role and to the hero subject? The main message should lead without overpowering the subject or the image, and supporting texts should be clearly subordinate yet readable. A headline that is clear but so large or heavy that it dominates the whole composition, or texts given such different treatments that the message fragments, is not a pass.',
  TYPOGRAPHY_COMPOSITION: 'Are the typographic elements well composed: alignment, spacing, grouping, proportion between texts, and a treatment that feels intentional?',
  CLAIM_VISIBILITY: 'Is the supporting claim easy to notice and read without dominating or fighting the main message?',
  PRICE_INTEGRATION: 'Is the price readable AND proportionate to its role, integrated with the visual language of the composition, without competing with the hero subject or the main message for attention? A price that is legible but oversized, or set as a separate heavy treatment of similar weight to the main message, is not a pass.',
  WHITESPACE_BALANCE: 'Is empty space used intentionally and generously, giving the elements room to breathe, without dead zones or crowding?',
  COMPOSITION_BALANCE: 'Is the overall composition balanced in visual weight AND does the arrangement feel considered rather than merely stable? Symmetry or a centred stack is not enough on its own: judge whether the distribution of weight serves the hero subject, whether stacked elements of similar weight make the arrangement rigid or mechanical, and whether it is commercially awkward (technically stable but unrefined or over-built).',
  BRAND_EXPRESSION: 'Does the image express the brand as described in the brief (its tone, restraint and visual principles), and not a generic advertisement?',
  PREMIUM_RETAIL_FEEL: 'Does the image feel like refined, professional retail communication, at the level a premium brand would publish?',
  TEMPLATE_LIKE_APPEARANCE: 'Is the image free of a template-like, mechanically assembled look (elements dropped into slots without a considered idea)? PASS means it does NOT look template-like.',
  AI_ARTIFACTS: 'Is the image free of visible generation artifacts (distorted shapes, incoherent details, uncanny textures, strange objects)? PASS means no artifact is visible.',
  OVERALL_SHIPPABILITY: 'Taking the whole image as a viewer would, would it be acceptable to publish as it stands, for a demanding brand? This is a perceptual opinion only: it can never approve publication.',
});

// @2: the questions of VISUAL_HIERARCHY, TEXT_HIERARCHY, PRICE_INTEGRATION and COMPOSITION_BALANCE judge proportion and competition, not only the existence of an order. The shape is unchanged.
export const CRITIQUE_VERSION = 'creative-critique@2';
