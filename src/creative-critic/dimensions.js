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
  VISUAL_HIERARCHY: 'Does the eye travel in a clear order across the whole image (what is seen first, second, third), with one clear focal point?',
  TEXT_HIERARCHY: 'Among the texts, is there a clear order of importance, with the main message dominant and supporting texts clearly subordinate and not competing?',
  TYPOGRAPHY_COMPOSITION: 'Are the typographic elements well composed: alignment, spacing, grouping, proportion between texts, and a treatment that feels intentional?',
  CLAIM_VISIBILITY: 'Is the supporting claim easy to notice and read without dominating or fighting the main message?',
  PRICE_INTEGRATION: 'Is the price presented in proportion to the rest and integrated with the composition, readable without overpowering the product or the message?',
  WHITESPACE_BALANCE: 'Is empty space used intentionally and generously, giving the elements room to breathe, without dead zones or crowding?',
  COMPOSITION_BALANCE: 'Is the overall composition balanced and coherent (weight, alignment, relationships between product, text and space)?',
  BRAND_EXPRESSION: 'Does the image express the brand as described in the brief (its tone, restraint and visual principles), and not a generic advertisement?',
  PREMIUM_RETAIL_FEEL: 'Does the image feel like refined, professional retail communication, at the level a premium brand would publish?',
  TEMPLATE_LIKE_APPEARANCE: 'Is the image free of a template-like, mechanically assembled look (elements dropped into slots without a considered idea)? PASS means it does NOT look template-like.',
  AI_ARTIFACTS: 'Is the image free of visible generation artifacts (distorted shapes, incoherent details, uncanny textures, strange objects)? PASS means no artifact is visible.',
  OVERALL_SHIPPABILITY: 'Taking the whole image as a viewer would, would it be acceptable to publish as it stands, for a demanding brand? This is a perceptual opinion only: it can never approve publication.',
});

export const CRITIQUE_VERSION = 'creative-critique@1';
