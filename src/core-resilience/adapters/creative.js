import { BRAIN_ERROR } from '../../creative-brain/validation.js';
import { RECOVERY_ACTION as CREATIVE_RECOVERY } from '../../creative-brain/production-strategist.js';
import { BRAIN_FAILURE } from '../../creative-brain-benchmark/failure.js';
import { ROOT_CAUSE } from '../../creative-runtime/stop-stage.js';
import { createDomainActionMap, RECOVERY_ACTION as A } from '../recovery.js';
import { classifyProviderFailure } from '../provider.js';
import { CORE_CATEGORY as C, makeCoreError } from '../taxonomy.js';
import { createDependencyGraph } from '../invalidation.js';

// CREATIVE BRAIN ON THE CORE RESILIENCE LAYER (the first pilot). Core owns the mechanics (taxonomy, policy, budgets, checkpoints); the Creative Brain keeps its creative reasoning and its richer vocabulary. This adapter
// only MAPS: each Brain contract code, each Brain failure cause and each runtime stop cause onto exactly one Core category, and each creative recovery action onto Core semantics (RECONCEPT -> REPLAN at the concept stage).

const SHAPE = { category: C.PROTOCOL_ERROR, domain_code: 'BRAIN_CONTRACT_SHAPE' };
const CODE_MAP = Object.freeze({
  // the model's answer does not have the shape of the contract: a protocol failure
  [BRAIN_ERROR.MALFORMED]: SHAPE,
  [BRAIN_ERROR.UNKNOWN_KEY]: SHAPE,
  [BRAIN_ERROR.MISSING_KEY]: SHAPE,
  [BRAIN_ERROR.TEXT_INVALID]: SHAPE,
  [BRAIN_ERROR.ENUM_INVALID]: SHAPE,
  [BRAIN_ERROR.LIST_INVALID]: SHAPE,
  [BRAIN_ERROR.NUMERIC_VALUE]: SHAPE,
  // the content breaks a creative rule: a domain rule, not a formatting problem
  [BRAIN_ERROR.FORBIDDEN_CONTENT]: { category: C.DOMAIN_RULE_VIOLATION, domain_code: 'BRAIN_FORBIDDEN_CONTENT' },
  [BRAIN_ERROR.NOT_DISTINCT]: { category: C.DOMAIN_RULE_VIOLATION, domain_code: 'BRAIN_CONCEPTS_NOT_DISTINCT' },
  [BRAIN_ERROR.PORT_FAILED]: { category: C.PROVIDER_FAILURE, domain_code: 'BRAIN_PORT_FAILED' },
});

/** The stable causes of a stopped Brain plan (the Brain's own closed list) on Core categories. */
export const BRAIN_CAUSE_MAP = Object.freeze({
  [BRAIN_FAILURE.COMPOSITION_OUTPUT_INVALID]: C.PROTOCOL_ERROR,
  [BRAIN_FAILURE.COMPOSITION_RELATIONS_CONTRADICTORY]: C.DOMAIN_RULE_VIOLATION,
  [BRAIN_FAILURE.PROBLEM_FRAME_INVALID]: C.PROTOCOL_ERROR,
  [BRAIN_FAILURE.IDEATION_PROVIDER_FAILURE]: C.PROVIDER_FAILURE,
  [BRAIN_FAILURE.CONCEPT_OUTPUT_INVALID]: C.PROTOCOL_ERROR,
  [BRAIN_FAILURE.CONCEPTS_NOT_DISTINCT]: C.DOMAIN_RULE_VIOLATION,
  [BRAIN_FAILURE.NO_CONCEPT_MEETS_BAR]: C.DOMAIN_RULE_VIOLATION, // a VALID rejection: the bar is never lowered
  [BRAIN_FAILURE.CONCEPT_SELECTION_PROVIDER_FAILURE]: C.PROVIDER_FAILURE,
  [BRAIN_FAILURE.CONCEPT_SELECTION_INVALID]: C.PROTOCOL_ERROR,
  [BRAIN_FAILURE.ART_DIRECTION_PROVIDER_FAILURE]: C.PROVIDER_FAILURE,
  [BRAIN_FAILURE.ART_DIRECTION_INVALID]: C.PROTOCOL_ERROR,
  [BRAIN_FAILURE.COMPOSITION_PLAN_INVALID]: C.PROTOCOL_ERROR,
  [BRAIN_FAILURE.CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT]: C.FATAL_SYSTEM_ERROR,
  [BRAIN_FAILURE.VALID_CREATIVE_BRAIN_REJECTION]: C.DOMAIN_RULE_VIOLATION,
});

/** The stable root causes of a stopped creative RUN (the runtime's own closed list) on Core categories. */
export const RUNTIME_CAUSE_MAP = Object.freeze({
  [ROOT_CAUSE.REVISION_DIRECTOR_PROVIDER_FAILURE]: C.PROVIDER_FAILURE,
  [ROOT_CAUSE.REVISION_DIRECTION_INVALID]: C.PROTOCOL_ERROR,
  [ROOT_CAUSE.REVISION_NOT_MEANINGFULLY_DIFFERENT]: C.DOMAIN_RULE_VIOLATION,
  [ROOT_CAUSE.VISUAL_PRODUCTION_PLAN_FAILURE]: C.TOOL_CAPABILITY_LIMIT,
  [ROOT_CAUSE.ENVIRONMENT_PROVIDER_FAILURE]: C.PROVIDER_FAILURE,
  [ROOT_CAUSE.ENVIRONMENT_NOT_EMPTY]: C.SAFETY_OR_FIDELITY_BLOCK, // the product-protection gate: never bypassed
  [ROOT_CAUSE.LAYOUT_CAPABILITY_LIMIT]: C.TOOL_CAPABILITY_LIMIT,
  [ROOT_CAUSE.DESIGN_DOCUMENT_FAILURE]: C.RECOVERABLE_EXECUTION_ERROR,
  [ROOT_CAUSE.RENDER_FAILURE]: C.RECOVERABLE_EXECUTION_ERROR,
  [ROOT_CAUSE.PREFLIGHT_FAIL]: C.DOMAIN_RULE_VIOLATION,
  [ROOT_CAUSE.FIDELITY_FAIL]: C.SAFETY_OR_FIDELITY_BLOCK,
  [ROOT_CAUSE.GUARDIAN_FAIL]: C.SAFETY_OR_FIDELITY_BLOCK,
  [ROOT_CAUSE.RUNTIME_REPORTING_DEFECT]: C.FATAL_SYSTEM_ERROR,
});

/** Creative actions keep their meaning and are mapped onto Core semantics. */
export const CREATIVE_ACTIONS = createDomainActionMap('creative', {
  [CREATIVE_RECOVERY.RECONCEPT]: { core: A.REPLAN, scope: 'IDEATE' }, // a different idea: back to the concept stage, keeping the frame
  [CREATIVE_RECOVERY.RECOMPOSE]: { core: A.REPLAN, scope: 'COMPOSE' }, // the idea stands, the arrangement changes
  [CREATIVE_RECOVERY.REFINE]: { core: A.REPLAN, scope: 'PRODUCTION' }, // the idea and arrangement stand, the execution is improved locally
});

/** Creative policy: the concept bar and the product protection are never negotiable; relation or rule violations may be planned again, never normalized. */
export const CREATIVE_POLICY = Object.freeze({
  allow: { DOMAIN_RULE_VIOLATION: [A.REPLAN, A.GRACEFUL_BLOCK] },
  forbid: {},
});

/** Which user-given facts each Brain stage depends on, for dependency-aware invalidation (the user changes one thing). */
export const CREATIVE_DEPENDENCIES = createDependencyGraph({
  facts: ['product', 'audience', 'occasion', 'brand', 'headline', 'claim', 'price', 'format'],
  stages: [
    { name: 'OBSERVE', reads: ['product', 'brand', 'format'] },
    { name: 'FRAME', reads: ['OBSERVE', 'audience', 'occasion'] },
    { name: 'IDEATE', reads: ['FRAME'] },
    { name: 'SELECT_CONCEPT', reads: ['IDEATE'] },
    { name: 'ART_DIRECT', reads: ['SELECT_CONCEPT', 'brand'] },
    { name: 'COMPOSE', reads: ['ART_DIRECT', 'headline', 'claim', 'price', 'format'] },
    { name: 'SCENE', reads: ['ART_DIRECT', 'COMPOSE'] },
    { name: 'PRODUCTION_STRATEGY', reads: ['SCENE', 'COMPOSE', 'product'] },
    { name: 'PRODUCTION', reads: ['PRODUCTION_STRATEGY', 'headline', 'claim', 'price'] },
    { name: 'CRITICS', reads: ['PRODUCTION'] },
  ],
});

export const CREATIVE_CODE_TABLE = Object.freeze(Object.fromEntries(Object.entries(CODE_MAP).map(([code, m]) => [code, { category: m.category, domain_code: m.domain_code }])));

/** Registers the Creative Brain codes. A BRAIN_PORT_FAILED error is classified from its safe provider diagnostics (a timeout is not a refusal). */
export function registerCreative(registry) {
  return registry.register('creative', CREATIVE_CODE_TABLE, {
    classifyUnknown(error, where) {
      if (error?.code === BRAIN_ERROR.RULE_VIOLATION) {
        // two equal keys in one JSON object are a protocol failure of the provider's answer; every other rule violation is a creative rule
        if (error.detail?.problem === 'DUPLICATE_KEY') return makeCoreError({ ...where, category: C.PROTOCOL_ERROR, code: 'PROVIDER_DUPLICATE_KEYS', domain_code: BRAIN_ERROR.RULE_VIOLATION });
        return makeCoreError({ ...where, category: C.DOMAIN_RULE_VIOLATION, code: BRAIN_ERROR.RULE_VIOLATION, domain_code: 'BRAIN_RELATION_OR_RULE', diagnostics: { problem: error.detail?.problem } });
      }
      if (error?.code === BRAIN_ERROR.PORT_FAILED) return classifyProviderFailure({ status: error.detail?.status, code: error.detail?.code, name: error.detail?.name, message: error.detail?.code }, where);
      const cause = error?.cause ?? error?.root_cause;
      if (typeof cause === 'string' && (BRAIN_CAUSE_MAP[cause] || RUNTIME_CAUSE_MAP[cause])) return makeCoreError({ ...where, category: BRAIN_CAUSE_MAP[cause] ?? RUNTIME_CAUSE_MAP[cause], code: cause });
      return null;
    },
  });
}

/** Maps a stopped Brain plan (its `error` record from the benchmark summary) to a CoreError. The creative cause stays as the code. */
export function coreErrorOfBrainStop(stop, { tenant = null } = {}) {
  const category = BRAIN_CAUSE_MAP[stop?.cause] ?? C.FATAL_SYSTEM_ERROR;
  return makeCoreError({ category, code: stop?.cause ?? 'UNCLASSIFIED_BRAIN_STOP', domain_code: stop?.code ?? null, module: 'creative', stage: stop?.brain_stage ?? 'unknown', tenant, evidence_ref: stop?.evidence?.request_id ?? null, diagnostics: { field: stop?.field, problem: stop?.problem }, unmapped: !BRAIN_CAUSE_MAP[stop?.cause] });
}
