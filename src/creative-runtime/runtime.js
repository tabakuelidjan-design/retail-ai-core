import { createHash } from 'node:crypto';

import * as CI from '../creative-intelligence/index.js';
import * as P from '../creative-intelligence/production.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../creative-fidelity/fidelity-gates.js';
import { COMPONENT, DECISION, manualSteeringReport } from './ledger.js';
import { buildEnvironmentRequest } from './request-builder.js';
import {
  assembleDocument, backdropSamples, chooseTextColor, selectLayoutRecipe,
} from './layout-plan.js';

// The product-preserving creative runtime. One run, from the Creative Brief to a candidate PNG, with every decision made by a Nordla component and recorded:
//
//   brief -> Product/Asset Analyst (preservation mode) -> Creative Director (direction) -> approved copy -> Visual Production Director (strategy)
//         -> local segmentation of the REAL product + an environment generated WITHOUT any product
//         -> layout planner (recipe) -> layout engine (placement of the cut-out and of the text) -> typography rules (colours from the actual environment)
//         -> preflight -> deterministic render (real fonts, shadow) -> IDENTITY fidelity gate on the delivered PNG
//
// The provider is used for the environment only and never receives a product pixel. The runtime stops at a candidate READY_FOR_REVIEW: there is no Critic and no
// approval here. A run that cannot decide something reports it (BLOCKED) instead of falling back to a hand-made choice.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CONSTANTS = Object.freeze({
  PRODUCT_ROLE: Object.keys(CI.PRODUCT_ROLE), SPATIAL_INTENT: Object.keys(CI.SPATIAL_INTENT), NEGATIVE_SPACE: Object.keys(CI.NEGATIVE_SPACE), HIERARCHY_ROLE: Object.keys(CI.HIERARCHY_ROLE),
});
export const DIRECTOR_CONSTANTS = CONSTANTS;

const blocked = (reason, extra = {}) => Object.freeze({ status: 'BLOCKED', reason, ...extra });

/**
 * @param {object} input
 *  at        ISO instant (explicit: the runtime reads no clock)
 *  brief     { ids, public_facts, approved_copy, claims, format, brand, asset, identity_annotations }
 *  fonts     the real font registry
 *  agents    { analyst, director, copy, visual_director }   C1 agents (createProductAssetAnalyst, createCreativeDirector, ...)
 *  ports     { segmenter, environment }                     execution of the requests: segmenter.segment(...) and environment.generate({ request }) -> { output_bytes, provenance }
 *  ledger    the decision ledger
 */
export async function runProductPreservingCreative({ at, brief, fonts, agents, ports, ledger }) {
  const { ids, asset, brand } = brief;
  const format = { ...brief.format };
  const canvas = format.canvas;

  // 1. Product / Asset Analyst: the preservation mode
  const analysis = await agents.analyst.invoke({
    merchant_id: ids.merchant_id, brand_id: ids.brand_id, product_ref: ids.product_ref, identity_annotations: brief.identity_annotations, at,
    asset: { ref: asset.ref, origin: asset.origin, width_px: asset.width_px, height_px: asset.height_px, rights_class: asset.rights_class, privacy_class: asset.privacy_class },
  }, { merchant_id: ids.merchant_id, brand_id: ids.brand_id });
  const understanding = analysis.product_understanding;
  if (understanding.transformation_policy.mode !== 'COMPOSITE') return blocked('THE_PRODUCT_PRESERVING_RUNTIME_NEEDS_A_COMPOSITE_STRATEGY', { preservation_mode: understanding.transformation_policy.mode, ledger: ledger.entries() });

  // 2. Creative Director: the direction
  const claimRefs = brief.claims.map((c) => c.ref);
  const { directions } = await agents.director.invoke({
    brief: { public_facts: brief.public_facts, approved_text_roles: [...new Set([...brief.claims.map((c) => c.role), ...brief.approved_copy.map((c) => c.role)])], format: { content_kind: 'IMAGE', aspect_ratio: format.aspect_ratio, canvas }, expression: brand.expression },
    ids: { merchant_id: ids.merchant_id, brand_id: ids.brand_id, brief_ref: ids.brief_ref, asset_refs: [asset.ref], claim_refs: claimRefs, evidence_refs: [] },
  }, { merchant_id: ids.merchant_id, brand_id: ids.brand_id, brief_ref: ids.brief_ref, claim_refs: claimRefs });
  const direction = directions[0];

  // 3. approved copy for the roles of the hierarchy
  const copy = await agents.copy.invoke({ hierarchy: direction.hierarchy, approved_copy: brief.approved_copy, claims: brief.claims }, { claim_refs: claimRefs });

  // 4. Visual Production Director: the strategy as requests; the runtime executes them and enforces that no product pixel reaches a provider
  const { requests } = await agents.visual_director.invoke({ understanding }, {});
  let segmentation = null; let environment = null;
  for (const request of requests) {
    if (request.capability === 'PRODUCT_SEGMENT') {
      segmentation = await ports.segmenter.segment({ asset, annotations: brief.identity_annotations });
      // a mask that cannot be trusted stops the run BEFORE any billable environment call
      if (!segmentation.quality.confident) return blocked('SEGMENTATION_LOW_CONFIDENCE', { quality: segmentation.quality, ledger: ledger.entries() });
    } else if (request.capability === 'IMAGE_GENERATE') {
      if (request.input_asset_refs.length !== 0) return blocked('A_PROVIDER_REQUEST_MAY_NOT_CARRY_A_PRODUCT_ASSET', { request_id: request.request_id, ledger: ledger.entries() });
      let built;
      try { built = buildEnvironmentRequest({ direction, expression: brand.expression, canvas, ledger }); } catch (error) { return blocked(error.code ?? 'ENVIRONMENT_REQUEST_REFUSED', { message: error.message, ledger: ledger.entries() }); }
      environment = await ports.environment.generate({ request: { ...built, capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [] }, expected_size: canvas });
    } else {
      return blocked('UNSUPPORTED_CAPABILITY_IN_THIS_RUNTIME', { capability: request.capability, ledger: ledger.entries() });
    }
  }
  if (!segmentation || !environment) return blocked('THE_STRATEGY_PRODUCED_NO_CUTOUT_OR_NO_ENVIRONMENT', { ledger: ledger.entries() });
  if (!segmentation.quality.confident) return blocked('SEGMENTATION_LOW_CONFIDENCE', { quality: segmentation.quality, ledger: ledger.entries() });
  let envPixels;
  try { envPixels = P.decodePng(environment.output_bytes); } catch { return blocked('THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG', { ledger: ledger.entries() }); }
  if (envPixels.width !== canvas.width || envPixels.height !== canvas.height) return blocked('THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS', { environment: [envPixels.width, envPixels.height], canvas: [canvas.width, canvas.height], ledger: ledger.entries() });

  // 5. layout planner: the recipe
  const recipe = selectLayoutRecipe(direction);
  if (!recipe) return blocked('NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT', { spatial_intent: direction.spatial_intent, ledger: ledger.entries() });
  ledger.record({ decision: DECISION.LAYOUT_RECIPE, decided_by: COMPONENT.LAYOUT_PLANNER, rule: recipe.rule, basis: [direction.direction_id], outcome: { recipe_id: recipe.recipe_id, spatial_intent: direction.spatial_intent, product_role: direction.product_role } });

  const cutoutRef = `asset://runtime/${ids.brief_ref.replace(/[^A-Za-z0-9_.-]/g, '-')}/product-cutout`;
  const environmentRef = `asset://runtime/${ids.brief_ref.replace(/[^A-Za-z0-9_.-]/g, '-')}/environment`;
  const document = assembleDocument({
    at, ids, direction, format: { ...format, recipe_id: recipe.recipe_id }, brand, copyItems: copy.items,
    product: { cutout_ref: cutoutRef }, environment: { ref: environmentRef, provider_id: environment.provenance.provider_id }, fonts, assetRefs: [cutoutRef, environmentRef], claimRefs,
  });
  const assets = { [cutoutRef]: { width_px: segmentation.width_px, height_px: segmentation.height_px }, [environmentRef]: { width_px: envPixels.width, height_px: envPixels.height } };

  // 6. layout engine: placement of the product and of the text
  const solved = CI.solveLayout({ document, recipe_id: recipe.recipe_id, fonts, assets, created_at: at });
  // (the director's negative-space intent is realized in the ENVIRONMENT request - calm areas to set text on - not as a margin the layout engine reserves)
  const productLayer = solved.document.layers.find((l) => l.type === 'PRODUCT');
  ledger.record({
    decision: DECISION.PRODUCT_PLACEMENT, decided_by: COMPONENT.LAYOUT_ENGINE, rule: 'RECIPE_SLOT_UNIFORM_FIT', basis: [recipe.recipe_id],
    outcome: { box: productLayer.geometry, canvas, product_height_share: productLayer.geometry.height / canvas.height, status: solved.status },
  });
  const texts = solved.document.layers.filter((l) => l.type === 'TEXT');
  ledger.record({
    decision: DECISION.TYPOGRAPHY_PLACEMENT, decided_by: COMPONENT.LAYOUT_ENGINE, rule: 'RECIPE_SLOTS_AND_TEXT_FITTING', basis: [recipe.recipe_id],
    outcome: { texts: texts.map((t) => ({ role: t.text_role, box: t.geometry, font_size: t.font_size })), unplaced: solved.unplaced, violations: solved.violations },
  });
  if (solved.status !== 'SOLVED') return blocked('THE_LAYOUT_COULD_NOT_BE_SOLVED', { violations: solved.violations, unplaced: solved.unplaced, ledger: ledger.entries() });

  // 7. typography rules: the colour of each text from the brand tokens against the environment actually behind it
  const measuredBackdrops = {};
  const colored = solved.document.layers.map((l) => {
    if (l.type !== 'TEXT') return l;
    const backdrops = backdropSamples(envPixels, l.geometry);
    measuredBackdrops[l.id] = backdrops;
    const pick = chooseTextColor({ textRole: l.text_role, backdrops, tokens: brand.colors });
    return { ...l, color: pick.hex, _choice: { role: l.text_role, token: pick.token, worst_contrast: pick.contrast, candidates: pick.candidates } };
  });
  const choices = colored.filter((l) => l._choice).map((l) => l._choice);
  const finalLayers = colored.map(({ _choice, ...layer }) => layer);
  const finalDocument = CI.reviseDesignDocument(solved.document, { layers: finalLayers, created_at: at, derivation: 'REFINE', created_by: 'ENGINE', producer_refs: ['engine:creative-runtime.typography-rules'] });
  ledger.record({ decision: DECISION.TEXT_STYLE, decided_by: COMPONENT.TYPOGRAPHY_RULES, rule: 'TOKEN_BY_CONTRAST_AGAINST_THE_ACTUAL_ENVIRONMENT', basis: Object.keys(brand.colors), outcome: { choices } });
  ledger.record({ decision: DECISION.SHADOW, decided_by: COMPONENT.SHADOW_RULE, rule: 'SOFT_CONTACT_SHADOW_FROM_THE_DARKEST_BRAND_COLOUR_SCALED_TO_THE_CANVAS', basis: [], outcome: { effects: finalDocument.layers.find((l) => l.type === 'PRODUCT').effects } });

  // 8. preflight
  const approvedTexts = Object.fromEntries(brief.claims.map((c) => [c.ref, CI.textDigest(c.wording)]));
  const preflight = CI.runCreativePreflight(finalDocument, {
    fonts, assets, approved_claim_refs: claimRefs, approved_texts: approvedTexts, measured_backdrops: measuredBackdrops,
  });
  ledger.record({ decision: DECISION.PREFLIGHT, decided_by: COMPONENT.PREFLIGHT, rule: 'EXISTING_PREFLIGHT_CHECKS', basis: [], outcome: { status: preflight.status, checks: preflight.checks.map((c) => `${c.code}=${c.status}`) } });
  if (preflight.status !== 'PASS') return Object.freeze({ status: 'PREFLIGHT_FAIL', preflight: { status: preflight.status, checks: preflight.checks }, document: finalDocument, ledger: ledger.entries(), steering: manualSteeringReport(ledger) });

  // 9. deterministic render with real typography; the only media consumed are the cut-out and the environment
  const bytesFor = (ref) => (ref === cutoutRef ? segmentation.cutout_png : (ref === environmentRef ? environment.output_bytes : null));
  const renderLog = P.createRenderLog(bytesFor);
  const rendered = CI.renderDesignDocument({ document: finalDocument, fonts, assetResolver: renderLog.resolver });
  const png = P.renderProductionPng(rendered);
  const log = renderLog.finish(rendered.svg);

  // 10. IDENTITY fidelity gate on the delivered PNG, against the verified real asset
  const producerId = `seg-${segmentation.cutout_sha256.slice(0, 16)}`;
  const observations = P.measureProductFidelity({
    source: { bytes: asset.bytes, sha256: asset.sha256, origin: asset.origin, width_px: asset.width_px, height_px: asset.height_px },
    derivation: {
      source_asset_ref: asset.ref, source_sha256: asset.sha256, derived_asset_ref: cutoutRef, derived_sha256: segmentation.cutout_sha256,
      producer: { provider_id: 'nordla-local-product-segmenter', model: 'deterministic-mask-and-cutout@1', region: 'local', request_id: producerId },
    },
    candidate: { png_bytes: png.bytes },
    canvas: { width: canvas.width, height: canvas.height },
    product_layers: finalDocument.layers.filter((l) => l.type === 'PRODUCT'),
    render_log: log,
    expected: { source_asset_ref: asset.ref, pinned_sha256: asset.sha256, derived_asset_ref: cutoutRef, piece_count: 1, allowed_other_image_draws: 1 },
    annotations: brief.identity_annotations,
  });
  const required = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);
  const gate = evaluateHardFidelityGate({ observations, requiredChecks: required });
  const failed = observations.flatMap((o) => (o.evidence.sub_observations ?? []).filter((s) => s.outcome !== 'PASS').map((s) => ({ check: o.code, observation: s.id, outcome: s.outcome, evidence: s.evidence })));
  ledger.record({ decision: DECISION.FIDELITY, decided_by: COMPONENT.IDENTITY_FIDELITY_GATE, rule: 'IDENTITY_PRESERVE_MEASUREMENTS_ON_THE_DELIVERED_PNG', basis: [asset.ref], outcome: { gate: gate.outcome, failed_observations: failed.map((f) => `${f.check}/${f.observation}=${f.outcome}`) } });

  return Object.freeze({
    status: gate.outcome === 'PASS' ? 'READY_FOR_REVIEW' : (gate.outcome === 'FAIL' ? 'FIDELITY_FAIL' : 'BLOCKED'),
    png_bytes: png.bytes,
    png_sha256: png.sha256,
    width: png.width,
    height: png.height,
    document: finalDocument,
    preflight: { status: preflight.status },
    fidelity: { gate: gate.outcome, observations, failed },
    render: { render_mode: rendered.render_mode, typography_mode: rendered.typography_mode, resolutions: log.resolutions.length, image_draws: log.image_draws },
    environment: environment.provenance,
    segmentation: { quality: segmentation.quality, cutout_sha256: segmentation.cutout_sha256 },
    direction,
    copy: copy.items,
    ledger: ledger.entries(),
    steering: manualSteeringReport(ledger),
    sha256_of: sha256(png.bytes),
  });
}
