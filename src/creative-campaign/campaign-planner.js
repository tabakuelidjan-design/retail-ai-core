import { safeCause } from '../creative-brain/model-port.js';
import { observeBrief } from '../creative-brain/problem-frame.js';
import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import {
  callerResource, EXECUTION, EXECUTION_REASON, FACT_KIND, FORMAT_KIND, FORMAT_RESOURCES, MULTI_ASSET_KINDS, normalizeRequest, PLAN_STATUS, USABLE_FACT_STATUS,
} from '../creative-planning/index.js';
import { COMPONENT, DECISION } from '../creative-runtime/ledger.js';
import {
  chooseProductionEnvelope, createCampaignBudget, reserveEstimate,
} from './budget.js';
import { buildContinuityContract, auditDiversity } from './continuity.js';
import {
  BRIEF_SOURCE, CAMPAIGN_QUESTION, CAMPAIGN_STATUS, DEFAULT_UNIT_COSTS, DEPENDS_ON, DEV_CAMPAIGN_CEILING_EUR, NODE, SCHEMA,
} from './constants.js';
import { assetChars, classifyDensity } from './density.js';
import { deriveObjectiveKind, planSequence } from './sequence.js';
import {
  emptyState, inputsHash, putNode, reusable,
} from './state.js';

// THE CAMPAIGN PLANNER. One user objective becomes one content plan per lane (a lane is one channel and one format), ONE shared frame, ONE shared concept, ONE shared art direction, and then one individually
// purposeful AssetPlan per asset, tied together by a continuity contract and checked by a diversity report. Everything is a node of a working state that is stored after each step: a campaign can stop at any
// node and resume, and a changed input recomputes exactly the nodes that depend on it.
//
//   request ─► CONTENT_PLAN ─► FRAME ─► CONCEPT ─► ART_DIRECTION ─► CAMPAIGN_PLAN (sequence, continuity, diversity, budget) ─► ASSET_PLAN × N
//
// Production stays PLANNED_NOT_EXECUTABLE (multi-asset production is a later phase). No provider is called here: the models behind the ports are the Creative Brain's and the asset director's.

const SEQUENCE_KINDS = new Set(MULTI_ASSET_KINDS);
const record = (ledger, decision, component, rule, outcome) => ledger?.record({ decision, decided_by: component, rule, basis: [], outcome });

function resourceOfAsset(asset) {
  return FORMAT_RESOURCES.find((r) => r.format_ref === asset.format_resource_ref)
    ?? callerResource({ format_ref: asset.format_resource_ref, canvas: asset.canvas, medium: asset.medium, aspect_ratio: asset.aspect_ratio });
}

/** The brief of a campaign for the shared stages: the original brief, with the canvas of the first asset, the roles of the text that is placed, and the audience and objective of the request when it states them. */
function campaignBriefOf({ brief, request, lanes }) {
  const lane = lanes.find((l) => l.plan.assets.length) ?? lanes[0];
  const first = lane.plan.assets[0];
  const roles = [...new Set(lane.plan.assets.flatMap((a) => a.slots.map((s) => s.role)))];
  const known = (v) => (v && v !== 'UNKNOWN' ? v : undefined);
  return {
    ...brief,
    format: first ? {
      ...brief.format, ref: first.format_resource_ref, canvas: { ...first.canvas }, aspect_ratio: first.aspect_ratio, medium: first.medium,
    } : brief.format,
    // stable references: the frame depends on which roles are said, not on the words
    approved_copy: roles.map((role) => ({ ref: `copy://campaign/${role}`, role, content: role })),
    claims: brief.claims ?? [],
    public_facts: { ...brief.public_facts, ...(known(request.audience) ? { audience: request.audience } : {}), ...(known(request.objective) ? { objective: request.objective } : {}) },
  };
}

/** @param {object} deps { brain, contentPlanner, assetDirector?, ledger?, store?, unitCosts?, ceilingEur? } */
export function createCampaignPlanner({
  brain, contentPlanner, assetDirector = null, ledger = null, store = null, unitCosts = DEFAULT_UNIT_COSTS, ceilingEur = DEV_CAMPAIGN_CEILING_EUR,
}) {
  async function chooseLane(prepared, laneOptions, request) {
    // the smallest text density that holds all the text on the assets; a stated density is kept as stated. When the format was not requested, a heavier density can turn a single image with a caption into a
    // sequence, so every class is tried (a requested single-asset format that fits gives the same plan in every class).
    const classes = request.slide_density ? [request.slide_density] : ['MEDIUM', 'HIGH', 'TEXT_LED'];
    const tried = [];
    for (const slideDensity of classes) {
      const plan = await contentPlanner.planPrepared(prepared, { ...laneOptions, slideDensity, quiet: true });
      const candidate = { plan, slideDensity };
      tried.push(candidate);
      if (plan.status !== PLAN_STATUS.PLANNED) break;
      const sequence = SEQUENCE_KINDS.has(plan.format?.kind);
      if (sequence && plan.caption === null && (request.requested_asset_count ? plan.assets.length === request.requested_asset_count : true)) break;
    }
    const sequences = tried.filter((t) => t.plan.status === PLAN_STATUS.PLANNED && SEQUENCE_KINDS.has(t.plan.format?.kind));
    const exact = sequences.find((t) => t.plan.caption === null && (request.requested_asset_count ? t.plan.assets.length === request.requested_asset_count : true));
    const chosen = exact ?? sequences.at(-1) ?? tried[0];
    contentPlanner.recordPlan(chosen.plan);
    return chosen;
  }

  async function buildLanes(prepared, request) {
    const campaign = request.channels.length > 1 || request.requested_format === FORMAT_KIND.MULTI_ASSET_CAMPAIGN;
    const specs = campaign ? (request.channels.length ? request.channels : [null]).map((channel) => ({ channel, options: { channels: channel ? [channel] : [], requested: null } })) : [{ channel: request.channels[0] ?? null, options: {} }];
    const lanes = [];
    for (const [i, spec] of specs.entries()) {
      const { plan, slideDensity } = await chooseLane(prepared, spec.options, request);
      lanes.push({
        lane_id: `L${i}`, channel: spec.channel, slide_density: SEQUENCE_KINDS.has(plan.format?.kind) ? slideDensity : null, plan,
      });
    }
    return { lanes, campaign };
  }

  async function plan({ brief, request: rawRequest, options = {} }) {
    const request = normalizeRequest(rawRequest);
    const state = (await store?.load()) ?? emptyState(request.request_ref);
    const executed = []; const reused = [];
    const checkpoint = async (label) => {
      state.saves += 1;
      await store?.save(state);
      record(ledger, DECISION.CAMPAIGN_CHECKPOINT, COMPONENT.CAMPAIGN_PLANNER, 'EVERY_NODE_IS_STORED_WITH_THE_HASH_OF_ITS_INPUTS', { node: label, saves: state.saves });
    };
    const useNode = (label, hash) => { const node = state.nodes[label]; if (reusable(node, hash)) { reused.push(label); return node; } return null; };

    // ---- CONTENT_PLAN
    const contentHash = inputsHash({ node: NODE.CONTENT_PLAN, request });
    let contentNode = useNode(NODE.CONTENT_PLAN, contentHash);
    if (!contentNode) {
      const prepared = await contentPlanner.prepare(rawRequest);
      const built = await buildLanes(prepared, request);
      contentNode = putNode(state, NODE.CONTENT_PLAN, {
        inputsHash: contentHash, id: deriveId('cps', built.lanes.map((l) => l.plan.content_plan_id)), artifact: { campaign: built.campaign, lanes: built.lanes },
      });
      executed.push(NODE.CONTENT_PLAN); await checkpoint(NODE.CONTENT_PLAN);
    }
    const { campaign: isCampaignRequest, lanes } = contentNode.artifact;
    const questions = [];
    const result = (status, extra = {}) => deepFreeze({
      status, executed, reused, saves: state.saves, content_plans: lanes.map((l) => l.plan), questions, ...extra,
    });
    for (const l of lanes) questions.push(...l.plan.questions.filter((q) => q.blocking));
    if (lanes.some((l) => l.plan.status === PLAN_STATUS.NEEDS_USER_DECISION)) return result(CAMPAIGN_STATUS.NEEDS_USER_DECISION);
    // a single image is a campaign of ONE asset only when the caller says so (the end-to-end run does): the default contract (NOT_A_MULTI_ASSET_PLAN) is unchanged
    const singleAsset = options.single_asset === true && lanes.length === 1 && lanes[0].plan.format.kind === FORMAT_KIND.SINGLE_IMAGE && lanes[0].plan.assets.length === 1;
    if (!isCampaignRequest && !SEQUENCE_KINDS.has(lanes[0].plan.format.kind) && !singleAsset) return result(CAMPAIGN_STATUS.NOT_A_MULTI_ASSET_PLAN);

    // ---- the shared stages: ONE frame, ONE concept, ONE art direction
    const cb = campaignBriefOf({ brief, request, lanes });
    const observation = observeBrief({ brief: cb });
    const frameHash = inputsHash({ node: NODE.FRAME, observation });
    let frameNode = useNode(NODE.FRAME, frameHash);
    if (!frameNode) {
      const framed = await brain.planFrame({ brief: cb });
      if (framed.status !== 'FRAMED') {
        questions.push(...(framed.assessment?.issues ?? []).map((i) => ({
          code: framed.status === 'USER_CONTRADICTION' ? CAMPAIGN_QUESTION.BRIEF_CONTRADICTORY : CAMPAIGN_QUESTION.BRIEF_NEEDS_CLARIFICATION, blocking: true, field: i.field, question: i.question, options: [],
        })));
        return result(CAMPAIGN_STATUS.NEEDS_USER_DECISION, { assessment: framed.assessment });
      }
      frameNode = putNode(state, NODE.FRAME, { inputsHash: frameHash, id: framed.problem_frame.frame_id, artifact: framed.problem_frame });
      executed.push(NODE.FRAME); await checkpoint(NODE.FRAME);
    }
    const frame = frameNode.artifact;
    const conceptHash = inputsHash({ node: NODE.CONCEPT, frame_inputs: frameNode.inputs_hash, frame_id: frame.frame_id });
    let conceptNode = useNode(NODE.CONCEPT, conceptHash);
    if (!conceptNode) {
      const picked = await brain.selectConcept({ frame });
      if (picked.status !== 'SELECTED') return result(CAMPAIGN_STATUS.NO_CONCEPT_SELECTED, { rounds: picked.rounds });
      conceptNode = putNode(state, NODE.CONCEPT, { inputsHash: conceptHash, id: picked.concept.concept_id, artifact: picked.concept });
      executed.push(NODE.CONCEPT); await checkpoint(NODE.CONCEPT);
    }
    const concept = conceptNode.artifact;
    const artHash = inputsHash({ node: NODE.ART_DIRECTION, concept_inputs: conceptNode.inputs_hash, concept_id: concept.concept_id });
    let artNode = useNode(NODE.ART_DIRECTION, artHash);
    if (!artNode) {
      const directed = await brain.directArt({ frame, concept });
      artNode = putNode(state, NODE.ART_DIRECTION, { inputsHash: artHash, id: directed.art_direction.art_direction_id, artifact: directed.art_direction });
      executed.push(NODE.ART_DIRECTION); await checkpoint(NODE.ART_DIRECTION);
    }
    const artDirection = artNode.artifact;

    // ---- CAMPAIGN_PLAN: sequence, continuity, diversity (deterministic, always recomputed: it costs nothing and depends on everything above)
    const usableFacts = request.facts.filter((f) => USABLE_FACT_STATUS.includes(f.status));
    const proofFactRefs = usableFacts.filter((f) => f.kind === FACT_KIND.PRODUCT_CLAIM).map((f) => f.fact_ref);
    const copyRefs = [...new Set(lanes.flatMap((l) => l.plan.assets.flatMap((a) => a.slots.flatMap((s) => s.pieces.map((p) => p.unit_ref)))))].sort();
    const continuity = buildContinuityContract({
      frame, concept, artDirection, brief: cb, factRefs: usableFacts.map((f) => f.fact_ref), copyRefs,
    });
    record(ledger, DECISION.CONTINUITY_CONTRACT, COMPONENT.CAMPAIGN_PLANNER, 'WHAT_STAYS_CONSISTENT_AND_WHAT_VARIES', { continuity_id: continuity.continuity_id });
    const hints = new Map((options.asset_hints ?? []).map((h) => [`${h.lane ?? 0}:${h.index}`, h]));
    const sharedInputs = { art_inputs: artNode.inputs_hash, art_id: artDirection.art_direction_id, frame_id: frame.frame_id, concept_id: concept.concept_id };

    const assetPlans = []; const laneRecords = [];
    for (const [laneIndex, lane] of lanes.entries()) {
      const contentAssets = lane.plan.assets;
      const kind = lane.plan.format?.kind;
      // a video lane has no assets: its storyboard and its production are later phases
      if (!contentAssets.length) {
        laneRecords.push({
          lane_id: lane.lane_id, channel: lane.channel, format_kind: kind, content_plan_id: lane.plan.content_plan_id, asset_plan_ids: [], execution: lane.plan.execution ?? { status: EXECUTION.PLANNED_NOT_EXECUTABLE, reasons: [EXECUTION_REASON.VIDEO_PRODUCTION_NOT_AVAILABLE] }, diversity: null, objective_kind: null, slide_density: null,
        });
        continue;
      }
      const resources = contentAssets.map(resourceOfAsset);
      const densities = contentAssets.map((a, i) => classifyDensity(assetChars(a), resources[i]));
      const bodyChars = lane.plan.density.body_chars;
      const objectiveKind = options.objective_kind ?? deriveObjectiveKind({ assets: contentAssets, bodyChars });
      const sequence = planSequence({
        assets: contentAssets, densities: densities.map((d) => d.density_class), objectiveKind, proofAvailable: proofFactRefs.length > 0,
        hints: new Map(contentAssets.map((_, i) => [i, hints.get(`${laneIndex}:${i}`)]).filter(([, h]) => h?.narrative_role)),
      });
      record(ledger, DECISION.CAMPAIGN_SEQUENCE, COMPONENT.CAMPAIGN_PLANNER, 'ROLES_FROM_THE_CONTENT_THE_LOOKS_FROM_THE_ROLES', { lane: lane.lane_id, objective_kind: objectiveKind, roles: sequence.map((s) => s.narrative_role), rules: [...new Set(sequence.map((s) => s.role_rule))] });
      const laneAssets = [];
      for (const [i, content] of contentAssets.entries()) {
        const seq = sequence[i];
        const hint = hints.get(`${laneIndex}:${i}`)?.imagery_hint ?? null;
        const copy = content.slots.map((s) => ({ role: s.role, text: s.text, chars: s.chars, words: s.words }));
        const label = `${NODE.ASSET_PLAN}:${lane.lane_id}:${i}`;
        const assetHash = inputsHash({
          node: NODE.ASSET_PLAN, ...sharedInputs, lane: lane.lane_id, role: seq.narrative_role, composition: seq.composition_intent, imagery: seq.imagery_intent, crop: seq.crop_scale, density: densities[i].density_class, copy: copy.map((c) => [c.role, c.text]), hint, director: Boolean(assetDirector), locale: request.locale,
        });
        let node = useNode(label, assetHash);
        if (!node) {
          let imagery = { imagery_brief: null, composition_note: null, rationale: null, source: BRIEF_SOURCE.INTENT_ONLY, request_id: null, failure_code: null };
          if (assetDirector) {
            try {
              const asked = await assetDirector.brief({
                concept, artDirection, asset: {
                  position: i + 1, of: contentAssets.length, narrative_role: seq.narrative_role, density_class: densities[i].density_class, composition_intent: seq.composition_intent, imagery_intent: seq.imagery_intent, crop_scale: seq.crop_scale, copy: copy.map((c) => ({ role: c.role, text: c.text })), hint,
                },
              });
              imagery = {
                imagery_brief: asked.imagery_brief, composition_note: asked.composition_note, rationale: asked.rationale, source: BRIEF_SOURCE.MODEL, request_id: asked.meta?.request_id ?? null, failure_code: null,
              };
              record(ledger, DECISION.ASSET_PLAN, COMPONENT.ASSET_DIRECTOR, 'ONE_IMAGERY_BRIEF_PER_ASSET_FROM_THE_SHARED_IDEA', { lane: lane.lane_id, index: i, request_id: imagery.request_id });
            } catch (error) {
              imagery.failure_code = safeCause(error).code ?? 'ASSET_DIRECTOR_FAILED';
              record(ledger, DECISION.ASSET_PLAN, COMPONENT.ASSET_DIRECTOR, 'ONE_IMAGERY_BRIEF_PER_ASSET_FROM_THE_SHARED_IDEA', { lane: lane.lane_id, index: i, outcome: 'DEGRADED_TO_INTENT_ONLY', failure_code: imagery.failure_code });
            }
          }
          const body = {
            schema: SCHEMA.asset,
            lane_id: lane.lane_id,
            index: i,
            content_asset_id: content.asset_id,
            narrative_role: seq.narrative_role,
            role_rule: seq.role_rule,
            density: { density_class: densities[i].density_class, chars: densities[i].chars, over_ceiling: densities[i].over_ceiling },
            copy,
            composition_intent: seq.composition_intent,
            imagery_intent: seq.imagery_intent,
            crop_scale: seq.crop_scale,
            imagery_brief: imagery.imagery_brief,
            composition_note: imagery.composition_note,
            imagery_brief_source: imagery.source,
            imagery_failure_code: imagery.failure_code,
            hint,
            evidence_fact_refs: seq.narrative_role === 'PROOF' ? proofFactRefs : [],
            canvas: content.canvas,
            format_resource_ref: content.format_resource_ref,
            execution: content.execution,
            shared: { frame_id: frame.frame_id, concept_id: concept.concept_id, art_direction_id: artDirection.art_direction_id, continuity_id: continuity.continuity_id },
            depends_on: { content_plan_id: lane.plan.content_plan_id, art_direction_id: artDirection.art_direction_id, nodes: DEPENDS_ON[NODE.ASSET_PLAN] },
          };
          const asset = deepFreeze({ asset_plan_id: deriveId('apl', body), ...body });
          node = putNode(state, label, {
            inputsHash: assetHash, id: asset.asset_plan_id, artifact: asset, status: imagery.failure_code ? 'DEGRADED' : 'DONE', failureCode: imagery.failure_code,
          });
          executed.push(label); await checkpoint(label);
        }
        laneAssets.push(node.artifact);
      }
      const diversity = auditDiversity(laneAssets);
      laneRecords.push({
        lane_id: lane.lane_id, channel: lane.channel, format_kind: kind, content_plan_id: lane.plan.content_plan_id, asset_plan_ids: laneAssets.map((a) => a.asset_plan_id), execution: { status: EXECUTION.PLANNED_NOT_EXECUTABLE, reasons: [...new Set(laneAssets.flatMap((a) => a.execution.reasons))] }, diversity, objective_kind: objectiveKind, slide_density: lane.slide_density,
      });
      assetPlans.push(...laneAssets);
    }
    putNode(state, NODE.CAMPAIGN_PLAN, { inputsHash: inputsHash({ node: NODE.CAMPAIGN_PLAN, ...sharedInputs, lanes: laneRecords.map((l) => l.asset_plan_ids) }), id: continuity.continuity_id, artifact: null });

    // ---- the budget: an estimate of producing what was planned, reserved against the ceiling before anything is spent
    const productionAssets = assetPlans.map((a) => ({ canvas: a.canvas }));
    const envelope = chooseProductionEnvelope({ assets: productionAssets, ceilingEur, unitCosts });
    const budget = createCampaignBudget({ ceilingEur });
    const reservation = reserveEstimate(budget, envelope.estimate);
    const budgetRecord = {
      schema: SCHEMA.budget, ceiling_eur: ceilingEur, estimated_worst_case_eur: envelope.estimate.total_eur, within_ceiling: reservation.ok, environment_candidates_per_asset: envelope.environment_candidates_per_asset, shared_eur: envelope.estimate.shared_eur, per_asset_eur: envelope.estimate.per_asset_eur, unit_costs: unitCosts,
    };
    record(ledger, DECISION.CAMPAIGN_BUDGET, COMPONENT.CAMPAIGN_PLANNER, 'RESERVE_BEFORE_THE_COST_AND_NEVER_PASS_THE_CEILING', { ceiling_eur: ceilingEur, estimated_worst_case_eur: budgetRecord.estimated_worst_case_eur, within_ceiling: reservation.ok, environment_candidates_per_asset: budgetRecord.environment_candidates_per_asset });
    if (!reservation.ok) {
      questions.push({
        code: CAMPAIGN_QUESTION.CAMPAIGN_BUDGET_EXCEEDED, blocking: true, field: 'budget', question: 'Even with one environment image per asset, producing this campaign could cost more than its ceiling. Fewer assets, or a higher ceiling?', options: ['FEWER_ASSETS', 'RAISE_THE_CEILING'],
      });
    }
    for (const l of laneRecords) if (l.diversity && !l.diversity.passed) questions.push({ code: 'CAMPAIGN_LOOKS_REPEATED', blocking: false, field: l.lane_id, question: 'The assets of this lane repeat a look. Change the roles or the number of assets?', options: [] });

    const status = questions.some((q) => q.blocking) ? CAMPAIGN_STATUS.NEEDS_USER_DECISION : CAMPAIGN_STATUS.PLANNED;
    const body = {
      schema: SCHEMA.campaign,
      campaign_ref: request.request_ref,
      status,
      content_plan_ids: lanes.map((l) => l.plan.content_plan_id),
      frame_id: frame.frame_id,
      concept_id: concept.concept_id,
      art_direction_id: artDirection.art_direction_id,
      continuity_id: continuity.continuity_id,
      lanes: laneRecords,
      asset_plan_ids: assetPlans.map((a) => a.asset_plan_id),
      budget: budgetRecord,
      questions,
      executable: false,
      dependencies: [
        ...[NODE.CONTENT_PLAN, NODE.FRAME, NODE.CONCEPT, NODE.ART_DIRECTION].map((n) => ({ node: n, depends_on: DEPENDS_ON[n] })),
        ...assetPlans.map((a) => ({ node: `${NODE.ASSET_PLAN}:${a.lane_id}:${a.index}`, depends_on: [NODE.CAMPAIGN_PLAN, NODE.ART_DIRECTION] })),
      ],
    };
    const campaign = deepFreeze({ campaign_id: deriveId('cmp', body), ...body });
    return result(status, {
      campaign_plan: campaign, shared: { problem_frame: frame, concept, art_direction: artDirection }, continuity, asset_plans: assetPlans, state: structuredClone(state),
    });
  }

  return Object.freeze({ plan });
}
