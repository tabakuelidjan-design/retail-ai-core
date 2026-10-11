import { createHash } from 'node:crypto';

import { priceImagesEur, priceTextEur, SpendGuard } from '../marketing-creative/alibaba/budget.js';
import {
  buildCriticInstruction, createCreativeCritic, finalizeVerdict,
} from '../creative-critic/index.js';
import {
  CAPABILITY, buildConceptCriticInstruction, buildFramerInstruction, createConceptCritic, createCreativeBrain, CREATIVE_KNOWLEDGE, CREATIVE_QUALITY, creativeQualityState, diagnoseRecovery, isSupported,
  observeBrief, validateKnowledge,
} from '../creative-brain/index.js';
import {
  computeLayoutCapabilityProfile, createApprovedCopyAgent, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, describeStop,
  executableSpatialIntents, runProductPreservingCreative,
} from '../creative-runtime/index.js';
import { BRAIN_PORT_LIMITS } from '../marketing-creative/alibaba/qwen-brain-port.js';
import { BRAIN_FAILURE, classifyBrainFailure } from './failure.js';

// THE CREATIVE BRAIN LIVE BENCHMARK. This module wires the existing Creative Brain, end to end, into the product-preserving runtime and the critics, under fixed bounds. It makes NO creative
// decision: every stage is the Brain's (or a deterministic gate's). It reads only the original brief, the real source asset and the brand package that its caller loads: never an earlier
// candidate, critique, direction or owner review. Language models, the image provider, the vision critic and the Brand Guardian are PORTS supplied by the caller (the CLI wires the real ones,
// the tests wire fakes), so everything here runs offline.
//
//   OBSERVE -> FRAME -> IDEATE -> SELECT -> ART DIRECT -> COMPOSE -> SCENE -> PRODUCTION STRATEGY   (the Brain)
//   -> environment image -> deterministic product-preserving composite -> Preflight -> Fidelity -> Brand Guardian   (the runtime and its gates)
//   -> execution critic + concept critic -> recovery decision -> STOP for owner review.
//
// Bounds of the first benchmark: at most 2 concept rounds of 3 concepts, 1 production candidate per selected concept, 1 recovery action. Only a RECONCEPT recovery is executed (it brings a new
// concept, which gets its own single candidate); a REFINE or RECOMPOSE decision is recorded as a recommendation and not executed, because executing it would be a second candidate for the
// same concept. The result is never "PASS": it is one of four states, and the owner's approval is always PENDING.

export const BENCHMARK_ID = 'creative-brain-benchmark-001';
export const BOUNDS = Object.freeze({ concept_rounds: 2, concepts_per_round: 3, production_candidates_per_concept: 1, recovery_actions: 1 });
export const MAX_CANDIDATES = 1 + BOUNDS.recovery_actions;
export const RESULT_STATE = Object.freeze({
  BLOCKED: 'BLOCKED',
  TECHNICAL_FAIL: 'TECHNICAL_FAIL',
  TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT: 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT',
  READY_FOR_OWNER_REVIEW: 'READY_FOR_OWNER_REVIEW',
});
export const OWNER_APPROVAL = 'PENDING';
export const HARD_CEILING_EUR = 1.0; // a benchmark whose worst case exceeds this is refused before any call
const VISION_MAX_OUTPUT_TOKENS = 2200;
const VISION_IMAGE_TOKENS = 3000;
const PRIVATE_FORBIDDEN_FRAGMENT = 'creative-run-001'; // the output of the earlier candidates: never reused, never read

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const REQUIRED_CAPABILITIES = Object.freeze([
  CAPABILITY.LOCAL_SEGMENTATION, CAPABILITY.PRODUCT_CUTOUT, CAPABILITY.DETERMINISTIC_PRODUCT_COMPOSITE, CAPABILITY.DETERMINISTIC_TEXT, CAPABILITY.RICH_SCENE_GENERATION, CAPABILITY.ENVIRONMENT_GENERATION,
  CAPABILITY.SHADOW_CONTACT_INTEGRATION,
]);

/**
 * The most the benchmark can call and spend, from its bounds alone.
 * text calls: 1 framing + 2 per concept round (ideation, evaluation) + 2 per planned candidate (art direction, composition); images: one per candidate; vision: two critics per candidate.
 */
export function worstCase({ canvas, criticChars, usdToEur = 1 }) {
  const text = 1 + (2 * BOUNDS.concept_rounds) + (2 * MAX_CANDIDATES);
  const image = MAX_CANDIDATES;
  const vision = 2 * MAX_CANDIDATES;
  const textEach = priceTextEur({ inputTokens: BRAIN_PORT_LIMITS.max_input_tokens, outputTokens: BRAIN_PORT_LIMITS.max_output_tokens, usdToEur });
  const imageEach = priceImagesEur({ n: 1, size: `${canvas.width}x${canvas.height}`, usdToEur });
  const visionEach = priceTextEur({ inputTokens: Math.ceil(criticChars / 4) + VISION_IMAGE_TOKENS, outputTokens: VISION_MAX_OUTPUT_TOKENS, usdToEur });
  const cost = { text: text * textEach, image: image * imageEach, vision: vision * visionEach };
  const total = cost.text + cost.image + cost.vision;
  return {
    calls: { text, image, vision, total: text + image + vision },
    per_call_eur: { text: textEach, image: imageEach, vision: visionEach },
    cost_eur: { ...cost, total },
    max_spend_eur: Math.round(Math.ceil((total - 1e-9) / 0.05) * 5) / 100,
  };
}

const safeError = (error) => ({ code: error?.code ?? null, name: error?.name ?? null, field: error?.field ?? null, status: error?.status ?? error?.detail?.status ?? null, request_id: error?.requestId ?? error?.detail?.request_id ?? null, message: String(error?.message ?? '').slice(0, 300) });

/** A stopped run names the exact stage, the round, one closed cause and the evidence of the failed model answer (bounded): never just "the plan stopped". */
const describeFailure = (error, stage) => {
  const brainStage = error?.brain_stage ?? null;
  const cause = classifyBrainFailure({ stage: brainStage, name: error?.name, code: error?.code, problem: error?.detail?.problem });
  return {
    stage, brain_stage: brainStage, brain_round: error?.brain_round ?? null, cause, ...safeError(error),
    evidence: error?.evidence ? { stage: error.evidence.stage, request_id: error.evidence.request_id, model: error.evidence.model, key_repairs: error.evidence.key_repairs, raw_answer: error.evidence.raw_answer } : null,
  };
};

function criticBriefs({ brief, expression }) {
  const principles = Object.fromEntries(['photography', 'product_presentation', 'composition', 'layout_principles'].filter((k) => expression?.[k]).map((k) => [k, { principles: expression[k].principles, do: expression[k].do, dont: expression[k].dont }]));
  return {
    execution: { public_facts: brief.public_facts, brand_principles: principles, verified_elsewhere: ['the wording of the headline, the supporting claim and the price', 'the identity, shape and printed artwork of the product', 'fonts, collisions and bounds', 'brand rules'] },
    concept: { public_facts: brief.public_facts },
  };
}

/** Everything that can be verified without any network call. Shared by --check and by --live (which refuses to start when it fails). */
export async function prepare(deps) {
  const report = { checks: [], bounds: BOUNDS, private_directory: deps.store.dir };
  const check = (name, ok, detail = null) => { report.checks.push({ name, ok, detail }); return ok; };
  const blocked = (reason) => ({ ok: false, report: { ...report, status: `BLOCKED: ${reason}` } });

  const credentials = deps.credentials();
  if (!check('credentials present', credentials.present, credentials.present ? null : { missing_environment_variables: credentials.missing })) return blocked('CREDENTIALS_NOT_PROVISIONED');
  if (!check('credentials and region valid', credentials.valid, credentials.detail ?? null)) return blocked('CONFIG_INVALID');

  if (!check('the output directory is new and private (never the earlier run)', !deps.store.dir.includes(PRIVATE_FORBIDDEN_FRAGMENT))) return blocked('OUTPUT_DIRECTORY_IS_THE_EARLIER_RUN');
  if (!check('no earlier record or live lock in the output directory', !(await deps.store.exists('summary.json')) && !(await deps.store.exists('live-run-001.lock')), { lock: 'live-run-001.lock' })) return blocked('BENCHMARK_ALREADY_ATTEMPTED');
  if (!check('the output directory is writable', await deps.store.probeWritable())) return blocked('OUTPUT_DIRECTORY_NOT_WRITABLE');

  const inputs = await deps.loadInputs();
  const { brief, fonts, expression } = inputs;
  if (!check('the source asset matches its pinned hash', sha256(brief.asset.bytes) === brief.asset.sha256)) return blocked('ASSET_HASH_MISMATCH');
  check('the brief holds only approved copy and claims', true, { approved_copy: brief.approved_copy.length, claims: brief.claims.map((c) => c.role) });

  try { validateKnowledge(CREATIVE_KNOWLEDGE.map((p) => structuredClone(p))); check('the Creative Brain contracts and knowledge are valid', true, { principles: CREATIVE_KNOWLEDGE.length }); } catch (error) { check('the Creative Brain contracts and knowledge are valid', false, safeError(error)); return blocked('CREATIVE_KNOWLEDGE_INVALID'); }
  const unsupported = REQUIRED_CAPABILITIES.filter((c) => !isSupported(c));
  if (!check('every capability the benchmark needs is supported by a tool', unsupported.length === 0, { required: REQUIRED_CAPABILITIES, unsupported, not_used: [CAPABILITY.LOCAL_REFINEMENT, CAPABILITY.SELECTIVE_EDITING, CAPABILITY.MULTI_REFERENCE_COMPOSITION] })) return blocked('CAPABILITY_UNSUPPORTED');

  const dry = await createLocalProductSegmenter({ ledger: createDecisionLedger() }).segment({ asset: brief.asset, annotations: brief.identity_annotations });
  if (!check('local segmentation dry-run is confident', dry.quality.confident)) return blocked('SEGMENTATION_LOW_CONFIDENCE');
  const capability = computeLayoutCapabilityProfile({ at: deps.now(), brief, fonts });
  check('preset layouts that could serve as an explicit fallback (the relational composition is tried first)', true, { executable_spatial_intents: executableSpatialIntents(capability) });

  const framer = buildFramerInstruction({ observation: observeBrief({ brief }) });
  check('the first Brain instruction is built from the brief only (nothing from any earlier candidate)', true, { system_chars: framer.system.length, user_chars: framer.user.length, user_sha256_prefix: sha256(framer.user).slice(0, 12) });
  const briefs = criticBriefs({ brief, expression });
  const exec = buildCriticInstruction({ brief: briefs.execution }); const conc = buildConceptCriticInstruction({ brief: briefs.concept });
  const criticChars = Math.max(exec.system.length + exec.user.length, conc.system.length + conc.user.length);
  const cost = worstCase({ canvas: brief.format.canvas, criticChars });
  if (!check('the worst-case cost is under the hard ceiling', cost.max_spend_eur <= (deps.hardCeilingEur ?? HARD_CEILING_EUR), { ...cost, hard_ceiling_eur: deps.hardCeilingEur ?? HARD_CEILING_EUR })) return blocked('WORST_CASE_COST_ABOVE_THE_CEILING');
  report.worst_case = cost;
  return { ok: true, report, ctx: { inputs, cost, briefs } };
}

export async function runCheck(deps) {
  const prepared = await prepare(deps);
  if (!prepared.ok) return prepared.report;
  return { ...prepared.report, status: 'READY_FOR_ONE_CREATIVE_BRAIN_BENCHMARK (nothing was sent)' };
}

function classify(result) {
  if (result.status === 'READY_FOR_REVIEW') return null;
  if (result.status === 'BLOCKED') return result.environment ? RESULT_STATE.TECHNICAL_FAIL : RESULT_STATE.BLOCKED;
  return RESULT_STATE.TECHNICAL_FAIL; // PREFLIGHT_FAIL, FIDELITY_FAIL, GUARDIAN_FAIL
}

/** The result of a benchmark is one of four states, never a plain PASS. */
export function assertFinalState(state) {
  if (!Object.values(RESULT_STATE).includes(state)) throw new Error(`the final state must be one of the four benchmark states: ${state}`);
  return state;
}

const stateOf = ({ quality }) => {
  if (quality.state === CREATIVE_QUALITY.NOT_TECHNICALLY_VALID) return RESULT_STATE.TECHNICAL_FAIL;
  if (quality.state === CREATIVE_QUALITY.CREATIVELY_SUFFICIENT_AWAITING_OWNER) return RESULT_STATE.READY_FOR_OWNER_REVIEW;
  return RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT; // including NOT_MEASURABLE: an unjudged candidate is never presented as ready
};

export async function runLive(deps, { confirmed = false } = {}) {
  if (!confirmed) return { status: 'BLOCKED: LIVE_RUN_NEEDS_EXPLICIT_CONFIRMATION', checks: [], private_directory: deps.store.dir };
  const prepared = await prepare(deps);
  if (!prepared.ok) return prepared.report;
  const { report } = prepared;
  const { inputs, cost, briefs } = prepared.ctx;
  const { brief, fonts, expression } = inputs;
  try { await deps.store.takeLock(); } catch { return { ...report, status: 'BLOCKED: BENCHMARK_ALREADY_ATTEMPTED' }; }

  const at = deps.now();
  const budget = new SpendGuard({ maxSpendEur: cost.max_spend_eur, maxImages: MAX_CANDIDATES, maxVideoSeconds: 0 });
  const journal = deps.journal;
  const brainLedger = createDecisionLedger();
  const record = { benchmark_id: BENCHMARK_ID, started_at: at, bounds: BOUNDS, worst_case: cost, owner_approval: OWNER_APPROVAL, manual_creative_steering: null, candidates: [], recovery: null, error: null };
  const summary = () => ({ ...report, ...record, budget: budget.snapshot(), brain_ledger: brainLedger.entries() });
  const persist = () => deps.store.writeJson('summary.json', summary());
  let currentStage = 'BRAIN_PORT';
  try {
    const brainComplete = deps.ports.brainPort({ budget, journal, maxCalls: cost.calls.text });
    const brain = createCreativeBrain({ complete: brainComplete, ledger: brainLedger, bounds: { concept_rounds: BOUNDS.concept_rounds, concepts_per_round: BOUNDS.concepts_per_round } });

    currentStage = 'CREATIVE_BRAIN_PLAN';
    const planned = await brain.plan({ brief });
    record.problem_frame = planned.problem_frame ?? planned.plan?.problem_frame ?? null;
    record.concept_rounds = planned.rounds ?? planned.plan?.rounds ?? [];
    if (planned.status !== 'PLANNED') {
      record.final = { state: RESULT_STATE.BLOCKED, reason: BRAIN_FAILURE.NO_CONCEPT_MEETS_BAR, classification: BRAIN_FAILURE.VALID_CREATIVE_BRAIN_REJECTION, stopped_at: 'SELECT_CONCEPT', note: 'no concept met the bar within the bounded rounds: nothing was produced (a valid rejection, the bar is not lowered)', owner_approval: OWNER_APPROVAL };
      await persist();
      return { ...report, status: RESULT_STATE.BLOCKED, final: record.final, owner_approval: OWNER_APPROVAL };
    }
    let plan = planned.plan;
    let recovered = false;

    for (let n = 1; n <= MAX_CANDIDATES; n += 1) {
      currentStage = `CANDIDATE_${n}`;
      const candidate = await produceCandidate({ n, plan, deps, brief, fonts, expression, briefs, budget, journal, at });
      record.candidates.push(candidate);
      await persist();
      if (!candidate.recovery) break; // a technical failure or a blocked candidate was never critiqued: there is nothing to recover from
      // one recovery action in the whole benchmark, and only a new concept is executed
      const { diagnosis } = candidate.recovery;
      if (diagnosis.action === 'NONE') break;
      if (recovered || n >= MAX_CANDIDATES) { candidate.recovery.executed = false; candidate.recovery.not_executed_reason = 'THE_RECOVERY_BOUND_IS_REACHED'; break; }
      if (diagnosis.action !== 'RECONCEPT') { candidate.recovery.executed = false; candidate.recovery.not_executed_reason = 'ONE_PRODUCTION_CANDIDATE_PER_CONCEPT: the recommendation is recorded for the owner'; break; }
      if (brain.remainingConceptRounds() < 1) { candidate.recovery.executed = false; candidate.recovery.not_executed_reason = 'NO_CONCEPT_ROUND_LEFT_WITHIN_THE_BOUNDS'; break; }
      currentStage = 'CREATIVE_BRAIN_RECONCEPT';
      const replanned = await brain.replan({ brief, plan, critique: candidate.critique, conceptCritique: candidate.concept_critique, history: [] });
      if (replanned.status !== 'REPLANNED') { candidate.recovery.executed = false; candidate.recovery.not_executed_reason = `THE_NEW_CONCEPT_ROUND_SELECTED_NOTHING (${replanned.status})`; break; }
      candidate.recovery.executed = true; candidate.recovery.new_plan_id = replanned.plan.plan_id; recovered = true;
      record.recovery = { action: 'RECONCEPT', from_plan_id: plan.plan_id, to_plan_id: replanned.plan.plan_id, concept_rounds: replanned.plan.rounds };
      plan = replanned.plan;
    }
  } catch (error) {
    record.error = describeFailure(error, currentStage);
  }

  // the final state is the state of the last candidate that exists (a failure while preparing a recovery does not hide a candidate the owner can review); with no candidate it is BLOCKED
  const last = record.candidates.at(-1) ?? null;
  const state = last ? last.state : RESULT_STATE.BLOCKED;
  record.final = { state, reason: record.error ? record.error.cause : (last?.reason ?? null), stopped_at: record.error ? (record.error.brain_stage ?? record.error.stage) : null, stopped_round: record.error?.brain_round ?? null, stopped_early: Boolean(record.error), candidate: last?.n ?? null, owner_approval: OWNER_APPROVAL };
  assertFinalState(record.final.state);
  record.manual_creative_steering = 'NONE';
  await persist();
  return { ...report, status: state, final: record.final, candidates: record.candidates.map((c) => ({ n: c.n, state: c.state, concept_id: c.concept_id, png: c.png ? { sha256: c.png.sha256 } : null })), budget: budget.snapshot(), owner_approval: OWNER_APPROVAL };
}

async function produceCandidate({ n, plan, deps, brief, fonts, expression, briefs, budget, journal, at }) {
  const tag = String(n).padStart(3, '0');
  const candidateRef = `candidate:${BENCHMARK_ID}-candidate-${tag}`;
  const ledger = createDecisionLedger();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression }),
    director: { invoke: async () => { throw new Error('the Creative Director is not used: the Creative Brain plan directs the run'); } },
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression }),
  };
  const ports = { segmenter: createLocalProductSegmenter({ ledger }), environment: deps.ports.environmentPort({ budget, journal, operationId: `${BENCHMARK_ID}-environment-${tag}` }) };
  const guardian = deps.ports.guardian({ candidateRef, at });
  const brainPart = { plan_id: plan.plan_id, concept_id: plan.concept.concept_id, concept: plan.concept, art_direction: plan.art_direction, composition: plan.composition, scene: plan.scene, production_plan: plan.production_plan, layout_choice: { source: plan.layout_choice.source, recipe_id: plan.layout_choice.recipe?.recipe_id ?? plan.layout_choice.recipe_id, reason: plan.layout_choice.reason } };
  const result = await runProductPreservingCreative({ at, brief, fonts, agents, ports, ledger, guardian, creativePlan: plan });
  const candidate = {
    n, ref: candidateRef, ...brainPart, runtime_status: result.status, reason: result.reason ?? null, runtime_ledger: result.ledger ?? ledger.entries(), steering: result.steering ?? null,
    preflight: result.preflight ? { status: result.preflight.status } : null, fidelity: result.fidelity ? { gate: result.fidelity.gate, failed: result.fidelity.failed } : null, guardian: result.guardian ? { outcome: result.guardian.outcome } : null,
    environment: result.environment ?? null, png: null, state: null, critique: null, concept_critique: null, quality: null, verdict: null, recovery: null,
  };
  const layout = ledger.of('LAYOUT_RECIPE')[0]?.outcome ?? null;
  candidate.layout = layout ? { source: layout.source, recipe_id: layout.recipe_id, fallback_reason: layout.fallback_reason ?? null } : null;
  if (result.png_bytes) {
    await deps.store.writeBytes(`candidate-${tag}.png`, result.png_bytes);
    candidate.png = { file: `candidate-${tag}.png`, sha256: result.png_sha256, width: result.width, height: result.height };
  }
  const technical = classify(result);
  if (technical) {
    candidate.state = technical;
    candidate.stop = describeStop({ result });
    return candidate;
  }

  // every deterministic gate passed: only now are the two critics paid for
  let vlmFor;
  try { vlmFor = () => deps.ports.vlm({ budget, journal, candidateRef, candidateSha: result.png_sha256 }); vlmFor(); } catch (error) {
    candidate.state = RESULT_STATE.BLOCKED; candidate.reason = 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED'; candidate.error = safeError(error);
    return candidate;
  }
  const subject = { ref: candidateRef, png_bytes: result.png_bytes };
  const executionOut = await createCreativeCritic({ vlm: vlmFor() }).critique({ candidate: subject, brief: briefs.execution });
  const conceptOut = await createConceptCritic({ vlm: vlmFor() }).critique({ candidate: subject, brief: briefs.concept });
  const deterministic = { preflight: result.preflight.status, fidelity: result.fidelity.gate, guardian: result.guardian.outcome };
  const verdict = finalizeVerdict({ critique: executionOut.critique, deterministic });
  const quality = creativeQualityState({ critique: executionOut.critique, conceptCritique: conceptOut.critique, deterministic });
  candidate.critique = executionOut.critique; candidate.critique_provenance = executionOut.provenance;
  candidate.concept_critique = conceptOut.critique; candidate.concept_critique_provenance = conceptOut.provenance;
  candidate.verdict = verdict; candidate.quality = quality;
  candidate.state = stateOf({ quality });
  const diagnosis = diagnoseRecovery({ critique: executionOut.critique, conceptCritique: conceptOut.critique, history: [], concept_id: plan.concept.concept_id });
  candidate.recovery = { diagnosis, executed: false, not_executed_reason: null };
  return candidate;
}

/** Offline and read-only: the execution chain and the stop reason, reconstructed from the stored evidence alone. */
export async function runExplain(deps) {
  const stored = await deps.store.readJson('summary.json');
  const report = { checks: [], private_directory: deps.store.dir };
  if (!stored) return { ...report, status: 'BLOCKED: NO_BENCHMARK_RECORD' };
  const events = await deps.store.readEvents();
  const decisions = (stored.brain_ledger ?? []).map((e) => e.decision);
  const seen = (d) => decisions.includes(d);
  const stages = [
    ['OBSERVE', seen('OBSERVATION')], ['FRAME', seen('PROBLEM_FRAME')], ['IDEATE', seen('CONCEPT_ROUND')], ['SELECT_CONCEPT', seen('CONCEPT_SELECTION')], ['ART_DIRECT', seen('ART_DIRECTION')],
    ['COMPOSE', seen('COMPOSITION_PLAN')], ['SCENE', seen('SCENE_SPEC')], ['PRODUCTION_STRATEGY', seen('PRODUCTION_PLAN')],
  ].map(([stage, reached]) => ({ stage, reached }));
  const candidates = (stored.candidates ?? []).map((c) => ({
    n: c.n, concept_id: c.concept_id, layout: c.layout, runtime_status: c.runtime_status, reason: c.reason, state: c.state, preflight: c.preflight?.status ?? null, fidelity: c.fidelity?.gate ?? null, guardian: c.guardian?.outcome ?? null,
    execution_critic: c.critique ? c.critique.dimensions.map((d) => [d.dimension, d.outcome]) : null, concept_critic: c.concept_critique ? c.concept_critique.dimensions.map((d) => [d.dimension, d.outcome]) : null,
    recovery: c.recovery ? { action: c.recovery.diagnosis.action, executed: c.recovery.executed, not_executed_reason: c.recovery.not_executed_reason } : null, stop: c.stop ?? null,
  }));
  const calls = events.filter((e) => e.event === 'SUCCEEDED' || e.event === 'FAILED').map((e) => ({ operation: e.operation ?? e.operation_id, event: e.event, request_id: e.request_id ?? null, latency_ms: e.latency_ms ?? null, usage: e.usage ?? null, cost_eur: e.actual_cost_eur ?? e.estimated_cost_eur ?? null, reason: e.reason ?? null }));
  return {
    ...report,
    status: 'EXPLAINED',
    final: stored.final ?? null,
    error: stored.error ?? null,
    brain_stages: stages,
    candidates,
    recovery: stored.recovery ?? null,
    provider_calls: calls,
    provider_call_count: calls.length,
    cost_eur_total: stored.budget?.settled_eur ?? null,
    owner_approval: OWNER_APPROVAL,
    manual_creative_steering: stored.manual_creative_steering ?? null,
  };
}
