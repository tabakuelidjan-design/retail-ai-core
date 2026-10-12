import { createHash } from 'node:crypto';

import * as CI from '../creative-intelligence/index.js';
import * as P from '../creative-intelligence/production.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../creative-fidelity/fidelity-gates.js';
import { createCampaignBudget, CampaignBudgetError } from '../creative-campaign/budget.js';
import { composeLayers } from '../creative-production/compositor.js';
import {
  LAYER_KIND, LAYER_Z, LAYERED_BLOCK as BLOCK, LAYERED_RUNTIME_POLICY, MATTE_POLICY, PRODUCTION_CAPABILITY as CAP, PRODUCTION_STATUS, PRODUCT_STATUS,
} from '../creative-production/constants.js';
import { sha256Text } from '../creative-production/copy-integrity.js';
import { matteProp } from '../creative-production/prop-matte.js';
import { resizePng } from '../creative-production/raster-ops.js';
import { COMPONENT, DECISION, manualSteeringReport } from './ledger.js';
import { assessEnvironment } from './environment-suitability.js';
import { TEXT_LED_SPEC } from '../creative-planning/index.js';
import { assertValidLayoutRecipe } from '../creative-intelligence/layout-recipes.js';
import {
  assembleDocument, backdropSamples, choosePlate, chooseTextColor, plateLayer, selectLayoutRecipe, TYPE_SCALE,
} from './layout-plan.js';

// THE LAYERED SCENE RUNTIME (Phase 3, executable). One run produces ONE candidate image from a SPECIFIED scene of the production planner, through the same gates as the single-image runtime:
//
//   scene specification (layers, tools, requests) + ProductIdentity + the real product asset
//     -> local segmentation of the REAL product            (a mask that cannot be trusted stops the run before any billable call)
//     -> layout solved on the REAL planned text             (a text that does not fit stops the run: it is never cut, rewritten or compressed)
//     -> budget reserved for every generated layer          (BEFORE the first provider call; a reservation that passes the ceiling blocks the run)
//     -> generated plate + props, each candidate judged alone by its OWN gate before it can be composited (a provider output is untrusted)
//     -> props placed around the product, composed in the z-order of the specification by the LAYER COMPOSITOR, which refuses an illegal overlap and any change to the product pixels
//     -> deterministic typography from the planned text, colours measured on what is really behind it
//     -> preflight -> deterministic render -> IDENTITY fidelity gate on the delivered PNG -> Brand Guardian
//
// What it never does: let a provider draw or touch the product (the real asset is the only source of its pixels), change a word of the planned text, switch tool or strategy on its own (a tool other than the one
// the specification selected, or a layer no candidate of which passes its gate, STOPS the run with the reason and the replanning it needs), fall back to the single-image generator, or spend beyond the reserved
// budget. It is reachable only by naming it: a single-image run is the unchanged `runProductPreservingCreative`.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const round = (x) => Math.round(x * 1e9) / 1e9;

/** The tools this runtime executes itself (LOCAL, deterministic). A specification that selects any other tool for these capabilities is not executed here. */
export const LAYERED_LOCAL_TOOLS = Object.freeze({
  [CAP.PROP_CUTOUT]: 'cutout/plain-ground-matte',
  [CAP.LOCAL_SEGMENTATION]: 'segmentation/annotated-outline',
  [CAP.PRODUCT_CUTOUT]: 'cutout/exact-source-pixels',
  [CAP.DETERMINISTIC_COMPOSITE]: 'composite/z-ordered-layers',
  [CAP.DETERMINISTIC_TEXT]: 'typography/real-fonts',
});
const PROVIDER_CAPABILITIES = Object.freeze([CAP.ENVIRONMENT_PLATE_GENERATION, CAP.PROP_ON_PLAIN_GROUND_GENERATION]);

/** The spatial intent a composition intent is realized with (the layout recipes are chosen by spatial intent). */
export const SPATIAL_INTENT_OF_COMPOSITION = Object.freeze({
  PRODUCT_CENTERED: 'PRODUCT_CENTER_TEXT_ABOVE',
  PRODUCT_OFFSET: 'PRODUCT_START_TEXT_END',
  TEXT_FIRST: 'TEXT_DOMINANT',
  FULL_BLEED_SCENE: 'PRODUCT_CENTER_TEXT_ABOVE',
  SPLIT_PANEL: 'PRODUCT_START_TEXT_END',
  CLOSE_CROP: 'PRODUCT_CENTER_TEXT_BELOW',
  WIDE_ESTABLISHING: 'PRODUCT_CENTER_TEXT_ABOVE',
});

/** The recipe solved on the planned text. A BODY is typeset with the typography its capacity was measured with (never shrunk below the layout's own minimum, never cut). */
function solveLayered({
  at, ids, direction, format, brand, copyItems, cutoutRef, cutoutSize, environmentRef, size, fonts, claimRefs, recipeId, recipe,
}) {
  const assembled = assembleDocument({
    at, ids, direction, format: { ...format, recipe_id: recipeId, ...(recipe ? { text_alignment: recipe.text_alignment } : {}) }, brand, copyItems, product: { cutout_ref: cutoutRef }, environment: { ref: environmentRef, provider_id: 'layered-base' }, fonts, assetRefs: [cutoutRef, environmentRef], claimRefs,
  });
  const document = copyItems.some((i) => i.text_role === 'BODY')
    ? CI.reviseDesignDocument(assembled, {
      layers: assembled.layers.map((l) => (l.type === 'TEXT' && l.text_role === 'BODY' ? { ...l, font_size: Math.round(size.width * TEXT_LED_SPEC.font_size_of_width), line_height: TEXT_LED_SPEC.line_height, tracking: TEXT_LED_SPEC.tracking, max_lines: 12 } : l)),
      created_at: at, derivation: 'REFINE', created_by: 'ENGINE', producer_refs: ['engine:creative-runtime.layered-production.body-typography'],
    })
    : assembled;
  const assets = { [cutoutRef]: { width_px: cutoutSize.width, height_px: cutoutSize.height }, [environmentRef]: { width_px: size.width, height_px: size.height } };
  const solved = CI.solveLayout({ document, ...(recipe ? { recipe } : { recipe_id: recipeId }), fonts, assets, created_at: at });
  const placeable = solved.status === 'SOLVED' && !solved.unplaced.some((u) => ['PRODUCT', 'TEXT'].includes(solved.document.layers.find((l) => l.id === u.layer_id)?.type));
  return { document, assets, solved, placeable };
}

/** The generated layers of a campaign, shared by its scenes: every candidate that was paid for is kept (and judged again, for free, by the scene that reuses it). */
export function createLayerStore() {
  const entries = new Map();
  return Object.freeze({
    candidates: (key) => [...(entries.get(key) ?? [])],
    add(key, candidate) { if (!entries.has(key)) entries.set(key, []); entries.get(key).push(candidate); },
    keys: () => [...entries.keys()],
    size: () => entries.size,
  });
}

/**
 * The reservation ledger of the layered runtime: the hard ceiling of the production with the non-generated lines of its plan already reserved. `spent` counts what was really incurred (a candidate that was not needed
 * is reserved but never spent).
 */
export function createLayerBudget({ production }) {
  const plan = production.production.budget;
  const budget = createCampaignBudget({ ceilingEur: plan.ceiling_eur });
  for (const row of plan.rows) if (!row.label.startsWith('GENERATED_LAYER:')) budget.reserve(row.label, row.eur);
  const state = { spent_eur: 0, calls: 0 };
  return Object.freeze({
    budget,
    unit_costs: plan.unit_costs,
    reserve: (label, eur) => budget.reserve(label, eur),
    spend(eur) { state.spent_eur = round(state.spent_eur + eur); state.calls += 1; },
    snapshot: () => ({ ceiling_eur: budget.ceiling_eur, reserved_eur: budget.reserved_eur(), spent_eur: state.spent_eur, provider_calls: state.calls, rows: budget.rows() }),
  });
}

/**
 * The layout of a text-led slide: the product above, the planned BODY below in the text region of its density class (the region the content planner measured its capacity in). The recipe is checked by the same
 * validator as every recipe, and the BODY is typeset with the typography the capacity was measured with.
 */
export function bodySlideRecipe(densityClass) {
  const share = TEXT_LED_SPEC.region_height_share[densityClass === 'LOW' ? 'MEDIUM' : densityClass];
  const gap = 0.04;
  return assertValidLayoutRecipe({
    recipe_id: `LAYERED_BODY_SLIDE_${densityClass}`,
    description: 'the product above, the body text below in the region of its density class',
    margin_ratio: TEXT_LED_SPEC.margin_x_of_width,
    mirror_on_rtl: false,
    text_alignment: 'START',
    slots: [
      { role: 'PRODUCT', x: 0, y: 0, w: 1, h: Number((1 - share - gap).toFixed(4)), align: 'CENTER' },
      { role: 'BODY', x: 0, y: Number((1 - share).toFixed(4)), w: 1, h: share },
    ],
  });
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * @param {object} input
 *  at          ISO instant (explicit)
 *  brief       the same brief as the single-image runtime { ids, claims, format, brand, asset, identity_annotations, ... }
 *  fonts       the real font registry
 *  agents      { analyst }                      (the Product/Asset Analyst: the preservation mode)
 *  ports       { segmenter, layers }           layers.generate({ request, expected_size, candidate_index }) -> { output_bytes, provenance }; layers.executes: { [capability]: tool_id }; layers.live
 *  ledger      the decision ledger
 *  production  the result of the production planner (status SPECIFIED) and scene_id the scene to produce
 *  gate        the verdict of the provider gate (required to reach a live provider)
 *  store       the shared generated layers; budget the layer budget of the production (both shared by the scenes of one campaign)
 *  policy      { placement, rasterize } overrides of the declared placement policy and the rasterizer of the compositor (tests inject a stricter policy or a faulty rasterizer)
 */
export async function runLayeredCreative({
  at, brief, fonts, agents, ports, ledger, guardian = null, production, scene_id: sceneId, gate = null, store = createLayerStore(), budget = null, policy = {},
}) {
  const { ids, asset, brand } = brief;
  const placement = { ...LAYERED_RUNTIME_POLICY, ...(policy.placement ?? {}) };
  const rasterizerOption = policy.rasterize ? { rasterize: policy.rasterize } : {};
  const evidence = { strategy: 'LAYERED_SCENE_PRODUCTION', scene_id: sceneId ?? null };
  const component = COMPONENT.LAYERED_PRODUCTION_RUNTIME;
  let layerBudget = budget;
  const stop = (reason, extra = {}, replan = null) => {
    ledger.record({ decision: DECISION.LAYERED_REPLAN, decided_by: component, rule: 'A_BLOCKED_LAYERED_RUN_NAMES_WHAT_MUST_BE_REPLANNED_AND_NEVER_SWITCHES_STRATEGY_ITSELF', basis: [sceneId ?? 'no-scene'], outcome: { reason, replan: replan ?? 'REPLAN_THE_SCENE', fallback_to_single_image: false, ...extra.detail ? { detail: extra.detail } : {} } });
    return Object.freeze({
      status: 'BLOCKED', reason, replan: replan ?? 'REPLAN_THE_SCENE', fallback_to_single_image: false, ...evidence, ...extra, provider_calls: layerBudget?.snapshot().provider_calls ?? 0, ledger: ledger.entries(), steering: manualSteeringReport(ledger),
    });
  };

  // ---- 0. the specification this run executes
  const scene = production?.scenes?.find((s) => s.scene_id === sceneId);
  if (!scene) return stop(BLOCK.SCENE_NOT_SPECIFIED, { detail: 'NO_SUCH_SCENE' });
  const identity = production.product_identity;
  if (production.status !== PRODUCTION_STATUS.SPECIFIED || scene.status !== PRODUCTION_STATUS.SPECIFIED) return stop(BLOCK.SCENE_NOT_SPECIFIED, { blocks: scene.blocks.map((b) => b.code), production_status: production.status }, 'REPLAN_THE_PRODUCTION_FROM_ITS_BLOCKS');
  if (identity.status !== PRODUCT_STATUS.VERIFIED) return stop(BLOCK.PRODUCT_IDENTITY_NOT_VERIFIED, { identity_status: identity.status }, 'VERIFY_THE_PRODUCT_IDENTITY');
  if (asset.sha256 !== identity.sha256 || asset.ref !== identity.asset_ref || sha256(asset.bytes) !== identity.sha256) return stop(BLOCK.PRODUCT_ASSET_DOES_NOT_MATCH_THE_IDENTITY, {}, 'VERIFY_THE_PRODUCT_IDENTITY');
  const canvas = scene.canvas;
  const requests = new Map(production.shared_layers.map((r) => [r.request_key, r]));

  // ---- 1. the tools of the specification are the tools executed: a provider port that is not the selected tool, or a local tool other than the implemented one, stops the run before any work
  const toolOf = (capability) => scene.tools.find((t) => t.capability === capability)?.selected ?? null;
  const toolProblems = [];
  for (const [capability, implemented] of Object.entries(LAYERED_LOCAL_TOOLS)) { const selected = toolOf(capability); if (selected && selected.tool_id !== implemented) toolProblems.push({ capability, selected: selected.tool_id, executed: implemented }); }
  const usesProps = scene.layers.some((l) => l.kind.startsWith('PROP_'));
  for (const capability of PROVIDER_CAPABILITIES) {
    if (capability === CAP.PROP_ON_PLAIN_GROUND_GENERATION && !usesProps) continue;
    const selected = toolOf(capability);
    if (!selected) toolProblems.push({ capability, selected: null, executed: ports.layers?.executes?.[capability] ?? null });
    else if (ports.layers?.executes?.[capability] !== selected.tool_id) toolProblems.push({ capability, selected: selected.tool_id, executed: ports.layers?.executes?.[capability] ?? null });
  }
  if (toolProblems.length) return stop(BLOCK.TOOL_DIFFERS_FROM_THE_SELECTED_TOOL, { detail: toolProblems }, 'REPLAN_WITH_THE_TOOL_THE_RUNTIME_CAN_EXECUTE');
  ledger.record({ decision: DECISION.LAYER_TOOL, decided_by: component, rule: 'ONLY_THE_SELECTED_TOOL_IS_EXECUTED', basis: [scene.scene_id], outcome: { tools: scene.tools.map((t) => ({ capability: t.capability, tool_id: t.selected.tool_id, executor: t.selected.executor })), execution_policy: 'ONLY_THE_SELECTED_TOOL' } });
  // a LIVE provider is reached only through an open provider gate
  if (ports.layers?.live === true && gate?.status !== 'OPEN_BY_OWNER') return stop(BLOCK.PROVIDER_GATE_NOT_OPEN, { gate_status: gate?.status ?? null, gate_reasons: gate?.reasons ?? null }, 'OPEN_THE_PROVIDER_GATE');

  // ---- 2. the analyst: the preservation mode must be a composite
  const analysis = await agents.analyst.invoke({
    merchant_id: ids.merchant_id, brand_id: ids.brand_id, product_ref: ids.product_ref, identity_annotations: brief.identity_annotations, at,
    asset: { ref: asset.ref, origin: asset.origin, width_px: asset.width_px, height_px: asset.height_px, rights_class: asset.rights_class, privacy_class: asset.privacy_class },
  }, { merchant_id: ids.merchant_id, brand_id: ids.brand_id });
  if (analysis.product_understanding.transformation_policy.mode !== 'COMPOSITE') return stop(BLOCK.THE_PRODUCT_PRESERVING_RUNTIME_NEEDS_A_COMPOSITE_STRATEGY, { preservation_mode: analysis.product_understanding.transformation_policy.mode });
  ledger.record({ decision: DECISION.CREATIVE_DIRECTION, decided_by: COMPONENT.PRODUCTION_PLANNER, rule: 'THE_SCENE_SPECIFICATION_IS_THE_DIRECTION', basis: [scene.scene_id], outcome: { scene_id: scene.scene_id, composition_intent: scene.intent.composition_intent, imagery_intent: scene.intent.imagery_intent, narrative_role: scene.intent.narrative_role } });
  ledger.record({ decision: DECISION.BACKGROUND_STRATEGY, decided_by: component, rule: 'LAYERED_PLATE_PROPS_REAL_PRODUCT_TEXT', basis: [scene.scene_id], outcome: { layers: scene.layers.map((l) => ({ kind: l.kind, z: l.z, source: l.source })) } });

  // ---- 3. the text of the scene: the planned text, as it is
  const claimRefs = brief.claims.map((c) => c.ref);
  const copyItems = [];
  const seenRoles = new Set();
  for (const layer of scene.text_layers) {
    if (!(layer.role in TYPE_SCALE.initial_size_of_canvas_width) || seenRoles.has(layer.role)) return stop(BLOCK.TEXT_ROLE_NOT_EXECUTABLE, { detail: { role: layer.role, duplicate: seenRoles.has(layer.role) } }, 'REPLAN_THE_COPY_OF_THE_ASSET');
    seenRoles.add(layer.role);
    if (layer.role === 'PRICE' || layer.role === 'LEGAL') {
      const claim = brief.claims.find((c) => c.role === layer.role && c.wording === layer.text);
      if (!claim) return stop(BLOCK.TEXT_ROLE_NOT_EXECUTABLE, { detail: { role: layer.role, reason: 'A_FACT_BEARING_TEXT_NEEDS_AN_APPROVED_CLAIM_OF_THE_SAME_WORDING' } }, 'REPLAN_THE_COPY_OF_THE_ASSET');
      copyItems.push({ text_role: layer.role, content: layer.text, text_kind: 'CLAIM_BEARING', claim_ref: claim.ref });
    } else copyItems.push({ text_role: layer.role, content: layer.text, text_kind: 'NON_CLAIM_CREATIVE_TEXT', claim_ref: null });
  }

  // ---- 4. the REAL product, cut out locally (before any billable call)
  const segmentation = await ports.segmenter.segment({ asset, annotations: brief.identity_annotations });
  evidence.segmentation = { quality: segmentation.quality };
  if (!segmentation.quality.confident) return stop(BLOCK.SEGMENTATION_LOW_CONFIDENCE, { quality: segmentation.quality }, 'PROVIDE_A_BETTER_OUTLINE_OF_THE_PRODUCT');

  // ---- 5. the layout, solved on the real planned text and the real cut-out, BEFORE any billable call
  const briefKey = ids.brief_ref.replace(/[^A-Za-z0-9_.-]/g, '-');
  const cutoutRef = `asset://runtime/${briefKey}/product-cutout`;
  const baseRef = `asset://runtime/${briefKey}/${scene.scene_id}/layered-base`;
  const direction = { direction_id: scene.scene_id, spatial_intent: SPATIAL_INTENT_OF_COMPOSITION[scene.intent.composition_intent], product_role: 'HERO' };
  const roles = copyItems.map((i) => i.text_role);
  let recipe; let explicitRecipe = null;
  if (roles.includes('BODY')) {
    // a text-led slide: the BODY alone has a recipe of its own; a BODY with another role has none (it is not squeezed into a recipe that was not made for it)
    recipe = roles.length === 1 ? { recipe_id: `LAYERED_BODY_SLIDE_${scene.intent.density_class}`, rule: 'THE_BODY_OF_A_TEXT_LED_SLIDE_HAS_THE_RECIPE_OF_ITS_DENSITY_CLASS', considered: [] } : { recipe_id: null, reason: 'NO_LAYOUT_RECIPE_COVERS_A_BODY_WITH_ANOTHER_ROLE', considered: roles };
    if (recipe.recipe_id) explicitRecipe = bodySlideRecipe(scene.intent.density_class);
  } else recipe = selectLayoutRecipe(direction, roles);
  if (!recipe.recipe_id) return stop(BLOCK.NO_EXECUTABLE_LAYOUT, { detail: { reason: recipe.reason, considered: recipe.considered } }, 'REPLAN_THE_COMPOSITION_OR_THE_COPY_OF_THE_ASSET');
  const divisor = gcd(canvas.width, canvas.height);
  const format = { ...brief.format, canvas: { width: canvas.width, height: canvas.height }, aspect_ratio: `${canvas.width / divisor}:${canvas.height / divisor}` };
  let solvedPlan;
  try {
    solvedPlan = solveLayered({
    at, ids, direction, format, brand, copyItems, cutoutRef, cutoutSize: { width: segmentation.width_px, height: segmentation.height_px }, environmentRef: baseRef, size: canvas, fonts, claimRefs, recipeId: recipe.recipe_id, recipe: explicitRecipe,
    });
  } catch (error) { return stop(BLOCK.TEXT_ROLE_NOT_EXECUTABLE, { detail: { code: error.code ?? 'ERROR', message: error.message } }, 'REPLAN_THE_COPY_OF_THE_ASSET'); }
  const { solved, assets, document } = solvedPlan;
  ledger.record({ decision: DECISION.LAYOUT_RECIPE, decided_by: COMPONENT.LAYOUT_PLANNER, rule: recipe.rule, basis: [scene.scene_id], outcome: { recipe_id: recipe.recipe_id, spatial_intent: direction.spatial_intent, composition_intent: scene.intent.composition_intent, considered: recipe.considered } });
  if (!solvedPlan.placeable) return stop(BLOCK.THE_LAYOUT_COULD_NOT_BE_SOLVED, { detail: { violations: solved.violations, unplaced: solved.unplaced }, before_provider_work: true }, 'DISTRIBUTE_THE_COPY_OVER_MORE_ASSETS_OR_CHANGE_THE_COMPOSITION');
  const productLayer = solved.document.layers.find((l) => l.type === 'PRODUCT');
  const texts = solved.document.layers.filter((l) => l.type === 'TEXT');
  // the planned text is the text of the layer, byte for byte: nothing the layout engine returns may differ
  const exactness = scene.text_layers.map((layer) => {
    const placed = texts.find((t) => t.text_role === layer.role);
    return { role: layer.role, layer_id: layer.layer_id, planned_sha256: layer.text_sha256, placed_sha256: placed ? sha256Text(placed.content) : null, exact: Boolean(placed) && sha256Text(placed.content) === layer.text_sha256 };
  });
  if (!exactness.every((e) => e.exact)) return stop(BLOCK.LOCKED_TEXT_ALTERED, { detail: exactness }, 'REPLAN_THE_COPY_OF_THE_ASSET');
  ledger.record({ decision: DECISION.PRODUCT_PLACEMENT, decided_by: COMPONENT.LAYOUT_ENGINE, rule: 'RECIPE_SLOT_UNIFORM_FIT', basis: [recipe.recipe_id], outcome: { box: productLayer.geometry, canvas, product_height_share: productLayer.geometry.height / canvas.height, status: solved.status } });
  ledger.record({ decision: DECISION.TYPOGRAPHY_PLACEMENT, decided_by: COMPONENT.LAYOUT_ENGINE, rule: 'RECIPE_SLOTS_AND_TEXT_FITTING', basis: [recipe.recipe_id], outcome: { texts: texts.map((t) => ({ role: t.text_role, box: t.geometry, font_size: t.font_size })), unplaced: solved.unplaced, violations: solved.violations } });

  // ---- 6. the generated layers of the scene, from the specification
  const generated = scene.layers.filter((l) => l.source === 'GENERATED').map((l) => ({ layer: l, request: requests.get(l.request_key) }));
  if (generated.some((g) => !g.request)) return stop(BLOCK.SCENE_NOT_SPECIFIED, { detail: 'A_GENERATED_LAYER_HAS_NO_REQUEST' }, 'REPLAN_THE_PRODUCTION_FROM_ITS_BLOCKS');
  layerBudget = budget ?? createLayerBudget({ production });
  evidence.layers = [];

  // the budget is reserved for every layer that is not already in the shared store, before the first provider call
  const toGenerate = generated.filter((g) => store.candidates(g.request.request_key).length === 0);
  const reservedRows = [];
  try {
    for (const g of toGenerate) {
      const unit = layerBudget.unit_costs.image_eur_by_size_class[g.request.size_class];
      const eur = round(g.request.candidates * unit);
      layerBudget.reserve(`GENERATED_LAYER:${g.request.request_key}`, eur);
      reservedRows.push({ request_key: g.request.request_key, candidates: g.request.candidates, unit_eur: unit, eur });
    }
  } catch (error) {
    if (!(error instanceof CampaignBudgetError)) throw error;
    ledger.record({ decision: DECISION.LAYER_BUDGET_RESERVATION, decided_by: component, rule: 'RESERVE_BEFORE_ANY_PROVIDER_WORK', basis: [scene.scene_id], outcome: { reserved: false, error: error.detail, snapshot: layerBudget.snapshot() } });
    return stop(BLOCK.PRODUCTION_BLOCKED_BY_BUDGET, { detail: error.detail }, 'RAISE_THE_CEILING_OR_REUSE_MORE_LAYERS');
  }
  ledger.record({ decision: DECISION.LAYER_BUDGET_RESERVATION, decided_by: component, rule: 'RESERVE_BEFORE_ANY_PROVIDER_WORK', basis: [scene.scene_id], outcome: { reserved: true, layers: reservedRows, reused_layers: generated.length - toGenerate.length, snapshot: layerBudget.snapshot() } });

  const plateGate = (bytes, request) => {
    let pixels;
    try { pixels = decodePng(bytes); } catch { return { ok: false, rejection: 'THE_PLATE_IS_NOT_A_DECODABLE_PNG' }; }
    if (pixels.width !== request.size.width || pixels.height !== request.size.height) return { ok: false, rejection: 'THE_PLATE_SIZE_DIFFERS_FROM_THE_REQUEST' };
    if (pixels.width !== canvas.width || pixels.height !== canvas.height) return { ok: false, rejection: 'THE_PLATE_SIZE_DIFFERS_FROM_THE_CANVAS' };
    for (let i = 3; i < pixels.pixels.length; i += 4) if (pixels.pixels[i] !== 255) return { ok: false, rejection: 'THE_PLATE_IS_NOT_OPAQUE' };
    const suitability = assessEnvironment({ environment: pixels, productBox: productLayer.geometry });
    return { ok: suitability.suitable, rejection: suitability.suitable ? null : 'ENVIRONMENT_NOT_EMPTY', suitability, pixels };
  };
  const propGate = (bytes, request) => {
    let pixels;
    try { pixels = decodePng(bytes); } catch { return { ok: false, rejection: 'THE_PROP_IS_NOT_A_DECODABLE_PNG' }; }
    if (pixels.width !== request.size.width || pixels.height !== request.size.height) return { ok: false, rejection: 'THE_PROP_SIZE_DIFFERS_FROM_THE_REQUEST' };
    const matte = matteProp({ png: bytes, policy: MATTE_POLICY });
    return { ok: matte.ok, rejection: matte.ok ? null : matte.reasons.join('+'), matte };
  };

  const accepted = new Map(); // request_key -> { request, candidate, gate }
  for (const g of generated) {
    const { request } = g;
    if (accepted.has(request.request_key)) continue;
    const judge = request.kind === 'PLATE' ? plateGate : propGate;
    const componentOfGate = request.kind === 'PLATE' ? COMPONENT.PLATE_GATE : COMPONENT.PROP_MATTE_GATE;
    const tried = [];
    const consider = (candidate, origin) => {
      const verdict = judge(candidate.bytes, request);
      tried.push({ index: candidate.index, origin, sha256: sha256(candidate.bytes), ok: verdict.ok, rejection: verdict.rejection });
      ledger.record({
        decision: DECISION.LAYER_GENERATION, decided_by: componentOfGate, rule: 'A_GENERATED_LAYER_IS_UNTRUSTED_UNTIL_ITS_OWN_GATE_PASSES', basis: [request.request_key],
        outcome: { kind: request.kind, candidate: candidate.index, of: request.candidates, origin, output_sha256: sha256(candidate.bytes), accepted: verdict.ok, rejection: verdict.rejection, measured: verdict.matte?.measured ?? verdict.suitability?.measured ?? null, request_id: candidate.provenance?.request_id ?? null },
      });
      if (verdict.ok) accepted.set(request.request_key, { request, candidate, verdict });
      return verdict.ok;
    };
    // the paid candidates of the shared store are judged again, for this scene, at no cost
    const cached = store.candidates(request.request_key);
    for (const candidate of cached) if (consider(candidate, 'SHARED_STORE')) break;
    if (cached.length && accepted.has(request.request_key)) {
      ledger.record({ decision: DECISION.LAYER_REUSE, decided_by: component, rule: 'A_SHARED_LAYER_IS_PRODUCED_ONCE', basis: [request.request_key], outcome: { request_key: request.request_key, kind: request.kind, provider_calls: 0, scene_id: scene.scene_id } });
    }
    // more candidates only for a layer with room left in its bounded set, and only within what was reserved for it
    let produced = cached.length;
    while (!accepted.has(request.request_key) && produced < request.candidates) {
      if (cached.length && !reservedRows.some((r) => r.request_key === request.request_key)) {
        const unit = layerBudget.unit_costs.image_eur_by_size_class[request.size_class];
        try { layerBudget.reserve(`GENERATED_LAYER:${request.request_key}:MORE`, round((request.candidates - produced) * unit)); } catch (error) {
          if (!(error instanceof CampaignBudgetError)) throw error;
          return stop(BLOCK.PRODUCTION_BLOCKED_BY_BUDGET, { detail: error.detail }, 'RAISE_THE_CEILING_OR_REUSE_MORE_LAYERS');
        }
        reservedRows.push({ request_key: request.request_key, candidates: request.candidates - produced, unit_eur: unit, eur: round((request.candidates - produced) * unit) });
      }
      ledger.record({
        decision: DECISION.PROVIDER_REQUEST_CONSTRUCTION, decided_by: COMPONENT.PROVIDER_REQUEST_BUILDER, rule: 'THE_REQUEST_OF_THE_SPECIFICATION_CARRIES_NO_PRODUCT_PIXEL', basis: [request.request_key],
        outcome: { kind: request.kind, size: request.size, carries_input_asset: request.carries_input_asset, prompt_sha256: request.prompt_sha256, candidate: produced + 1 },
      });
      const out = await ports.layers.generate({ request: { ...request, capability: request.capability, input_asset_refs: [] }, expected_size: request.size, candidate_index: produced + 1 });
      produced += 1;
      layerBudget.spend(layerBudget.unit_costs.image_eur_by_size_class[request.size_class]);
      const candidate = { index: produced, bytes: out.output_bytes, provenance: out.provenance };
      store.add(request.request_key, candidate);
      consider(candidate, 'GENERATED');
    }
    evidence.layers.push({ request_key: request.request_key, kind: request.kind, candidates: tried, accepted: accepted.has(request.request_key) });
    if (!accepted.has(request.request_key)) {
      return stop(BLOCK.GENERATED_LAYER_REJECTED, { detail: { request_key: request.request_key, kind: request.kind, candidates: tried }, budget: layerBudget.snapshot() }, request.kind === 'PLATE' ? 'REPLAN_THE_PLATE_OR_THE_COMPOSITION' : 'REPLAN_THE_PROP_OR_DROP_IT_FROM_THE_SPECIFICATION');
    }
  }
  const plateAccepted = accepted.get(generated.find((g) => g.request.kind === 'PLATE').request.request_key);
  ledger.record({ decision: DECISION.ENVIRONMENT_SUITABILITY, decided_by: COMPONENT.ENVIRONMENT_SUITABILITY_GATE, rule: plateAccepted.verdict.suitability.rule, basis: [plateAccepted.request.request_key], outcome: { suitable: true, zone: plateAccepted.verdict.suitability.zone, measured: plateAccepted.verdict.suitability.measured, limit: plateAccepted.verdict.suitability.limit } });

  // ---- 7. placement of the props around the real product (deterministic, declared policy), then the composition by the LAYER COMPOSITOR
  const productFit = P.containFit(productLayer.geometry, segmentation.width_px, segmentation.height_px);
  const productRect = { x: Math.round(productFit.x), y: Math.round(productFit.y), width: Math.max(1, Math.round(productFit.width)), height: Math.max(1, Math.round(productFit.height)) };
  const placedProduct = resizePng({ png: segmentation.cutout_png, width: productRect.width, height: productRect.height });
  const occupied = [{ x: productRect.x - canvas.width * placement.clearance_of_width, y: productRect.y - canvas.width * placement.clearance_of_width, width: productRect.width + 2 * canvas.width * placement.clearance_of_width, height: productRect.height + 2 * canvas.width * placement.clearance_of_width }, ...texts.map((t) => t.geometry)];
  const margin = Math.round(canvas.width * placement.margin_of_width);
  const rasterLayers = [{ layer_id: plateAccepted.request.request_key, kind: LAYER_KIND.PLATE, z: LAYER_Z.PLATE, png: plateAccepted.candidate.bytes, x: 0, y: 0 }];
  const slotsByKind = new Map();
  const foregroundDraws = [];
  for (const g of generated.filter((x) => x.layer.kind !== LAYER_KIND.PLATE)) {
    const { layer, request } = g;
    const got = accepted.get(request.request_key);
    const trimmedBounds = decodePng(got.verdict.matte.cutout_png);
    const share = placement.prop_height_share[request.zone];
    const targetHeight = Math.max(8, Math.round(canvas.height * share));
    const targetWidth = Math.max(8, Math.round(trimmedBounds.width * (targetHeight / trimmedBounds.height)));
    const placed = resizePng({ png: got.verdict.matte.cutout_png, width: targetWidth, height: targetHeight });
    let at2 = null;
    if (layer.kind === LAYER_KIND.PROP_FOREGROUND) {
      at2 = { x: Math.round(productRect.x + productRect.width - placement.foreground_inset * placed.width), y: Math.round(productRect.y + productRect.height - placement.foreground_inset * placed.height) };
      if (at2.x < 0 || at2.y < 0 || at2.x + placed.width > canvas.width || at2.y + placed.height > canvas.height) return stop(BLOCK.NO_ROOM_FOR_A_PROP, { detail: { request_key: request.request_key, zone: request.zone, reason: 'THE_FOREGROUND_PROP_WOULD_LEAVE_THE_CANVAS' } }, 'REPLAN_THE_COMPOSITION_OR_DROP_THE_PROP');
    } else {
      const anchors = [
        { x: margin, y: canvas.height - margin - placed.height }, { x: canvas.width - margin - placed.width, y: canvas.height - margin - placed.height },
        { x: margin, y: Math.round(canvas.height * 0.5) }, { x: canvas.width - margin - placed.width, y: Math.round(canvas.height * 0.5) },
        { x: margin, y: margin }, { x: canvas.width - margin - placed.width, y: margin },
      ];
      at2 = anchors.find((a) => a.x >= 0 && a.y >= 0 && a.x + placed.width <= canvas.width && a.y + placed.height <= canvas.height && !occupied.some((o) => intersects({ ...a, width: placed.width, height: placed.height }, o)));
      if (!at2) return stop(BLOCK.NO_ROOM_FOR_A_PROP, { detail: { request_key: request.request_key, zone: request.zone, reason: 'NO_FREE_PLACE_AROUND_THE_PRODUCT_AND_THE_TEXT' } }, 'REPLAN_THE_COMPOSITION_OR_DROP_THE_PROP');
      occupied.push({ ...at2, width: placed.width, height: placed.height });
    }
    const slot = slotsByKind.get(layer.kind) ?? 0; slotsByKind.set(layer.kind, slot + 1);
    const raster = { layer_id: layer.layer_id, kind: layer.kind, z: LAYER_Z[layer.kind] + slot, png: placed.png, x: at2.x, y: at2.y, ...(layer.overlap ? { overlap: layer.overlap } : {}) };
    rasterLayers.push(raster);
    if (layer.kind === LAYER_KIND.PROP_FOREGROUND) foregroundDraws.push({ ...raster, ref: `asset://runtime/${briefKey}/${scene.scene_id}/foreground-${slot}`, width: placed.width, height: placed.height });
    ledger.record({ decision: DECISION.LAYER_PLACEMENT, decided_by: component, rule: 'DECLARED_PLACEMENT_POLICY_AROUND_THE_REAL_PRODUCT', basis: [layer.layer_id], outcome: { kind: layer.kind, box: { x: at2.x, y: at2.y, width: placed.width, height: placed.height }, source_sha256: sha256(got.candidate.bytes) } });
  }
  // the protected regions of the product (the printed artwork), in canvas pixels
  const protectedRegions = [];
  const art = brief.identity_annotations?.artwork_region;
  if (art) {
    const k = productRect.width / segmentation.width_px;
    protectedRegions.push({
      x: productRect.x + (art.x * asset.width_px - segmentation.crop.x0) * k, y: productRect.y + (art.y * asset.height_px - segmentation.crop.y0) * k, width: art.width * asset.width_px * k, height: art.height * asset.height_px * k,
    });
  }
  const productRaster = { layer_id: scene.layers.find((l) => l.kind === LAYER_KIND.PRODUCT).layer_id, kind: LAYER_KIND.PRODUCT, z: LAYER_Z.PRODUCT, png: placedProduct.png, x: productRect.x, y: productRect.y };
  // (1) the complete z-ordered stack, with its overlap and product-pixel measurements: refused as it is, never adjusted
  const stack = composeLayers({ canvas, layers: [...rasterLayers, productRaster], protectedRegions, ...rasterizerOption });
  ledger.record({ decision: DECISION.LAYER_COMPOSITION, decided_by: COMPONENT.LAYER_COMPOSITOR, rule: 'Z_ORDER_OVERLAP_AND_PRODUCT_PIXELS_ARE_MEASURED_AND_NEVER_ADJUSTED', basis: [scene.scene_id], outcome: { stage: 'FULL_STACK', status: stack.status, order: stack.report.layer_order, foreground: stack.report.foreground, product_pixels_checked: stack.report.product_pixels_checked, product_pixels_changed: stack.report.product_pixels_changed, problems: stack.report.problems } });
  if (stack.status !== 'COMPOSED') return stop(BLOCK.COMPOSITION_REFUSED, { detail: { problems: stack.report.problems, foreground: stack.report.foreground } }, 'REPLAN_THE_COMPOSITION_OR_THE_FOREGROUND_PROP');
  // (2) the layers UNDER the product, composed into the base the deterministic renderer draws the product on
  const under = composeLayers({ canvas, layers: rasterLayers.filter((l) => LAYER_Z[l.kind] < LAYER_Z.PRODUCT), requireProduct: false, ...rasterizerOption });
  ledger.record({ decision: DECISION.LAYER_COMPOSITION, decided_by: COMPONENT.LAYER_COMPOSITOR, rule: 'Z_ORDER_OVERLAP_AND_PRODUCT_PIXELS_ARE_MEASURED_AND_NEVER_ADJUSTED', basis: [scene.scene_id], outcome: { stage: 'UNDER_THE_PRODUCT', status: under.status, order: under.report.layer_order, problems: under.report.problems } });
  if (under.status !== 'COMPOSED') return stop(BLOCK.COMPOSITION_REFUSED, { detail: { problems: under.report.problems } }, 'REPLAN_THE_COMPOSITION');

  // ---- 8. typography: the colour of each text from the brand tokens against what is really behind it (the composed stack)
  const backdropPixels = decodePng(stack.png);
  const measuredBackdrops = {};
  const plates = [];
  let plateChoice = null;
  const colored = solved.document.layers.map((l) => {
    if (l.type !== 'TEXT') return l;
    const backdrops = backdropSamples(backdropPixels, l.geometry);
    measuredBackdrops[l.id] = backdrops;
    const pick = chooseTextColor({ textRole: l.text_role, backdrops, tokens: brand.colors });
    if (pick.contrast >= 4.5) return { ...l, color: pick.hex, _choice: { role: l.text_role, token: pick.token, worst_contrast: pick.contrast, candidates: pick.candidates } };
    plateChoice = plateChoice ?? choosePlate({ tokens: brand.colors });
    if (!plateChoice) return { ...l, _noPair: true };
    const tokens = Object.fromEntries(Object.entries(brand.colors).filter(([token]) => token !== plateChoice.plate_token));
    const onPlate = chooseTextColor({ textRole: l.text_role, backdrops: [plateChoice.plate_hex], tokens });
    plates.push(plateLayer({ id: `plate-${l.text_role.toLowerCase()}`, z: 12 + plates.length, box: l.geometry, canvas, fill: plateChoice.plate_hex }));
    measuredBackdrops[l.id] = [plateChoice.plate_hex];
    return { ...l, color: onPlate.hex, _choice: { role: l.text_role, token: onPlate.token, worst_contrast: onPlate.contrast, candidates: onPlate.candidates, plate: { token: plateChoice.plate_token, reason: 'NO_BRAND_TOKEN_READS_ON_THE_ENVIRONMENT', best_on_environment: pick.contrast } } };
  });
  if (colored.some((l) => l._noPair)) return stop(BLOCK.NO_BRAND_COLOUR_PAIR_READS, { backdrops: measuredBackdrops }, 'REPLAN_THE_PLATE_OR_THE_BRAND_COLOURS');
  const choices = colored.filter((l) => l._choice).map((l) => l._choice);
  // the foreground props are IMAGE layers between the product and the text, drawn 1:1 from the pixels the compositor verified
  const foregroundLayers = foregroundDraws.map((f, i) => ({
    id: `foreground-${i}`, type: 'IMAGE', z_index: 15 + i, geometry: { x: f.x, y: f.y, width: f.width, height: f.height, rotation_deg: 0 }, visibility: 'VISIBLE', locked: false, source_ref: f.ref, constraints: [], effects: [], fit: 'CONTAIN', provenance: { origin: 'GENERATED', producer_ref: 'layered-production-runtime', evidence_refs: [] },
  }));
  const finalLayers = [...colored.map(({ _choice, _noPair, ...layer }) => layer), ...plates, ...foregroundLayers];
  const finalDocument = CI.reviseDesignDocument(solved.document, {
    layers: finalLayers, asset_refs: [...document.asset_refs, ...foregroundDraws.map((f) => f.ref)], created_at: at, derivation: 'REFINE', created_by: 'ENGINE', producer_refs: ['engine:creative-runtime.layered-production'],
  });
  ledger.record({ decision: DECISION.TEXT_STYLE, decided_by: COMPONENT.TYPOGRAPHY_RULES, rule: 'TOKEN_BY_CONTRAST_AGAINST_THE_ACTUAL_ENVIRONMENT_OR_A_BRAND_PLATE_WHEN_NO_TOKEN_READS', basis: Object.keys(brand.colors), outcome: { choices, plates: plates.map((p) => p.id) } });

  // ---- 9. preflight, the deterministic render, the IDENTITY fidelity gate, the Guardian: the gates of the single-image runtime, unchanged
  const approvedTexts = Object.fromEntries(brief.claims.map((c) => [c.ref, CI.textDigest(c.wording)]));
  const catalogue = { ...assets, ...Object.fromEntries(foregroundDraws.map((f) => [f.ref, { width_px: f.width, height_px: f.height }])) };
  const preflight = CI.runCreativePreflight(finalDocument, { fonts, assets: catalogue, approved_claim_refs: claimRefs, approved_texts: approvedTexts, measured_backdrops: measuredBackdrops });
  ledger.record({ decision: DECISION.PREFLIGHT, decided_by: COMPONENT.PREFLIGHT, rule: 'EXISTING_PREFLIGHT_CHECKS', basis: [], outcome: { status: preflight.status, checks: preflight.checks.map((c) => `${c.code}=${c.status}`) } });
  const base = { ...evidence, budget: layerBudget.snapshot(), provider_calls: layerBudget.snapshot().provider_calls };
  if (preflight.status !== 'PASS') return Object.freeze({ status: 'PREFLIGHT_FAIL', ...base, preflight: { status: preflight.status, checks: preflight.checks }, document: finalDocument, ledger: ledger.entries(), steering: manualSteeringReport(ledger) });

  const foregroundByRef = new Map(foregroundDraws.map((f) => [f.ref, f.png]));
  const bytesFor = (ref) => (ref === cutoutRef ? segmentation.cutout_png : (ref === baseRef ? under.png : (foregroundByRef.get(ref) ?? null)));
  const renderLog = P.createRenderLog(bytesFor);
  const rendered = CI.renderDesignDocument({ document: finalDocument, fonts, assetResolver: renderLog.resolver });
  const png = P.renderProductionPng(rendered);
  const log = renderLog.finish(rendered.svg);

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
    expected: { source_asset_ref: asset.ref, pinned_sha256: asset.sha256, derived_asset_ref: cutoutRef, piece_count: 1, allowed_other_image_draws: 1 + foregroundDraws.length },
    annotations: brief.identity_annotations,
  });
  const required = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);
  const fidelity = evaluateHardFidelityGate({ observations, requiredChecks: required });
  const failed = observations.flatMap((o) => (o.evidence.sub_observations ?? []).filter((s) => s.outcome !== 'PASS').map((s) => ({ check: o.code, observation: s.id, outcome: s.outcome, evidence: s.evidence })));
  ledger.record({ decision: DECISION.FIDELITY, decided_by: COMPONENT.IDENTITY_FIDELITY_GATE, rule: 'IDENTITY_PRESERVE_MEASUREMENTS_ON_THE_DELIVERED_PNG', basis: [asset.ref], outcome: { gate: fidelity.outcome, failed_observations: failed.map((f) => `${f.check}/${f.observation}=${f.outcome}`) } });

  let guardianResult = null;
  if (guardian) {
    guardianResult = guardian.evaluate({ document: finalDocument, fonts, fidelityGate: fidelity });
    ledger.record({ decision: DECISION.BRAND_GUARDIAN, decided_by: COMPONENT.BRAND_GUARDIAN, rule: 'APPROVED_BRAND_MEMORY_HARD_RULES_ON_THE_DECLARED_CANDIDATE', basis: [], outcome: { outcome: guardianResult.outcome, rules: guardianResult.rule_results.map((r) => `${r.rule_id}=${r.outcome}`) } });
  }
  let status;
  if (fidelity.outcome === 'FAIL') status = 'FIDELITY_FAIL';
  else if (fidelity.outcome !== 'PASS') status = 'BLOCKED';
  else if (!guardianResult) status = 'BLOCKED';
  else status = guardianResult.outcome === 'PASS' ? 'READY_FOR_REVIEW' : 'GUARDIAN_FAIL';

  return Object.freeze({
    status,
    ...(status === 'BLOCKED' && fidelity.outcome === 'PASS' && !guardianResult ? { reason: 'BRAND_GUARDIAN_NOT_CONFIGURED' } : {}),
    ...base,
    fallback_to_single_image: false,
    png_bytes: png.bytes,
    png_sha256: png.sha256,
    width: png.width,
    height: png.height,
    document: finalDocument,
    preflight: { status: preflight.status },
    guardian: guardianResult,
    fidelity: { gate: fidelity.outcome, observations, failed },
    render: { render_mode: rendered.render_mode, typography_mode: rendered.typography_mode, resolutions: log.resolutions.length, resolved: log.resolutions, image_draws: log.image_draws },
    composition: { base_sha256: sha256(under.png), stack_sha256: sha256(stack.png), order: stack.report.layer_order, foreground: stack.report.foreground, product_pixels_checked: stack.report.product_pixels_checked, product_pixels_changed: stack.report.product_pixels_changed, protected_regions: protectedRegions.length },
    text: exactness,
    segmentation: { quality: segmentation.quality, cutout_sha256: segmentation.cutout_sha256 },
    product_rect: productRect,
    ledger: ledger.entries(),
    steering: manualSteeringReport(ledger),
    sha256_of: sha256(png.bytes),
  });
}

/** What the layered runtime is made of, by the references it really calls: the readiness gate reads this, so a stage that is not wired cannot be reported as wired. */
export function describeLayeredRuntime() {
  const stages = {
    compositor: typeof composeLayers === 'function',
    prop_matte: typeof matteProp === 'function',
    deterministic_text: typeof CI.renderDesignDocument === 'function' && typeof solveLayered === 'function' && typeof assembleDocument === 'function',
    identity_fidelity_gate: typeof P.measureProductFidelity === 'function' && typeof evaluateHardFidelityGate === 'function',
    plate_suitability_gate: typeof assessEnvironment === 'function',
    budget_reservation: typeof createLayerBudget === 'function',
    shared_layer_store: typeof createLayerStore === 'function',
  };
  return Object.freeze({
    entry: typeof runLayeredCreative === 'function' ? 'runLayeredCreative' : null,
    stages: Object.freeze(stages),
    local_tools: LAYERED_LOCAL_TOOLS,
    wired: typeof runLayeredCreative === 'function' && Object.values(stages).every(Boolean),
    opt_in: true,
    single_image_fallback: false,
  });
}
