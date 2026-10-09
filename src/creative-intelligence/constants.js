// Creative Intelligence C1: closed vocabularies and stable error codes.
//
//   MARKETING DECIDES WHY / TO WHOM / WHAT   ·   CREATIVE INTELLIGENCE DECIDES HOW TO EXPRESS THE APPROVED BRIEF
//   CREATIVE FIDELITY GUARDS THE PRODUCT     ·   BRAND GUARDIAN GUARDS THE BRAND   ·   ACTIVATION PUBLISHES
//
// The durable output is not an image: it is a DesignDocument + a CreativeCandidate + provenance + a preflight / quality report.
// A PNG / SVG is a projection of that structured state. Critical text (price, offer, CTA, legal) is rendered deterministically
// from the document and is never baked into generated pixels. No provider, model or prompt is a permanent part of the domain.

export const CI_VERSION = 'creative-intelligence.v1';

export class CreativeIntelligenceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'CreativeIntelligenceError';
    this.code = code;
    this.detail = detail;
  }
}

export const CI_ERROR = Object.freeze({
  // shape
  INVALID_FIELD: 'CI_INVALID_FIELD',
  UNKNOWN_KEY: 'CI_UNKNOWN_KEY',
  FORBIDDEN_KEY: 'CI_FORBIDDEN_KEY',
  INVALID_REFERENCE: 'CI_INVALID_REFERENCE',
  INVALID_TIMESTAMP: 'CI_INVALID_TIMESTAMP',
  ID_MISMATCH: 'CI_ID_MISMATCH',
  SECRET_LEAK: 'CI_SECRET_LEAK',
  // intake / context
  INTAKE_INVALID: 'CI_INTAKE_INVALID',
  CONTENT_KIND_UNSUPPORTED: 'CI_CONTENT_KIND_UNSUPPORTED',
  CANVAS_INVALID: 'CI_CANVAS_INVALID',
  ASPECT_RATIO_MISMATCH: 'CI_ASPECT_RATIO_MISMATCH',
  ZONE_INVALID: 'CI_ZONE_INVALID',
  DIRECTION_LOCALE_MISMATCH: 'CI_DIRECTION_LOCALE_MISMATCH',
  // assets / product
  ASSET_REPORT_INVALID: 'CI_ASSET_REPORT_INVALID',
  PRESERVATION_POLICY_INVALID: 'CI_PRESERVATION_POLICY_INVALID',
  REGION_INVALID: 'CI_REGION_INVALID',
  // direction
  DIRECTION_INVALID: 'CI_DIRECTION_INVALID',
  DIRECTION_NOT_DISTINCT: 'CI_DIRECTION_NOT_DISTINCT',
  // document / layers
  DOCUMENT_INVALID: 'CI_DOCUMENT_INVALID',
  LAYER_INVALID: 'CI_LAYER_INVALID',
  GEOMETRY_INVALID: 'CI_GEOMETRY_INVALID',
  TEXT_LAYER_INVALID: 'CI_TEXT_LAYER_INVALID',
  PRODUCT_LAYER_INVALID: 'CI_PRODUCT_LAYER_INVALID',
  PRODUCT_PIXEL_MUTATION: 'CI_PRODUCT_PIXEL_MUTATION',
  CLAIM_BASIS_MISSING: 'CI_CLAIM_BASIS_MISSING',
  CLAIM_REF_NOT_APPROVED: 'CI_CLAIM_REF_NOT_APPROVED',
  NON_CLAIM_TEXT_FACTUAL: 'CI_NON_CLAIM_TEXT_FACTUAL',
  TEXT_DIGEST_MISMATCH: 'CI_TEXT_DIGEST_MISMATCH',
  CONSTRAINT_INVALID: 'CI_CONSTRAINT_INVALID',
  LAYER_LOCKED: 'CI_LAYER_LOCKED',
  EFFECT_INVALID: 'CI_EFFECT_INVALID',
  COLOR_INVALID: 'CI_COLOR_INVALID',
  // layout / typography / render
  LAYOUT_RECIPE_UNKNOWN: 'CI_LAYOUT_RECIPE_UNKNOWN',
  LAYOUT_INPUT_INVALID: 'CI_LAYOUT_INPUT_INVALID',
  LAYOUT_UNSATISFIABLE: 'CI_LAYOUT_UNSATISFIABLE',
  FONT_INVALID: 'CI_FONT_INVALID',
  FONT_MISSING: 'CI_FONT_MISSING',
  RENDER_INPUT_INVALID: 'CI_RENDER_INPUT_INVALID',
  RASTER_UNSUPPORTED: 'CI_RASTER_UNSUPPORTED',
  RENDER_NOT_RESOLVED: 'CI_RENDER_NOT_RESOLVED',
  // quality / candidate / selection
  QUALITY_REPORT_INVALID: 'CI_QUALITY_REPORT_INVALID',
  CANDIDATE_INVALID: 'CI_CANDIDATE_INVALID',
  CANDIDATE_APPROVAL_CLAIMED: 'CI_CANDIDATE_APPROVAL_CLAIMED',
  CANDIDATE_REPORT_STALE: 'CI_CANDIDATE_REPORT_STALE',
  SELECTION_INVALID: 'CI_SELECTION_INVALID',
  // provider registry
  PROVIDER_INVALID: 'CI_PROVIDER_INVALID',
  PROVIDER_RANKING_FORBIDDEN: 'CI_PROVIDER_RANKING_FORBIDDEN',
  PROVIDER_DUPLICATE: 'CI_PROVIDER_DUPLICATE',
  // resource resolution boundary
  RESOURCE_INVALID: 'CI_RESOURCE_INVALID',
  RESOURCE_REF_MISMATCH: 'CI_RESOURCE_REF_MISMATCH',
  RESOURCE_CROSS_MERCHANT: 'CI_RESOURCE_CROSS_MERCHANT',
  RESOURCE_KIND_MISMATCH: 'CI_RESOURCE_KIND_MISMATCH',
  RESOURCE_NOT_ACTIVE: 'CI_RESOURCE_NOT_ACTIVE',
  RESOURCE_RESOLVER_FAILED: 'CI_RESOURCE_RESOLVER_FAILED',
  RESOURCE_METADATA_LOCATION: 'CI_RESOURCE_METADATA_LOCATION',
  // marketing handoff
  HANDOFF_INVALID: 'CI_HANDOFF_INVALID',
  READINESS_INVALID: 'CI_READINESS_INVALID',
  PROBE_FAILED: 'CI_PROBE_FAILED',
  BENCHMARK_INVALID: 'CI_BENCHMARK_INVALID',
  // agents
  AGENT_UNKNOWN_ROLE: 'CI_AGENT_UNKNOWN_ROLE',
  AGENT_OUTPUT_INVALID: 'CI_AGENT_OUTPUT_INVALID',
  AGENT_FAILED: 'CI_AGENT_FAILED',
});

// Content kinds Creative Intelligence C1 can express (a deterministic still). VIDEO / TEXT are other lanes (later).
export const CI_SUPPORTED_CONTENT_KINDS = Object.freeze(['IMAGE', 'DOCUMENT']);

export const MEDIUM = Object.freeze({ PHYSICAL: 'PHYSICAL', DIGITAL: 'DIGITAL' });
export const TEXT_DIRECTION = Object.freeze({ LTR: 'LTR', RTL: 'RTL' });
export const RTL_LANGUAGES = Object.freeze(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv']);

export const PRIVACY_CLASS = Object.freeze({
  PUBLIC: 'PUBLIC', BUSINESS: 'BUSINESS', PERSONAL: 'PERSONAL', RESTRICTED: 'RESTRICTED',
});
// Ordered from least to most sensitive: a provider accepts an input when its privacy_class is at least as high as the input's.
export const PRIVACY_ORDER = Object.freeze(['PUBLIC', 'BUSINESS', 'PERSONAL', 'RESTRICTED']);
export const RIGHTS_CLASS = Object.freeze({
  OWNED: 'OWNED', LICENSED: 'LICENSED', UNKNOWN: 'UNKNOWN', RESTRICTED: 'RESTRICTED',
});
export const ASSET_KIND = Object.freeze({
  PRODUCT: 'PRODUCT', IMAGE: 'IMAGE', LOGO: 'LOGO', BACKGROUND: 'BACKGROUND',
});

export const READINESS = Object.freeze({
  READY: 'READY', PARTIAL: 'PARTIAL', NOT_READY: 'NOT_READY', NOT_MEASURABLE: 'NOT_MEASURABLE',
});

export const PRESERVATION_MODE = Object.freeze({
  PIXEL_PRESERVE: 'PIXEL_PRESERVE',
  COMPOSITE: 'COMPOSITE',
  CONTROLLED_EDIT: 'CONTROLLED_EDIT',
  GENERATIVE_REFERENCE: 'GENERATIVE_REFERENCE',
});
// The C1 renderer only places existing pixels: it renders the first two. The other two are CONTRACT-only modes for later lanes.
export const RENDERABLE_PRESERVATION_MODES = Object.freeze(['PIXEL_PRESERVE', 'COMPOSITE']);
export const ORIENTATION = Object.freeze({
  FRONT: 'FRONT', BACK: 'BACK', SIDE: 'SIDE', TOP: 'TOP', THREE_QUARTER: 'THREE_QUARTER', UNKNOWN: 'UNKNOWN',
});

export const PRODUCT_ROLE = Object.freeze({
  HERO: 'HERO', SUPPORTING: 'SUPPORTING', CONTEXT: 'CONTEXT', ABSENT: 'ABSENT',
});
export const SPATIAL_INTENT = Object.freeze({
  PRODUCT_CENTER_TEXT_BELOW: 'PRODUCT_CENTER_TEXT_BELOW',
  PRODUCT_CENTER_TEXT_ABOVE: 'PRODUCT_CENTER_TEXT_ABOVE',
  PRODUCT_START_TEXT_END: 'PRODUCT_START_TEXT_END',
  PRODUCT_END_TEXT_START: 'PRODUCT_END_TEXT_START',
  TEXT_DOMINANT: 'TEXT_DOMINANT',
  PRODUCT_AND_PRICE: 'PRODUCT_AND_PRICE',
});
export const NEGATIVE_SPACE = Object.freeze({
  NONE: 'NONE', TOP: 'TOP', BOTTOM: 'BOTTOM', START: 'START', END: 'END', SURROUNDING: 'SURROUNDING',
});
export const HIERARCHY_ROLE = Object.freeze({
  HEADLINE: 'HEADLINE', SUBHEADLINE: 'SUBHEADLINE', PRODUCT: 'PRODUCT', PRICE: 'PRICE', CTA: 'CTA', LOGO: 'LOGO',
  BODY: 'BODY', CAPTION: 'CAPTION',
});
// A provider prompt, a model, a seed or a parameter is ephemeral adapter data: it can never be stored in a domain object.
export const FORBIDDEN_PROVIDER_KEYS = Object.freeze([
  'prompt', 'negative_prompt', 'system_prompt', 'instruction', 'instructions', 'model', 'model_id', 'provider', 'provider_id',
  'seed', 'sampler', 'cfg', 'cfg_scale', 'steps', 'lora', 'temperature', 'api_key', 'endpoint',
]);

export const LAYER_TYPE = Object.freeze({
  BACKGROUND: 'BACKGROUND', PRODUCT: 'PRODUCT', IMAGE: 'IMAGE', TEXT: 'TEXT', SHAPE: 'SHAPE', LOGO: 'LOGO', GROUP: 'GROUP',
});
export const VISIBILITY = Object.freeze({ VISIBLE: 'VISIBLE', HIDDEN: 'HIDDEN' });
export const LAYER_ORIGIN = Object.freeze({
  PROVIDED_ASSET: 'PROVIDED_ASSET', ENGINE: 'ENGINE', AGENT: 'AGENT', GENERATED: 'GENERATED', HUMAN: 'HUMAN',
});
export const DERIVATION = Object.freeze({
  CREATE: 'CREATE', ADAPT: 'ADAPT', REFINE: 'REFINE', REUSE: 'REUSE',
});
export const IMAGE_FIT = Object.freeze({ COVER: 'COVER', CONTAIN: 'CONTAIN' });
export const SHAPE_KIND = Object.freeze({ RECT: 'RECT', ELLIPSE: 'ELLIPSE', LINE: 'LINE' });

export const TEXT_ROLE = Object.freeze({
  HEADLINE: 'HEADLINE', SUBHEADLINE: 'SUBHEADLINE', BODY: 'BODY', PRICE: 'PRICE', CTA: 'CTA', LEGAL: 'LEGAL',
  CAPTION: 'CAPTION', DECORATIVE: 'DECORATIVE',
});
// Roles that carry a fact whenever they exist: they MUST be claim-bearing.
export const FACT_BEARING_TEXT_ROLES = Object.freeze(['PRICE', 'LEGAL']);
export const TEXT_KIND = Object.freeze({
  CLAIM_BEARING: 'CLAIM_BEARING',
  NON_CLAIM_CREATIVE_TEXT: 'NON_CLAIM_CREATIVE_TEXT',
});
export const TEXT_ALIGNMENT = Object.freeze({ START: 'START', CENTER: 'CENTER', END: 'END' });
export const OVERFLOW_POLICY = Object.freeze({
  FAIL: 'FAIL', REWRITE_REQUIRED: 'REWRITE_REQUIRED', RELAYOUT_REQUIRED: 'RELAYOUT_REQUIRED',
});
export const MAX_TEXT_CONTENT = 600;
export const MAX_TEXT_LINES = 12;

export const CONSTRAINT_KIND = Object.freeze({
  MIN_MARGIN: 'MIN_MARGIN',
  NO_OVERLAP: 'NO_OVERLAP',
  WITHIN_SAFE_ZONE: 'WITHIN_SAFE_ZONE',
  ABOVE: 'ABOVE',
  BELOW: 'BELOW',
  ALIGN_CENTER_X: 'ALIGN_CENTER_X',
});
export const EFFECT_KIND = Object.freeze({ SHADOW: 'SHADOW', OPACITY: 'OPACITY' });

export const SCRIPT = Object.freeze({
  LATIN: 'LATIN', CYRILLIC: 'CYRILLIC', GREEK: 'GREEK', ARABIC: 'ARABIC', HEBREW: 'HEBREW', CJK: 'CJK', OTHER: 'OTHER',
});

export const PREFLIGHT_STATUS = Object.freeze({
  PASS: 'PASS', REVIEW_REQUIRED: 'REVIEW_REQUIRED', FAIL: 'FAIL', NOT_MEASURABLE: 'NOT_MEASURABLE',
});
// The mandate's minimum checks come first, in a fixed order; the extra ones are narrower integrity checks.
export const PREFLIGHT_CHECK = Object.freeze({
  TEXT_OVERFLOW: 'TEXT_OVERFLOW',
  TEXT_BELOW_MIN_SIZE: 'TEXT_BELOW_MIN_SIZE',
  LAYER_OUT_OF_BOUNDS: 'LAYER_OUT_OF_BOUNDS',
  SAFE_ZONE_VIOLATION: 'SAFE_ZONE_VIOLATION',
  FORBIDDEN_ZONE_OVERLAP: 'FORBIDDEN_ZONE_OVERLAP',
  PRODUCT_TEXT_COLLISION: 'PRODUCT_TEXT_COLLISION',
  MISSING_ASSET_REF: 'MISSING_ASSET_REF',
  MISSING_FONT_REF: 'MISSING_FONT_REF',
  MISSING_CLAIM_REF: 'MISSING_CLAIM_REF',
  DUPLICATE_LAYER_ID: 'DUPLICATE_LAYER_ID',
  INVALID_Z_ORDER: 'INVALID_Z_ORDER',
  INSUFFICIENT_CONTRAST: 'INSUFFICIENT_CONTRAST',
  OUTPUT_DIMENSION_MISMATCH: 'OUTPUT_DIMENSION_MISMATCH',
  // additional integrity checks
  TEXT_CONTENT_CHANGED: 'TEXT_CONTENT_CHANGED',
  FONT_SCRIPT_UNSUPPORTED: 'FONT_SCRIPT_UNSUPPORTED',
  PRODUCT_ASPECT_MISMATCH: 'PRODUCT_ASPECT_MISMATCH',
  GROUP_MEMBER_MISSING: 'GROUP_MEMBER_MISSING',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  TEXT_LAYER_OVERLAP: 'TEXT_LAYER_OVERLAP',
});
export const MANDATE_PREFLIGHT_CHECKS = Object.freeze(Object.values(PREFLIGHT_CHECK).slice(0, 13));

// WCAG 2.x contrast thresholds. "Large" text starts at 24 px (18 pt); below that the 4.5:1 rule applies.
export const CONTRAST_MIN = 4.5;
export const CONTRAST_MIN_LARGE = 3;
export const LARGE_TEXT_PX = 24;
export const ASPECT_TOLERANCE = 0.01;
export const GEOMETRY_EPSILON = 0.001;

export const QUALITY_DIMENSIONS = Object.freeze([
  'composition', 'hierarchy', 'balance', 'spacing', 'readability', 'product_prominence', 'visual_clutter', 'artifact_risk',
  'premium_credibility', 'channel_fit',
]);
export const QUALITY_STATUS = Object.freeze({
  PASS: 'PASS', REVIEW_REQUIRED: 'REVIEW_REQUIRED', NOT_MEASURABLE: 'NOT_MEASURABLE',
});
// No numeric "beauty" score, rank, rating or winner can exist in a quality report or a selection.
export const FORBIDDEN_SCORE_KEYS = Object.freeze([
  'score', 'scores', 'rating', 'rank', 'ranking', 'beauty', 'beauty_score', 'points', 'weight', 'weights', 'winner', 'best',
  'best_candidate', 'overall', 'overall_score', 'confidence_score',
]);
// A candidate never claims another module's verdict.
export const FORBIDDEN_APPROVAL_KEYS = Object.freeze([
  'approved', 'approval', 'approved_by', 'brand_approved', 'brand_guardian', 'guardian', 'guardian_status', 'guardian_verdict',
  'fidelity', 'fidelity_status', 'fidelity_verdict', 'creative_fidelity', 'published', 'publish', 'scheduled', 'activation',
]);

export const PROVIDER_CAPABILITY = Object.freeze({
  IMAGE_GENERATE: 'IMAGE_GENERATE',
  IMAGE_EDIT: 'IMAGE_EDIT',
  IMAGE_BACKGROUND: 'IMAGE_BACKGROUND',
  IMAGE_VECTOR: 'IMAGE_VECTOR',
  PRODUCT_SEGMENT: 'PRODUCT_SEGMENT',
  PRODUCT_RELIGHT: 'PRODUCT_RELIGHT',
  VIDEO_GENERATE: 'VIDEO_GENERATE',
  VIDEO_EDIT: 'VIDEO_EDIT',
  VOICE: 'VOICE',
  STT: 'STT',
});
export const LATENCY_CLASS = Object.freeze({ INTERACTIVE: 'INTERACTIVE', STANDARD: 'STANDARD', BATCH: 'BATCH' });
export const PROVIDER_HEALTH = Object.freeze({
  AVAILABLE: 'AVAILABLE', DEGRADED: 'DEGRADED', UNAVAILABLE: 'UNAVAILABLE', UNKNOWN: 'UNKNOWN',
});
// A permanent ranking / preference / default / winner is not part of the architecture (providers are data, not code).
export const FORBIDDEN_RANKING_KEYS = Object.freeze([
  'rank', 'ranking', 'score', 'priority', 'preferred', 'default', 'is_default', 'winner', 'best', 'weight', 'order', 'tier',
  'recommended', 'primary', 'fallback_order',
]);

export const AGENT_ROLE = Object.freeze({
  CREATIVE_ORCHESTRATOR: 'CREATIVE_ORCHESTRATOR',
  PRODUCT_ASSET_ANALYST: 'PRODUCT_ASSET_ANALYST',
  CREATIVE_DIRECTOR: 'CREATIVE_DIRECTOR',
  COPY_CLAIMS_AGENT: 'COPY_CLAIMS_AGENT',
  VISUAL_PRODUCTION_DIRECTOR: 'VISUAL_PRODUCTION_DIRECTOR',
  CREATIVE_CRITIC: 'CREATIVE_CRITIC',
});
export const ORCHESTRATION_STEP = Object.freeze({
  ASSET_READINESS: 'ASSET_READINESS',
  PRODUCT_UNDERSTANDING: 'PRODUCT_UNDERSTANDING',
  CREATIVE_DIRECTION: 'CREATIVE_DIRECTION',
  COPY_AND_CLAIMS: 'COPY_AND_CLAIMS',
  VISUAL_PRODUCTION: 'VISUAL_PRODUCTION',
  LAYOUT: 'LAYOUT',
  RENDER: 'RENDER',
  PREFLIGHT: 'PREFLIGHT',
  QUALITY_CRITIQUE: 'QUALITY_CRITIQUE',
  SELECTION: 'SELECTION',
});
export const VISUAL_PURPOSE = Object.freeze({
  BACKGROUND: 'BACKGROUND', AMBIENCE: 'AMBIENCE', RETOUCH: 'RETOUCH', REFERENCE: 'REFERENCE',
});
export const MAX_CANDIDATE_BUDGET = 5;

// ---- resource resolution boundary
// A reference is an OPAQUE identity. What it names (a product, a category, an asset, a claim, a font, a format) is told by an injected,
// trusted resolver - never inferred from the shape of the string. The resolver's kind is authoritative.
export const RESOURCE_KIND = Object.freeze({
  PRODUCT: 'PRODUCT',
  COLLECTION: 'COLLECTION',
  CATEGORY: 'CATEGORY',
  SUBJECT_OTHER: 'SUBJECT_OTHER',
  ASSET: 'ASSET',
  CLAIM: 'CLAIM',
  FONT: 'FONT',
  FORMAT: 'FORMAT',
  POLICY: 'POLICY',
});
// What a Marketing `subject_ref` may turn out to be once resolved.
export const SUBJECT_KINDS = Object.freeze(['PRODUCT', 'COLLECTION', 'CATEGORY', 'SUBJECT_OTHER']);
export const RESOURCE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE', UNRESOLVED: 'UNRESOLVED', REVOKED: 'REVOKED', EXPIRED: 'EXPIRED', RESTRICTED: 'RESTRICTED',
});
// Platform-level resources (a font, a format definition) may belong to no merchant; everything else belongs to exactly one.
export const PLATFORM_LEVEL_KINDS = Object.freeze(['FONT', 'FORMAT']);

// ---- pre-C2 dependencies (C2 stays blocked until every one that is not DEFERRED has explicit evidence)
export const PRE_C2_DEPENDENCY = Object.freeze({
  RESOURCE_RESOLVER: 'RESOURCE_RESOLVER',
  BRAND_EXPRESSION_SYSTEM: 'BRAND_EXPRESSION_SYSTEM',
  REAL_FONT_METRICS: 'REAL_FONT_METRICS',
  COMPLEX_SCRIPT_SHAPING: 'COMPLEX_SCRIPT_SHAPING',
  ARABIC_BIDI_RTL_VERIFICATION: 'ARABIC_BIDI_RTL_VERIFICATION',
  DETERMINISTIC_RASTERIZER: 'DETERMINISTIC_RASTERIZER',
  REAL_PNG_RENDER_PATH: 'REAL_PNG_RENDER_PATH',
  REAL_CAMPAIGN_BENCHMARK: 'REAL_CAMPAIGN_BENCHMARK',
  CJK_LINE_BREAKING: 'CJK_LINE_BREAKING',
});

// A render is STRUCTURAL while any media reference it needs has not been resolved into an ephemeral payload by the trusted resolver
// (it holds symbolic placeholders: fine for deterministic inspection, never a production render); RESOLVED when every one has.
export const RENDER_MODE = Object.freeze({ STRUCTURAL: 'STRUCTURAL', RESOLVED: 'RESOLVED' });
