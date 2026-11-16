// CREATIVE CAMPAIGN (Phase 2). Closed vocabularies and declared policies of the planning of several assets that share one idea.
// Nothing here knows a provider, a model, a merchant or a product. Figures below are DECLARED planning policy or unit costs to be recalibrated from measured production costs; none is a creative figure.

export const SCHEMA = Object.freeze({
  campaign: 'campaign-plan@1', asset: 'asset-plan@1', continuity: 'continuity-contract@1', diversity: 'diversity-report@1', state: 'campaign-state@1', budget: 'campaign-budget@1',
});

/** The part an asset plays in the sequence. A campaign uses the roles its content needs; none is compulsory. */
export const NARRATIVE_ROLE = Object.freeze({
  HOOK: 'HOOK', CONTEXT: 'CONTEXT', PROBLEM: 'PROBLEM', PROGRESSION: 'PROGRESSION', PROOF: 'PROOF', DETAIL: 'DETAIL', OFFER: 'OFFER', CTA: 'CTA',
});
export const OBJECTIVE_KIND = Object.freeze({ AWARENESS: 'AWARENESS', EDUCATE: 'EDUCATE', SELL: 'SELL', ANNOUNCE: 'ANNOUNCE' });

/** How much text an asset carries, as a design class (not a character count): the copy decides it by measurement, the role says how much is wise. */
export const DENSITY_CLASS = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', TEXT_LED: 'TEXT_LED' });
export const DENSITY_ORDER = Object.freeze([DENSITY_CLASS.LOW, DENSITY_CLASS.MEDIUM, DENSITY_CLASS.HIGH, DENSITY_CLASS.TEXT_LED]);
/** LOW is text that fits the headline and subheadline roles together (their measured capacities sum to this many characters). */
export const LOW_DENSITY_MAX_CHARS = 150;

export const COMPOSITION_INTENT = Object.freeze({
  PRODUCT_CENTERED: 'PRODUCT_CENTERED', PRODUCT_OFFSET: 'PRODUCT_OFFSET', TEXT_FIRST: 'TEXT_FIRST', FULL_BLEED_SCENE: 'FULL_BLEED_SCENE', SPLIT_PANEL: 'SPLIT_PANEL', CLOSE_CROP: 'CLOSE_CROP', WIDE_ESTABLISHING: 'WIDE_ESTABLISHING',
});
export const IMAGERY_INTENT = Object.freeze({
  PRODUCT_HERO: 'PRODUCT_HERO', PRODUCT_DETAIL: 'PRODUCT_DETAIL', PRODUCT_IN_CONTEXT: 'PRODUCT_IN_CONTEXT', EVIDENCE_VISUAL: 'EVIDENCE_VISUAL', TYPOGRAPHIC_PANEL: 'TYPOGRAPHIC_PANEL', OFFER_GRAPHIC: 'OFFER_GRAPHIC',
});
export const CROP_SCALE = Object.freeze({ WIDE: 'WIDE', MID: 'MID', CLOSE: 'CLOSE' });

const R = NARRATIVE_ROLE; const C = COMPOSITION_INTENT; const I = IMAGERY_INTENT; const D = DENSITY_CLASS;
/** The most text a composition can carry and still be that composition. */
export const COMPOSITION_MAX_DENSITY = Object.freeze({
  [C.PRODUCT_CENTERED]: D.MEDIUM, [C.CLOSE_CROP]: D.MEDIUM, [C.WIDE_ESTABLISHING]: D.MEDIUM, [C.FULL_BLEED_SCENE]: D.HIGH, [C.PRODUCT_OFFSET]: D.HIGH, [C.SPLIT_PANEL]: D.TEXT_LED, [C.TEXT_FIRST]: D.TEXT_LED,
});
export const CROP_OF_COMPOSITION = Object.freeze({
  [C.CLOSE_CROP]: CROP_SCALE.CLOSE, [C.WIDE_ESTABLISHING]: CROP_SCALE.WIDE, [C.FULL_BLEED_SCENE]: CROP_SCALE.WIDE, [C.PRODUCT_CENTERED]: CROP_SCALE.MID, [C.PRODUCT_OFFSET]: CROP_SCALE.MID, [C.SPLIT_PANEL]: CROP_SCALE.MID, [C.TEXT_FIRST]: CROP_SCALE.MID,
});
/** Per role, in order of preference: the compositions and the imagery that suit it. The k-th occurrence of a role takes the k-th option, so a repeated role does not repeat its look. */
export const ROLE_OPTIONS = Object.freeze({
  [R.HOOK]: [[C.PRODUCT_CENTERED, I.PRODUCT_HERO], [C.CLOSE_CROP, I.PRODUCT_DETAIL]],
  [R.CONTEXT]: [[C.WIDE_ESTABLISHING, I.PRODUCT_IN_CONTEXT], [C.FULL_BLEED_SCENE, I.PRODUCT_IN_CONTEXT]],
  [R.PROBLEM]: [[C.TEXT_FIRST, I.TYPOGRAPHIC_PANEL], [C.SPLIT_PANEL, I.PRODUCT_IN_CONTEXT]],
  [R.PROGRESSION]: [[C.PRODUCT_OFFSET, I.PRODUCT_IN_CONTEXT], [C.SPLIT_PANEL, I.PRODUCT_DETAIL], [C.FULL_BLEED_SCENE, I.PRODUCT_IN_CONTEXT], [C.CLOSE_CROP, I.PRODUCT_DETAIL], [C.PRODUCT_OFFSET, I.PRODUCT_DETAIL], [C.SPLIT_PANEL, I.PRODUCT_IN_CONTEXT], [C.FULL_BLEED_SCENE, I.PRODUCT_DETAIL], [C.TEXT_FIRST, I.TYPOGRAPHIC_PANEL]],
  [R.PROOF]: [[C.SPLIT_PANEL, I.EVIDENCE_VISUAL], [C.TEXT_FIRST, I.TYPOGRAPHIC_PANEL]],
  [R.DETAIL]: [[C.CLOSE_CROP, I.PRODUCT_DETAIL], [C.PRODUCT_OFFSET, I.PRODUCT_DETAIL]],
  [R.OFFER]: [[C.PRODUCT_CENTERED, I.OFFER_GRAPHIC], [C.SPLIT_PANEL, I.OFFER_GRAPHIC]],
  [R.CTA]: [[C.PRODUCT_CENTERED, I.PRODUCT_HERO], [C.TEXT_FIRST, I.TYPOGRAPHIC_PANEL]],
});
/** What a slide may use when none of its role's options carries its density. */
export const TEXT_LED_FALLBACK = Object.freeze([[C.TEXT_FIRST, I.TYPOGRAPHIC_PANEL], [C.SPLIT_PANEL, I.PRODUCT_IN_CONTEXT], [C.SPLIT_PANEL, I.PRODUCT_DETAIL], [C.TEXT_FIRST, I.PRODUCT_DETAIL], [C.SPLIT_PANEL, I.PRODUCT_HERO]]);
/** The most text a role should carry by design: a hook says little, a text-led progression may say a lot. A role that is fixed by its position (hook, offer, call to action) keeps it even if its locked copy is longer. */
export const ROLE_MAX_DENSITY = Object.freeze({
  [R.HOOK]: D.LOW, [R.CTA]: D.LOW, [R.OFFER]: D.MEDIUM, [R.DETAIL]: D.HIGH, [R.PROOF]: D.HIGH, [R.CONTEXT]: D.TEXT_LED, [R.PROBLEM]: D.TEXT_LED, [R.PROGRESSION]: D.TEXT_LED,
});
export const POSITIONAL_ROLES = Object.freeze([R.HOOK, R.OFFER, R.CTA]);

/** Per objective, the roles of the body slides after the hook, in order (the last one repeats as long as slides remain). Nothing forces a role the content does not need. */
export const BODY_PATTERN = Object.freeze({
  [OBJECTIVE_KIND.EDUCATE]: [R.CONTEXT, R.PROGRESSION],
  [OBJECTIVE_KIND.SELL]: [R.DETAIL, R.PROGRESSION],
  [OBJECTIVE_KIND.AWARENESS]: [R.CONTEXT, R.DETAIL, R.PROGRESSION],
  [OBJECTIVE_KIND.ANNOUNCE]: [R.DETAIL, R.PROGRESSION],
});

export const CAMPAIGN_STATUS = Object.freeze({ PLANNED: 'PLANNED', NEEDS_USER_DECISION: 'NEEDS_USER_DECISION', NOT_A_MULTI_ASSET_PLAN: 'NOT_A_MULTI_ASSET_PLAN', NO_CONCEPT_SELECTED: 'NO_CONCEPT_SELECTED' });
export const BRIEF_SOURCE = Object.freeze({ MODEL: 'MODEL', INTENT_ONLY: 'INTENT_ONLY' });

export const CAMPAIGN_QUESTION = Object.freeze({
  CAMPAIGN_BUDGET_EXCEEDED: 'CAMPAIGN_BUDGET_EXCEEDED',
  BRIEF_NEEDS_CLARIFICATION: 'BRIEF_NEEDS_CLARIFICATION',
  BRIEF_CONTRADICTORY: 'BRIEF_CONTRADICTORY',
  NOT_ENOUGH_TEXT_FOR_THE_REQUESTED_ASSETS: 'NOT_ENOUGH_TEXT_FOR_THE_REQUESTED_ASSETS',
});

/** The facts a campaign keeps consistent across its assets, and what it lets vary. */
export const MUST_STAY_CONSISTENT = Object.freeze({
  CAMPAIGN_CONCEPT: 'CAMPAIGN_CONCEPT', ART_DIRECTION: 'ART_DIRECTION', BRAND_CONSTRAINTS: 'BRAND_CONSTRAINTS', PRODUCT_IDENTITY: 'PRODUCT_IDENTITY', APPROVED_FACTS: 'APPROVED_FACTS', VISUAL_LANGUAGE: 'VISUAL_LANGUAGE',
});
export const SHOULD_VARY = Object.freeze({
  SLIDE_ROLE: 'SLIDE_ROLE', COMPOSITION: 'COMPOSITION', IMAGERY: 'IMAGERY', CROP_SCALE: 'CROP_SCALE', TEXT_HIERARCHY: 'TEXT_HIERARCHY', RHYTHM: 'RHYTHM',
});
export const FORBIDDEN_PATTERN = 'SAME_SLIDE_REPEATED_WITH_DIFFERENT_TEXT';

/** The working-state nodes of a campaign and what each depends on (the structure; reuse is decided by the hash of each node's inputs). */
export const NODE = Object.freeze({
  CONTENT_PLAN: 'CONTENT_PLAN', FRAME: 'FRAME', CONCEPT: 'CONCEPT', ART_DIRECTION: 'ART_DIRECTION', CAMPAIGN_PLAN: 'CAMPAIGN_PLAN', ASSET_PLAN: 'ASSET_PLAN',
});
export const DEPENDS_ON = Object.freeze({
  [NODE.CONTENT_PLAN]: [], [NODE.FRAME]: [NODE.CONTENT_PLAN], [NODE.CONCEPT]: [NODE.FRAME], [NODE.ART_DIRECTION]: [NODE.CONCEPT], [NODE.CAMPAIGN_PLAN]: [NODE.CONTENT_PLAN, NODE.ART_DIRECTION], [NODE.ASSET_PLAN]: [NODE.CAMPAIGN_PLAN, NODE.ART_DIRECTION],
});

/**
 * Unit costs of the production of a campaign, in EUR, by capability class (never by provider). They are the worst-case reservations observed on the Creative Brain benchmark and are to be recalibrated from
 * measured production costs. The image price depends on the size class of the canvas (the longest side).
 */
export const DEFAULT_UNIT_COSTS = Object.freeze({
  text_stage_eur: 0.03,
  vision_critic_eur: 0.01,
  image_eur_by_size_class: Object.freeze({ UP_TO_1024: 0.034, ABOVE_1024: 0.069 }),
});
/** The hard ceiling of a development or benchmark campaign. Configurable; never silently exceeded. */
export const DEV_CAMPAIGN_CEILING_EUR = 2.0;
/** The bounded shape of the production of a campaign that the estimate is made for. */
export const PRODUCTION_BOUNDS = Object.freeze({
  concept_rounds: 2, shared_protocol_repairs: 4, text_stages_per_asset: 2, protocol_repairs_per_asset: 1, vision_calls_per_asset: 2, environment_candidates_options: Object.freeze([3, 2, 1]),
});
