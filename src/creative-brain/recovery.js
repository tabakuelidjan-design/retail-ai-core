import { OUTCOME } from '../creative-critic/dimensions.js';
import { CONCEPT_DIMENSION } from './concept-critic.js';
import { RECOVERY_ACTION } from './production-strategist.js';
import { deepFreeze } from './validation.js';

// CREATIVE RECOVERY. When a candidate is not good enough, Nordla diagnoses WHAT KIND of failure it is, from the critic's evidence, and chooses how to recover:
//   REFINE      the concept stands; the execution needs local improvement (product integration, price treatment, typography, brand expression, artifacts)
//   RECOMPOSE   the concept stands; the composition is structurally weak (hierarchy, balance, whitespace, a template-like stack): plan the composition again, keep the concept and art direction
//   RECONCEPT   the idea itself is generic, weak or cannot reach the target: invent new concepts, distinct from the rejected one
// A weak concept is never endlessly polished: a concept-level failure, or a concept that has already been refined or recomposed twice without becoming sufficient, is a RECONCEPT.
// The decision is a fixed function of the critic's words (and of the history), never of a model.

export { RECOVERY_ACTION };

const GROUPS = Object.freeze({
  CONCEPT: Object.freeze(Object.values(CONCEPT_DIMENSION)),
  STRUCTURE: Object.freeze(['VISUAL_HIERARCHY', 'TEXT_HIERARCHY', 'COMPOSITION_BALANCE', 'WHITESPACE_BALANCE', 'TEMPLATE_LIKE_APPEARANCE']),
  EXECUTION: Object.freeze(['PRODUCT_INTEGRATION', 'PRICE_INTEGRATION', 'TYPOGRAPHY_COMPOSITION', 'CLAIM_VISIBILITY', 'PRODUCT_PROMINENCE', 'PREMIUM_RETAIL_FEEL', 'BRAND_EXPRESSION', 'AI_ARTIFACTS']),
});
const DECISIVE_CONCEPT = Object.freeze([CONCEPT_DIMENSION.CONCEPT_STRENGTH, CONCEPT_DIMENSION.DISTINCTIVENESS, CONCEPT_DIMENSION.NARRATIVE_COHESION]);
const CONCEPT_FLAGGED_TO_RECONCEPT = 3;
const STRUCTURE_FLAGGED_TO_RECOMPOSE = 2;
const POLISH_LIMIT = 2; // refinements / recompositions of the same concept allowed before the concept itself is blamed

const isFlag = (d) => d.outcome === OUTCOME.FAIL || d.outcome === OUTCOME.REVIEW_REQUIRED;

/**
 * @param {object} input { critique (the 14 dimensions), conceptCritique (the six, optional), history: [{ concept_id, action }] of earlier recoveries, concept_id }
 * @returns {{ action: 'REFINE'|'RECOMPOSE'|'RECONCEPT'|'NONE', reasons, reuse, redo, exhausted }}
 */
export function diagnoseRecovery({ critique, conceptCritique = null, history = [], concept_id: conceptId = null }) {
  const byName = new Map([...(critique?.dimensions ?? []), ...(conceptCritique?.dimensions ?? [])].map((d) => [d.dimension, d]));
  const flaggedIn = (names) => names.map((n) => byName.get(n)).filter((d) => d && isFlag(d));
  const concept = flaggedIn(GROUPS.CONCEPT); const structure = flaggedIn(GROUPS.STRUCTURE); const execution = flaggedIn(GROUPS.EXECUTION);
  const reasons = (list, group) => list.map((d) => ({ dimension: d.dimension, outcome: d.outcome, group }));
  const polished = history.filter((h) => h.concept_id === conceptId && h.action !== RECOVERY_ACTION.RECONCEPT).length;
  const anythingFlagged = concept.length + structure.length + execution.length > 0;
  const decisiveConceptFail = concept.some((d) => DECISIVE_CONCEPT.includes(d.dimension) && d.outcome === OUTCOME.FAIL);
  let action; let why; let exhausted = false;
  if (decisiveConceptFail || concept.length >= CONCEPT_FLAGGED_TO_RECONCEPT) { action = RECOVERY_ACTION.RECONCEPT; why = reasons(concept, 'CONCEPT'); }
  else if (anythingFlagged && polished >= POLISH_LIMIT) { action = RECOVERY_ACTION.RECONCEPT; exhausted = true; why = [...reasons(concept, 'CONCEPT'), ...reasons(structure, 'STRUCTURE'), ...reasons(execution, 'EXECUTION')]; }
  else if (structure.some((d) => d.outcome === OUTCOME.FAIL) || structure.length >= STRUCTURE_FLAGGED_TO_RECOMPOSE) { action = RECOVERY_ACTION.RECOMPOSE; why = reasons(structure, 'STRUCTURE'); }
  else if (anythingFlagged) { action = RECOVERY_ACTION.REFINE; why = [...reasons(concept, 'CONCEPT'), ...reasons(structure, 'STRUCTURE'), ...reasons(execution, 'EXECUTION')]; }
  else { action = 'NONE'; why = []; }
  const plan = {
    REFINE: { reuse: ['PROBLEM_FRAME', 'CONCEPT', 'ART_DIRECTION', 'COMPOSITION_PLAN'], redo: ['SCENE', 'PRODUCTION'] },
    RECOMPOSE: { reuse: ['PROBLEM_FRAME', 'CONCEPT', 'ART_DIRECTION'], redo: ['COMPOSITION_PLAN', 'SCENE', 'PRODUCTION'] },
    RECONCEPT: { reuse: ['PROBLEM_FRAME'], redo: ['CONCEPTS', 'CONCEPT_SELECTION', 'ART_DIRECTION', 'COMPOSITION_PLAN', 'SCENE', 'PRODUCTION'] },
    NONE: { reuse: [], redo: [] },
  }[action];
  return deepFreeze({ action, reasons: why, reuse: plan.reuse, redo: plan.redo, exhausted });
}
