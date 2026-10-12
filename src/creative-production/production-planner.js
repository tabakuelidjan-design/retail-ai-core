import { createHash } from 'node:crypto';

import { normalizeRequest } from '../creative-planning/index.js';
import { claimWordsOf } from '../creative-planning/copy-policy.js';
import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import { emptyState, inputsHash, putNode, reusable } from '../creative-campaign/state.js';
import { COMPONENT, DECISION } from '../creative-runtime/ledger.js';
import {
  BLOCK, PRODUCTION_NODE as NODE, PRODUCTION_POLICY, PRODUCTION_STATUS, PRODUCTION_UNIT_COSTS, SCHEMA,
} from './constants.js';
import { checkTextFeasibility, recoverLockedCopy } from './copy-integrity.js';
import { detectSubstitutes, resolveProductIdentity } from './product-identity.js';
import { estimateProduction, reserveProduction } from './production-cost.js';
import {
  buildSceneSpec, plateRequest, propRequest, propsForAsset, validateSceneSpec,
} from './scene-spec.js';
import { FORMAT_RESOURCES, callerResource } from '../creative-planning/index.js';

// THE PRODUCTION PLANNER. From a planned campaign (its content plans, its shared concept and art direction, its asset plans) it specifies the layered scene of every asset: the product identity first, then the
// shared plates and props, then one scene per asset. Everything is deterministic and content-addressed; every node is stored with the hash of its inputs, so a resumed run reproduces a clean run exactly and a
// changed input recomputes only what depends on it.
//
// What it never does: call a provider, draw a pixel, change a word, lower a quality setting to fit a budget, or fill a gap with a plausible replacement. A scene that cannot honestly be specified is BLOCKED or
// INTENT_ONLY, with the reason.
//
//   PRODUCT_IDENTITY ─┬─► SCENE_PLATE:<key> ─┐
//                     ├─► SCENE_PROP:<key>  ─┼─► SCENE:<lane>:<index>
//   ART_DIRECTION ────┘   (asset plan) ──────┘

const record = (ledger, decision, component, rule, outcome) => ledger?.record({ decision, decided_by: component, rule, basis: [], outcome });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const resourceOf = (asset) => FORMAT_RESOURCES.find((r) => r.format_ref === asset.format_resource_ref)
  ?? callerResource({ format_ref: asset.format_resource_ref, canvas: asset.canvas, medium: asset.medium ?? 'DIGITAL', aspect_ratio: asset.aspect_ratio });

/** How plates are shared: by the crop scale of the asset (reuse level 0), crops merged into the middle view (1), one plate for everything (2). */
const VARIANT_OF = Object.freeze([(crop) => crop, (crop) => (crop === 'CLOSE' ? 'MID' : crop), () => 'ALL']);
const REUSE_LEVELS = VARIANT_OF.length;

/** @param {object} deps { store, ledger?, font?, unitCosts?, policy? } */
export function createProductionPlanner({
  store, ledger = null, font = null, unitCosts = PRODUCTION_UNIT_COSTS, policy = PRODUCTION_POLICY,
}) {
  async function plan({
    campaignResult, brief, request: rawRequest, bytes = null,
  }) {
    if (!campaignResult?.campaign_plan) return deepFreeze({ status: 'NOT_A_CAMPAIGN', reason: campaignResult?.status ?? 'NO_CAMPAIGN_PLAN' });
    // a campaign that still needs a decision of the owner is not produced
    if (campaignResult.status !== 'PLANNED') return deepFreeze({ status: 'CAMPAIGN_NOT_PLANNED', reason: campaignResult.status });
    const request = normalizeRequest(rawRequest);
    const state = (await store?.load()) ?? emptyState(request.request_ref);
    const executed = []; const reused = [];
    const checkpoint = async (label) => { state.saves += 1; await store?.save(state); record(ledger, DECISION.CAMPAIGN_CHECKPOINT, COMPONENT.PRODUCTION_PLANNER, 'EVERY_NODE_IS_STORED_WITH_THE_HASH_OF_ITS_INPUTS', { node: label, saves: state.saves }); };
    const useNode = (label, hash) => { const node = state.nodes[label]; if (reusable(node, hash)) { reused.push(label); return node; } return null; };
    const { campaign_plan: campaign, shared, asset_plans: assetPlans, content_plans: contentPlans } = campaignResult;
    const art = shared.art_direction;

    // ---- PRODUCT_IDENTITY
    const identityHash = inputsHash({
      node: NODE.PRODUCT_IDENTITY, product_ref: brief?.ids?.product_ref ?? null, asset_ref: brief?.asset?.ref ?? null, sha256: brief?.asset?.sha256 ?? null, description: brief?.public_facts?.product ?? null, outline: Boolean(brief?.identity_annotations?.outline), bytes: bytes ? sha(bytes) : null, campaign_product_ref: campaign.product_ref ?? null,
    });
    let identityNode = useNode(NODE.PRODUCT_IDENTITY, identityHash);
    if (!identityNode) {
      const identity = resolveProductIdentity({ brief, bytes, campaignProductRef: campaignResult.product_ref ?? null });
      identityNode = putNode(state, NODE.PRODUCT_IDENTITY, { inputsHash: identityHash, id: identity.identity_id, artifact: identity });
      executed.push(NODE.PRODUCT_IDENTITY); await checkpoint(NODE.PRODUCT_IDENTITY);
      record(ledger, DECISION.PRODUCT_IDENTITY, COMPONENT.PRODUCT_IDENTITY_GUARD, 'THE_PRODUCT_IS_A_PINNED_ASSET_OR_THE_PRODUCTION_IS_BLOCKED', { identity_id: identity.identity_id, status: identity.status, reasons: identity.reasons });
    }
    const identity = identityNode.artifact;

    // ---- the words of the campaign that are allowed to make a claim: the approved copy and the verified facts
    const approvedWords = new Set(claimWordsOf([...request.copy.map((c) => c.text ?? ''), ...request.facts.filter((f) => f.status === 'VERIFIED' || f.status === 'APPROVED_CLAIM').map((f) => f.statement)].join(' ')));

    // ---- the art direction must hold nothing that could stand in for the product (checked against THIS product)
    const elements = [...art.narrative_elements.map((e) => ({ element: e.element, zone: e.zone, reason: e.reason })), ...art.permitted_secondary_elements.map((e) => ({ element: e, zone: 'MIDGROUND', reason: null }))];
    const rejected = elements.map((e) => ({ ...e, hits: detectSubstitutes({ text: e.element, identity }) })).filter((e) => e.hits.length);
    const globalBlocks = [];
    if (rejected.length) globalBlocks.push({ code: BLOCK.ART_DIRECTION_HOLDS_A_SUBSTITUTE, detail: { elements: rejected.map((e) => ({ element: e.element, hits: e.hits })) } });
    const propPool = art.narrative_elements.map((e) => ({ element: e.element, zone: e.zone }));

    // ---- the assets of the campaign, each with its content asset
    const assets = assetPlans.map((ap) => {
      const laneIndex = Number(ap.lane_id.slice(1));
      const contentAsset = contentPlans[laneIndex].assets[ap.index];
      return { ap, laneIndex, contentAsset, resource: resourceOf(contentAsset) };
    });

    // ---- text feasibility and recoverability: the copy is never changed to fit; a composition that cannot carry it is a block
    const feasibility = assets.map((a) => checkTextFeasibility({ slots: a.contentAsset.slots, density: a.ap.density.density_class, resource: a.resource, font, locale: request.locale }));
    const sources = new Map([...request.copy.filter((c) => c.text).map((c) => [c.copy_ref, c.text]), ...request.sources.filter((s) => s.text).map((s) => [s.ref, s.text])]);

    // ---- the shared layers and the reuse level: reuse first, never a lower quality; a budget that cannot hold the layers blocks
    let level = 0; let layered = null; let reservation = null; let estimate = null;
    const chain = { request_ref: request.request_ref, campaign_id: campaign.campaign_id, art_direction_id: art.art_direction_id, concept_id: shared.concept.concept_id, frame_id: shared.problem_frame.frame_id };
    // a scene that cannot be specified gets no generated layer: nothing is requested, and nothing is paid for, on behalf of a scene that will not be made
    const unspecifiable = (i) => identity.status !== 'VERIFIED' || globalBlocks.length > 0 || !feasibility[i].fits;
    const buildLayers = (lvl) => {
      const plates = new Map(); const props = new Map(); const perAsset = [];
      for (const [i, a] of assets.entries()) {
        if (unspecifiable(i)) { perAsset.push({ plate: null, props: [] }); continue; }
        const variant = VARIANT_OF[lvl](a.ap.crop_scale);
        const p = plateRequest({
          artDirection: art, canvas: a.contentAsset.canvas, variant, identity, approvedWords, policy,
        });
        plates.set(p.request.request_key, p);
        const chosen = propsForAsset({
          elements: propPool, composition: a.ap.composition_intent, index: a.ap.index, maxProps: policy.max_props_per_asset,
        }).map((e) => propRequest({
          element: e, artDirection: art, identity, approvedWords, policy,
        }));
        for (const c of chosen) props.set(c.request.request_key, c);
        perAsset.push({ plate: p, props: chosen });
      }
      return { plates, props, perAsset };
    };
    for (level = 0; level < REUSE_LEVELS; level += 1) {
      layered = buildLayers(level);
      const layerList = [...layered.plates.values(), ...layered.props.values()].map((x) => x.request);
      estimate = estimateProduction({ sharedStagesEur: campaign.budget.shared_eur, assets: assets.length, layers: layerList, unitCosts, policy });
      reservation = reserveProduction({ estimate, ceilingEur: campaign.budget.ceiling_eur });
      if (reservation.ok) break;
    }
    if (!reservation.ok) level = REUSE_LEVELS - 1;
    const productionBlocks = [...globalBlocks];
    if (!reservation.ok) productionBlocks.push({ code: BLOCK.PRODUCTION_BLOCKED_BY_BUDGET, detail: { ceiling_eur: campaign.budget.ceiling_eur, estimated_eur: estimate.total_eur, reuse_level_tried: REUSE_LEVELS, error: reservation.error } });
    record(ledger, DECISION.PRODUCTION_BUDGET, COMPONENT.PRODUCTION_PLANNER, 'REUSE_BEFORE_ANYTHING_AND_NEVER_A_LOWER_QUALITY', { within_ceiling: reservation.ok, reuse_level: level, estimated_eur: estimate.total_eur, ceiling_eur: campaign.budget.ceiling_eur });

    // ---- the shared layer nodes
    const sharedLayers = new Map();
    for (const group of [layered.plates, layered.props]) {
      for (const { request: r, checked } of group.values()) {
        const kindNode = r.kind === 'PLATE' ? NODE.PLATE : NODE.PROP;
        const label = `${kindNode}:${r.request_key}`;
        const hash = inputsHash({
          node: kindNode, prompt_sha256: r.prompt_sha256, candidates: r.candidates, size: r.size, identity_id: identity.identity_id, art_direction_id: art.art_direction_id,
        });
        let node = useNode(label, hash);
        if (!node) { node = putNode(state, label, { inputsHash: hash, id: r.request_key, artifact: { ...r, guard: { substitutes: checked.hits, claims: checked.claims, digits: checked.digits } } }); executed.push(label); await checkpoint(label); }
        sharedLayers.set(r.request_key, node.artifact);
      }
    }
    const layerBlocks = [];
    for (const r of sharedLayers.values()) {
      if (r.guard.substitutes.length) layerBlocks.push({ code: BLOCK.ART_DIRECTION_HOLDS_A_SUBSTITUTE, detail: { request_key: r.request_key, hits: r.guard.substitutes } });
      if (r.guard.claims.length || r.guard.digits) layerBlocks.push({ code: BLOCK.UNSUPPORTED_CLAIM_IN_A_LAYER, detail: { request_key: r.request_key, claims: r.guard.claims, digits: r.guard.digits } });
    }
    productionBlocks.push(...layerBlocks);

    // ---- one scene per asset
    const scenes = [];
    for (const [i, a] of assets.entries()) {
      const label = `${NODE.SCENE}:${a.ap.lane_id}:${a.ap.index}`;
      const mine = layered.perAsset[i];
      const blocks = productionBlocks.map((b) => ({ ...b }));
      const hash = inputsHash({
        node: NODE.SCENE, asset_plan_id: a.ap.asset_plan_id, plate: mine.plate?.request.request_key ?? null, props: mine.props.map((p) => p.request.request_key), identity_id: identity.identity_id, feasibility: [feasibility[i].fits, feasibility[i].reasons], blocks: blocks.map((b) => b.code),
        copy: a.contentAsset.slots.map((slot) => [slot.role, sha(slot.text), slot.pieces.map((p) => [p.piece_id, p.origin, p.start, p.end, sha(p.text)])]),
      });
      let node = useNode(label, hash);
      if (!node) {
        const scene = buildSceneSpec({
          chain: { ...chain, content_plan_id: contentPlans[a.laneIndex].content_plan_id, lane_id: a.ap.lane_id }, assetPlan: a.ap, contentAsset: a.contentAsset, identity, plate: mine.plate?.request ?? null, props: mine.props, resource: a.resource, feasibility: feasibility[i], blocks,
        });
        node = putNode(state, label, { inputsHash: hash, id: scene.scene_id, artifact: scene });
        executed.push(label); await checkpoint(label);
        record(ledger, DECISION.PRODUCTION_SPEC, COMPONENT.PRODUCTION_PLANNER, 'A_SCENE_IS_SPECIFIED_OR_EXPLICITLY_BLOCKED', { scene_id: scene.scene_id, status: scene.status, blocks: scene.blocks.map((b) => b.code), layers: scene.layers.length });
      }
      scenes.push(node.artifact);
    }

    // ---- the checks that hold for the whole production
    const approved = approvedWords;
    const sceneProblems = scenes.flatMap((s, i) => validateSceneSpec(s, { identity, sharedLayers, approvedWords: approved, contentAsset: assets[i].contentAsset }).map((rule) => ({ scene_id: s.scene_id, rule })));
    const textLayers = scenes.flatMap((s) => s.text_layers);
    const captionPieces = contentPlans.flatMap((p) => p.caption?.pieces ?? []);
    const copy = recoverLockedCopy({ layers: textLayers, captionPieces, sources });
    const extra = [];
    if (sceneProblems.length) extra.push({ code: BLOCK.PROVENANCE_BROKEN, detail: { problems: sceneProblems } });
    if (!copy.ok) extra.push({ code: BLOCK.LOCKED_COPY_NOT_RECOVERABLE, detail: { problems: copy.problems } });
    const blocks = [...productionBlocks, ...extra, ...scenes.flatMap((s) => s.blocks).filter((b) => !productionBlocks.some((p) => p.code === b.code))];
    const uniqueBlocks = blocks.filter((b, i) => blocks.findIndex((x) => x.code === b.code && JSON.stringify(x.detail) === JSON.stringify(b.detail)) === i);
    const status = uniqueBlocks.length === 0 ? PRODUCTION_STATUS.SPECIFIED : (identity.status !== 'VERIFIED' ? PRODUCTION_STATUS.INTENT_ONLY : PRODUCTION_STATUS.BLOCKED);
    const body = {
      schema: SCHEMA.production,
      campaign_id: campaign.campaign_id,
      request_ref: request.request_ref,
      status,
      blocks: uniqueBlocks,
      product_identity_id: identity.identity_id,
      shared_layers: [...sharedLayers.values()].map(({ guard: _g, ...r }) => r),
      scene_ids: scenes.map((s) => s.scene_id),
      budget: {
        ceiling_eur: campaign.budget.ceiling_eur, estimated_worst_case_eur: estimate.total_eur, within_ceiling: reservation.ok, reuse_level: level, candidates_per_generated_layer: policy.candidates_per_generated_layer, generated_layers: sharedLayers.size, rows: reservation.rows, unit_costs: unitCosts,
      },
      copy_integrity: { recoverable: copy.ok, problems: copy.problems, pieces_checked: textLayers.reduce((n, l) => n + l.pieces.length, 0) + captionPieces.length },
    };
    const production = deepFreeze({ production_id: deriveId('prd', body), ...body });
    return deepFreeze({
      status, production, scenes, product_identity: identity, shared_layers: [...sharedLayers.values()], executed, reused, saves: state.saves, state: structuredClone(state),
    });
  }
  return Object.freeze({ plan });
}
