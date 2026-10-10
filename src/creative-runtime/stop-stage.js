import { CI_ERROR } from '../creative-intelligence/index.js';
import { DECISION } from './ledger.js';

// Where a creative run really stopped, and why: the execution chain in order, derived ONLY from the evidence the run left (the ledger, the result fields and the provider journal),
// and one classification of the stopping cause. A run that never reached the deterministic gates is never described as having failed them.

export const ROOT_CAUSE = Object.freeze({
  REVISION_DIRECTOR_PROVIDER_FAILURE: 'REVISION_DIRECTOR_PROVIDER_FAILURE',
  REVISION_DIRECTION_INVALID: 'REVISION_DIRECTION_INVALID',
  REVISION_NOT_MEANINGFULLY_DIFFERENT: 'REVISION_NOT_MEANINGFULLY_DIFFERENT',
  VISUAL_PRODUCTION_PLAN_FAILURE: 'VISUAL_PRODUCTION_PLAN_FAILURE',
  ENVIRONMENT_PROVIDER_FAILURE: 'ENVIRONMENT_PROVIDER_FAILURE',
  ENVIRONMENT_NOT_EMPTY: 'ENVIRONMENT_NOT_EMPTY',
  LAYOUT_CAPABILITY_LIMIT: 'LAYOUT_CAPABILITY_LIMIT',
  DESIGN_DOCUMENT_FAILURE: 'DESIGN_DOCUMENT_FAILURE',
  RENDER_FAILURE: 'RENDER_FAILURE',
  PREFLIGHT_FAIL: 'PREFLIGHT_FAIL',
  FIDELITY_FAIL: 'FIDELITY_FAIL',
  GUARDIAN_FAIL: 'GUARDIAN_FAIL',
  RUNTIME_REPORTING_DEFECT: 'RUNTIME_REPORTING_DEFECT',
});

const STAGE_FOR = Object.freeze({
  REVISION_DIRECTOR_PROVIDER_FAILURE: 'REVISION_DIRECTOR_CALL',
  REVISION_DIRECTION_INVALID: 'REVISED_CREATIVE_DIRECTION',
  REVISION_NOT_MEANINGFULLY_DIFFERENT: 'MEANINGFUL_DIFFERENCE_CHECK',
  VISUAL_PRODUCTION_PLAN_FAILURE: 'VISUAL_PRODUCTION_DIRECTOR',
  ENVIRONMENT_PROVIDER_FAILURE: 'ENVIRONMENT_IMAGE_CALL',
  ENVIRONMENT_NOT_EMPTY: 'ENVIRONMENT_SUITABILITY_GATE',
  LAYOUT_CAPABILITY_LIMIT: 'LAYOUT_PLAN',
  DESIGN_DOCUMENT_FAILURE: 'DESIGN_DOCUMENT',
  RENDER_FAILURE: 'RENDER',
  PREFLIGHT_FAIL: 'PREFLIGHT',
  FIDELITY_FAIL: 'FIDELITY',
  GUARDIAN_FAIL: 'BRAND_GUARDIAN',
  RUNTIME_REPORTING_DEFECT: 'UNKNOWN',
});

const REASON_CAUSE = Object.freeze({
  THE_LAYOUT_COULD_NOT_BE_SOLVED: ROOT_CAUSE.LAYOUT_CAPABILITY_LIMIT,
  NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT: ROOT_CAUSE.LAYOUT_CAPABILITY_LIMIT,
  NO_LAYOUT_RECIPE_COVERS_THE_HIERARCHY: ROOT_CAUSE.LAYOUT_CAPABILITY_LIMIT,
  ENVIRONMENT_NOT_EMPTY: ROOT_CAUSE.ENVIRONMENT_NOT_EMPTY,
  NO_BRAND_COLOUR_PAIR_READS: ROOT_CAUSE.DESIGN_DOCUMENT_FAILURE,
  THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG: ROOT_CAUSE.ENVIRONMENT_PROVIDER_FAILURE,
  THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS: ROOT_CAUSE.ENVIRONMENT_PROVIDER_FAILURE,
  SEGMENTATION_LOW_CONFIDENCE: ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE,
  THE_STRATEGY_PRODUCED_NO_CUTOUT_OR_NO_ENVIRONMENT: ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE,
  A_PROVIDER_REQUEST_MAY_NOT_CARRY_A_PRODUCT_ASSET: ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE,
  UNSUPPORTED_CAPABILITY_IN_THIS_RUNTIME: ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE,
  A_REVISION_NEEDS_A_REVISION_DIRECTOR: ROOT_CAUSE.REVISION_DIRECTION_INVALID,
  BRAND_GUARDIAN_NOT_CONFIGURED: ROOT_CAUSE.GUARDIAN_FAIL,
});

/** The cause of a run that THREW (an agent or a port failed). */
export function classifyRuntimeError(error) {
  const cause = error?.detail?.cause ?? {};
  const code = cause.code ?? error?.code ?? null;
  if (code === 'REVISED_DIRECTION_NOT_DIFFERENT') return ROOT_CAUSE.REVISION_NOT_MEANINGFULLY_DIFFERENT;
  if (error?.code === CI_ERROR.AGENT_FAILED) {
    const role = error.detail?.role;
    if (role === 'VISUAL_PRODUCTION_DIRECTOR') return ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE;
    if (cause.status != null || /Provider|Timeout|Throttl/i.test(cause.name ?? '') || ['TIMEOUT', 'access_denied'].includes(code)) return ROOT_CAUSE.REVISION_DIRECTOR_PROVIDER_FAILURE;
    return ROOT_CAUSE.REVISION_DIRECTION_INVALID;
  }
  // a port failure outside an agent: the environment provider is the only billable port of the runtime
  if (/ProviderError$/.test(error?.name ?? '') || error?.status != null || error?.requestId != null) return ROOT_CAUSE.ENVIRONMENT_PROVIDER_FAILURE;
  return ROOT_CAUSE.RUNTIME_REPORTING_DEFECT;
}

/** The cause of a run that RETURNED without a READY_FOR_REVIEW candidate. */
export function classifyRuntimeStop(result) {
  if (result?.status === 'PREFLIGHT_FAIL') return ROOT_CAUSE.PREFLIGHT_FAIL;
  if (result?.status === 'FIDELITY_FAIL') return ROOT_CAUSE.FIDELITY_FAIL;
  if (result?.status === 'GUARDIAN_FAIL') return ROOT_CAUSE.GUARDIAN_FAIL;
  return REASON_CAUSE[result?.reason] ?? ROOT_CAUSE.RUNTIME_REPORTING_DEFECT;
}

// (the journal's director completions carry no `operation`; the environment and vision calls name theirs)
const textEvents = (events) => events.filter((e) => e.operation == null);
const envEvents = (events) => events.filter((e) => e.operation === 'IMAGE_GENERATE_ENVIRONMENT');
const lastOf = (list, event) => list.filter((e) => e.event === event).at(-1) ?? null;

/**
 * The execution chain of a revision run, in order. `events` is the provider journal (RESERVED / SUCCEEDED / FAILED rows), `error` the thrown error when the run threw.
 * Every state comes from evidence: a step with no evidence is NOT RUN, never guessed.
 */
export function buildExecutionChain({ result = null, error = null, events = [] }) {
  const ledger = result?.ledger ?? [];
  const of = (decision) => ledger.filter((e) => e.decision === decision);
  const thrown = error ? classifyRuntimeError(error) : null;
  const text = textEvents(events); const env = envEvents(events);
  const textOk = lastOf(text, 'SUCCEEDED'); const textFail = lastOf(text, 'FAILED');
  const envOk = lastOf(env, 'SUCCEEDED'); const envFail = lastOf(env, 'FAILED');
  const placement = of(DECISION.PRODUCT_PLACEMENT)[0]?.outcome ?? null;
  const typography = of(DECISION.TYPOGRAPHY_PLACEMENT)[0]?.outcome ?? null;
  const suit = of(DECISION.ENVIRONMENT_SUITABILITY)[0]?.outcome ?? null;
  const layoutSolved = placement ? placement.status === 'SOLVED' && !(typography?.violations?.length) : null;
  const directionAccepted = of(DECISION.CREATIVE_DIRECTION).length > 0;
  const row = (n, step, state, detail = null) => ({ n, step, state, detail });
  return [
    row(1, 'Revision Director call', text.length ? 'SENT' : 'NOT SENT', text[0]?.operation_id ?? null),
    row(2, 'Revision Director provider result', textOk ? 'SUCCESS' : (textFail || thrown === ROOT_CAUSE.REVISION_DIRECTOR_PROVIDER_FAILURE ? 'FAIL' : 'NOT RUN'), textOk?.request_id ?? textFail?.reason ?? null),
    row(3, 'Revised Creative Direction', directionAccepted ? 'ACCEPTED' : (thrown === ROOT_CAUSE.REVISION_DIRECTION_INVALID || thrown === ROOT_CAUSE.REVISION_NOT_MEANINGFULLY_DIFFERENT ? 'REJECTED' : 'NOT RUN'), null),
    row(4, 'Meaningful-difference check', of(DECISION.REVISION_DIRECTION).length ? 'PASS' : (thrown === ROOT_CAUSE.REVISION_NOT_MEANINGFULLY_DIFFERENT ? 'FAIL' : 'NOT RUN'), of(DECISION.REVISION_DIRECTION)[0]?.outcome?.changed_structural ?? null),
    row(5, 'Visual Production Director', of(DECISION.BACKGROUND_STRATEGY).length ? 'PASS' : (thrown === ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE ? 'FAIL' : 'NOT RUN'), null),
    row(6, 'Environment image call', env.length ? 'SENT' : 'NOT SENT', envOk?.request_id ?? envFail?.reason ?? null),
    row(7, 'Environment suitability gate', suit ? (suit.suitable ? 'PASS' : 'FAIL') : 'NOT RUN', null),
    row(8, 'Layout plan', placement ? (layoutSolved ? 'BUILT' : 'FAIL') : 'NOT RUN', layoutSolved === false ? { solver_status: placement.status, violations: typography?.violations ?? [], unplaced: typography?.unplaced ?? [] } : null),
    row(9, 'DesignDocument', placement ? (layoutSolved ? 'BUILT' : 'FAIL') : 'NOT RUN', placement && !layoutSolved ? 'assembled, but its layout is not solved' : null),
    row(10, 'Render', result?.png_sha256 ? 'SUCCESS' : 'NOT RUN', null),
    row(11, 'Preflight', result?.preflight?.status ?? 'NOT RUN', null),
    row(12, 'Fidelity', result?.fidelity?.gate ?? 'NOT RUN', null),
    row(13, 'Brand Guardian', result?.guardian?.outcome ?? 'NOT RUN', null),
  ];
}

/**
 * The one-line status of a run that did not produce a reviewable candidate. It names the real stopping stage; "did not pass the deterministic gates" is said ONLY when a candidate
 * existed and at least one of Preflight, Fidelity or Guardian actually ran and did not pass.
 */
export function describeStop({ result = null, error = null }) {
  const cause = error ? classifyRuntimeError(error) : classifyRuntimeStop(result);
  const gatesRan = Boolean(result?.png_sha256) && [result?.preflight?.status, result?.fidelity?.gate, result?.guardian?.outcome].some((g) => g != null);
  const stage = STAGE_FOR[cause];
  const status = gatesRan && [ROOT_CAUSE.PREFLIGHT_FAIL, ROOT_CAUSE.FIDELITY_FAIL, ROOT_CAUSE.GUARDIAN_FAIL].includes(cause)
    ? `${cause}: Candidate 2 did not pass the deterministic gates; the critic was not called`
    : `STOPPED_AT_${stage}: ${cause}${result?.reason ? ` (${result.reason})` : ''}; no candidate reached the deterministic gates, the critic was not called`;
  return Object.freeze({ cause, stage, status, reached_gates: gatesRan });
}
