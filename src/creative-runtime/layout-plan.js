import * as CI from '../creative-intelligence/index.js';

// Layout planning for the product-preserving runtime: the DECISIONS that turn a Creative Direction and the approved copy into a DesignDocument, as Nordla rules.
// Placement itself is the deterministic layout constraint engine's (solveLayout, recipe slots, uniform fit, text fitting); typography is the real fonts'.
// Nothing here knows the case at hand: it reads the direction, the brand tokens and the pixels of the environment.

/** The recipes that realize a spatial intent, in order of affinity (a hero product prefers the dominant layout). */
export function recipesForIntent(direction) {
  const hero = direction.product_role === 'HERO';
  const table = {
    PRODUCT_CENTER_TEXT_ABOVE: hero ? ['PRODUCT_DOMINANT', 'PRODUCT_HERO'] : ['PRODUCT_HERO', 'PRODUCT_DOMINANT'],
    PRODUCT_CENTER_TEXT_BELOW: ['PRODUCT_AND_PRICE'],
    PRODUCT_START_TEXT_END: ['EDITORIAL_SPLIT'],
    TEXT_DOMINANT: ['TEXT_LED'],
    PRODUCT_AND_PRICE: ['PRODUCT_AND_PRICE'],
  };
  return table[direction.spatial_intent] ?? [];
}

/**
 * spatial intent (+ product role) -> layout recipe, among the recipes of that intent the first one that has a SLOT for every text role the copy fills (a role with no slot would
 * be left unplaced). `roles` are the filled text roles. Returns { recipe_id, rule, considered } or { recipe_id: null, reason, considered }: never an approximation.
 */
export function selectLayoutRecipe(direction, roles = []) {
  const candidates = recipesForIntent(direction);
  if (!candidates.length) return { recipe_id: null, reason: 'NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT', considered: [] };
  const considered = candidates.map((id) => ({ recipe_id: id, missing_slots: roles.filter((role) => !CI.getLayoutRecipe(id).slots.some((s) => s.role === role)) }));
  const fit = considered.find((c) => c.missing_slots.length === 0);
  if (!fit) return { recipe_id: null, reason: 'NO_LAYOUT_RECIPE_COVERS_THE_HIERARCHY', considered };
  return { recipe_id: fit.recipe_id, rule: `SPATIAL_INTENT_${direction.spatial_intent}_RECIPE_WITH_A_SLOT_FOR_EVERY_ROLE`, considered };
}

// ---- typography rules (provisional, stated)
export const TYPE_SCALE = Object.freeze({
  rule: 'TYPE_SCALE_V1',
  initial_size_of_canvas_width: Object.freeze({ HEADLINE: 0.09, SUBHEADLINE: 0.05, PRICE: 0.075, CTA: 0.04, BODY: 0.035, CAPTION: 0.03, LEGAL: 0.025 }),
  max_lines: Object.freeze({ HEADLINE: 2, SUBHEADLINE: 1, PRICE: 1, CTA: 1, BODY: 3, CAPTION: 2, LEGAL: 3 }),
  min_size_of_canvas_width: 0.028,
});
const TYPOGRAPHY_ROLE_FOR = Object.freeze({
  HEADLINE: ['headline'], SUBHEADLINE: ['subheadline', 'speed_claim', 'supporting'], PRICE: ['price'], CTA: ['cta', 'supporting'], BODY: ['body', 'supporting'], CAPTION: ['supporting'], LEGAL: ['supporting'],
});

export const typographyRoleFor = (textRole, roles) => (TYPOGRAPHY_ROLE_FOR[textRole] ?? []).find((name) => roles[name]) ?? null;

// ---- colour rules
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
function saturation(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255); const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2; return (max - min) / (1 - Math.abs(2 * l - 1));
}

/** Quantile colours (by luminance: P5, P25, P50, P75, P95) of an environment image inside a box (a text slot): what the text really sits on. */
export function backdropSamples({ width, height, pixels }, box) {
  const x0 = Math.max(0, Math.floor(box.x)); const y0 = Math.max(0, Math.floor(box.y)); const x1 = Math.min(width, Math.ceil(box.x + box.width)); const y1 = Math.min(height, Math.ceil(box.y + box.height));
  const samples = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const p = (y * width + x) * 4; samples.push({ rgb: [pixels[p], pixels[p + 1], pixels[p + 2]], lum: 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2] }); }
  if (!samples.length) return ['#FFFFFF'];
  samples.sort((a, b) => a.lum - b.lum);
  return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => rgbToHex(samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].rgb));
}

/** The mean colour of an environment image inside a box (a text slot). */
export function meanColorInBox({ width, height, pixels }, box) {
  const x0 = Math.max(0, Math.floor(box.x)); const y0 = Math.max(0, Math.floor(box.y)); const x1 = Math.min(width, Math.ceil(box.x + box.width)); const y1 = Math.min(height, Math.ceil(box.y + box.height));
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const p = (y * width + x) * 4; r += pixels[p]; g += pixels[p + 1]; b += pixels[p + 2]; n += 1; }
  return n ? rgbToHex([r / n, g / n, b / n]) : '#FFFFFF';
}

/**
 * The text colour of a layer, from the brand's own colour tokens and the actual environment behind it:
 *   PRICE        -> the most saturated token that reads (contrast >= 4.5): the accent
 *   other roles  -> the token with the highest contrast
 * No token that reads (contrast < 4.5) means the best available is chosen and the preflight decides.
 */
export function chooseTextColor({ textRole, backdrops, tokens }) {
  // the contrast of a token is its WORST contrast over the colours the text really sits on
  const candidates = Object.entries(tokens).map(([token, hex]) => ({ token, hex, contrast: Math.min(...backdrops.map((b) => CI.contrastRatio(hex, b))), sat: saturation(hex) }));
  const reading = candidates.filter((c) => c.contrast >= 4.5);
  const pool = reading.length ? reading : candidates;
  const best = textRole === 'PRICE' && reading.length
    ? [...pool].sort((a, b) => b.sat - a.sat || b.contrast - a.contrast || (a.token < b.token ? -1 : 1))[0]
    : [...pool].sort((a, b) => b.contrast - a.contrast || (a.token < b.token ? -1 : 1))[0];
  return { ...best, candidates: candidates.map(({ token, contrast }) => ({ token, contrast })) };
}

/**
 * When no brand token reads on the environment behind a text, a SOLID plate in a brand token is placed behind it and the text takes a token that reads on the plate. The
 * plate token is the one on which most brand tokens read (ties: the lighter one), so every plated text uses the same plate. Returns null when no brand pair reads.
 */
export function choosePlate({ tokens }) {
  const entries = Object.entries(tokens);
  const scored = entries.map(([token, hex]) => ({ token, hex, readers: entries.filter(([other, h]) => other !== token && CI.contrastRatio(h, hex) >= 4.5).length, lum: CI.relativeLuminance(hex) }));
  scored.sort((a, b) => b.readers - a.readers || b.lum - a.lum || (a.token < b.token ? -1 : 1));
  return scored[0] && scored[0].readers > 0 ? { plate_token: scored[0].token, plate_hex: scored[0].hex } : null;
}

/** The plate layer behind a text box: a solid rectangle, padded, inside the canvas. */
export function plateLayer({ id, z, box, canvas, fill }) {
  const pad = Math.round(canvas.width * 0.02);
  const x = Math.max(0, box.x - pad); const y = Math.max(0, box.y - pad);
  const width = Math.min(canvas.width - x, box.width + 2 * pad); const height = Math.min(canvas.height - y, box.height + 2 * pad);
  return {
    ...common(id, 'SHAPE', z, geo(x, y, width, height), 'ENGINE'), shape_kind: 'RECT', fill, stroke: null, stroke_width: 0, corner_radius: Math.round(canvas.width * 0.012),
  };
}

/** A soft contact shadow under the product: the darkest brand colour, offset down and slightly to the end, scaled to the canvas. */
export function shadowRule({ canvas, tokens }) {
  const darkest = Object.values(tokens).map((hex) => ({ hex, lum: CI.relativeLuminance(hex) })).sort((a, b) => a.lum - b.lum)[0].hex;
  return { kind: 'SHADOW', dx: Math.round(canvas.width * 0.006), dy: Math.round(canvas.height * 0.012), blur: Math.round(canvas.width * 0.016), color: darkest, opacity: 0.32 };
}

const common = (id, type, z, geometry, origin, producerRef = null) => ({
  id, type, z_index: z, geometry, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin, producer_ref: producerRef, evidence_refs: [] },
});
const geo = (x, y, width, height) => ({ x, y, width, height, rotation_deg: 0 });

/**
 * The (unplaced) DesignDocument: the generated environment as the background, the real product cut-out as a COMPOSITE product layer with its contact shadow, and one
 * text layer per approved copy item. The layout engine places everything afterwards.
 */
export function assembleDocument({
  at, ids, direction, format, brand, copyItems, product, environment, fonts, assetRefs, claimRefs,
}) {
  const { canvas } = format;
  const layers = [
    { ...common('environment', 'BACKGROUND', 0, geo(0, 0, canvas.width, canvas.height), 'GENERATED', `provider:${environment.provider_id}`), source_ref: environment.ref, fill: null },
    {
      ...common('product', 'PRODUCT', 10, geo(0, 0, 100, 100), 'PROVIDED_ASSET'),
      effects: [shadowRule({ canvas, tokens: brand.colors })],
      product_ref: ids.product_ref,
      asset_ref: product.cutout_ref,
      preservation_mode: 'COMPOSITE',
      protected_regions: [],
      allow_crop: false,
      allow_relight: false,
      allow_shadow: true,
      allow_rotation: false,
    },
  ];
  const sorted = [...copyItems];
  let z = 20;
  const centered = ['PRODUCT_DOMINANT', 'PRODUCT_HERO', 'TEXT_LED', 'PRODUCT_AND_PRICE'].includes(format.recipe_id);
  for (const item of sorted) {
    const typo = typographyRoleFor(item.text_role, brand.typography_roles);
    if (!typo) throw Object.assign(new Error(`no typography role in the brand for the text role ${item.text_role}`), { code: 'NO_TYPOGRAPHY_ROLE_FOR_TEXT_ROLE' });
    const initial = Math.round(canvas.width * TYPE_SCALE.initial_size_of_canvas_width[item.text_role]);
    layers.push({
      ...common(`text-${item.text_role.toLowerCase()}`, 'TEXT', z, geo(0, 0, 400, 100), 'ENGINE'),
      content: item.content,
      font_ref: brand.typography_roles[typo].instance_ref,
      font_size: initial,
      min_font_size: Math.round(canvas.width * TYPE_SCALE.min_size_of_canvas_width),
      line_height: 1.15,
      tracking: 0,
      alignment: centered ? 'CENTER' : 'START',
      max_lines: TYPE_SCALE.max_lines[item.text_role],
      color: Object.values(brand.colors)[0],
      box: { padding: 0, vertical_align: 'TOP' },
      overflow_policy: 'RELAYOUT_REQUIRED',
      locale: format.locale ?? 'fr-BE',
      direction: 'LTR',
      text_role: item.text_role,
      text_kind: item.text_kind,
      claim_ref: item.claim_ref,
      approved_digest: item.text_kind === 'CLAIM_BEARING' ? CI.textDigest(item.content) : null,
    });
    z += 1;
  }
  return CI.buildDesignDocument({
    version: 1,
    merchant_id: ids.merchant_id,
    brand_id: ids.brand_id,
    brief_ref: ids.brief_ref,
    direction_ref: `direction:${direction.direction_id}`,
    output_context: {
      content_kind: 'IMAGE',
      channel: format.channel ?? 'SOCIAL_FEED',
      placement: format.placement ?? 'FEED_POST',
      format_ref: format.ref,
      canvas: { width: canvas.width, height: canvas.height },
      aspect_ratio: format.aspect_ratio ?? '4:5',
      physical_or_digital: format.medium,
      viewing_distance_m: null,
      expected_dwell_time_s: 2,
      safe_zones: format.safe_zones ?? [],
      forbidden_zones: format.forbidden_zones ?? [],
      locale: format.locale ?? 'fr-BE',
      direction: 'LTR',
      production_constraints: format.production_constraints ?? [],
    },
    canvas: { width: canvas.width, height: canvas.height, background_color: Object.values(brand.colors).find((hex) => hex.toUpperCase() === '#FFFFFF') ?? '#FFFFFF' },
    layers,
    constraints: [],
    asset_refs: assetRefs,
    claim_refs: claimRefs,
    provenance: { schema_version: CI.CI_VERSION, derivation: 'CREATE', parent_document_ref: null, created_by: 'ENGINE', producer_refs: ['engine:creative-runtime.layout-plan'], evidence_refs: [] },
    created_at: at,
  });
}
