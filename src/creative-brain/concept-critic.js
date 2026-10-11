import { createHash } from 'node:crypto';

import { assertSemanticHint, CRITIQUE_LIMITS, critiqueRuleStatements } from '../creative-critic/critique.js';
import { OUTCOME } from '../creative-critic/dimensions.js';
import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import { parseJsonObject } from './model-port.js';
import {
  BRAIN_ERROR, BrainError, closed, deepFreeze, deriveId, enumOf, fail, listOf, noNumbers, oneLine,
} from './validation.js';

// CRITIC EXPANSION. The critic keeps its 14 dimensions untouched. The concept-level qualities are judged SEPARATELY, on the rendered image, in the same words (PASS / FAIL / REVIEW_REQUIRED /
// NOT_MEASURABLE), each with visual evidence, never as one score. This is what lets Nordla say "the execution is clean but the concept is weak" (which is what the third benchmark candidate was), and the
// creative-quality state below makes sure that green deterministic gates and a clean composition are never read as premium creative quality.

export const CONCEPT_DIMENSION = Object.freeze({
  CONCEPT_STRENGTH: 'CONCEPT_STRENGTH',
  NARRATIVE_COHESION: 'NARRATIVE_COHESION',
  EMOTIONAL_RESONANCE: 'EMOTIONAL_RESONANCE',
  EDITORIAL_SOPHISTICATION: 'EDITORIAL_SOPHISTICATION',
  DISTINCTIVENESS: 'DISTINCTIVENESS',
  WOW_FACTOR: 'WOW_FACTOR',
});
export const CONCEPT_DIMENSIONS = Object.freeze(Object.values(CONCEPT_DIMENSION));
export const CONCEPT_CRITIQUE_VERSION = 'concept-critique@1';

export const CONCEPT_DIMENSION_QUESTIONS = Object.freeze({
  CONCEPT_STRENGTH: 'Looking only at the image: is there one strong central visual idea that the whole composition serves, rather than a tidy arrangement of a product, a background and text?',
  NARRATIVE_COHESION: 'Do the scene, the light, the space, the product and the texts tell one coherent story that a viewer feels at a glance?',
  EMOTIONAL_RESONANCE: 'Does the image evoke a feeling that fits an occasion and the meaning the product has for the person who gives or receives it?',
  EDITORIAL_SOPHISTICATION: 'Does the image have the composition, restraint and typographic intelligence of an art-directed editorial piece, rather than a retail template?',
  DISTINCTIVENESS: 'Could only this brand and this product have produced this image, or could any competitor publish it unchanged?',
  WOW_FACTOR: 'Is there a memorable moment that makes a viewer stop, beyond being correct, clean and well organized?',
});

// a score hidden in words ("8/10", "rated 4 out of 5") is still a score
const SCORE_IN_TEXT = /\b\d+(\.\d+)?\s*(\/|out of)\s*(5|10|100)\b|\b(score|rating|rated|grade)\b\s*[:=]?\s*\d|\b\d{1,3}\s*(points?|pts)\b/i;
const OUTCOMES = Object.values(OUTCOME);

/** A concept-level critique from a model's answer: only the six dimensions, only the four outcomes, evidence for every judgment, semantic hints, no score. Unanswered dimensions are NOT_MEASURABLE. */
export function normalizeConceptCritique(raw, { candidate_ref: ref, candidate_sha256: sha }) {
  if (typeof ref !== 'string' || !ref || !/^[0-9a-f]{64}$/.test(sha ?? '')) fail(BRAIN_ERROR.MALFORMED, 'a concept critique is about one identified candidate (ref + sha256)', 'context');
  noNumbers(raw, 'concept_critique');
  closed(raw, ['dimensions'], 'concept_critique');
  const seen = new Map();
  listOf(raw.dimensions, 'concept_critique.dimensions', { min: 0, max: CONCEPT_DIMENSIONS.length }, (d, where) => {
    if (!d || typeof d !== 'object') fail(BRAIN_ERROR.MALFORMED, `${where} must be an object`, where);
    for (const key of Object.keys(d)) if (!['dimension', 'outcome', 'evidence', 'revision_hint'].includes(key)) fail(BRAIN_ERROR.UNKNOWN_KEY, `${where}.${key} is not part of this contract`, `${where}.${key}`);
    const dimension = enumOf(d.dimension, CONCEPT_DIMENSION, `${where}.dimension`);
    if (seen.has(dimension)) fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.dimension repeats a dimension`, `${where}.dimension`);
    const outcome = enumOf(d.outcome, Object.fromEntries(OUTCOMES.map((o) => [o, o])), `${where}.outcome`);
    const judged = outcome !== OUTCOME.NOT_MEASURABLE;
    const evidence = judged ? oneLine(d.evidence, `${where}.evidence`, { min: CRITIQUE_LIMITS.evidence_min, max: 400 }) : oneLine(d.evidence || 'No visual evidence was given.', `${where}.evidence`, { max: 400 });
    if (/https?:\/\//i.test(evidence)) fail(BRAIN_ERROR.TEXT_INVALID, `${where}.evidence holds a URL`, `${where}.evidence`);
    if (SCORE_IN_TEXT.test(evidence)) fail(BRAIN_ERROR.NUMERIC_VALUE, `${where}.evidence holds a numeric score`, `${where}.evidence`);
    const asks = outcome === OUTCOME.FAIL || outcome === OUTCOME.REVIEW_REQUIRED;
    const hint = d.revision_hint == null || d.revision_hint === '' ? null : assertSemanticHint(d.revision_hint, `${where}.revision_hint`);
    if (hint && !asks) fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.revision_hint is only for a FAIL or REVIEW_REQUIRED dimension`, `${where}.revision_hint`);
    seen.set(dimension, { dimension, outcome, evidence, revision_hint: hint });
    return dimension;
  });
  const dimensions = CONCEPT_DIMENSIONS.map((dimension) => seen.get(dimension) ?? { dimension, outcome: OUTCOME.NOT_MEASURABLE, evidence: 'The model gave no answer for this dimension.', revision_hint: null });
  const body = { schema_version: CONCEPT_CRITIQUE_VERSION, candidate_ref: ref, candidate_sha256: sha, dimensions };
  return deepFreeze({ critique_id: deriveId('ccc', body), ...body });
}

export const notMeasurableConceptCritique = (context, reason) => normalizeConceptCritique({ dimensions: CONCEPT_DIMENSIONS.map((dimension) => ({ dimension, outcome: OUTCOME.NOT_MEASURABLE, evidence: `Not assessed: ${reason}.` })) }, context);

export function buildConceptCriticInstruction({ brief = {} } = {}) {
  const system = [
    'You are the Nordla concept critic. You look at ONE rendered marketing image and judge its CONCEPT-LEVEL qualities, dimension by dimension, as a demanding creative director would.',
    'You judge only what you can SEE. The correctness of claims and prices, the identity of the product, fonts and brand rules are verified elsewhere: assume them correct. A clean, well-organized image can still have a weak concept: say so.',
    'Return ONLY one JSON object: { "dimensions": [ { "dimension": "...", "outcome": "...", "evidence": "...", "revision_hint": "..." } ] } with exactly one entry per dimension listed below.',
    'outcome is PASS, FAIL, REVIEW_REQUIRED or NOT_MEASURABLE. evidence is one or two concrete sentences about what is visible. revision_hint (only for FAIL or REVIEW_REQUIRED) is one sentence about the INTENT of a change in plain words: never coordinates, sizes, pixel or percentage values, font names or colour codes.',
    'Never give a score, a rating, a number out of ten or a winner. Never say whether the image is approved: you give an opinion, a person decides.',
    ...critiqueRuleStatements({ dimensions: CONCEPT_DIMENSIONS.length, evidenceMax: 400, forbiddenKeys: false }),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.CRITIQUE, domains: ['STORYTELLING', 'DISTINCTIVENESS', 'OCCASION_INTELLIGENCE', 'PREMIUM_CRAFT'] })),
  ].join('\n');
  const user = ['THE BRIEF (public facts):', JSON.stringify(brief.public_facts ?? {}), 'THE DIMENSIONS (answer every one):', ...CONCEPT_DIMENSIONS.map((d) => `- ${d}: ${CONCEPT_DIMENSION_QUESTIONS[d]}`)].join('\n');
  return { system, user };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The concept critic behind a vision-language port (same port as the 14-dimension critic). A failure or a non-conforming answer is NOT_MEASURABLE, never a pass. */
export function createConceptCritic({ vlm }) {
  if (typeof vlm?.invoke !== 'function') throw new TypeError('a vision-language port is required');
  return Object.freeze({
    async critique({ candidate, brief }) {
      const png = candidate?.png_bytes; const ref = candidate?.ref;
      if (typeof ref !== 'string' || !ref) throw new TypeError('candidate.ref is required');
      const context = { candidate_ref: ref, candidate_sha256: sha256(png ?? new Uint8Array()) };
      if (!png || png.length < 8) return { critique: notMeasurableConceptCritique(context, 'there is no rendered image to look at'), provenance: { called: false, reason: 'NO_VISUAL_EVIDENCE' } };
      let reply;
      try { reply = await vlm.invoke({ ...buildConceptCriticInstruction({ brief }), images: [{ label: 'candidate', media_type: 'image/png', bytes: png }] }); } catch (error) {
        return { critique: notMeasurableConceptCritique(context, 'the vision model could not be reached'), provenance: { called: true, failure: { code: error?.code ?? null, status: error?.status ?? null, request_id: error?.requestId ?? null } } };
      }
      const provenance = { called: true, model: reply.model ?? null, request_id: reply.request_id ?? null, usage: reply.usage ?? null, cost_eur: reply.cost_eur ?? null };
      try { return { critique: normalizeConceptCritique(parseJsonObject(reply.text, 'concept_critique'), context), provenance }; } catch (error) {
        if (!(error instanceof BrainError) && !error?.code) throw error;
        return { critique: notMeasurableConceptCritique(context, 'the model answer did not conform to the concept critique contract'), provenance: { ...provenance, rejected: { code: error.code ?? null, field: error.field ?? null } } };
      }
    },
  });
}

// ---- the creative-quality state
export const CREATIVE_QUALITY = Object.freeze({
  NOT_TECHNICALLY_VALID: 'NOT_TECHNICALLY_VALID',
  TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT: 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT',
  CREATIVELY_SUFFICIENT_AWAITING_OWNER: 'CREATIVELY_SUFFICIENT_AWAITING_OWNER',
  NOT_MEASURABLE: 'NOT_MEASURABLE',
});
const flagged = (d) => d.outcome === OUTCOME.FAIL || d.outcome === OUTCOME.REVIEW_REQUIRED;

/**
 * Green deterministic gates never imply premium creative quality. The state is derived from the gates, the 14-dimension critique and the concept critique:
 *   NOT_TECHNICALLY_VALID                              a deterministic gate did not pass (Preflight, Fidelity, Brand Guardian)
 *   NOT_MEASURABLE                                     a critique is missing or could not judge
 *   TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT      the gates pass but something creative is not met (the canonical case: clean execution, weak concept)
 *   CREATIVELY_SUFFICIENT_AWAITING_OWNER               every dimension passes: an opinion, never an approval; only the owner approves
 */
export function creativeQualityState({ critique, conceptCritique, deterministic = {} }) {
  const gates = [deterministic.preflight, deterministic.fidelity, deterministic.guardian];
  const technicallyValid = gates.every((g) => g === 'PASS');
  const execution = critique?.dimensions ?? []; const concept = conceptCritique?.dimensions ?? [];
  const weakConcept = concept.some(flagged);
  const executionClean = !execution.some((d) => d.outcome === OUTCOME.FAIL);
  const measurable = execution.length === 14 && concept.length === CONCEPT_DIMENSIONS.length && !execution.every((d) => d.outcome === OUTCOME.NOT_MEASURABLE) && !concept.every((d) => d.outcome === OUTCOME.NOT_MEASURABLE);
  let state;
  if (!technicallyValid) state = CREATIVE_QUALITY.NOT_TECHNICALLY_VALID;
  else if (!measurable) state = CREATIVE_QUALITY.NOT_MEASURABLE;
  else if (execution.every((d) => d.outcome === OUTCOME.PASS) && concept.every((d) => d.outcome === OUTCOME.PASS)) state = CREATIVE_QUALITY.CREATIVELY_SUFFICIENT_AWAITING_OWNER;
  else state = CREATIVE_QUALITY.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT;
  return deepFreeze({
    state,
    technically_valid: technicallyValid,
    execution_clean: technicallyValid && executionClean,
    weak_concept: weakConcept,
    diagnosis: technicallyValid && executionClean && weakConcept ? 'EXECUTION_IS_CLEAN_BUT_THE_CONCEPT_IS_WEAK' : null,
    premium_quality_implied: false, // by construction: no gate, no clean composition and no critic opinion implies it
    owner_approval: 'PENDING',
  });
}
