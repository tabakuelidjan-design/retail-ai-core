// CONTENT PLANNING (Creative Phase 1). Closed vocabularies and declared limits of the stages that run BEFORE the Creative Brain: CONTENT_ANALYSIS -> FORMAT_PLAN.
// Nothing here knows a provider, a model, a merchant or a product. Every number below is a DECLARED planning limit or a measured fact (never a creative figure invented by a model).

export const SCHEMA = Object.freeze({ request: 'content-request@1', inventory: 'content-inventory@1', plan: 'content-plan@1', observation: 'input-observation@1' });

/** What can be decided to be made. VIDEO kinds can be selected but are never executable in this phase. */
export const FORMAT_KIND = Object.freeze({
  SINGLE_IMAGE: 'SINGLE_IMAGE',
  CAROUSEL: 'CAROUSEL',
  MULTI_VISUAL_SERIES: 'MULTI_VISUAL_SERIES',
  STORY_SEQUENCE: 'STORY_SEQUENCE',
  POSTER: 'POSTER',
  FLYER: 'FLYER',
  MULTI_ASSET_CAMPAIGN: 'MULTI_ASSET_CAMPAIGN',
  SHORT_VIDEO: 'SHORT_VIDEO',
  PROMOTIONAL_VIDEO: 'PROMOTIONAL_VIDEO',
});
export const VIDEO_KINDS = Object.freeze([FORMAT_KIND.SHORT_VIDEO, FORMAT_KIND.PROMOTIONAL_VIDEO]);
/** One canvas, one asset. */
export const SINGLE_CANVAS_KINDS = Object.freeze([FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.POSTER, FORMAT_KIND.FLYER]);
/** Several assets on the same kind of canvas. */
export const MULTI_ASSET_KINDS = Object.freeze([FORMAT_KIND.CAROUSEL, FORMAT_KIND.MULTI_VISUAL_SERIES, FORMAT_KIND.STORY_SEQUENCE]);

/** THE COPY POLICY of an input text, decided by the person (or the merchant's policy), never by Nordla. */
export const COPY_MODE = Object.freeze({
  COPY_LOCKED: 'COPY_LOCKED', // approved text is immutable: it may be distributed across assets and caption, never rewritten
  COPY_ADAPTABLE: 'COPY_ADAPTABLE', // Nordla may condense or restructure it; its meaning and every factual claim stay
  COPY_GENERATABLE: 'COPY_GENERATABLE', // Nordla may write appropriate copy from verified facts and the objective; it never invents a fact
});

export const TEXT_ROLE = Object.freeze({ HEADLINE: 'HEADLINE', SUBHEADLINE: 'SUBHEADLINE', BODY: 'BODY', PRICE: 'PRICE', CTA: 'CTA', CAPTION: 'CAPTION' });
/** The roles the deterministic layout can place TODAY (a role with no layout slot is planned, not executable). Kept equal to the layout recipes by a test. */
export const EXECUTABLE_ROLES = Object.freeze([TEXT_ROLE.HEADLINE, TEXT_ROLE.SUBHEADLINE, TEXT_ROLE.PRICE, TEXT_ROLE.CTA]);
export const ROLE_ORDER = Object.freeze([TEXT_ROLE.HEADLINE, TEXT_ROLE.SUBHEADLINE, TEXT_ROLE.BODY, TEXT_ROLE.PRICE, TEXT_ROLE.CTA]);

/** What a fact is, and how far it may be used. Only VERIFIED and APPROVED_CLAIM facts may be put into generated copy. */
export const FACT_KIND = Object.freeze({ PRICE: 'PRICE', PRODUCT_CLAIM: 'PRODUCT_CLAIM', LEGAL: 'LEGAL', SUPPLIER: 'SUPPLIER', COMPLIANCE: 'COMPLIANCE', COMMERCIAL: 'COMMERCIAL', DESCRIPTIVE: 'DESCRIPTIVE' });
export const FACT_STATUS = Object.freeze({ VERIFIED: 'VERIFIED', APPROVED_CLAIM: 'APPROVED_CLAIM', ESTIMATE: 'ESTIMATE', UNKNOWN: 'UNKNOWN' });
export const USABLE_FACT_STATUS = Object.freeze([FACT_STATUS.VERIFIED, FACT_STATUS.APPROVED_CLAIM]);
/** What a generated text is for. A price is never generated: it is copied from a price fact as a locked text. */
export const GENERATION_PURPOSE = Object.freeze({ HEADLINE: 'HEADLINE', SUBHEADLINE: 'SUBHEADLINE', BODY: 'BODY', CTA: 'CTA', CAPTION: 'CAPTION' });

/** The kinds of input the planner can be given (text, product image, uploaded file, reference image, structured facts). */
export const SOURCE_KIND = Object.freeze({ TEXT: 'TEXT', PRODUCT_IMAGE: 'PRODUCT_IMAGE', UPLOADED_FILE: 'UPLOADED_FILE', REFERENCE_IMAGE: 'REFERENCE_IMAGE', STRUCTURED_FACTS: 'STRUCTURED_FACTS' });
/** The role of a reference, carried now so that multi-reference composition (deferred) needs no new contract. */
export const REFERENCE_ROLE = Object.freeze({ PRODUCT: 'PRODUCT', STYLE: 'STYLE', LAYOUT: 'LAYOUT', BRAND: 'BRAND', CONTENT: 'CONTENT' });
export const ANALYSIS_STATUS = Object.freeze({ ANALYZED: 'ANALYZED', METADATA_ONLY: 'METADATA_ONLY', NOT_ANALYZED: 'NOT_ANALYZED' });

/** Hard constraints of a request. MAX_ASSETS carries a number (a requested limit). */
export const CONSTRAINT = Object.freeze({ ALL_TEXT_ON_ASSET: 'ALL_TEXT_ON_ASSET', SINGLE_ASSET_ONLY: 'SINGLE_ASSET_ONLY', FORMAT_IS_FIXED: 'FORMAT_IS_FIXED', MAX_ASSETS: 'MAX_ASSETS', NO_GENERATED_COPY: 'NO_GENERATED_COPY' });

export const PLAN_STATUS = Object.freeze({ PLANNED: 'PLANNED', NEEDS_USER_DECISION: 'NEEDS_USER_DECISION' });
export const EXECUTION = Object.freeze({ EXECUTABLE_NOW: 'EXECUTABLE_NOW', PLANNED_NOT_EXECUTABLE: 'PLANNED_NOT_EXECUTABLE' });
export const EXECUTION_REASON = Object.freeze({
  MULTI_ASSET_PRODUCTION_NOT_AVAILABLE: 'MULTI_ASSET_PRODUCTION_NOT_AVAILABLE',
  VIDEO_PRODUCTION_NOT_AVAILABLE: 'VIDEO_PRODUCTION_NOT_AVAILABLE',
  CAMPAIGN_PRODUCTION_NOT_AVAILABLE: 'CAMPAIGN_PRODUCTION_NOT_AVAILABLE',
  ROLE_HAS_NO_LAYOUT_SLOT: 'ROLE_HAS_NO_LAYOUT_SLOT',
  CANVAS_EXCEEDS_THE_CURRENT_PRODUCTION_LIMIT: 'CANVAS_EXCEEDS_THE_CURRENT_PRODUCTION_LIMIT',
  COPY_NOT_YET_GENERATED: 'COPY_NOT_YET_GENERATED',
  ASSET_HAS_NO_TEXT: 'ASSET_HAS_NO_TEXT',
});

export const ASSET_ROLE = Object.freeze({ SINGLE: 'SINGLE', COVER: 'COVER', CONTENT: 'CONTENT', CLOSING: 'CLOSING', ITEM: 'ITEM' });
export const PIECE_ORIGIN = Object.freeze({ LOCKED: 'LOCKED', ADAPTED: 'ADAPTED', GENERATED: 'GENERATED', PENDING_GENERATION: 'PENDING_GENERATION' });
export const DENSITY_BAND = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' });
export const FORMAT_BASIS = Object.freeze({ REQUESTED: 'REQUESTED', CHANNEL: 'CHANNEL', DENSITY: 'DENSITY', DEFAULTED: 'DEFAULTED' });
export const CANVAS_SOURCE = Object.freeze({ CALLER_RESOURCE: 'CALLER_RESOURCE', STANDARD_RESOURCE: 'STANDARD_RESOURCE' });

/** Why a person is asked. Asking is the exception: only a hard constraint, or a meaning that would change, justifies it. */
export const QUESTION_CODE = Object.freeze({
  TEXT_CANNOT_BE_PLACED_WITHOUT_ALTERING_IT: 'TEXT_CANNOT_BE_PLACED_WITHOUT_ALTERING_IT',
  REQUESTED_FORMAT_CANNOT_HOLD_THE_LOCKED_TEXT: 'REQUESTED_FORMAT_CANNOT_HOLD_THE_LOCKED_TEXT',
  CONSTRAINTS_CONTRADICT_EACH_OTHER: 'CONSTRAINTS_CONTRADICT_EACH_OTHER',
  NOTHING_VERIFIED_TO_GENERATE_FROM: 'NOTHING_VERIFIED_TO_GENERATE_FROM',
  NOTHING_TO_SAY: 'NOTHING_TO_SAY',
  VIDEO_NOT_PRODUCIBLE_CHOOSE_ALTERNATIVE: 'VIDEO_NOT_PRODUCIBLE_CHOOSE_ALTERNATIVE',
});

/** The rules that decide a format, recorded with every decision. */
export const FORMAT_RULE = Object.freeze({
  EXPLICIT_REQUEST_IS_HONOURED: 'EXPLICIT_REQUEST_IS_HONOURED',
  VIDEO_IS_PLANNED_NOT_PRODUCED: 'VIDEO_IS_PLANNED_NOT_PRODUCED',
  SEVERAL_CHANNELS_MAKE_A_CAMPAIGN: 'SEVERAL_CHANNELS_MAKE_A_CAMPAIGN',
  TEXT_THAT_FITS_STAYS_ON_ONE_ASSET: 'TEXT_THAT_FITS_STAYS_ON_ONE_ASSET',
  SECTIONED_LONG_TEXT_BECOMES_A_SEQUENCE: 'SECTIONED_LONG_TEXT_BECOMES_A_SEQUENCE',
  BODY_TEXT_GOES_TO_THE_CAPTION_WHEN_THE_ASSET_HAS_NO_BODY_SLOT: 'BODY_TEXT_GOES_TO_THE_CAPTION_WHEN_THE_ASSET_HAS_NO_BODY_SLOT',
  ALL_TEXT_ON_ASSET_NEEDS_THE_SMALLEST_FORMAT_THAT_HOLDS_IT: 'ALL_TEXT_ON_ASSET_NEEDS_THE_SMALLEST_FORMAT_THAT_HOLDS_IT',
  NO_CHANNEL_MEANS_A_GENERIC_DIGITAL_FEED: 'NO_CHANNEL_MEANS_A_GENERIC_DIGITAL_FEED',
});

/** Declared limits of the planning. */
export const LIMITS = Object.freeze({
  request_text_chars: 100000,
  copy_items: 40,
  facts: 100,
  sources: 20,
  constraints: 8,
  ref_chars: 200,
  channels: 8,
  max_assets: Object.freeze({ CAROUSEL: 10, MULTI_VISUAL_SERIES: 10, STORY_SEQUENCE: 8 }),
  /** the provider limit on the pixels of one generated image that the current production path accepts (width x height) */
  max_production_pixels: 2048 * 2048,
});

/** Where a channel profile says text may go. A channel Nordla does not know is a generic digital feed. */
export const CHANNEL_PROFILE = Object.freeze({
  SOCIAL_FEED: { caption: true, kinds: [FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.CAROUSEL, FORMAT_KIND.MULTI_VISUAL_SERIES] },
  SOCIAL_STORY: { caption: false, kinds: [FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.STORY_SEQUENCE] },
  VIDEO_FEED: { caption: true, kinds: [FORMAT_KIND.SHORT_VIDEO] },
  STORE_WINDOW: { caption: false, kinds: [FORMAT_KIND.POSTER, FORMAT_KIND.MULTI_VISUAL_SERIES] },
  PRINT: { caption: false, kinds: [FORMAT_KIND.FLYER, FORMAT_KIND.POSTER, FORMAT_KIND.MULTI_VISUAL_SERIES] },
  GENERIC_DIGITAL: { caption: true, kinds: [FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.CAROUSEL, FORMAT_KIND.MULTI_VISUAL_SERIES] },
});
const CHANNEL_ALIASES = Object.freeze({
  SOCIAL_FEED: 'SOCIAL_FEED', FEED: 'SOCIAL_FEED', INSTAGRAM_FEED: 'SOCIAL_FEED', ORGANIC_SOCIAL: 'SOCIAL_FEED', INSTAGRAM: 'SOCIAL_FEED', FACEBOOK: 'SOCIAL_FEED',
  SOCIAL_STORY: 'SOCIAL_STORY', STORY: 'SOCIAL_STORY', STORIES: 'SOCIAL_STORY', INSTAGRAM_STORY: 'SOCIAL_STORY',
  TIKTOK: 'VIDEO_FEED', REELS: 'VIDEO_FEED', INSTAGRAM_REELS: 'VIDEO_FEED', SHORT_VIDEO: 'VIDEO_FEED', VIDEO_FEED: 'VIDEO_FEED',
  STORE_WINDOW: 'STORE_WINDOW', STORE_FRONT: 'STORE_WINDOW', WINDOW: 'STORE_WINDOW', SHOP_WINDOW: 'STORE_WINDOW',
  PRINT: 'PRINT', FLYER: 'PRINT', LEAFLET: 'PRINT',
});
/** The profile of a channel token ({ profile, name, known }). Pure. */
export function channelProfileOf(channel) {
  const token = typeof channel === 'string' ? channel.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_') : '';
  const name = CHANNEL_ALIASES[token] ?? 'GENERIC_DIGITAL';
  return { name, profile: CHANNEL_PROFILE[name], known: Boolean(CHANNEL_ALIASES[token]), defaulted: token === '' };
}
