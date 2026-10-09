import test from 'node:test';
import assert from 'node:assert/strict';

import * as CI from '../src/creative-intelligence/index.js';
import {
  ASSET_LOGO, ASSET_PHOTO, ASSET_PRODUCT, BRIEF, CLAIM_OTHER, CLAIM_PRICE, IDS, NOW, PRODUCT, acode, clone, code, intakeInput, isDeepFrozen, outputContext, resolutionFor,
} from './creative-intelligence-fixtures.js';

// Each `// N text` marker below is one row of the C1 coverage matrix (docs/architecture/creative-intelligence-v1.md); a test
// that checks the row carries the marker right above the assertion.

// ------------------------------------------------------------------ creative intake (1-10)

test('Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic', () => {
  const intake = CI.normalizeCreativeIntake(intakeInput());
  // 1 a valid intake is normalized and deep-frozen
  assert.ok(isDeepFrozen(intake));
  assert.equal(intake.merchant_id, IDS.merchant);
  // 2 the intake id is derived from the content and deterministic
  assert.equal(CI.normalizeCreativeIntake(intakeInput()).intake_id, intake.intake_id);
  assert.notEqual(CI.normalizeCreativeIntake(intakeInput({ brief_ref: 'brief:other' })).intake_id, intake.intake_id);
  // 3 an unknown key is refused
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ extra: 1 }))), CI.CI_ERROR.UNKNOWN_KEY);
  // 4 a provider prompt / model key is refused
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ prompt: 'make it pop' }))), CI.CI_ERROR.FORBIDDEN_KEY);
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ output_context: { ...outputContext(), model: 'x' } }))), CI.CI_ERROR.FORBIDDEN_KEY);
  // 5 a URL can never be an asset reference
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: ['https://cdn.example.com/a.png'] }))), CI.CI_ERROR.INVALID_REFERENCE);
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: ['cdn.example.com/a.png'] }))), CI.CI_ERROR.INVALID_REFERENCE);
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: ['data:image/png;base64,AAAA'] }))), CI.CI_ERROR.INVALID_REFERENCE);
  // the platform convention scheme://name is an identity, not a location
  assert.deepEqual(CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: ['asset://folder/a'] })).source_asset_refs, ['asset://folder/a']);
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: ['s3://bucket/a'] }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 6 identifiers are validated (merchant UUID, brief reference)
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ merchant_id: 'not-a-uuid' }))), CI.CI_ERROR.INVALID_FIELD);
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ brief_ref: undefined }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 7 an intake may carry no source asset (the readiness report then says NO_ASSETS)
  assert.deepEqual(CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: [] })).source_asset_refs, []);
  // 8 a free-text claim is not a claim reference
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ claim_refs: ['Livraison gratuite dès 50 euros'] }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 9 the clock is explicit and carries an offset
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ created_at: '2026-10-10' }))), CI.CI_ERROR.INVALID_TIMESTAMP);
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ created_at: undefined }))), CI.CI_ERROR.INVALID_TIMESTAMP);
  // 10 an intake needs a subject reference or an approved claim reference, and no content can be both mandatory and prohibited
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ subject_refs: [], claim_refs: [] }))), CI.CI_ERROR.INTAKE_INVALID);
  assert.ok(CI.normalizeCreativeIntake(intakeInput({ subject_refs: [] })));
  assert.equal(code(() => CI.normalizeCreativeIntake(intakeInput({ mandatory_content_refs: ['content://x'], prohibited_content_refs: ['content://x'] }))), CI.CI_ERROR.INTAKE_INVALID);
});

// ------------------------------------------------------------------ output context (11-20)

test('Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds', () => {
  const ctx = CI.normalizeOutputContext(outputContext());
  // 11 a valid output context is normalized
  assert.equal(ctx.canvas.width, 1080);
  assert.equal(ctx.aspect_ratio, '4:5');
  // 12 the aspect ratio must follow from the canvas
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ aspect_ratio: '16:9' }))), CI.CI_ERROR.ASPECT_RATIO_MISMATCH);
  assert.equal(CI.reducedAspectRatio(1920, 1080), '16:9');
  // 13 VIDEO and TEXT are not expressible by C1
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ content_kind: 'VIDEO' }))), CI.CI_ERROR.CONTENT_KIND_UNSUPPORTED);
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ content_kind: 'TEXT' }))), CI.CI_ERROR.CONTENT_KIND_UNSUPPORTED);
  // 14 canvas bounds are enforced
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ canvas: { width: 10, height: 10 }, aspect_ratio: '1:1' }))), CI.CI_ERROR.CANVAS_INVALID);
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ canvas: { width: 20000, height: 10000 }, aspect_ratio: '2:1' }))), CI.CI_ERROR.CANVAS_INVALID);
  // 15 a zone must lie inside the canvas
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ safe_zones: [{ zone_id: 'z', x: 900, y: 0, width: 400, height: 100 }] }))), CI.CI_ERROR.ZONE_INVALID);
  // 16 zones are validated and their ids are unique across safe and forbidden zones
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ forbidden_zones: [{ zone_id: 'safe-main', x: 0, y: 0, width: 10, height: 10 }] }))), CI.CI_ERROR.ZONE_INVALID);
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ safe_zones: [{ zone_id: 'a', x: 0, y: 0, width: 10, height: 10 }, { zone_id: 'a', x: 20, y: 0, width: 10, height: 10 }] }))), CI.CI_ERROR.ZONE_INVALID);
  // 17 the direction must agree with the locale
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ locale: 'ar-SA', direction: 'LTR' }))), CI.CI_ERROR.DIRECTION_LOCALE_MISMATCH);
  assert.equal(CI.normalizeOutputContext(outputContext({ locale: 'ar-SA', direction: 'RTL' })).direction, 'RTL');
  assert.equal(CI.directionForLocale('fr-BE'), 'LTR');
  // 18 a viewing distance only exists for a PHYSICAL output
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ viewing_distance_m: 2 }))), CI.CI_ERROR.INVALID_FIELD);
  assert.equal(CI.normalizeOutputContext(outputContext({ physical_or_digital: 'PHYSICAL', viewing_distance_m: 2 })).viewing_distance_m, 2);
  // 19 an unknown key is refused and production constraints are tokens
  assert.equal(code(() => CI.normalizeOutputContext({ ...outputContext(), icc_profile: 'FOGRA39' })), CI.CI_ERROR.UNKNOWN_KEY);
  assert.equal(code(() => CI.normalizeOutputContext(outputContext({ production_constraints: ['not a token'] }))), CI.CI_ERROR.INVALID_FIELD);
  // 20 the context is deep-frozen and its zones are in a stable order
  const ordered = CI.normalizeOutputContext(outputContext({ safe_zones: [{ zone_id: 'b', x: 0, y: 0, width: 10, height: 10 }, { zone_id: 'a', x: 20, y: 0, width: 10, height: 10 }] }));
  assert.deepEqual(ordered.safe_zones.map((z) => z.zone_id), ['a', 'b']);
  assert.ok(isDeepFrozen(ordered));
});

// ------------------------------------------------------------------ asset readiness (21-35)

const asset = (over = {}) => ({
  asset_ref: ASSET_PRODUCT, kind: 'PRODUCT', width_px: 2000, height_px: 2500, has_alpha: true, cutout_available: true, rights_class: 'OWNED', privacy_class: 'PUBLIC', released: true, ...over,
});
const readiness = (assets, target = { width: 1080, height: 1350 }, resolutions = assets.map((a) => resolutionFor(a.asset_ref))) => CI.buildAssetReadinessReport({
  merchant_id: IDS.merchant, brand_id: IDS.brand, assets, resolutions, target, created_at: NOW,
});

test('Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation', () => {
  // 21 a sufficient, owned, classified product with a cut-out is READY
  assert.equal(readiness([asset()]).status, 'READY');
  // 22 an asset that needs an upscale is PARTIAL
  assert.equal(readiness([asset({ width_px: 800, height_px: 1000 })]).status, 'PARTIAL');
  // 23 an asset far below the target is NOT_READY
  assert.equal(readiness([asset({ width_px: 200, height_px: 250 })]).status, 'NOT_READY');
  // 24 restricted rights are NOT_READY
  assert.equal(readiness([asset({ rights_class: 'RESTRICTED' })]).status, 'NOT_READY');
  // 25 unknown rights are PARTIAL, never READY
  assert.equal(readiness([asset({ rights_class: 'UNKNOWN' })]).status, 'PARTIAL');
  // 26 unknown dimensions are NOT_MEASURABLE
  assert.equal(readiness([asset({ width_px: null, height_px: null })]).status, 'NOT_MEASURABLE');
  // 27 an unclassified privacy class is NOT_MEASURABLE
  assert.equal(readiness([asset({ privacy_class: null })]).status, 'NOT_MEASURABLE');
  // 28 a product with no cut-out information is NOT_MEASURABLE
  assert.equal(readiness([asset({ has_alpha: null, cutout_available: null })]).status, 'NOT_MEASURABLE');
  // 29 a product that needs a cut-out is PARTIAL
  assert.equal(readiness([asset({ has_alpha: false, cutout_available: false })]).status, 'PARTIAL');
  // 30 no assets at all is NOT_READY (NO_ASSETS)
  const none = readiness([]);
  assert.equal(none.status, 'NOT_READY');
  assert.deepEqual(none.reason_codes, ['NO_ASSETS']);
  // 31 aggregation precedence: NOT_READY > NOT_MEASURABLE > PARTIAL > READY
  const mixed = readiness([
    asset({ asset_ref: 'asset:a' }),
    asset({ asset_ref: 'asset:b', rights_class: 'UNKNOWN' }),
    asset({ asset_ref: 'asset:c', width_px: null, height_px: null }),
  ]);
  assert.equal(mixed.status, 'NOT_MEASURABLE');
  assert.equal(readiness([...mixed.items.map((i) => ({ ...asset(), asset_ref: i.asset_ref })), asset({ asset_ref: 'asset:z', rights_class: 'RESTRICTED' })]).status, 'NOT_READY');
  // 32 personal, restricted, unclassified or unreleased media is not allowed to reach a cloud provider by default
  const flags = Object.fromEntries(readiness([
    asset({ asset_ref: 'asset:pub' }),
    asset({ asset_ref: 'asset:biz', privacy_class: 'BUSINESS' }),
    asset({ asset_ref: 'asset:per', privacy_class: 'PERSONAL' }),
    asset({ asset_ref: 'asset:unk', privacy_class: null }),
    asset({ asset_ref: 'asset:rel', released: false }),
  ]).items.map((i) => [i.asset_ref, i.cloud_provider_allowed]));
  assert.deepEqual(flags, { 'asset:pub': true, 'asset:biz': true, 'asset:per': false, 'asset:unk': false, 'asset:rel': false });
  // 33 the same asset reference twice is refused
  assert.equal(code(() => readiness([asset(), asset()])), CI.CI_ERROR.ASSET_REPORT_INVALID);
  // 34 the reuse lookup is a contract: references and provenance only, and it answers its own request
  const request = CI.normalizeReuseLookupRequest({ merchant_id: IDS.merchant, brand_id: IDS.brand, product_ref: PRODUCT, content_kind: 'IMAGE', channel: 'SOCIAL_FEED', locale: 'fr-BE' });
  const match = {
    asset_ref: ASSET_PHOTO, approved_at: NOW, provenance_ref: 'prov:approved-1', content_kind: 'IMAGE', channel: 'SOCIAL_FEED', locale: 'fr-BE',
  };
  assert.equal(CI.normalizeReuseLookupResult({ request_id: request.request_id, matches: [match] }, request).matches.length, 1);
  assert.equal(code(() => CI.normalizeReuseLookupResult({ request_id: 'clr_other', matches: [] }, request)), CI.CI_ERROR.ASSET_REPORT_INVALID);
  assert.equal(code(() => CI.normalizeReuseLookupResult({ request_id: request.request_id, matches: [{ ...match, asset_ref: 'https://x.test/a.png' }] }, request)), CI.CI_ERROR.INVALID_REFERENCE);
  // 35 the report id is derived, the report is deep-frozen and an unknown key is refused
  const report = readiness([asset()]);
  assert.match(report.report_id, /^car_[0-9a-f]{32}$/);
  assert.equal(readiness([asset()]).report_id, report.report_id);
  assert.ok(isDeepFrozen(report));
  assert.equal(code(() => readiness([{ ...asset(), pixels: 'AAAA' }])), CI.CI_ERROR.ASSET_REPORT_INVALID);
});

// ------------------------------------------------------------------ product understanding (36-45)

const understanding = (over = {}) => ({
  merchant_id: IDS.merchant,
  brand_id: IDS.brand,
  product_ref: PRODUCT,
  asset_refs: [ASSET_PRODUCT],
  protected_regions: [{ region_id: 'logo', x: 0.3, y: 0.4, width: 0.4, height: 0.2 }],
  logo_regions: [{ region_id: 'logo', x: 0.3, y: 0.4, width: 0.4, height: 0.2 }],
  packaging_text_regions: [],
  dominant_orientation: 'FRONT',
  product_bounds: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
  transformation_policy: { mode: 'COMPOSITE', allow_crop: false, allow_relight: false, allow_shadow: true, allow_rotation: false },
  created_at: NOW,
  ...over,
});
const policy = (over) => understanding({ transformation_policy: { mode: 'COMPOSITE', ...over } });

test('Product understanding: preservation modes, protected regions and the commerce default', () => {
  // 36 a valid package is normalized
  const pkg = CI.normalizeProductUnderstanding(understanding());
  assert.equal(pkg.transformation_policy.mode, 'COMPOSITE');
  // 37 PIXEL_PRESERVE forbids crop, relight and rotation
  for (const flag of ['allow_relight', 'allow_rotation', 'allow_crop']) {
    assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ transformation_policy: { mode: 'PIXEL_PRESERVE', [flag]: true } }))), CI.CI_ERROR.PRESERVATION_POLICY_INVALID);
  }
  assert.ok(CI.normalizeProductUnderstanding(understanding({ transformation_policy: { mode: 'PIXEL_PRESERVE', allow_shadow: true } })));
  // 38 COMPOSITE places the original pixels: no relight
  assert.equal(code(() => CI.normalizeProductUnderstanding(policy({ allow_relight: true }))), CI.CI_ERROR.PRESERVATION_POLICY_INVALID);
  // 39 CONTROLLED_EDIT needs a justification and protected regions
  assert.equal(code(() => CI.normalizeProductUnderstanding(policy({ mode: 'CONTROLLED_EDIT' }))), CI.CI_ERROR.PRESERVATION_POLICY_INVALID);
  assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ protected_regions: [], logo_regions: [], transformation_policy: { mode: 'CONTROLLED_EDIT', justification_ref: 'just:1' } }))), CI.CI_ERROR.PRESERVATION_POLICY_INVALID);
  assert.ok(CI.normalizeProductUnderstanding(understanding({ transformation_policy: { mode: 'CONTROLLED_EDIT', justification_ref: 'just:1' } })));
  // 40 GENERATIVE_REFERENCE needs a justification as well
  assert.equal(code(() => CI.normalizeProductUnderstanding(policy({ mode: 'GENERATIVE_REFERENCE' }))), CI.CI_ERROR.PRESERVATION_POLICY_INVALID);
  assert.ok(CI.normalizeProductUnderstanding(policy({ mode: 'GENERATIVE_REFERENCE', justification_ref: 'just:2' })));
  // 41 a logo / packaging-text region must be covered by a protected region
  assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ protected_regions: [] }))), CI.CI_ERROR.REGION_INVALID);
  assert.ok(CI.normalizeProductUnderstanding(understanding({ protected_regions: [{ region_id: 'whole', x: 0, y: 0, width: 1, height: 1 }] })));
  // 42 regions are fractions that stay inside the asset
  assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ protected_regions: [{ region_id: 'logo', x: 0.8, y: 0.8, width: 0.4, height: 0.4 }], logo_regions: [] }))), CI.CI_ERROR.REGION_INVALID);
  assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ product_bounds: { x: 0, y: 0, width: 2, height: 1 } }))), CI.CI_ERROR.REGION_INVALID);
  // 43 the same region id twice is refused
  const dup = { region_id: 'logo', x: 0.3, y: 0.4, width: 0.4, height: 0.2 };
  assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ protected_regions: [dup, dup] }))), CI.CI_ERROR.REGION_INVALID);
  // 44 the orientation defaults to UNKNOWN and is a closed set
  assert.equal(CI.normalizeProductUnderstanding(understanding({ dominant_orientation: undefined })).dominant_orientation, 'UNKNOWN');
  assert.equal(code(() => CI.normalizeProductUnderstanding(understanding({ dominant_orientation: 'UPSIDE_DOWN' }))), CI.CI_ERROR.INVALID_FIELD);
  // 45 the package id is derived, the package is deep-frozen and an unknown key is refused
  assert.match(pkg.package_id, /^cpu_[0-9a-f]{32}$/);
  assert.ok(isDeepFrozen(pkg));
  assert.equal(code(() => CI.normalizeProductUnderstanding({ ...understanding(), mask_bytes: 'AAAA' })), CI.CI_ERROR.UNKNOWN_KEY);
});

// ------------------------------------------------------------------ creative direction (46-55)

const direction = (over = {}) => ({
  merchant_id: IDS.merchant,
  brand_id: IDS.brand,
  brief_ref: BRIEF,
  concept: 'The case as a small personal object',
  copy_intent: 'Invite the customer to personalize',
  visual_intent: 'Calm, uncluttered, soft daylight',
  product_role: 'HERO',
  spatial_intent: 'PRODUCT_CENTER_TEXT_BELOW',
  negative_space_intent: 'TOP',
  hierarchy: ['HEADLINE', 'PRODUCT', 'PRICE', 'CTA'],
  required_asset_refs: [ASSET_PRODUCT],
  claim_refs: [CLAIM_PRICE],
  forbidden_transformations: ['RECOLOR_PRODUCT', 'REDRAW_LOGO'],
  evidence_refs: ['evidence:brief-1'],
  ...over,
});

test('Creative direction: intent as enums, never a provider prompt; distinct directions', () => {
  // 46 a valid direction is normalized and deep-frozen
  const d = CI.normalizeCreativeDirection(direction());
  assert.ok(isDeepFrozen(d));
  assert.match(d.direction_id, /^cdr_[0-9a-f]{32}$/);
  // 47 a provider prompt, model or seed is refused anywhere in the input
  for (const key of ['prompt', 'negative_prompt', 'model', 'seed', 'provider', 'temperature']) {
    assert.equal(code(() => CI.normalizeCreativeDirection(direction({ [key]: 'x' }))), CI.CI_ERROR.FORBIDDEN_KEY, key);
  }
  // 48 an unknown key is refused
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ camera: '85mm' }))), CI.CI_ERROR.UNKNOWN_KEY);
  // 49 hierarchy rules: no repeated role, a HERO needs the product in it, an absent product cannot be ranked
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ hierarchy: ['HEADLINE', 'HEADLINE'] }))), CI.CI_ERROR.DIRECTION_INVALID);
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ hierarchy: ['HEADLINE', 'PRICE'] }))), CI.CI_ERROR.DIRECTION_INVALID);
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ product_role: 'ABSENT' }))), CI.CI_ERROR.DIRECTION_INVALID);
  // 50 a forged direction id is refused
  assert.equal(code(() => CI.normalizeCreativeDirection({ ...direction(), direction_id: 'cdr_forged' })), CI.CI_ERROR.ID_MISMATCH);
  assert.equal(CI.normalizeCreativeDirection({ ...direction(), direction_id: d.direction_id }).direction_id, d.direction_id);
  // 51 the spatial intent is a closed set
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ spatial_intent: 'TEXT_ON_THE_LEFT_SOMEWHERE' }))), CI.CI_ERROR.INVALID_FIELD);
  // 52 the negative-space intent is a closed set
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ negative_space_intent: 'LOTS' }))), CI.CI_ERROR.INVALID_FIELD);
  // 53 the same direction twice is not a second candidate
  const a = CI.normalizeCreativeDirection(direction());
  assert.equal(code(() => CI.assertDistinctDirections([a, CI.normalizeCreativeDirection(direction())])), CI.CI_ERROR.DIRECTION_NOT_DISTINCT);
  // 54 two directions with the same concept and spatial intent are not distinct
  const b = CI.normalizeCreativeDirection(direction({ visual_intent: 'Bold colour blocking' }));
  assert.equal(code(() => CI.assertDistinctDirections([a, b])), CI.CI_ERROR.DIRECTION_NOT_DISTINCT);
  const c = CI.normalizeCreativeDirection(direction({ concept: 'A gift to be opened', spatial_intent: 'TEXT_DOMINANT', hierarchy: ['HEADLINE', 'PRODUCT'] }));
  assert.equal(CI.assertDistinctDirections([a, c]).length, 2);
  // 55 references are opaque: a URL is refused
  assert.equal(code(() => CI.normalizeCreativeDirection(direction({ required_asset_refs: ['https://x.test/a.png'] }))), CI.CI_ERROR.INVALID_REFERENCE);
});

// ------------------------------------------------------------------ provider capability registry (206-220)

const provider = (over = {}) => ({
  provider_id: 'provider-a',
  capabilities: ['IMAGE_GENERATE', 'IMAGE_BACKGROUND'],
  regions: ['EU'],
  privacy_class: 'BUSINESS',
  commercial_rights_ref: 'rights:a',
  latency_class: 'STANDARD',
  cost_model_ref: 'cost:a',
  health: 'AVAILABLE',
  benchmark_refs: ['bench:2026-q4-a'],
  ...over,
});

test('Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor', async () => {
  // 206 a valid entry is normalized and deep-frozen
  const entry = CI.normalizeProviderEntry(provider());
  assert.ok(isDeepFrozen(entry));
  assert.deepEqual(entry.capabilities, ['IMAGE_BACKGROUND', 'IMAGE_GENERATE']);
  // 207 capabilities are a closed set (video and voice exist as contract values, anything else is refused)
  assert.equal(code(() => CI.normalizeProviderEntry(provider({ capabilities: ['MIND_READING'] }))), CI.CI_ERROR.PROVIDER_INVALID);
  assert.ok(CI.normalizeProviderEntry(provider({ capabilities: ['VIDEO_GENERATE', 'VOICE', 'STT'] })));
  assert.equal(code(() => CI.normalizeProviderEntry(provider({ capabilities: [] }))), CI.CI_ERROR.PROVIDER_INVALID);
  // 208 a rank, priority, default, preference or winner is refused
  for (const key of ['rank', 'priority', 'default', 'preferred', 'winner', 'score', 'weight', 'is_default', 'recommended']) {
    assert.equal(code(() => CI.normalizeProviderEntry(provider({ [key]: 1 }))), CI.CI_ERROR.PROVIDER_RANKING_FORBIDDEN, key);
  }
  // 209 no default and no winner: every qualifying provider is returned, in provider_id order
  const registry = CI.createProviderRegistry([provider({ provider_id: 'zeta' }), provider({ provider_id: 'alpha' }), provider({ provider_id: 'mid' })]);
  assert.deepEqual(registry.findByCapability('IMAGE_GENERATE', { inputPrivacy: 'PUBLIC' }).map((p) => p.provider_id), ['alpha', 'mid', 'zeta']);
  // 210 an input more sensitive than the provider's class is filtered out
  const privacy = CI.createProviderRegistry([provider({ provider_id: 'pub', privacy_class: 'PUBLIC' }), provider({ provider_id: 'per', privacy_class: 'PERSONAL' })]);
  assert.deepEqual(privacy.findByCapability('IMAGE_EDIT', { inputPrivacy: 'PERSONAL' }).map((p) => p.provider_id), []);
  assert.deepEqual(CI.createProviderRegistry([provider({ provider_id: 'per', privacy_class: 'PERSONAL', capabilities: ['IMAGE_EDIT'] })]).findByCapability('IMAGE_EDIT', { inputPrivacy: 'BUSINESS' }).map((p) => p.provider_id), ['per']);
  assert.deepEqual(privacy.findByCapability('IMAGE_GENERATE', { inputPrivacy: 'PUBLIC' }).map((p) => p.provider_id), ['per', 'pub']);
  assert.deepEqual(privacy.findByCapability('IMAGE_GENERATE', { inputPrivacy: 'BUSINESS' }).map((p) => p.provider_id), ['per']);
  // 211 the region filter applies when asked
  const regions = CI.createProviderRegistry([provider({ provider_id: 'eu', regions: ['EU'] }), provider({ provider_id: 'us', regions: ['US'] })]);
  assert.deepEqual(regions.findByCapability('IMAGE_GENERATE', { inputPrivacy: 'PUBLIC', region: 'EU' }).map((p) => p.provider_id), ['eu']);
  // 212 an UNAVAILABLE provider is excluded, a DEGRADED one only when allowed
  const health = CI.createProviderRegistry([provider({ provider_id: 'up' }), provider({ provider_id: 'down', health: 'UNAVAILABLE' }), provider({ provider_id: 'slow', health: 'DEGRADED' }), provider({ provider_id: 'unk', health: 'UNKNOWN' })]);
  assert.deepEqual(health.findByCapability('IMAGE_GENERATE', { inputPrivacy: 'PUBLIC' }).map((p) => p.provider_id), ['slow', 'unk', 'up']);
  assert.deepEqual(health.findByCapability('IMAGE_GENERATE', { inputPrivacy: 'PUBLIC', allowDegraded: false }).map((p) => p.provider_id), ['unk', 'up']);
  // 213 the same provider id twice is refused
  assert.equal(code(() => CI.createProviderRegistry([provider(), provider()])), CI.CI_ERROR.PROVIDER_DUPLICATE);
  // 214 commercial rights and cost model are required opaque references
  assert.equal(code(() => CI.normalizeProviderEntry(provider({ commercial_rights_ref: undefined }))), CI.CI_ERROR.INVALID_REFERENCE);
  assert.equal(code(() => CI.normalizeProviderEntry(provider({ cost_model_ref: 'https://vendor.test/pricing' }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 215 benchmarks are references to evidence, not numbers
  assert.equal(code(() => CI.normalizeProviderEntry(provider({ benchmark_refs: [0.93] }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 216 the registry performs no network access (the source has no network primitive)
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/creative-intelligence/provider-registry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|node:http|node:https|node:net|XMLHttpRequest|WebSocket/);
  // 217 the registry and its entries are immutable
  assert.ok(Object.isFrozen(registry));
  assert.throws(() => { registry.list()[0].capabilities.push('VIDEO_EDIT'); }, TypeError);
  // 218 an unknown key is refused
  assert.equal(code(() => CI.normalizeProviderEntry(provider({ api_endpoint: 'x' }))), CI.CI_ERROR.PROVIDER_INVALID);
  // 219 an empty registry is valid and qualifies nobody
  assert.deepEqual(CI.createProviderRegistry([]).findByCapability('IMAGE_GENERATE', { inputPrivacy: 'PUBLIC' }), []);
  // 220 no provider or model name is hardcoded anywhere in the Creative Intelligence source
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../src/creative-intelligence/', import.meta.url);
  for (const file of await readdir(dir)) {
    const text = await readFile(new URL(file, dir), 'utf8');
    assert.doesNotMatch(text, /\b(openai|anthropic|gemini|midjourney|stability|flux|ideogram|recraft|photoroom|qwen|seedream|canva|adobe|figma|firefly|runway|kling)\b/i, file);
  }
});

// ------------------------------------------------------------------ agent interfaces and the trust boundary (221-235)

const copyContext = { claim_refs: [CLAIM_PRICE] };

test('Agents: six roles, one trust boundary - model output is untrusted until it is normalized', async () => {
  // 221 the six C1 roles exist and nothing else
  assert.deepEqual(Object.keys(CI.AGENT_ROLE).sort(), ['COPY_CLAIMS_AGENT', 'CREATIVE_CRITIC', 'CREATIVE_DIRECTOR', 'CREATIVE_ORCHESTRATOR', 'PRODUCT_ASSET_ANALYST', 'VISUAL_PRODUCTION_DIRECTOR']);
  // 222 a handler's output becomes an immutable domain object
  const director = CI.createFakeAgent('CREATIVE_DIRECTOR', { directions: [direction()] });
  const out = await director.invoke({ brief: BRIEF }, { merchant_id: IDS.merchant, brand_id: IDS.brand, brief_ref: BRIEF });
  assert.ok(isDeepFrozen(out));
  assert.equal(out.directions[0].product_role, 'HERO');
  // 223 a function inside the output is refused
  assert.equal(await acode(CI.defineCreativeAgent('CREATIVE_DIRECTOR', () => ({ directions: [direction({ concept: () => 'x' })] })).invoke({})), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 224 a class instance (not plain data) is refused
  class Sneaky { constructor() { this.directions = [direction()]; } }
  assert.equal(await acode(CI.defineCreativeAgent('CREATIVE_DIRECTOR', () => new Sneaky()).invoke({})), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.equal(await acode(CI.defineCreativeAgent('CREATIVE_DIRECTOR', () => 'just text').invoke({})), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 225 an unknown role is refused
  assert.equal(code(() => CI.defineCreativeAgent('PUBLISHER', () => ({}))), CI.CI_ERROR.AGENT_UNKNOWN_ROLE);
  assert.equal(code(() => CI.normalizeAgentOutput('PUBLISHER', {})), CI.CI_ERROR.AGENT_UNKNOWN_ROLE);
  // 226 a failing handler becomes AGENT_FAILED and its message is not echoed
  const leaky = ['sk', 'live', '123456789012345'].join('_'); // built at runtime: the repository privacy scan must stay quiet
  const failing = CI.defineCreativeAgent('CREATIVE_DIRECTOR', () => { throw new Error(`secret=${leaky}`); });
  const error = await failing.invoke({}).catch((e) => e);
  assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
  assert.ok(!(JSON.stringify(error.detail) + error.message).includes(leaky));
  assert.doesNotMatch(JSON.stringify(error.detail) + error.message, /secret=/);
  // 227 a director output carrying a provider prompt is refused
  assert.equal(await acode(CI.defineCreativeAgent('CREATIVE_DIRECTOR', () => ({ directions: [{ ...direction(), prompt: 'ultra realistic' }] })).invoke({})), CI.CI_ERROR.FORBIDDEN_KEY);
  // 228 the copy agent cannot use a claim reference that is not approved
  const copy = (items, ctx = copyContext) => CI.defineCreativeAgent('COPY_CLAIMS_AGENT', () => ({ items })).invoke({}, ctx);
  assert.equal(await acode(copy([{ text_role: 'PRICE', content: '19,90 €', text_kind: 'CLAIM_BEARING', claim_ref: CLAIM_OTHER }])), CI.CI_ERROR.CLAIM_REF_NOT_APPROVED);
  assert.equal(await acode(copy([{ text_role: 'PRICE', content: '19,90 €', text_kind: 'CLAIM_BEARING', claim_ref: CLAIM_PRICE }], {})), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 229 an approved claim gets the digest of its wording; a number in non-claim text is refused
  const ok = await copy([{ text_role: 'PRICE', content: '19,90 €', text_kind: 'CLAIM_BEARING', claim_ref: CLAIM_PRICE }, { text_role: 'HEADLINE', content: 'Votre objet, votre style', text_kind: 'NON_CLAIM_CREATIVE_TEXT' }]);
  assert.equal(ok.items.find((i) => i.text_role === 'PRICE').approved_digest, CI.textDigest('19,90 €'));
  assert.equal(await acode(copy([{ text_role: 'HEADLINE', content: 'Dès 25 euros', text_kind: 'NON_CLAIM_CREATIVE_TEXT' }])), CI.CI_ERROR.NON_CLAIM_TEXT_FACTUAL);
  assert.equal(await acode(copy([{ text_role: 'PRICE', content: '19,90 €', text_kind: 'NON_CLAIM_CREATIVE_TEXT' }])), CI.CI_ERROR.CLAIM_BASIS_MISSING);
  // 230 one text per role
  assert.equal(await acode(copy([{ text_role: 'HEADLINE', content: 'Un', text_kind: 'NON_CLAIM_CREATIVE_TEXT' }, { text_role: 'HEADLINE', content: 'Deux', text_kind: 'NON_CLAIM_CREATIVE_TEXT' }])), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 231 a visual request must state that no critical text is generated into pixels
  const request = (over = {}) => ({
    request_id: 'req-1', capability: 'IMAGE_BACKGROUND', purpose: 'BACKGROUND', input_asset_refs: [ASSET_PHOTO], privacy_class: 'PUBLIC', text_policy: 'NO_CRITICAL_TEXT', forbidden_transformations: [], ...over,
  });
  const visual = (requests) => CI.defineCreativeAgent('VISUAL_PRODUCTION_DIRECTOR', () => ({ requests })).invoke({});
  assert.equal((await visual([request()])).requests.length, 1);
  assert.equal(await acode(visual([request({ text_policy: 'RENDER_PRICE_IN_IMAGE' })])), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 232 video capabilities and provider parameters are refused at this stage
  assert.equal(await acode(visual([request({ capability: 'VIDEO_GENERATE' })])), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.equal(await acode(visual([{ ...request(), seed: 42 }])), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 233 the orchestrator cannot publish, schedule or decide strategy; it must keep RENDER and PREFLIGHT, in order
  const plan = CI.planCreativeRun({ candidate_budget: 3 });
  const orch = (raw) => CI.defineCreativeAgent('CREATIVE_ORCHESTRATOR', () => raw).invoke({});
  assert.deepEqual((await orch(plan)).sequence, plan.sequence);
  assert.equal(await acode(orch({ ...plan, publish: true })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.equal(await acode(orch({ ...plan, budget: 500 })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.equal(await acode(orch({ ...plan, sequence: ['LAYOUT', 'RENDER'] })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.equal(await acode(orch({ ...plan, sequence: ['PREFLIGHT', 'RENDER'] })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.equal(await acode(orch({ ...plan, candidate_budget: 99 })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 234 the critic returns dimension statuses: no score, no unknown dimension, only its own document
  const critic = (raw, ctx = {}) => CI.defineCreativeAgent('CREATIVE_CRITIC', () => raw).invoke({}, ctx);
  const report = await critic({ document_ref: 'cdd_x', reviewer_ref: 'agent:critic', dimensions: { composition: { status: 'PASS' }, hierarchy: { status: 'REVIEW_REQUIRED', reason_codes: ['WEAK_FOCAL_POINT'] } } });
  assert.equal(report.status, 'REVIEW_REQUIRED');
  assert.equal(report.dimensions.balance.status, 'NOT_MEASURABLE');
  assert.equal(await acode(critic({ document_ref: 'cdd_x', dimensions: {}, score: 0.93 })), CI.CI_ERROR.FORBIDDEN_KEY);
  assert.equal(await acode(critic({ document_ref: 'cdd_x', dimensions: { vibes: { status: 'PASS' } } })), CI.CI_ERROR.QUALITY_REPORT_INVALID);
  assert.equal(await acode(critic({ document_ref: 'cdd_x', dimensions: { composition: { status: 'FAIL' } } })), CI.CI_ERROR.QUALITY_REPORT_INVALID);
  assert.equal(await acode(critic({ document_ref: 'cdd_x', dimensions: {} }, { document_ref: 'cdd_other' })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 235 the analyst returns a product package and a readiness report, for the right merchant only
  const analyst = (raw, ctx = {}) => CI.defineCreativeAgent('PRODUCT_ASSET_ANALYST', () => raw).invoke({}, ctx);
  const raw = { product_understanding: understanding(), asset_observations: [asset()] };
  const analysed = await analyst(raw, { merchant_id: IDS.merchant, brand_id: IDS.brand, target: { width: 1080, height: 1350 }, resolutions: [resolutionFor(ASSET_PRODUCT)] });
  assert.equal(analysed.product_understanding.product_ref, PRODUCT);
  assert.equal(analysed.asset_readiness.status, 'READY');
  assert.equal(await acode(analyst(raw, { merchant_id: IDS.otherMerchant, brand_id: IDS.brand })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  assert.deepEqual(clone(raw), clone(raw));
});
