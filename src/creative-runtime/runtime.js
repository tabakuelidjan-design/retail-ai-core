import { createHash } from 'node:crypto';

import * as CI from '../creative-intelligence/index.js';
import * as P from '../creative-intelligence/production.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../creative-fidelity/fidelity-gates.js';
import { COMPONENT, DECISION, manualSteeringReport } from './ledger.js';
import { directionFromPlan } from '../creative-brain/brain.js';
import { describeZone, projectSceneRequest } from '../creative-brain/scene-composer.js';
import { buildEnvironmentRequest, forbiddenVisualsIn } from './request-builder.js';
import {
  backdropSamples, choosePlate, chooseTextColor, plateLayer, selectLayoutRecipe, solveRecipeLayout,
} from './layout-plan.js';
import { assessEnvironment } from './environment-suitability.js';
import { computeLayoutCapabilityProfile, executableSpatialIntents } from './layout-capability.js';

// The product-preserving creative runtime. One run, from the Creative Brief to a candidate PNG, with every decision made by a Nordla component and recorded:
//
//   brief -> Product/Asset Analyst (preservation mode) -> Creative Director (direction) -> approved copy -> Visual Production Director (strategy)
//         -> local segmentation of the REAL product + an environment generated WITHOUT any product
//         -> layout planner (recipe) -> layout engine (placement of the cut-out and of the text) -> typography rules (colours from the actual environment)
//         -> preflight -> deterministic render (real fonts, shadow) -> IDENTITY fidelity gate on the delivered PNG
//
// The provider is used for the environment only and never receives a product pixel. The runtime stops at a candidate READY_FOR_REVIEW: there is no Critic and no
// approval here. A run that cannot decide something reports it (BLOCKED) instead of falling back to a hand-made choice.
// Every produced candidate also passes the deterministic Brand Guardian gate (`guardian`); READY_FOR_REVIEW needs Preflight, Fidelity AND Guardian to PASS.
// A run may be a REVISION (`revision`): the same pipeline, with the direction produced by the revision Director.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CONSTANTS = Object.freeze({
  PRODUCT_ROLE: Object.keys(CI.PRODUCT_ROLE), SPATIAL_INTENT: Object.keys(CI.SPATIAL_INTENT), NEGATIVE_SPACE: Object.keys(CI.NEGATIVE_SPACE), HIERARCHY_ROLE: Object.keys(CI.HIERARCHY_ROLE),
});
export const DIRECTOR_CONSTANTS = CONSTANTS;

/** The most environment images ONE scene may use: a bounded reliability recovery, never a loop (the provider is text-only and may draw an object in the reserved zone although it was asked not to). */
export const MAX_ENVIRONMENT_CANDIDATES = 3;

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
export async function runProductPreservingCreative({
  at, brief, fonts, agents, ports, ledger, guardian = null, revision = null, ambition = null, creativePlan = null, environmentCandidates = 1,
}) {
  const { ids, asset, brand } = brief;
  const format = { ...brief.format };
  const canvas = format.canvas;
  // every way of stopping carries the evidence gathered so far (direction, copy, environment provenance, segmentation quality): a stopped run is diagnosable from its record
  const evidence = {};
  const stop = (reason, extra = {}) => blocked(reason, { ...evidence, ...extra, ledger: ledger.entries(), steering: manualSteeringReport(ledger) });

  // 1. Product / Asset Analyst: the preservation mode
  const analysis = await agents.analyst.invoke({
    merchant_id: ids.merchant_id, brand_id: ids.brand_id, product_ref: ids.product_ref, identity_annotations: brief.identity_annotations, at,
    asset: { ref: asset.ref, origin: asset.origin, width_px: asset.width_px, height_px: asset.height_px, rights_class: asset.rights_class, privacy_class: asset.privacy_class },
  }, { merchant_id: ids.merchant_id, brand_id: ids.brand_id });
  const understanding = analysis.product_understanding;
  if (understanding.transformation_policy.mode !== 'COMPOSITE') return stop('THE_PRODUCT_PRESERVING_RUNTIME_NEEDS_A_COMPOSITE_STRATEGY', { preservation_mode: understanding.transformation_policy.mode });

  // 2. Creative Director: the direction
  const claimRefs = brief.claims.map((c) => c.ref);
  // (a revision is directed by the revision Director from canonical evidence and semantic intents only; the initial direction by the Creative Director)
  const directorInput = {
    brief: { public_facts: brief.public_facts, approved_text_roles: [...new Set([...brief.claims.map((c) => c.role), ...brief.approved_copy.map((c) => c.role)])], format: { content_kind: 'IMAGE', aspect_ratio: format.aspect_ratio, canvas }, expression: brand.expression },
    ids: { merchant_id: ids.merchant_id, brand_id: ids.brand_id, brief_ref: ids.brief_ref, asset_refs: [asset.ref], claim_refs: claimRefs, evidence_refs: [] },
  };
  const directorContext = { merchant_id: ids.merchant_id, brand_id: ids.brand_id, brief_ref: ids.brief_ref, claim_refs: claimRefs };
  if (revision && !creativePlan && !agents.revision_director) return stop('A_REVISION_NEEDS_A_REVISION_DIRECTOR');
  // a revision is told what the layout can execute for the approved copy, BEFORE it chooses; with nothing executable it does not even ask the model
  let capability = null;
  if (revision && !creativePlan) {
    try { capability = computeLayoutCapabilityProfile({ at, brief, fonts }); } catch (error) { return stop('NO_EXECUTABLE_LAYOUT_CAPABILITY', { message: error.code ?? error.message }); }
    if (!executableSpatialIntents(capability).length) return stop('NO_EXECUTABLE_LAYOUT_CAPABILITY', { capability });
    evidence.capability = capability;
  }
  // a Creative Brain plan directs the run: its canonical direction (validated by the C1 contract) replaces the Director's, and nothing downstream is bypassed
  const { directions } = creativePlan
    ? { directions: [directionFromPlan({ plan: creativePlan, ids: { merchant_id: ids.merchant_id, brand_id: ids.brand_id, brief_ref: ids.brief_ref }, assetRef: asset.ref, claimRefs })] }
    : revision
    ? await agents.revision_director.invoke({ ...directorInput, revision, capability, ...(ambition ? { ambition } : {}) }, directorContext)
    : await agents.director.invoke(directorInput, directorContext);
  const direction = directions[0];
  evidence.direction = direction;
  if (creativePlan) {
    ledger.record({
      decision: DECISION.CREATIVE_DIRECTION, decided_by: COMPONENT.CREATIVE_DIRECTOR, rule: 'CREATIVE_BRAIN_PLAN_PROJECTED_TO_THE_CANONICAL_DIRECTION', basis: [creativePlan.plan_id],
      outcome: { direction_id: direction.direction_id, plan_id: creativePlan.plan_id, concept_id: creativePlan.concept.concept_id, composition_id: creativePlan.composition.composition_id, scene_id: creativePlan.scene.scene_id },
    });
  }

  // 3. approved copy for the roles of the hierarchy
  const copy = await agents.copy.invoke({ hierarchy: direction.hierarchy, approved_copy: brief.approved_copy, claims: brief.claims }, { claim_refs: claimRefs });
  evidence.copy = copy.items;

  // the layout plan: recipe, document and constraint solving. It needs only the cut-out and the canvas size (the environment is exactly the canvas), so it is run BEFORE the billable
  // environment call as well: a direction whose layout cannot be solved must not cost a provider call
  const cutoutRef = `asset://runtime/${ids.brief_ref.replace(/[^A-Za-z0-9_.-]/g, '-')}/product-cutout`;
  const environmentRef = `asset://runtime/${ids.brief_ref.replace(/[^A-Za-z0-9_.-]/g, '-')}/environment`;
  let segmentation = null; let environment = null;
  const planLayout = ({ providerId, size }) => {
    const roles = copy.items.map((i) => i.text_role);
    // a plan's synthesized recipe is used only if it has a slot for every approved text; otherwise the preset of the direction is used, and the choice says so (never a silent substitution)
    const ladder = creativePlan?.layout_choice?.ladder ?? [];
    const attempts = [];
    const solveWith = (chosen, explicit) => solveRecipeLayout({
      at, ids, direction, format, brand, copyItems: copy.items, cutoutRef, cutoutSize: { width: segmentation.width_px, height: segmentation.height_px }, environmentRef, providerId, size, fonts, claimRefs, recipeId: chosen.recipe_id, ...(explicit ? { recipe: explicit } : {}),
    });
    // the relational plan is tried FIRST, as a bounded ladder of recipes that keep every relation and flex only the text proportion; the REAL solver decides on the REAL approved texts
    for (const rung of ladder) {
      const recipeOfRung = rung.recipe;
      if (!roles.every((role) => recipeOfRung.slots.some((s) => s.role === role))) { attempts.push({ recipe_id: recipeOfRung.recipe_id, step: rung.step, relaxation: rung.relaxation, outcome: 'SKIPPED_NO_SLOT_FOR_AN_APPROVED_TEXT' }); continue; }
      const attempt = solveWith({ recipe_id: recipeOfRung.recipe_id }, recipeOfRung);
      attempts.push({ recipe_id: recipeOfRung.recipe_id, step: rung.step, relaxation: rung.relaxation, outcome: attempt.placeable ? 'SOLVED' : 'NOT_SOLVED', violations: attempt.placeable ? [] : attempt.solved.violations.map((v) => ({ code: v.code, layers: v.layers, reasons: v.reasons ?? null })), unplaced: attempt.placeable ? [] : attempt.solved.unplaced });
      if (attempt.placeable) return { recipe: { recipe_id: recipeOfRung.recipe_id, rule: 'RECIPE_SYNTHESIZED_FROM_THE_COMPOSITION_PLAN', considered: [], source: 'SYNTHESIZED', relaxation: rung.relaxation, relaxation_step: rung.step }, document: attempt.document, assets: attempt.assets, solved: attempt.solved, ok: true, attempts };
    }
    let fallbackReason = null;
    if (creativePlan) {
      if (!ladder.length) fallbackReason = creativePlan.layout_choice?.reason ?? 'NO_SYNTHESIZED_RECIPE';
      else fallbackReason = attempts.every((x) => x.outcome.startsWith('SKIPPED')) ? 'THE_SYNTHESIZED_RECIPE_HAS_NO_SLOT_FOR_AN_APPROVED_TEXT' : 'THE_SYNTHESIZED_RECIPE_DID_NOT_SOLVE_FOR_THE_APPROVED_TEXTS';
    }
    const recipe = { ...selectLayoutRecipe(direction, roles), source: creativePlan ? 'PRESET_FALLBACK' : 'PRESET', ...(creativePlan ? { fallback_reason: fallbackReason } : {}) };
    if (!recipe.recipe_id) return { recipe: creativePlan ? { ...recipe, preset_reason: recipe.reason, reason: 'NO_EXECUTABLE_LAYOUT_FOR_THE_COMPOSITION' } : recipe, ok: false, attempts };
    const { document, assets, solved, placeable: ok } = solveRecipeLayout({
      at, ids, direction, format, brand, copyItems: copy.items, cutoutRef, cutoutSize: { width: segmentation.width_px, height: segmentation.height_px }, environmentRef, providerId, size, fonts, claimRefs, recipeId: recipe.recipe_id,
    });
    return { recipe, document, assets, solved, ok, attempts };
  };
  // when no layout exists, the record says what was tried: every rung of the relational ladder with the solver's own reasons, then the preset fallback and why it had nothing to offer
  const noLayout = (planned) => {
    if (!creativePlan) return {};
    const detail = { layout_attempts: planned.attempts, preset_fallback: { attempted: true, reason: planned.recipe.preset_reason ?? null, spatial_intent: direction.spatial_intent } };
    ledger.record({ decision: DECISION.LAYOUT_RECIPE, decided_by: COMPONENT.LAYOUT_PLANNER, rule: 'NO_EXECUTABLE_LAYOUT_FOR_THE_COMPOSITION', basis: [direction.direction_id], outcome: { source: 'NONE', spatial_intent: direction.spatial_intent, ...detail } });
    return detail;
  };
  const recordLayout = ({ recipe, solved, attempts = [] }) => {
    ledger.record({
      decision: DECISION.LAYOUT_RECIPE, decided_by: COMPONENT.LAYOUT_PLANNER, rule: recipe.rule, basis: [direction.direction_id],
      outcome: { recipe_id: recipe.recipe_id, spatial_intent: direction.spatial_intent, product_role: direction.product_role, considered: recipe.considered, ...(creativePlan ? { source: recipe.source, fallback_reason: recipe.fallback_reason ?? null, relaxation: recipe.relaxation ?? null, relaxation_step: recipe.relaxation_step ?? 0, attempts } : {}) },
    });
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
  };

  // 4. Visual Production Director: the strategy as requests; the runtime executes them and enforces that no product pixel reaches a provider
  const { requests } = await agents.visual_director.invoke({ understanding }, {});
  for (const request of requests) {
    if (request.capability === 'PRODUCT_SEGMENT') {
      segmentation = await ports.segmenter.segment({ asset, annotations: brief.identity_annotations });
      // a mask that cannot be trusted stops the run BEFORE any billable environment call
      evidence.segmentation = { quality: segmentation.quality };
      if (!segmentation.quality.confident) return stop('SEGMENTATION_LOW_CONFIDENCE', { quality: segmentation.quality });
    } else if (request.capability === 'IMAGE_GENERATE') {
      if (request.input_asset_refs.length !== 0) return stop('A_PROVIDER_REQUEST_MAY_NOT_CARRY_A_PRODUCT_ASSET', { request_id: request.request_id });
      // the layout is solved with the real cut-out and the canvas-sized environment BEFORE the provider is paid: an unsolvable layout stops here, with its record
      if (segmentation) {
        const pre = planLayout({ providerId: 'pending-environment', size: canvas });
        if (!pre.recipe.recipe_id) return stop(pre.recipe.reason, { spatial_intent: direction.spatial_intent, considered: pre.recipe.considered, before_environment_call: true, ...noLayout(pre) });
        if (!pre.ok) { recordLayout(pre); return stop('THE_LAYOUT_COULD_NOT_BE_SOLVED', { violations: pre.solved.violations, unplaced: pre.solved.unplaced, before_environment_call: true }); }
      }
      let built;
      try {
        if (creativePlan) {
          // the scene of the plan, with the integration zone where the layout has just placed the real product (described in words, never coordinates); text only, no product pixel
          const pre = planLayout({ providerId: 'pending-environment', size: canvas });
          const zone = describeZone(pre.solved.document.layers.find((l) => l.type === 'PRODUCT').geometry, canvas);
          built = projectSceneRequest({ scene: creativePlan.scene, zone, canvas });
          const forbidden = forbiddenVisualsIn(built.prompt, brand.expression);
          if (forbidden.length) throw Object.assign(new Error(`the scene asks for visuals the brand forbids: ${forbidden.join(', ')}`), { code: 'SCENE_VIOLATES_BRAND_FORBIDDEN_VISUALS' });
          ledger.record({
            decision: DECISION.PROVIDER_REQUEST_CONSTRUCTION, decided_by: COMPONENT.PROVIDER_REQUEST_BUILDER, rule: 'SCENE_SPEC_PROJECTED_WITH_A_RESERVED_INTEGRATION_ZONE', basis: [creativePlan.scene.scene_id],
            outcome: { lane: 'ENVIRONMENT', size: built.size, carries_input_asset: false, forbidden_objects_only_in_the_negative_prompt: true, brand_forbidden_terms_checked: true, integration_zone: zone, scene_layers: creativePlan.scene.layers.length },
          });
        } else built = buildEnvironmentRequest({ direction, expression: brand.expression, canvas, ledger });
      } catch (error) { return stop(error.code ?? 'ENVIRONMENT_REQUEST_REFUSED', { message: error.message }); }
      const envRequest = { ...built, capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [] };
      const wanted = Number.isInteger(environmentCandidates) ? Math.max(1, Math.min(MAX_ENVIRONMENT_CANDIDATES, environmentCandidates)) : 1;
      if (wanted === 1) {
        environment = await ports.environment.generate({ request: envRequest, expected_size: canvas });
        evidence.environment = environment.provenance;
      } else {
        // BOUNDED MULTI-ENVIRONMENT: the SAME scene, the SAME request (no change of concept, art direction or prompt), up to `wanted` images; each is judged alone by the deterministic product-zone gate and the
        // FIRST one that passes wins (no aesthetic ranking, no hand-picking). If none passes, the run stops with a precise provider limitation. Never a fourth image.
        const requestSha = createHash('sha256').update(JSON.stringify({ prompt: envRequest.prompt, negative_prompt: envRequest.negative_prompt, size: envRequest.size })).digest('hex');
        const judge = (candidate) => {
          let pixels;
          try { pixels = P.decodePng(candidate.output_bytes); } catch { return { suitable: false, rejection: 'THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG' }; }
          if (pixels.width !== canvas.width || pixels.height !== canvas.height) return { suitable: false, rejection: 'THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS' };
          const candidatePlan = planLayout({ providerId: candidate.provenance.provider_id, size: { width: pixels.width, height: pixels.height } });
          if (!candidatePlan.recipe.recipe_id || !candidatePlan.ok) return { suitable: false, rejection: 'THE_LAYOUT_COULD_NOT_BE_SOLVED_FOR_THIS_ENVIRONMENT' };
          const suitability = assessEnvironment({ environment: pixels, productBox: candidatePlan.solved.document.layers.find((l) => l.type === 'PRODUCT').geometry });
          return { suitable: suitability.suitable, rejection: suitability.suitable ? null : 'ENVIRONMENT_NOT_EMPTY', suitability };
        };
        const tried = [];
        let lastVerdict = null;
        for (let index = 1; index <= wanted && !environment; index += 1) {
          const candidate = await ports.environment.generate({ request: envRequest, expected_size: canvas, candidate_index: index });
          const verdict = judge(candidate);
          lastVerdict = verdict;
          tried.push({ index, provenance: candidate.provenance, suitable: verdict.suitable, rejection: verdict.rejection, measured: verdict.suitability?.measured ?? null });
          ledger.record({
            decision: DECISION.ENVIRONMENT_CANDIDATE, decided_by: COMPONENT.ENVIRONMENT_SUITABILITY_GATE, rule: 'THE_FIRST_ENVIRONMENT_THAT_PASSES_THE_PRODUCT_ZONE_GATE_WINS_WITH_NO_RANKING', basis: [creativePlan?.scene?.scene_id ?? 'direction'],
            outcome: {
              candidate: index, of: wanted, request_sha256: requestSha, request_id: candidate.provenance.request_id, output_sha256: candidate.provenance.sha256, suitable: verdict.suitable, rejection: verdict.rejection,
              zone: verdict.suitability?.zone ?? null, measured: verdict.suitability?.measured ?? null, limit: verdict.suitability?.limit ?? null, selected: verdict.suitable,
            },
          });
          evidence.environment = candidate.provenance;
          if (verdict.suitable) environment = candidate;
        }
        evidence.environment_candidates = tried;
        if (!environment) {
          // the final decision of the gate is still recorded (the last candidate's measurements), so the record is complete
          ledger.record({ decision: DECISION.ENVIRONMENT_SUITABILITY, decided_by: COMPONENT.ENVIRONMENT_SUITABILITY_GATE, rule: 'NO_ENVIRONMENT_OF_THE_BOUNDED_SET_IS_A_CALM_SURFACE_WHERE_THE_PRODUCT_IS_PLACED', basis: [], outcome: { suitable: false, zone: lastVerdict?.suitability?.zone ?? null, measured: lastVerdict?.suitability?.measured ?? null, limit: lastVerdict?.suitability?.limit ?? null, candidates: tried.length } });
          return stop('PROVIDER_ENVIRONMENT_LIMITATION', { candidates: tried.map((t) => ({ index: t.index, rejection: t.rejection, measured: t.measured, sha256: t.provenance?.sha256 ?? null })) });
        }
      }
    } else {
      return stop('UNSUPPORTED_CAPABILITY_IN_THIS_RUNTIME', { capability: request.capability });
    }
  }
  if (!segmentation || !environment) return stop('THE_STRATEGY_PRODUCED_NO_CUTOUT_OR_NO_ENVIRONMENT');
  let envPixels;
  try { envPixels = P.decodePng(environment.output_bytes); } catch { return stop('THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG'); }
  if (envPixels.width !== canvas.width || envPixels.height !== canvas.height) return stop('THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS', { environment_size: [envPixels.width, envPixels.height], canvas: [canvas.width, canvas.height] });

  // 5-6. layout planner (the recipe) and layout engine (placement of the product and of the text), now with the environment actually delivered
  const plan = planLayout({ providerId: environment.provenance.provider_id, size: { width: envPixels.width, height: envPixels.height } });
  if (!plan.recipe.recipe_id) return stop(plan.recipe.reason, { spatial_intent: direction.spatial_intent, considered: plan.recipe.considered, ...noLayout(plan) });
  const { recipe, document, assets, solved } = plan;
  recordLayout(plan);
  // (the director's negative-space intent is realized in the ENVIRONMENT request - calm areas to set text on - not as a margin the layout engine reserves)
  const productLayer = solved.document.layers.find((l) => l.type === 'PRODUCT');
  if (!plan.ok) return stop('THE_LAYOUT_COULD_NOT_BE_SOLVED', { violations: solved.violations, unplaced: solved.unplaced });

  // 6b. environment suitability: where the real product is placed the environment must be a calm surface (a provider may draw an object although it was asked not to)
  const suitability = assessEnvironment({ environment: envPixels, productBox: productLayer.geometry });
  ledger.record({ decision: DECISION.ENVIRONMENT_SUITABILITY, decided_by: COMPONENT.ENVIRONMENT_SUITABILITY_GATE, rule: suitability.rule, basis: [], outcome: { suitable: suitability.suitable, zone: suitability.zone, measured: suitability.measured, limit: suitability.limit } });
  if (!suitability.suitable) return stop('ENVIRONMENT_NOT_EMPTY', { suitability });

  // 7. typography rules: the colour of each text from the brand tokens against the environment actually behind it
  const measuredBackdrops = {};
  const plates = [];
  let plateChoice = null;
  const colored = solved.document.layers.map((l) => {
    if (l.type !== 'TEXT') return l;
    const backdrops = backdropSamples(envPixels, l.geometry);
    measuredBackdrops[l.id] = backdrops;
    const pick = chooseTextColor({ textRole: l.text_role, backdrops, tokens: brand.colors });
    if (pick.contrast >= 4.5) return { ...l, color: pick.hex, _choice: { role: l.text_role, token: pick.token, worst_contrast: pick.contrast, candidates: pick.candidates } };
    // no brand token reads on the environment behind this text: a solid brand-token plate goes behind it, and the text takes a token that reads on the plate
    plateChoice = plateChoice ?? choosePlate({ tokens: brand.colors });
    if (!plateChoice) return { ...l, _noPair: true };
    const tokens = Object.fromEntries(Object.entries(brand.colors).filter(([token]) => token !== plateChoice.plate_token));
    const onPlate = chooseTextColor({ textRole: l.text_role, backdrops: [plateChoice.plate_hex], tokens });
    plates.push(plateLayer({ id: `plate-${l.text_role.toLowerCase()}`, z: 12 + plates.length, box: l.geometry, canvas, fill: plateChoice.plate_hex }));
    measuredBackdrops[l.id] = [plateChoice.plate_hex];
    return {
      ...l,
      color: onPlate.hex,
      _choice: { role: l.text_role, token: onPlate.token, worst_contrast: onPlate.contrast, candidates: onPlate.candidates, plate: { token: plateChoice.plate_token, reason: 'NO_BRAND_TOKEN_READS_ON_THE_ENVIRONMENT', best_on_environment: pick.contrast } },
    };
  });
  if (colored.some((l) => l._noPair)) return stop('NO_BRAND_COLOUR_PAIR_READS', { backdrops: measuredBackdrops });
  const choices = colored.filter((l) => l._choice).map((l) => l._choice);
  const finalLayers = [...colored.map(({ _choice, _noPair, ...layer }) => layer), ...plates];
  const finalDocument = CI.reviseDesignDocument(solved.document, { layers: finalLayers, created_at: at, derivation: 'REFINE', created_by: 'ENGINE', producer_refs: ['engine:creative-runtime.typography-rules'] });
  ledger.record({ decision: DECISION.TEXT_STYLE, decided_by: COMPONENT.TYPOGRAPHY_RULES, rule: 'TOKEN_BY_CONTRAST_AGAINST_THE_ACTUAL_ENVIRONMENT_OR_A_BRAND_PLATE_WHEN_NO_TOKEN_READS', basis: Object.keys(brand.colors), outcome: { choices, plates: plates.map((p) => p.id) } });
  ledger.record({ decision: DECISION.SHADOW, decided_by: COMPONENT.SHADOW_RULE, rule: 'SOFT_CONTACT_SHADOW_FROM_THE_DARKEST_BRAND_COLOUR_SCALED_TO_THE_CANVAS', basis: [], outcome: { effects: finalDocument.layers.find((l) => l.type === 'PRODUCT').effects } });

  // 8. preflight
  const approvedTexts = Object.fromEntries(brief.claims.map((c) => [c.ref, CI.textDigest(c.wording)]));
  const preflight = CI.runCreativePreflight(finalDocument, {
    fonts, assets, approved_claim_refs: claimRefs, approved_texts: approvedTexts, measured_backdrops: measuredBackdrops,
  });
  ledger.record({ decision: DECISION.PREFLIGHT, decided_by: COMPONENT.PREFLIGHT, rule: 'EXISTING_PREFLIGHT_CHECKS', basis: [], outcome: { status: preflight.status, checks: preflight.checks.map((c) => `${c.code}=${c.status}`) } });
  if (preflight.status !== 'PASS') return Object.freeze({ status: 'PREFLIGHT_FAIL', ...evidence, preflight: { status: preflight.status, checks: preflight.checks }, document: finalDocument, ledger: ledger.entries(), steering: manualSteeringReport(ledger) });

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

  // 11. Brand Guardian: a deterministic gate on EVERY candidate (it consumes the Fidelity result and never recomputes it); not configured => the candidate cannot be reviewed
  let guardianResult = null;
  if (guardian) {
    guardianResult = guardian.evaluate({ document: finalDocument, fonts, fidelityGate: gate });
    ledger.record({ decision: DECISION.BRAND_GUARDIAN, decided_by: COMPONENT.BRAND_GUARDIAN, rule: 'APPROVED_BRAND_MEMORY_HARD_RULES_ON_THE_DECLARED_CANDIDATE', basis: [], outcome: { outcome: guardianResult.outcome, rules: guardianResult.rule_results.map((r) => `${r.rule_id}=${r.outcome}`) } });
  }
  let status;
  if (gate.outcome === 'FAIL') status = 'FIDELITY_FAIL';
  else if (gate.outcome !== 'PASS') status = 'BLOCKED';
  else if (!guardianResult) status = 'BLOCKED';
  else status = guardianResult.outcome === 'PASS' ? 'READY_FOR_REVIEW' : 'GUARDIAN_FAIL';

  return Object.freeze({
    status,
    ...(status === 'BLOCKED' && gate.outcome === 'PASS' && !guardianResult ? { reason: 'BRAND_GUARDIAN_NOT_CONFIGURED' } : {}),
    png_bytes: png.bytes,
    png_sha256: png.sha256,
    width: png.width,
    height: png.height,
    document: finalDocument,
    preflight: { status: preflight.status },
    guardian: guardianResult,
    fidelity: { gate: gate.outcome, observations, failed },
    render: { render_mode: rendered.render_mode, typography_mode: rendered.typography_mode, resolutions: log.resolutions.length, image_draws: log.image_draws },
    environment: environment.provenance,
    environment_candidates: evidence.environment_candidates ?? null, // the whole bounded set when more than one image was generated for the scene
    segmentation: { quality: segmentation.quality, cutout_sha256: segmentation.cutout_sha256 },
    direction,
    copy: copy.items,
    ledger: ledger.entries(),
    steering: manualSteeringReport(ledger),
    sha256_of: sha256(png.bytes),
  });
}
