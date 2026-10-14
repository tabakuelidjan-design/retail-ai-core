import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createAssetDirector, createCampaignPlanner, createMemoryCheckpointStore } from '../creative-campaign/index.js';
import { createCreativeBrain } from '../creative-brain/index.js';
import { createContentFormatPlanner } from '../creative-planning/index.js';
import { createProductionPlanner } from '../creative-production/index.js';
import {
  createDecisionLedger, createLayerBudget, createLayerStore, createProductAssetAnalyst, runLayeredCreative,
} from '../creative-runtime/index.js';
import { createRefineMemory, defectsFromCandidate, refineCreative } from '../creative-refine/index.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { STATE as IS } from '../creative-integration/index.js';
import { deriveAnnotations, prepareAsset } from './asset.js';
import {
  E2E_BLOCK, E2E_STATE, GATE_STATUS, OPERATION, STAGE, STAGE_ORDER,
} from './constants.js';
import { dispositionOfClaims } from './claims.js';
import { checkProductCopyConsistency } from './consistency.js';
import { checkDelivered, checkProductPlacement, createShadowHook } from './integration-stage.js';
import { RunBudgetError, RunInvariantError, createRunContext } from './run-context.js';
import { computeProductSegmentation, precomputedSegmenter } from './segmentation-stage.js';

// THE END-TO-END CREATIVE RUN. One explicit, opt-in entry point that chains the five phases: request → asset → real-product segmentation (before any billable call) → format plan → Brain plan → production plan →
// layered production of ONE scene with the integrated product → refine (only for a named, repairable defect) → final gates → one result contract. One run id, one ledger, one budget, one chain of operation ids.
// It replaces nothing: the single-image runtime and a direct call of the layered runtime are unchanged; this function is reached only by naming it. It never falls back to a generated or redrawn product.

const sha = (v) => createHash('sha256').update(typeof v === 'string' || v instanceof Uint8Array ? v : JSON.stringify(v)).digest('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

const gate = (id, status, outcome, mandatory, evidence = {}) => Object.freeze({ id, status, outcome, mandatory, evidence });

/**
 * The layered run's own status, said so that it cannot contradict the final state: its raw status stays (it is evidence), and `delivery` says what it means for the asset.
 * A hard fidelity gate that could not be MEASURED (no case annotations for this product) makes the raw status BLOCKED although an image exists: the delivery is then
 * IDENTITY_NOT_MEASURED_BY_THE_CASE_GATE, and the pixels of the product are judged by the final gates of the run instead.
 */
export function layeredRunOf(layered) {
  if (!layered?.png_bytes) return { raw_status: layered?.status ?? null, delivery: 'NO_IMAGE', case_gate: layered?.fidelity?.gate ?? null };
  const gateOfCase = layered.fidelity?.gate ?? null;
  const delivery = layered.status === 'READY_FOR_REVIEW' ? 'COMPLETE'
    : (layered.status === 'BLOCKED' && gateOfCase === 'NOT_MEASURABLE') ? 'IDENTITY_NOT_MEASURED_BY_THE_CASE_GATE'
      : 'A_GATE_OF_THE_LAYERED_RUN_FAILED';
  return { raw_status: layered.status, delivery, case_gate: gateOfCase };
}

/**
 * ONE status model. The planner's own `execution` flag (PLANNED_NOT_EXECUTABLE in a stored content or asset plan) means "the planner does not produce"; it is a statement about the PLAN, superseded by this field.
 * produced = an image exists; deliverable = it passed every mandatory gate (the state says whether anyone should look at it).
 */
export function executionOf({ state, png, planned, specified, layered }) {
  const produced = Boolean(png);
  return { planned: Boolean(planned), specified: Boolean(specified), produced, deliverable: produced && (state === E2E_STATE.READY || state === E2E_STATE.NEEDS_OWNER_REVIEW), layered_delivery: layeredRunOf(layered).delivery };
}

/** What the run is made of, by the references it really calls (the readiness gate reads this). */
export function describeEndToEnd() {
  const parts = {
    campaign_planner: typeof createCampaignPlanner === 'function', production_planner: typeof createProductionPlanner === 'function', layered_runtime: typeof runLayeredCreative === 'function',
    refine: typeof refineCreative === 'function', integration_segmentation: typeof computeProductSegmentation === 'function', run_context: typeof createRunContext === 'function',
  };
  return Object.freeze({ entry: 'runCreativeEndToEnd', stages: STAGE_ORDER, parts: Object.freeze(parts), wired: Object.values(parts).every(Boolean), opt_in: true, replaces_legacy: false });
}

/**
 * @param {object} input
 *  run_id, at, ceiling_eur            the run
 *  request, brief                     the campaign request and brief (brief.asset = the REAL product file, brief.claims, brief.brand, brief.format, brief.ids)
 *  fonts, font                        the real font registry and the font object of the production planner
 *  ports                              { brainComplete, directorComplete, layers, segmentation?, critic?, maskedEdit? }   (every paid port is wrapped: operation id + reservation)
 *  guardian                           the Brand Guardian port (a mandatory gate: without it the run cannot be READY)
 *  options                            { scene_index, source_mode: 'AUTO'|'NATIVE_ALPHA'|'PHOTO', selection, contact_shadow: { kind, light?, support? }, refine: { enabled, max_attempts, scopes, defects }, require_critic, gate }
 *  resume                             the `resume_state` of a previous result of this run
 *  deps                               { runLayered, refine, segment }  replacements of the three heavy collaborators (tests of the routing decisions inject fakes); the defaults are the real ones
 */
export async function runCreativeEndToEnd({
  run_id: runId, at, ceiling_eur: ceiling = 2, request, brief, fonts, font = null, ports = {}, guardian = null, options = {}, resume = null, ledger = createDecisionLedger(), deps = {},
}) {
  const runLayered = deps.runLayered ?? runLayeredCreative; const refine = deps.refine ?? refineCreative; const segment = deps.segment ?? computeProductSegmentation;
  let ctx;
  try { ctx = createRunContext({ run_id: runId, ceiling_eur: ceiling, ledger, at, resume: resume?.run_state ?? null }); } catch (error) {
    // the run itself could not be created (an invalid id, ceiling or resume state): a technical failure with no run to describe
    return Object.freeze({ schema: 'creative-e2e-result@1', state: E2E_STATE.TECHNICAL_FAIL, run_id: runId ?? null, final: null, gates: [], budget: null, provider_calls: [], operation_ids: [], warnings: [], block: null, failure: { code: error?.code ?? 'ERROR', detail: error?.detail ?? null }, owner_approval: 'PENDING', fallback_to_generated_product: false, resume_state: null });
  }
  const stages = {}; const warnings = []; const gates = []; let consistency = null; let claimDispositions = null;
  const campaignStore = createMemoryCheckpointStore(resume?.campaign_store ?? null);
  let layerStore = createLayerStore(resume?.layer_store ?? null);
  const refineMemory = createRefineMemory(resume?.refine_memory ?? null);
  let layerBudget = null; let production = null; let campaign = null; let segmentationEval = null; let assetPrep = null; let layeredResult = null; let refineSummary = { decision: 'NOT_EVALUATED' };
  let integrationChecks = null; let sceneId = null;
  const timings = {}; let tLap = performance.now(); const lap = (name) => { const n = performance.now(); timings[name] = Math.round((timings[name] ?? 0) + (n - tLap)); tLap = n; };

  const snapshotResume = () => ({ schema: 'e2e-resume@1', run_state: ctx.exportState(), campaign_store: campaignStore.peek(), layer_store: layerStore.export(), refine_memory: refineMemory.export?.() ?? null });
  const save = (stage, input, payload, meta) => { ctx.checkpoints.save(stage, { input_sha256: sha(input), payload, meta }); stages[stage] = { status: 'DONE', payload_sha256: ctx.checkpoints.get(stage).payload_sha256 }; };
  const finish = (state, { block = null, failure = null, final = null } = {}) => {
    const png = final?.png_bytes ?? null;
    const contract = {
      schema: 'creative-e2e-result@1', state, run_id: runId, asset_id: sceneId, campaign_id: campaign?.campaign_plan?.campaign_id ?? null, asset_count: campaign?.asset_plans?.length ?? null,
      format: campaign?.content_plans?.[0]?.format?.kind ?? null,
      final: png ? { png_bytes: png, png_sha256: sha(png), width: final.width, height: final.height, layered_run: layeredRunOf(final) } : null,
      execution: executionOf({ state, png, planned: campaign?.status === 'PLANNED', specified: production?.status === 'SPECIFIED', layered: final }),
      source_provenance: assetPrep?.asset ? { ...assetPrep.provenance, asset_ref: assetPrep.asset.ref, origin: assetPrep.asset.origin, rights_class: assetPrep.asset.rights_class } : null,
      product_identity: {
        pinned_sha256: production?.product_identity?.sha256 ?? null, identity_status: production?.product_identity?.status ?? null,
        delivered_identity: integrationChecks?.identity ? { valid: integrationChecks.identity.valid, checks: integrationChecks.identity.findings.map((f) => `${f.code}:${f.ok ? 'PASS' : 'FAIL'}:${typeof f.value === 'number' ? +f.value.toFixed(4) : f.value}`) } : null,
        product_pixels_changed_by_compositor: final?.composition?.product_pixels_changed ?? null,
      },
      copy_integrity: final?.text ? { exact: final.text.every((t) => t.exact), roles: final.text.map((t) => t.role) } : null,
      integration: segmentationEval ? {
        state: segmentationEval.state, source_kind: segmentationEval.source_kind, reasons: segmentationEval.reasons, evidence: segmentationEval.stage_evidence ?? null, grade: 'NOT_APPLIED_IN_THE_LAYERED_FLOW', shadow: final?.integration_shadow ? { kind: final.integration_shadow.kind } : null,
      } : null,
      layers: layeredResult?.artifact ? { plate: layeredResult.artifact.nodes.plate.node_id, props: layeredResult.artifact.nodes.props.map((x) => ({ node_id: x.node_id, layer_id: x.layer_id, kind: x.kind })), product: layeredResult.artifact.nodes.product.node_id, text: layeredResult.artifact.nodes.text.map((x) => x.node_id) } : null,
      selection: { mode: options.selection?.mode ?? 'AUTO', ids: options.selection?.ids ?? null, product_ids: segmentationEval?.seg?.components?.filter((c) => c.selected).map((c) => c.id) ?? null },
      refine: refineSummary,
      consistency, claims: claimDispositions, gates, budget: ctx.budget.snapshot(), provider_calls: ctx.operations.providerCalls(), operation_ids: ctx.operations.ids(),
      ledger_reference: { run_id: runId, entries: ledger.entries().length, sha256: sha(ledger.entries().map((e) => e.decision ?? e.rule ?? '').join('|')) },
      timings_ms: { ...timings, total: Object.values(timings).reduce((a, b) => a + b, 0) }, memory_mb: { rss: Math.round(process.memoryUsage().rss / 1048576), heap_used: Math.round(process.memoryUsage().heapUsed / 1048576) },
      stages: { ...stages }, checkpoints: ctx.checkpoints.list(), warnings, block, failure, owner_approval: 'PENDING', fallback_to_generated_product: false,
      resume_state: snapshotResume(),
    };
    return Object.freeze(contract);
  };
  const blocked = (stage, code, reason, replan, extra = {}) => { stages[stage] = { status: 'STOPPED' }; ctx.setFailure({ stage, code, reason }); return finish(E2E_STATE.BLOCKED, { block: { stage, code, reason, replan, ...extra } }); };

  // the ceiling refused a reservation: that is BUDGET_EXCEEDED, whatever the port that was waiting made of the refusal (a provider failure is a different state)
  const budgetStop = () => { const d = ctx.budgetRefusal(); if (!d) return null; ctx.setFailure({ stage: 'BUDGET', code: 'BUDGET_EXCEEDED', detail: d }); return finish(E2E_STATE.BUDGET_EXCEEDED, { failure: { code: 'BUDGET_EXCEEDED', detail: d } }); };

  try {
    // ---- REQUEST
    if (!(ceiling > 0)) { ctx.setFailure({ stage: STAGE.REQUEST, code: 'BUDGET_EXCEEDED' }); return finish(E2E_STATE.BUDGET_EXCEEDED, { failure: { code: 'BUDGET_EXCEEDED', detail: { source: 'A_RUN_WITHOUT_BUDGET_CANNOT_DO_PAID_WORK', ceiling_eur: ceiling } } }); }
    const problems = [];
    if (!request || !brief?.asset?.bytes || !brief?.ids || !brief?.format) problems.push('REQUEST_OR_BRIEF_INCOMPLETE');
    if (typeof ports.brainComplete !== 'function') problems.push('NO_BRAIN_PORT');
    if (problems.length) return blocked(STAGE.REQUEST, E2E_BLOCK.REQUEST_INVALID, problems.join(','), 'FIX_THE_REQUEST');
    if (typeof ports.layers?.generate !== 'function') { stages[STAGE.REQUEST] = { status: 'STOPPED' }; ctx.setFailure({ stage: STAGE.REQUEST, code: E2E_BLOCK.LAYER_PORT_NOT_CONNECTED }); return finish(E2E_STATE.PROVIDER_NOT_CONNECTED, { block: { stage: STAGE.REQUEST, code: E2E_BLOCK.LAYER_PORT_NOT_CONNECTED, reason: 'THE_LAYER_GENERATOR_IS_NOT_CONNECTED', replan: 'CONNECT_A_LAYER_PROVIDER' } }); }
    // product / copy consistency: before anything is spent
    consistency = checkProductCopyConsistency({ brief, request });
    ctx.event('PRODUCT_COPY_CONSISTENCY', { status: consistency.status, product_category: consistency.product_category, findings: consistency.findings.length });
    gates.push(gate('PRODUCT_COPY_CONSISTENCY', GATE_STATUS.EXECUTABLE_NOW, consistency.status === 'CONFLICT' ? 'FAIL' : consistency.status === 'CONSISTENT' ? 'PASS' : 'NOT_APPLICABLE', true, { status: consistency.status, product_category: consistency.product_category, findings: consistency.findings }));
    if (consistency.status === 'CONFLICT') return blocked(STAGE.REQUEST, E2E_BLOCK.PRODUCT_COPY_CONFLICT, consistency.findings.map((f) => `${f.source}:${f.copy_says}:${f.evidence}`).join(' | '), 'FIX_THE_COPY_OR_THE_PRODUCT_DECLARATION', { findings: consistency.findings });
    save(STAGE.REQUEST, { request_ref: request.request_ref, run: runId }, { request_ref: request.request_ref, channel: request.channel, requested_format: request.requested_format });

    // ---- ASSET: the real product file, decoded with its alpha, downscaled once with a recorded provenance
    lap('request');
    assetPrep = prepareAsset(brief.asset);
    if (assetPrep.error) return blocked(STAGE.ASSET, E2E_BLOCK.REQUEST_INVALID, assetPrep.error, 'PROVIDE_A_PNG_OR_JPEG_PRODUCT_ASSET');
    save(STAGE.ASSET, { sha: assetPrep.provenance.original_sha256 }, assetPrep.provenance); lap('asset');

    // ---- SEGMENTATION (before any billable call)
    const selection = options.selection ?? { mode: 'AUTO' }; const mode = options.source_mode ?? 'AUTO';
    const segInput = { asset: assetPrep.asset.sha256, mode, selection };
    const cached = ctx.checkpoints.reusable(STAGE.SEGMENTATION, sha(segInput)) ? ctx.checkpoints.get(STAGE.SEGMENTATION).payload : null;
    if (cached && cached.state === IS.READY_FOR_COMPOSITE) {
      segmentationEval = { state: cached.state, reasons: [], source_kind: cached.source_kind, stage_evidence: cached.stage_evidence, layered: { ...cached.layered, cutout_png: unb64(cached.layered.cutout_png_b64) }, cutout: { ...cached.cutout, pixels: unb64(cached.cutout.pixels_b64) }, annotations: cached.annotations, resumed: true };
      stages[STAGE.SEGMENTATION] = { status: 'REUSED', payload_sha256: ctx.checkpoints.get(STAGE.SEGMENTATION).payload_sha256 };
    } else {
      const segmentationPort = ports.segmentation ?? null;
      const computed = await segment({ ctx, rgba: assetPrep.rgba, mode, selection, port: segmentationPort });
      segmentationEval = computed;
      if (computed.state !== IS.READY_FOR_COMPOSITE) {
        const code = computed.state;
        stages[STAGE.SEGMENTATION] = { status: 'STOPPED' }; ctx.setFailure({ stage: STAGE.SEGMENTATION, code, reasons: computed.reasons });
        return finish(E2E_STATE.BLOCKED, { block: { stage: STAGE.SEGMENTATION, code, reason: computed.reasons.join(','), replan: code === IS.MATTE_INVALID ? 'SHOOT_THE_PRODUCT_ON_A_PLAIN_GROUND_OR_USE_A_CLEAN_PRE_CUT_ASSET' : 'PROVIDE_A_CLEARER_PRODUCT_IMAGE_OR_AN_EXPLICIT_SELECTION', state: code } });
      }
      segmentationEval.annotations = brief.identity_annotations ?? deriveAnnotations({ alpha: computed.seg.alpha, width: assetPrep.rgba.width, height: assetPrep.rgba.height, bounds: computed.seg.bounds });
      const l = computed.layered; const c = computed.cutout;
      save(STAGE.SEGMENTATION, segInput, {
        state: computed.state, source_kind: computed.source_kind, stage_evidence: computed.stage_evidence, annotations: segmentationEval.annotations,
        layered: { component: l.component, cutout_png_b64: b64(l.cutout_png), cutout_sha256: l.cutout_sha256, width_px: l.width_px, height_px: l.height_px, crop: l.crop, quality: l.quality },
        cutout: { width: c.width, height: c.height, pixels_b64: b64(c.pixels), crop: c.crop, decontaminated_pixels: c.decontaminated_pixels },
      });
    }
    lap('segmentation');
    const briefRun = { ...brief, asset: assetPrep.asset, identity_annotations: segmentationEval.annotations };

    // ---- FORMAT_PLAN + BRAIN_PLAN (campaign planner: content planning, framing, ideation, selection, art direction, asset directing). Every text call is an operation of the run.
    const brain = createCreativeBrain({ complete: ctx.wrapComplete(ports.brainComplete, OPERATION.BRAIN_TEXT), ledger });
    const contentPlanner = createContentFormatPlanner({ ledger, ...(ports.copy ?? {}) });
    const assetDirector = ports.directorComplete ? createAssetDirector({ complete: ctx.wrapComplete(ports.directorComplete, OPERATION.ASSET_DIRECTOR_TEXT) }) : null;
    const planner = createCampaignPlanner({ brain, contentPlanner, assetDirector, ledger, store: campaignStore, ceilingEur: options.planner_ceiling_eur ?? ceiling });
    campaign = await planner.plan({ brief: briefRun, request, options: { single_asset: true } });
    if ((campaign.questions ?? []).some((q) => q.code === 'CAMPAIGN_BUDGET_EXCEEDED')) { ctx.setFailure({ stage: STAGE.FORMAT_PLAN, code: 'BUDGET_EXCEEDED' }); stages[STAGE.FORMAT_PLAN] = { status: 'STOPPED' }; return finish(E2E_STATE.BUDGET_EXCEEDED, { failure: { code: 'BUDGET_EXCEEDED', detail: { source: 'THE_CAMPAIGN_PLANNER_ESTIMATE_EXCEEDS_THE_RUN_CEILING', ceiling_eur: ceiling, questions: campaign.questions } } }); }
    { const stopped = budgetStop(); if (stopped) { stages[STAGE.FORMAT_PLAN] = { status: 'STOPPED' }; return stopped; } }
    if (campaign.status !== 'PLANNED') return blocked(STAGE.FORMAT_PLAN, E2E_BLOCK.PLANNING_NOT_PLANNED, `campaign status ${campaign.status}`, 'ANSWER_THE_QUESTIONS_OR_FIX_THE_REQUEST', { questions: campaign.questions ?? [] });
    // every approved claim ends with a stated disposition; a declared one that the plan does not hold, or an amount written in another form, stops the run before production
    {
      const out = dispositionOfClaims({ brief: briefRun, contentPlans: campaign.content_plans, policy: options.claim_policy ?? {} });
      claimDispositions = out.dispositions;
      ctx.event('CLAIM_DISPOSITIONS', { dispositions: out.dispositions.map((d) => `${d.ref}=${d.disposition}`), blocks: out.blocks.map((b) => b.code) });
      gates.push(gate('CLAIM_DISPOSITION', GATE_STATUS.EXECUTABLE_NOW, out.blocks.length ? 'FAIL' : 'PASS', true, { dispositions: out.dispositions.map((d) => ({ ref: d.ref, disposition: d.disposition, reason: d.reason })), blocks: out.blocks }));
      if (out.blocks.length) return blocked(STAGE.FORMAT_PLAN, E2E_BLOCK[out.blocks[0].code] ?? E2E_BLOCK.CLAIM_NOT_PLACED, out.blocks.map((b) => `${b.code}:${b.ref}`).join(','), 'PUT_THE_APPROVED_WORDING_IN_THE_COPY_OR_CHANGE_THE_DECLARED_DISPOSITION', { blocks: out.blocks });
    }
    save(STAGE.FORMAT_PLAN, { request_ref: request.request_ref, copy: request.copy }, { content_plan_ids: campaign.campaign_plan.content_plan_ids, format: campaign.content_plans?.[0]?.format?.kind ?? null });
    save(STAGE.BRAIN_PLAN, { frame: campaign.campaign_plan.frame_id }, { frame_id: campaign.campaign_plan.frame_id, concept_id: campaign.campaign_plan.concept_id, art_direction_id: campaign.campaign_plan.art_direction_id, asset_plan_ids: campaign.campaign_plan.asset_plan_ids });

    lap('planning_format_and_brain');
    // ---- PRODUCTION_PLAN
    const productionPlanner = createProductionPlanner({ store: campaignStore, font, ledger });
    const planned = await productionPlanner.plan({ campaignResult: campaign, brief: briefRun, request, bytes: assetPrep.asset.bytes });
    if (planned.status !== 'SPECIFIED') return blocked(STAGE.PRODUCTION_PLAN, E2E_BLOCK.PRODUCTION_NOT_SPECIFIED, `production status ${planned.status}`, 'REPLAN_THE_PRODUCTION_FROM_ITS_BLOCKS', { blocks: planned.production?.blocks ?? [] });
    production = planned;
    const scene = production.scenes[options.scene_index ?? 0];
    if (!scene) return blocked(STAGE.PRODUCTION_PLAN, E2E_BLOCK.PRODUCTION_NOT_SPECIFIED, 'NO_SUCH_SCENE', 'CHOOSE_AN_EXISTING_SCENE');
    sceneId = scene.scene_id;
    save(STAGE.PRODUCTION_PLAN, { campaign: campaign.campaign_plan.campaign_id, asset: assetPrep.asset.sha256 }, { production_id: production.production.production_id, scene_id: sceneId, scenes: production.production.scene_ids, budget: production.production.budget });

    lap('production_plan');
    // ---- INTEGRATION: the layered production of the scene; the product is the cut-out of the segmentation stage; the layer port is an operation of the run
    layerBudget = createLayerBudget({ production });
    const unitOf = (request2) => production.production.budget.unit_costs.image_eur_by_size_class[request2.size_class];
    const layerPort = ctx.wrapLayerPort(ports.layers, unitOf);
    const shadowHook = createShadowHook(options.contact_shadow ?? null);
    const placementVerdict = null;
    const agents = { analyst: createProductAssetAnalyst({ ledger, expression: briefRun.brand.expression }) };
    const run = {
      at, brief: briefRun, fonts, agents, ports: { segmenter: precomputedSegmenter(segmentationEval.layered), layers: layerPort }, ledger, guardian, production, scene_id: sceneId, gate: options.gate ?? null,
      policy: shadowHook ? { contact_shadow: shadowHook, product_shadow_effect: false } : {},
    };
    layeredResult = await runLayered({ ...run, store: layerStore, budget: layerBudget });
    if (!layeredResult.png_bytes) { const stopped = budgetStop(); if (stopped) { stages[STAGE.INTEGRATION] = { status: 'STOPPED' }; return stopped; } }
    stages[STAGE.INTEGRATION] = { status: 'RAN', layered_status: layeredResult.status };

    // a run stopped before any image exists
    if (layeredResult.status === 'BLOCKED' && !layeredResult.png_bytes) {
      if (layeredResult.reason === 'BRAND_GUARDIAN_NOT_CONFIGURED') return blocked(STAGE.INTEGRATION, E2E_BLOCK.A_MANDATORY_GATE_DID_NOT_RUN, 'BRAND_GUARDIAN_NOT_CONFIGURED', 'CONFIGURE_THE_BRAND_GUARDIAN');
      return blocked(STAGE.INTEGRATION, E2E_BLOCK.LAYERED_STOP, layeredResult.reason, layeredResult.replan, { detail: layeredResult.detail ?? null });
    }

    save(STAGE.INTEGRATION, { production: production.production.production_id, scene: sceneId, asset: assetPrep.asset.sha256 }, { layered_status: layeredResult.status, png_sha256: layeredResult.png_bytes ? sha(layeredResult.png_bytes) : null, artifact_render_sha256: layeredResult.artifact?.nodes?.render?.png_sha256 ?? null, provider_calls: layeredResult.provider_calls ?? 0 });

    lap('layered_production_and_integration');
    // ---- REFINE: only for a NAMED defect that a layer repair can fix, within policy, budget and capability
    const repairable = new Set(['PREFLIGHT_FAIL', 'FIDELITY_FAIL', 'GUARDIAN_FAIL']);
    const extraDefects = options.refine?.defects ?? [];
    let attempts = 0;
    while ((repairable.has(layeredResult.status) || extraDefects.length) && attempts < (options.refine?.max_attempts ?? 1)) {
      if (!options.refine?.enabled) { refineSummary = { decision: 'DISABLED', named_defects: defectsFromCandidate(layeredResult).length + extraDefects.length }; warnings.push('REFINE_DISABLED_WITH_NAMED_DEFECTS'); break; }
      const defects = [...defectsFromCandidate(layeredResult), ...extraDefects];
      if (!defects.length) { refineSummary = { decision: 'NO_NAMED_DEFECT' }; break; }
      attempts += 1;
      const maskedNeeded = options.refine.scopes ? null : null; void maskedNeeded;
      const r = await refine({ candidate: layeredResult, defects, run, store: layerStore, budget: layerBudget, memory: refineMemory, allowedScopes: options.refine.scopes ?? null, allowUnmeasurableIdentity: true });
      if (r.status !== 'REPAIRED') { const stopped = budgetStop(); if (stopped) { stages[STAGE.REFINE] = { status: 'STOPPED' }; return stopped; } }
      refineSummary = { decision: 'ATTEMPTED', status: r.status, scope: r.plan?.scope ?? null, block: r.block ?? null, provider_calls: r.cost?.provider_calls ?? 0, layer_diff: r.layer_diff ?? null, product_identical: r.product_identical ?? null, locked_copy_identical: r.locked_copy_identical ?? null };
      if (r.status === 'REPAIRED') { layeredResult = r.candidate; layerStore = r.store ?? layerStore; stages[STAGE.REFINE] = { status: 'REPAIRED' }; save(STAGE.REFINE, { before: layeredResult.png_sha256, defects: defects.map((d) => d.defect_id) }, { status: r.status, scope: r.plan?.scope ?? null, changed: r.layer_diff?.changed ?? [], png_sha256: layeredResult.png_sha256 }); continue; }
      stages[STAGE.REFINE] = { status: r.status };
      if (r.block?.code === 'NEEDS_A_MASKED_EDIT_PROVIDER') { ctx.setFailure({ stage: STAGE.REFINE, code: E2E_BLOCK.MASKED_EDIT_NOT_CONNECTED }); return finish(E2E_STATE.PROVIDER_NOT_CONNECTED, { block: { stage: STAGE.REFINE, code: E2E_BLOCK.MASKED_EDIT_NOT_CONNECTED, reason: 'THE_DEFECT_NEEDS_A_MASKED_EDIT_PROVIDER', replan: 'CONNECT_A_MASKED_EDIT_PROVIDER' }, final: layeredResult }); }
      return blocked(STAGE.REFINE, E2E_BLOCK.REFINE_REJECTED, r.block?.code ?? r.status, r.replan ?? r.block?.replan ?? 'REPLAN_THE_SCENE', { refine: refineSummary });
    }
    if (refineSummary.decision === 'NOT_EVALUATED') refineSummary = { decision: 'NOT_NEEDED' };
    if (!layeredResult.png_bytes) return blocked(STAGE.INTEGRATION, E2E_BLOCK.LAYERED_STOP, layeredResult.status, 'REPLAN_THE_SCENE');
    if (layeredResult.status === 'PREFLIGHT_FAIL' || layeredResult.status === 'GUARDIAN_FAIL' || layeredResult.status === 'FIDELITY_FAIL') {
      return blocked(STAGE.INTEGRATION, E2E_BLOCK.A_MANDATORY_GATE_FAILED, layeredResult.status, 'REPAIR_OR_REPLAN', { final: undefined });
    }

    lap('refine');
    // ---- FINAL GATES
    const canvas = { width: layeredResult.width, height: layeredResult.height };
    const cutoutRgba = (() => { const c = decodePng(segmentationEval.layered.cutout_png); return c; })();
    const placement = checkProductPlacement({ result: layeredResult, cutoutSize: { width: cutoutRgba.width, height: cutoutRgba.height }, canvas });
    gates.push(gate('PLACEMENT', GATE_STATUS.EXECUTABLE_NOW, placement.state === IS.READY_FOR_COMPOSITE ? 'PASS' : 'FAIL', true, { reasons: placement.reasons, measurements: placement.measurements }));
    const plateKey = layeredResult.artifact.nodes.plate.request_key; const plateSha = layeredResult.artifact.nodes.plate.candidate_sha256;
    const plateCandidate = layerStore.candidates(plateKey).find((c) => sha(c.bytes) === plateSha);
    const excluded = [
      ...(layeredResult.artifact.nodes.text ?? []).map((t) => t.geometry),
      ...(layeredResult.artifact.nodes.props ?? []).filter((p) => p.kind === 'PROP_FOREGROUND').map((p) => p.box),
    ];
    integrationChecks = checkDelivered({ result: layeredResult, plateBytes: plateCandidate?.bytes ?? null, cutout: cutoutRgba, cutoutPng: segmentationEval.layered.cutout_png, shadowHook, excludedRects: excluded, productShadowEffect: !shadowHook });
    gates.push(gate('PRODUCT_DELIVERED_IDENTITY', GATE_STATUS.EXECUTABLE_NOW, integrationChecks.identity.valid ? 'PASS' : 'FAIL', true, { checks: integrationChecks.identity.findings.map((f) => `${f.code}:${f.ok ? 'PASS' : 'FAIL'}:${typeof f.value === 'number' ? +f.value.toFixed(4) : f.value}`) }));
    gates.push(gate('PRODUCT_PIXELS_IN_THE_COMPOSITOR', GATE_STATUS.EXECUTABLE_NOW, layeredResult.composition.product_pixels_changed === 0 && layeredResult.composition.product_pixels_checked > 0 ? 'PASS' : 'FAIL', true, { checked: layeredResult.composition.product_pixels_checked, changed: layeredResult.composition.product_pixels_changed }));
    gates.push(gate('COPY_INTEGRITY', GATE_STATUS.EXECUTABLE_NOW, layeredResult.text.every((t) => t.exact) ? 'PASS' : 'FAIL', true, { roles: layeredResult.text.map((t) => `${t.role}:${t.exact}`) }));
    gates.push(gate('LAYOUT_TEXT_PREFLIGHT', GATE_STATUS.EXECUTABLE_NOW, layeredResult.preflight.status === 'PASS' ? 'PASS' : 'FAIL', true, { status: layeredResult.preflight.status }));
    gates.push(integrationChecks.artifacts
      ? gate('INTEGRATION_ARTIFACTS', GATE_STATUS.EXECUTABLE_NOW, integrationChecks.artifacts.clean ? 'PASS' : 'FAIL', true, { failed: integrationChecks.artifacts.findings.filter((f) => !f.ok).map((f) => f.code) })
      : gate('INTEGRATION_ARTIFACTS', GATE_STATUS.EXECUTABLE_NOW, 'NOT_RUN', true, { reason: 'THE_PLATE_WAS_NOT_FOUND_IN_THE_LAYER_STORE' }));
    const fid = layeredResult.fidelity?.gate;
    gates.push(gate('PRODUCT_IDENTITY_CASE_GATE', GATE_STATUS.EXECUTABLE_NOW, fid === 'PASS' ? 'PASS' : fid === 'FAIL' ? 'FAIL' : 'NOT_APPLICABLE', false, { gate: fid ?? null, note: 'defined for printed phone cases (camera module, lenses, artwork): a product without such annotations is judged by PRODUCT_DELIVERED_IDENTITY' }));
    gates.push(gate('BRAND_GUARDIAN', guardian ? GATE_STATUS.EXECUTABLE_NOW : GATE_STATUS.EXECUTABLE_NOW, layeredResult.guardian ? (layeredResult.guardian.outcome === 'PASS' ? 'PASS' : 'FAIL') : 'NOT_RUN', true, { outcome: layeredResult.guardian?.outcome ?? null }));
    // the vision critic: provider-required
    if (ports.critic) {
      const op = ctx.operations.begin({ kind: OPERATION.VISION_CRITIC, key: `CRITIC:${sha(layeredResult.png_bytes)}`, estimate_eur: 0.01, executor: 'PROVIDER', basis: [sceneId] });
      let verdict;
      if (op.reused) verdict = op.result; else { try { verdict = await ports.critic.critique({ png_bytes: layeredResult.png_bytes, scene_id: sceneId }); op.complete({ result: verdict }); } catch (e) { op.fail(e?.message); throw e; } }
      gates.push(gate('VISION_CRITIC', GATE_STATUS.PROVIDER_REQUIRED, verdict?.outcome === 'PASS' ? 'PASS' : 'FAIL', Boolean(options.require_critic), { outcome: verdict?.outcome ?? null }));
    } else gates.push(gate('VISION_CRITIC', GATE_STATUS.PROVIDER_REQUIRED, 'SKIPPED_PROVIDER_NOT_CONNECTED', Boolean(options.require_critic), {}));

    const failed = gates.filter((g) => g.mandatory && g.outcome === 'FAIL');
    const notRun = gates.filter((g) => g.mandatory && ['NOT_RUN', 'SKIPPED_PROVIDER_NOT_CONNECTED'].includes(g.outcome));
    lap('final_gates');
    save(STAGE.FINAL_GATES, { png: sha(layeredResult.png_bytes) }, { gates: gates.map((g) => `${g.id}=${g.outcome}`) });
    if (notRun.length) { ctx.setFailure({ stage: STAGE.FINAL_GATES, code: E2E_BLOCK.A_MANDATORY_GATE_DID_NOT_RUN, gates: notRun.map((g) => g.id) }); return finish(E2E_STATE.BLOCKED, { block: { stage: STAGE.FINAL_GATES, code: E2E_BLOCK.A_MANDATORY_GATE_DID_NOT_RUN, reason: notRun.map((g) => g.id).join(','), replan: 'RUN_OR_CONNECT_THE_MISSING_GATE' }, final: layeredResult }); }
    if (failed.length) {
      const stateOf = failed.some((g) => g.id === 'PRODUCT_DELIVERED_IDENTITY') ? IS.PRODUCT_IDENTITY_RISK : failed.some((g) => g.id === 'PLACEMENT') ? IS.PLACEMENT_INVALID : failed.some((g) => g.id === 'INTEGRATION_ARTIFACTS') ? IS.INTEGRATION_ARTIFACT : E2E_BLOCK.A_MANDATORY_GATE_FAILED;
      ctx.setFailure({ stage: STAGE.FINAL_GATES, code: stateOf, gates: failed.map((g) => g.id) });
      return finish(E2E_STATE.BLOCKED, { block: { stage: STAGE.FINAL_GATES, code: stateOf, state: stateOf, reason: failed.map((g) => g.id).join(','), replan: 'REPAIR_OR_REPLAN_THE_SCENE' }, final: layeredResult });
    }
    for (const g of gates) if (g.outcome === 'NOT_APPLICABLE') warnings.push(`${g.id}_NOT_APPLICABLE`);
    for (const d of claimDispositions ?? []) if (d.disposition === 'NOT_USED' && d.declared !== 'NOT_USED') warnings.push(`CLAIM_NOT_USED:${d.ref}`);
    for (const g of gates) if (!g.mandatory && g.outcome === 'SKIPPED_PROVIDER_NOT_CONNECTED') warnings.push(`${g.id}_SKIPPED_PROVIDER_NOT_CONNECTED`);
    if (segmentationEval.annotations?.derived_from) warnings.push('IDENTITY_ANNOTATIONS_DERIVED_FROM_THE_MATTE');
    return finish(warnings.length ? E2E_STATE.NEEDS_OWNER_REVIEW : E2E_STATE.READY, { final: layeredResult });
  } catch (error) {
    if (error instanceof RunBudgetError) { ctx.setFailure({ stage: 'BUDGET', code: 'BUDGET_EXCEEDED', detail: error.detail }); return finish(E2E_STATE.BUDGET_EXCEEDED, { failure: { code: 'BUDGET_EXCEEDED', detail: error.detail } }); }
    { const stopped = budgetStop(); if (stopped) return stopped; } // a port that wrapped the refusal into its own error (the Brain's BRAIN_PORT_FAILED, a layer provider failure) is not a provider failure
    if (error?.code === 'SHADOW_INVALID') { ctx.setFailure({ stage: STAGE.INTEGRATION, code: IS.SHADOW_INVALID }); return finish(E2E_STATE.BLOCKED, { block: { stage: STAGE.INTEGRATION, code: IS.SHADOW_INVALID, state: IS.SHADOW_INVALID, reason: (error.reasons ?? []).join(','), replan: 'FIX_THE_DECLARED_LIGHT_OR_KIND' } }); }
    ctx.setFailure({ stage: 'EXCEPTION', code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 200) });
    if (error instanceof RunInvariantError) return finish(E2E_STATE.TECHNICAL_FAIL, { failure: { code: error.code, detail: error.detail } });
    return finish(E2E_STATE.TECHNICAL_FAIL, { failure: { code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 200) } });
  }
}
