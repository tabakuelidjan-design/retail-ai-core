import { RELATION_PROBLEMS } from '../creative-brain/composition.js';

// The exact cause of a stopped Creative Brain plan, from the stage that failed and the safe code of its error. A stop is never reported as "the plan stopped": it names the stage, the round and one
// cause from this closed list. NO_CONCEPT_MEETS_BAR is a VALID rejection by the Brain (the quality bar is never lowered to force a candidate), not a defect.

export const BRAIN_FAILURE = Object.freeze({
  COMPOSITION_OUTPUT_INVALID: 'COMPOSITION_OUTPUT_INVALID',
  COMPOSITION_RELATIONS_CONTRADICTORY: 'COMPOSITION_RELATIONS_CONTRADICTORY',
  PROBLEM_FRAME_INVALID: 'PROBLEM_FRAME_INVALID',
  IDEATION_PROVIDER_FAILURE: 'IDEATION_PROVIDER_FAILURE',
  CONCEPT_OUTPUT_INVALID: 'CONCEPT_OUTPUT_INVALID',
  CONCEPTS_NOT_DISTINCT: 'CONCEPTS_NOT_DISTINCT',
  NO_CONCEPT_MEETS_BAR: 'NO_CONCEPT_MEETS_BAR',
  CONCEPT_SELECTION_PROVIDER_FAILURE: 'CONCEPT_SELECTION_PROVIDER_FAILURE',
  CONCEPT_SELECTION_INVALID: 'CONCEPT_SELECTION_INVALID',
  ART_DIRECTION_PROVIDER_FAILURE: 'ART_DIRECTION_PROVIDER_FAILURE',
  ART_DIRECTION_INVALID: 'ART_DIRECTION_INVALID',
  COMPOSITION_PLAN_INVALID: 'COMPOSITION_PLAN_INVALID',
  CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT: 'CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT',
  VALID_CREATIVE_BRAIN_REJECTION: 'VALID_CREATIVE_BRAIN_REJECTION',
});

/** @param {object} input { stage, name, code, problem } : the Brain stage that failed (error.brain_stage) and the safe facts of its error */
export function classifyBrainFailure({ stage = null, name = null, code = null, problem = null } = {}) {
  if (name !== 'BrainError') return BRAIN_FAILURE.CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT; // a TypeError or any error that is not the Brain's own contract speaking
  const port = code === 'BRAIN_PORT_FAILED';
  switch (stage) {
    case 'FRAME': return BRAIN_FAILURE.PROBLEM_FRAME_INVALID;
    case 'IDEATE':
      if (port) return BRAIN_FAILURE.IDEATION_PROVIDER_FAILURE;
      return problem === 'CONCEPTS_NOT_DISTINCT' ? BRAIN_FAILURE.CONCEPTS_NOT_DISTINCT : BRAIN_FAILURE.CONCEPT_OUTPUT_INVALID;
    case 'SELECT_CONCEPT': return port ? BRAIN_FAILURE.CONCEPT_SELECTION_PROVIDER_FAILURE : BRAIN_FAILURE.CONCEPT_SELECTION_INVALID;
    case 'ART_DIRECT': return port ? BRAIN_FAILURE.ART_DIRECTION_PROVIDER_FAILURE : BRAIN_FAILURE.ART_DIRECTION_INVALID;
    case 'SCENE': return BRAIN_FAILURE.ART_DIRECTION_INVALID; // the scene is derived from the art direction: a scene it cannot carry is an art direction that is not valid
    case 'COMPOSE':
      if (port) return BRAIN_FAILURE.COMPOSITION_PLAN_INVALID;
      return RELATION_PROBLEMS.includes(problem) ? BRAIN_FAILURE.COMPOSITION_RELATIONS_CONTRADICTORY : BRAIN_FAILURE.COMPOSITION_OUTPUT_INVALID;
    case 'PRODUCTION_STRATEGY': case 'PLAN_COHERENCE': return BRAIN_FAILURE.COMPOSITION_PLAN_INVALID;
    default: return BRAIN_FAILURE.CREATIVE_BRAIN_RUNTIME_WIRING_DEFECT;
  }
}
