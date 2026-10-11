import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import {
  list, obj, renderContract, renderRules, text, validateSpec, word,
} from './contract.js';
import { askAndNormalize } from './model-port.js';
import {
  BRAIN_ERROR, closed, deepFreeze, enumOf, fail, isPlain, listOf, noNumbers, oneLine,
} from './validation.js';

// SELECT CONCEPT. Concepts are compared on named criteria, each judged in words (MEETS / PARTIAL / FAILS / NOT_ASSESSED) with evidence; there is no number and no beauty score. Nordla derives the
// decision of each concept and the outcome of the round from those words with fixed rules, so the model never decides the outcome:
//   SELECT          one concept clearly stands above the others and meets the bar
//   REFINE_CONCEPT  the best concept is promising but not yet strong enough: refine it before production
//   REJECT_CONCEPT  every concept fails a decisive criterion
//   NO_CLEAR_WINNER several concepts stand and none dominates: the round is not decided

export const CRITERION = Object.freeze({
  CONCEPT_STRENGTH: 'CONCEPT_STRENGTH',
  RELEVANCE_TO_BRIEF: 'RELEVANCE_TO_BRIEF',
  EMOTIONAL_RESONANCE: 'EMOTIONAL_RESONANCE',
  PRODUCT_RELATIONSHIP: 'PRODUCT_RELATIONSHIP',
  DISTINCTIVENESS: 'DISTINCTIVENESS',
  FEASIBILITY: 'FEASIBILITY',
  BRAND_COMPATIBILITY: 'BRAND_COMPATIBILITY',
  COMMERCIAL_CLARITY: 'COMMERCIAL_CLARITY',
  NARRATIVE_COHESION: 'NARRATIVE_COHESION',
  GENERIC_RISK: 'GENERIC_RISK', // MEETS = the risk of a generic or template output is low
});
export const CRITERIA = Object.freeze(Object.values(CRITERION));
export const CRITERION_QUESTIONS = Object.freeze({
  CONCEPT_STRENGTH: 'Is there one strong central idea that the whole image could serve?',
  RELEVANCE_TO_BRIEF: 'Does the concept answer the brief, the audience and the occasion it was framed for?',
  EMOTIONAL_RESONANCE: 'Does the concept evoke a feeling that fits the occasion and the relationship it expresses?',
  PRODUCT_RELATIONSHIP: 'Is the relationship between the concept and the product clear and necessary, and does the concept resolve back to the product?',
  DISTINCTIVENESS: 'Could only this brand, product and occasion produce this concept, rather than any competitor?',
  FEASIBILITY: 'Can the concept be realized with a protected real product, a generated scene and deterministic typography, without a substitute product or an unreadable result?',
  BRAND_COMPATIBILITY: 'Does the concept fit the brand\'s principles, restraint and forbidden territory?',
  COMMERCIAL_CLARITY: 'Does the concept leave the offer, the approved claims and the price clear and easy to find?',
  NARRATIVE_COHESION: 'Do the idea, the metaphor and the story hold together as one coherent narrative?',
  GENERIC_RISK: 'Is the risk low that the result looks like a generic, template or stock-association image?',
});
export const OUTCOME = Object.freeze({ MEETS: 'MEETS', PARTIAL: 'PARTIAL', FAILS: 'FAILS', NOT_ASSESSED: 'NOT_ASSESSED' });
export const SELECTION = Object.freeze({ SELECT: 'SELECT', REFINE_CONCEPT: 'REFINE_CONCEPT', REJECT_CONCEPT: 'REJECT_CONCEPT', NO_CLEAR_WINNER: 'NO_CLEAR_WINNER' });
const DECISION = Object.freeze({ SELECT: 'SELECT', REFINE_CONCEPT: 'REFINE_CONCEPT', REJECT_CONCEPT: 'REJECT_CONCEPT' });

const BLOCKING = Object.freeze([CRITERION.RELEVANCE_TO_BRIEF, CRITERION.BRAND_COMPATIBILITY, CRITERION.FEASIBILITY, CRITERION.COMMERCIAL_CLARITY, CRITERION.PRODUCT_RELATIONSHIP]);
const DECISIVE_CREATIVE = Object.freeze([CRITERION.CONCEPT_STRENGTH, CRITERION.DISTINCTIVENESS, CRITERION.GENERIC_RISK]);
const MAX_PARTIAL_TO_SELECT = 2;
const RANK = Object.freeze({ MEETS: 2, PARTIAL: 1, FAILS: 0, NOT_ASSESSED: 0 });

/** The judgment of one concept: every criterion exactly once, in words, with evidence. */
export function normalizeEvaluation(raw, where = 'evaluation') {
  noNumbers(raw, where);
  // an optional key given as null (a stored evaluation) is an absent key
  const prepared = isPlain(raw) && Array.isArray(raw.criteria) ? { ...raw, criteria: raw.criteria.map((c) => (isPlain(c) && c.refinement == null ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'refinement')) : c)) } : raw;
  const checked = validateSpec(EVALUATION_SPEC, prepared, where);
  const seen = new Map();
  checked.criteria.forEach((c, i) => {
    const w = `${where}.criteria[${i}]`;
    if (seen.has(c.criterion)) fail(BRAIN_ERROR.RULE_VIOLATION, `${w}.criterion repeats a criterion`, `${w}.criterion`);
    const assessed = c.outcome !== OUTCOME.NOT_ASSESSED;
    if (assessed && (c.evidence === undefined || c.evidence.length < EVIDENCE_MIN)) fail(BRAIN_ERROR.TEXT_INVALID, `${w}.evidence must be one line of ${EVIDENCE_MIN}..240 characters`, `${w}.evidence`);
    seen.set(c.criterion, { criterion: c.criterion, outcome: c.outcome, evidence: assessed ? c.evidence : (c.evidence ?? 'Not assessed.'), refinement: c.refinement ?? null });
  });
  // a criterion the model did not judge was not assessed: never a guessed pass
  const criteria = CRITERIA.map((criterion) => seen.get(criterion) ?? { criterion, outcome: OUTCOME.NOT_ASSESSED, evidence: 'The model gave no judgment for this criterion.', refinement: null });
  return deepFreeze({ concept_id: checked.concept_id, criteria });
}

/** One concept's judgment as a model states it: the contract the answer is validated against AND the contract the instruction states. */
export const CRITERION_JUDGMENT_SPEC = obj({ criterion: word(CRITERION), outcome: word(OUTCOME), evidence: text({ max: 240 }), refinement: text({ min: 8, max: 240 }) }, { optional: ['evidence', 'refinement'] });
export const EVALUATION_SPEC = obj({ concept_id: text({ max: 80 }), criteria: list(CRITERION_JUDGMENT_SPEC, { min: 0, max: CRITERIA.length }) });
export const evaluationsAnswerSpec = (count) => obj({ evaluations: list(EVALUATION_SPEC, { min: 1, max: count }) });
export const EVIDENCE_MIN = 12;
export const SELECTION_RULES = Object.freeze([
  { enforcedBy: 'concept-selection.js#selectConcept', id: 'ONE_EVALUATION_PER_CONCEPT', statement: 'give exactly one evaluation for each concept of the round, with its concept_id written exactly as it is given. An evaluation of a concept that is not in the round, or two evaluations of the same concept, is refused.' },
  { enforcedBy: 'concept-selection.js#normalizeEvaluation', id: 'EACH_CRITERION_AT_MOST_ONCE', statement: `each of the ${CRITERIA.length} criteria appears at most once per concept. A criterion you leave out is treated as NOT_ASSESSED, never as a pass.` },
  { enforcedBy: 'concept-selection.js#normalizeEvaluation', id: 'EVIDENCE_WHEN_ASSESSED', statement: `evidence is required (${EVIDENCE_MIN} to 240 characters, concrete) for every outcome except NOT_ASSESSED, where it may be left out. refinement is optional (8 to 240 characters, only meaningful for PARTIAL or FAILS); leave the key out rather than write null.` },
  { id: 'NO_DECISION_KEYS', statement: 'never add a key that is not listed above (no score, rank, winner, selected or decision): Nordla derives the decision.', enforcedBy: 'closed spec (concept-selection.js#normalizeEvaluation)' },
]);

const outcomeOf = (evaluation, criterion) => evaluation.criteria.find((c) => c.criterion === criterion).outcome;

/** The decision for one concept, from its words only. */
export function decideConcept(evaluation) {
  const outcomes = evaluation.criteria.map((c) => c.outcome);
  const fails = outcomes.filter((o) => o === OUTCOME.FAILS).length;
  const partials = outcomes.filter((o) => o === OUTCOME.PARTIAL).length;
  const blockingFail = BLOCKING.some((c) => outcomeOf(evaluation, c) === OUTCOME.FAILS);
  const decisiveFail = DECISIVE_CREATIVE.some((c) => outcomeOf(evaluation, c) === OUTCOME.FAILS);
  const blockingUnassessed = BLOCKING.some((c) => outcomeOf(evaluation, c) === OUTCOME.NOT_ASSESSED);
  // (only two criteria are neither blocking nor decisive, so three failures always include a blocking or decisive one)
  if (blockingFail || decisiveFail) return DECISION.REJECT_CONCEPT;
  const strong = outcomeOf(evaluation, CRITERION.CONCEPT_STRENGTH) === OUTCOME.MEETS && outcomeOf(evaluation, CRITERION.DISTINCTIVENESS) === OUTCOME.MEETS;
  if (fails === 0 && !blockingUnassessed && partials <= MAX_PARTIAL_TO_SELECT && strong) return DECISION.SELECT;
  return DECISION.REFINE_CONCEPT;
}

const rankOf = (evaluation, criterion) => RANK[outcomeOf(evaluation, criterion)];
/** a dominates b: at least as good on every criterion and better on at least one (no weights, no sum). */
export function dominates(a, b) {
  let better = false;
  for (const criterion of CRITERIA) {
    const x = rankOf(a, criterion); const y = rankOf(b, criterion);
    if (x < y) return false;
    if (x > y) better = true;
  }
  return better;
}

function unique(candidates, evaluations) {
  const nonDominated = candidates.filter((a) => !candidates.some((b) => b !== a && dominates(evaluations.get(b), evaluations.get(a))));
  return nonDominated.length === 1 ? nonDominated[0] : null;
}

const summary = (evaluation) => {
  const keys = [CRITERION.CONCEPT_STRENGTH, CRITERION.DISTINCTIVENESS, CRITERION.GENERIC_RISK].map((c) => evaluation.criteria.find((x) => x.criterion === c));
  return oneLine(keys.map((k) => `${k.criterion}=${k.outcome}: ${k.evidence}`).join(' | ').slice(0, 290), 'summary', { max: 300 });
};

/**
 * The outcome of a round of concepts, derived by Nordla from the per-criterion words.
 * @returns {{ outcome, concept_id, decisions: [{ concept_id, decision, evidence }], reasons }}
 */
export function selectConcept({ concepts, evaluations }) {
  const byId = new Map(evaluations.map((e) => [e.concept_id, e]));
  for (const c of concepts) if (!byId.has(c.concept_id)) fail(BRAIN_ERROR.RULE_VIOLATION, 'a concept has no evaluation', 'evaluations');
  if (byId.size !== concepts.length) fail(BRAIN_ERROR.RULE_VIOLATION, 'an evaluation does not belong to a concept of this round', 'evaluations');
  const decisions = concepts.map((c) => ({ concept_id: c.concept_id, decision: decideConcept(byId.get(c.concept_id)), evidence: summary(byId.get(c.concept_id)) }));
  const ofDecision = (d) => decisions.filter((x) => x.decision === d).map((x) => x.concept_id);
  const selectable = ofDecision(DECISION.SELECT);
  const refinable = ofDecision(DECISION.REFINE_CONCEPT);
  let outcome; let conceptId = null; let reasons;
  if (selectable.length) {
    conceptId = unique(selectable, byId);
    outcome = conceptId ? SELECTION.SELECT : SELECTION.NO_CLEAR_WINNER;
    reasons = [conceptId ? 'ONE_CONCEPT_MEETS_THE_BAR_AND_IS_NOT_DOMINATED' : 'SEVERAL_CONCEPTS_MEET_THE_BAR_AND_NONE_DOMINATES'];
  } else if (refinable.length) {
    conceptId = unique(refinable, byId);
    outcome = conceptId ? SELECTION.REFINE_CONCEPT : SELECTION.NO_CLEAR_WINNER;
    reasons = [conceptId ? 'THE_BEST_CONCEPT_IS_PROMISING_BUT_NOT_YET_STRONG_ENOUGH' : 'SEVERAL_CONCEPTS_NEED_REFINEMENT_AND_NONE_DOMINATES'];
  } else { outcome = SELECTION.REJECT_CONCEPT; reasons = ['EVERY_CONCEPT_FAILS_A_DECISIVE_CRITERION']; }
  return deepFreeze({ outcome, concept_id: conceptId, decisions, reasons });
}

export function buildEvaluationInstruction({ frame, concepts }) {
  const system = [
    'You are the Nordla concept selector. You compare creative concepts for one problem frame, criterion by criterion, in words.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(evaluationsAnswerSpec(concepts.length), 'answer'),
    ...renderRules(SELECTION_RULES),
    'outcome MEETS means the expectation is met, PARTIAL that it is arguable, FAILS that it clearly is not, NOT_ASSESSED that you cannot judge it.',
    'Never give a score, a number, a rank or a winner: Nordla derives the decision. Be demanding: a clean idea that any competitor could publish is not distinctive, and a concept that hides the product does not meet the commercial criteria.',
    'The criteria:',
    ...CRITERIA.map((c) => `- ${c}: ${CRITERION_QUESTIONS[c]}`),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.SELECT_CONCEPT })),
  ].join('\n');
  return { system, user: JSON.stringify({ problem_frame: frame, concepts }) };
}

/** A model's whole answer for a round: closed, one evaluation per concept of the round, then Nordla's own decision. Everything that can refuse the answer happens here, so a refusal carries its evidence. */
export function normalizeEvaluationsAnswer(raw, concepts) {
  closed(raw, ['evaluations'], 'answer');
  const evaluations = listOf(raw.evaluations, 'evaluations', { min: 1, max: concepts.length }, (e, w) => normalizeEvaluation(e, w));
  return { evaluations, selection: selectConcept({ concepts, evaluations }) };
}

/** The SELECT stage: one model completion for the judgments, then Nordla's own decision. */
export function createConceptSelector({ complete }) {
  return Object.freeze({
    async select({ frame, concepts }) {
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildEvaluationInstruction({ frame, concepts }), stage: 'SELECT_CONCEPT',
        spec: evaluationsAnswerSpec(concepts.length), normalize: (raw) => normalizeEvaluationsAnswer(raw, concepts),
      });
      return { selection: value.selection, evaluations: value.evaluations, meta };
    },
  });
}
