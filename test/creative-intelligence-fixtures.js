// Synthetic, generic fixtures for the Creative Intelligence C1 tests (no merchant-specific content, no network, no media bytes).

import * as CI from '../src/creative-intelligence/index.js';

export const IDS = Object.freeze({
  merchant: '11111111-1111-4111-8111-111111111111',
  otherMerchant: '22222222-2222-4222-8222-222222222222',
  brand: '33333333-3333-4333-8333-333333333333',
});
export const NOW = '2026-10-10T09:00:00.000Z';
export const LATER = '2026-10-10T10:00:00.000Z';
export const BRIEF = 'brief:demo-001';
export const DIRECTION_REF = 'direction:demo-a';
export const PRODUCT = 'product://demo-item';
export const ASSET_PRODUCT = 'asset://demo/product-cutout';
export const ASSET_LOGO = 'asset://demo/logo';
export const ASSET_PHOTO = 'asset://demo/photo';
export const CLAIM_PRICE = 'claim://demo-price';
export const CLAIM_OTHER = 'claim://demo-other';
export const FONT = 'font:synthetic-sans';
export const FONT_AR = 'font:synthetic-arabic';
export const FONT_AR_EXACT = 'font:synthetic-arabic-exact';

// Real advance widths come from the real font file later; these are synthetic and deterministic (units per em = 1000).
const NARROW = 'iljtfI.,:;!|\'’ ';
const WIDE = 'mwMW@';
function advances() {
  const table = {};
  for (const ch of NARROW) table[ch] = 290;
  for (const ch of WIDE) table[ch] = 860;
  for (const ch of '0123456789') table[ch] = 560;
  return table;
}
export const fontEntries = () => [
  {
    font_ref: FONT, family: 'Synthetic Sans', generic: 'sans-serif', units_per_em: 1000, ascent: 800, descent: 200, default_advance: 540, advances: advances(), scripts: ['LATIN', 'CYRILLIC'], shaping: 'ADVANCE_TABLE',
  },
  {
    font_ref: FONT_AR, family: 'Synthetic Arabic', generic: 'sans-serif', units_per_em: 1000, ascent: 800, descent: 300, default_advance: 500, advances: {}, scripts: ['ARABIC'], shaping: 'ADVANCE_TABLE',
  },
  {
    font_ref: FONT_AR_EXACT, family: 'Synthetic Arabic Exact', generic: 'sans-serif', units_per_em: 1000, ascent: 800, descent: 300, default_advance: 500, advances: {}, scripts: ['ARABIC'], shaping: 'EXACT',
  },
];
export const fonts = () => CI.createFontRegistry(fontEntries());
export const assetDims = () => ({
  [ASSET_PRODUCT]: { width_px: 800, height_px: 1000 },
  [ASSET_LOGO]: { width_px: 600, height_px: 200 },
  [ASSET_PHOTO]: { width_px: 2000, height_px: 2000 },
});

export const outputContext = (over = {}) => ({
  content_kind: 'IMAGE',
  channel: 'SOCIAL_FEED',
  placement: 'FEED_POST',
  format_ref: 'format://demo/feed-4x5',
  canvas: { width: 1080, height: 1350 },
  aspect_ratio: '4:5',
  physical_or_digital: 'DIGITAL',
  viewing_distance_m: null,
  expected_dwell_time_s: 2,
  safe_zones: [{ zone_id: 'safe-main', x: 40, y: 100, width: 1000, height: 1150 }],
  forbidden_zones: [],
  locale: 'fr-BE',
  direction: 'LTR',
  production_constraints: [],
  ...over,
});

const provenance = (origin = 'AGENT') => ({ origin, producer_ref: null, evidence_refs: [] });
const geo = (x = 0, y = 0, width = 100, height = 100) => ({
  x, y, width, height, rotation_deg: 0,
});

export const textLayer = (id, role, content, over = {}) => {
  const factual = over.claim_ref !== undefined;
  return {
    id,
    type: 'TEXT',
    z_index: over.z_index ?? 20,
    geometry: over.geometry ?? geo(0, 0, 400, 100),
    visibility: 'VISIBLE',
    locked: false,
    source_ref: null,
    constraints: [],
    effects: [],
    provenance: provenance(),
    content,
    font_ref: FONT,
    font_size: over.font_size ?? 60,
    min_font_size: over.min_font_size ?? 24,
    line_height: 1.15,
    tracking: 0,
    alignment: 'START',
    max_lines: over.max_lines ?? 3,
    color: '#0F2A52',
    box: { padding: 0, vertical_align: 'TOP' },
    overflow_policy: 'RELAYOUT_REQUIRED',
    locale: 'fr-BE',
    direction: 'LTR',
    text_role: role,
    text_kind: factual ? 'CLAIM_BEARING' : 'NON_CLAIM_CREATIVE_TEXT',
    claim_ref: factual ? over.claim_ref : null,
    approved_digest: factual ? CI.textDigest(content) : null,
    ...(over.extra ?? {}),
  };
};

export const productLayer = (over = {}) => ({
  id: 'product',
  type: 'PRODUCT',
  z_index: 10,
  geometry: geo(100, 400, 400, 500),
  visibility: 'VISIBLE',
  locked: false,
  source_ref: null,
  constraints: [],
  effects: [],
  provenance: provenance('PROVIDED_ASSET'),
  product_ref: PRODUCT,
  asset_ref: ASSET_PRODUCT,
  preservation_mode: 'COMPOSITE',
  protected_regions: [{
    region_id: 'logo-on-pack', x: 0.3, y: 0.4, width: 0.4, height: 0.2,
  }],
  allow_crop: false,
  allow_relight: false,
  allow_shadow: true,
  allow_rotation: false,
  ...over,
});

export const logoLayer = (over = {}) => ({
  id: 'logo',
  type: 'LOGO',
  z_index: 15,
  geometry: geo(70, 70, 150, 50),
  visibility: 'VISIBLE',
  locked: false,
  source_ref: ASSET_LOGO,
  constraints: [],
  effects: [],
  provenance: provenance('PROVIDED_ASSET'),
  ...over,
});

export const backgroundLayer = (over = {}) => ({
  id: 'bg',
  type: 'BACKGROUND',
  z_index: 0,
  geometry: geo(0, 0, 1080, 1350),
  visibility: 'VISIBLE',
  locked: false,
  source_ref: null,
  constraints: [],
  effects: [],
  provenance: provenance('ENGINE'),
  fill: '#FBF8F3',
  ...over,
});

/** The unplaced layers of the demo creative: headline, subheadline, price (claim-bearing), call to action, logo, product, background. */
export const demoLayers = () => [
  backgroundLayer(),
  productLayer(),
  logoLayer(),
  textLayer('headline', 'HEADLINE', 'Votre objet, votre style', { font_size: 76, min_font_size: 44, z_index: 20 }),
  textLayer('subheadline', 'SUBHEADLINE', 'Personnalisée avec vos photos', { font_size: 40, min_font_size: 28, z_index: 21 }),
  textLayer('price', 'PRICE', '19,90 €', { claim_ref: CLAIM_PRICE, font_size: 64, min_font_size: 36, z_index: 22, max_lines: 1 }),
  textLayer('cta', 'CTA', 'Découvrir', { font_size: 44, min_font_size: 28, z_index: 23, max_lines: 1 }),
];

export const documentParts = (over = {}) => ({
  version: 1,
  merchant_id: IDS.merchant,
  brand_id: IDS.brand,
  brief_ref: BRIEF,
  direction_ref: DIRECTION_REF,
  output_context: outputContext(),
  canvas: { width: 1080, height: 1350, background_color: '#FBF8F3' },
  layers: demoLayers(),
  constraints: [],
  asset_refs: [ASSET_LOGO, ASSET_PRODUCT],
  claim_refs: [CLAIM_PRICE],
  provenance: {
    schema_version: CI.CI_VERSION, derivation: 'CREATE', parent_document_ref: null, created_by: 'AGENT', producer_refs: ['agent:demo'], evidence_refs: [],
  },
  created_at: NOW,
  ...over,
});

export const demoDocument = (over) => CI.buildDesignDocument(documentParts(over));
export const solved = (over = {}) => CI.solveLayout({
  document: over.document ?? demoDocument(), recipe_id: over.recipe_id ?? 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER, ...over,
});
export const preflightContext = (over = {}) => ({
  fonts: fonts(), assets: assetDims(), approved_claim_refs: [CLAIM_PRICE], ...over,
});

// An ephemeral payload a trusted resolver would hand to ONE render (a 1x1 PNG). It never belongs to a document.
export const PAYLOAD = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const resolveAllMedia = () => PAYLOAD;

export function candidateFor(document, { context = preflightContext(), quality = null } = {}) {
  const rendered = CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: resolveAllMedia });
  return CI.normalizeCreativeCandidate({
    merchant_id: document.merchant_id,
    brand_id: document.brand_id,
    brief_ref: document.brief_ref,
    direction_ref: document.direction_ref,
    render_mode: rendered.render_mode,
    rendered_asset_ref: CI.renderedAssetRefOf(rendered),
    design_document: document,
    preflight_report: CI.runCreativePreflight(document, context),
    quality_report: quality,
    provenance: { created_by: 'ENGINE', producer_refs: ['engine:demo'], evidence_refs: [] },
    created_at: LATER,
  });
}

export const code = (fn) => { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; };
export const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return 'NO_ERROR'; };
export const clone = (v) => JSON.parse(JSON.stringify(v));
export const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
export const checkOf = (report, name) => report.checks.find((c) => c.code === name);

export const resolutionFor = (reference, over = {}) => ({
  ref: reference, kind: 'ASSET', merchant_id: IDS.merchant, version: 1, status: 'ACTIVE', metadata: null, ...over,
});
export const intakeInput = (over = {}) => ({
  merchant_id: IDS.merchant,
  brand_id: IDS.brand,
  brief_ref: BRIEF,
  deliverable_ref: 'deliverable://demo-1',
  brand_context_ref: 'handoff://demo-1',
  subject_refs: [PRODUCT],
  source_asset_refs: [ASSET_PRODUCT, ASSET_LOGO],
  claim_refs: [CLAIM_PRICE],
  mandatory_content_refs: [],
  prohibited_content_refs: [],
  requirement_refs: [],
  policy_requirement_refs: [],
  consent_requirement_refs: [],
  promotion_rule_refs: [],
  needed_by: LATER,
  output_context: outputContext(),
  evidence_refs: ['evidence://brief-1'],
  created_at: NOW,
  ...over,
});
