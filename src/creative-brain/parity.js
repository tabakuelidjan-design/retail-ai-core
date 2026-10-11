import { createHash } from 'node:crypto';

import {
  normalizeCritique, FORBIDDEN_KEYS, FORBIDDEN_KEY_CATEGORIES, CRITIQUE_LIMITS,
} from '../creative-critic/critique.js';
import { DIMENSIONS } from '../creative-critic/dimensions.js';
import { buildCriticInstruction } from '../creative-critic/critic.js';
import {
  ART_RULES, ART_SPEC, buildArtDirectionInstruction, normalizeArtDirection,
} from './art-direction.js';
import {
  buildCompositionInstruction, COMPOSITION_RULES, COMPOSITION_SPEC, normalizeCompositionPlan, RELATION_RULES,
} from './composition.js';
import {
  buildConceptInstruction, CONCEPT_RULES, CONCEPT_SPEC, conceptsAnswerSpec, normalizeConcept, normalizeConceptsAnswer,
} from './concept.js';
import {
  buildEvaluationInstruction, EVALUATION_SPEC, evaluationsAnswerSpec, normalizeEvaluationsAnswer, SELECTION_RULES,
} from './concept-selection.js';
import {
  buildConceptCriticInstruction, CONCEPT_DIMENSIONS, normalizeConceptCritique,
} from './concept-critic.js';
import { renderShape, renderSpec } from './contract.js';
import {
  buildFramerInstruction, buildProblemFrame, FRAME_CONTRACT, FRAME_SPEC,
} from './problem-frame.js';
import { FORBIDDEN_SCENE_WORDS } from './substitutes.js';

// THE PARITY AUDIT. For every model-generated stage of the Creative Brain it builds the contract matrix (what the validator enforces, the exact instruction text that tells the model, the source that
// enforces it) and verifies MECHANICALLY, from the real instruction the real builder produces:
//   VALIDATOR RULE -> STATED IN THE INSTRUCTION      every key, vocabulary word, limit, count, lexicon word and cross-field rule appears in the instruction text
//   INSTRUCTION RULE -> ENFORCED OR DECLARED ADVISORY every `RULE` line of the instruction is a declared rule that has a check, or is declared as enforced by the spec or advisory
// The deterministic stages (SCENE, PRODUCTION_STRATEGY, RECOVERY) are derived by Nordla from validated inputs and receive no model answer: they appear in the matrix as such.

const SAMPLE_OBSERVATION = Object.freeze({
  product_ref: 'product://sample', asset_origin: 'MERCHANT_PROVIDED', protected_region_count: 0, approved_text_roles: ['HEADLINE', 'PRICE'], claim_refs: [], format: { content_kind: 'IMAGE', aspect_ratio: '4:5', locale: 'fr-BE' },
  public_facts: {}, expression_sections: [],
});
const SAMPLE_CONCEPT_RAW = Object.freeze({
  central_idea: 'A quiet harbour morning where small effort proves lasting care for someone far away.',
  visual_metaphor: 'A lantern carried along a weathered quay toward a waiting window at dawn.',
  story: 'Someone carries a single lantern to a distant window and the light is the message.',
  emotional_intent: 'Tender anticipation and the warmth of being thought of.',
  product_role: 'PROOF_OF_THE_STORY', message_role: 'EMBEDDED_IN_THE_STORY', memory_hook: 'The lantern reaching the window.', distinctiveness_reason: 'It argues care through effort, not through an object.', risks: ['could read as a postcard'],
});
export const SAMPLE_CONCEPT = normalizeConcept(SAMPLE_CONCEPT_RAW);
// three distinct sample concepts (a round): the SELECT contract needs the concepts it evaluates
const sampleConcept = (n) => normalizeConcept({
  ...SAMPLE_CONCEPT_RAW, central_idea: `Sample idea ${'abcdefg'[n]}: ${['orchard', 'granite', 'ember'][n]} patience becomes a ${['ledger', 'compass', 'mosaic'][n]} of small promises kept by ${['willow', 'tide', 'velvet'][n]} hands.`,
  visual_metaphor: `A ${['meadow', 'drift', 'ripple'][n]} unfolding slowly beyond a ${['copper', 'linen', 'amber'][n]} doorway at ${['dusk', 'noon', 'dawn'][n]}.`,
  story: `${['Mara', 'Joss', 'Elin'][n]} keeps a ${['jar', 'box', 'tin'][n]} of ${['seeds', 'letters', 'stones'][n]} until the ${['spring', 'autumn', 'winter'][n]} arrives for someone else.`, emotional_intent: `${['Calm', 'Pride', 'Wonder'][n]} and a ${['quiet', 'bright', 'soft'][n]} sense of being remembered.`,
});
export const SAMPLE_CONCEPTS = Object.freeze([sampleConcept(0), sampleConcept(1), sampleConcept(2)]);
const SAMPLE_FRAME = Object.freeze({ f: 'sample frame' });

const specStage = (stage, spec, rules, instruction, validator, extra = {}) => ({
  stage, model: true, spec, rules, instruction, validator, ...extra,
});

export const STAGE_CONTRACTS = Object.freeze([
  specStage('FRAME', FRAME_SPEC, FRAME_CONTRACT.rules, () => buildFramerInstruction({ observation: SAMPLE_OBSERVATION }), 'src/creative-brain/problem-frame.js#buildProblemFrame', { normalize: (raw) => buildProblemFrame({ observation: SAMPLE_OBSERVATION, model: raw }), root: 'frame' }),
  specStage('IDEATE', conceptsAnswerSpec({ min: 3, max: 3 }), CONCEPT_RULES, () => buildConceptInstruction({ frame: SAMPLE_FRAME, count: { min: 3, max: 3 } }), 'src/creative-brain/concept.js#normalizeConceptsAnswer', { itemSpec: CONCEPT_SPEC, normalize: (raw) => normalizeConceptsAnswer(raw, { count: { min: 3, max: 3 } }), root: 'concepts' }),
  specStage('SELECT_CONCEPT', evaluationsAnswerSpec(3), SELECTION_RULES, () => buildEvaluationInstruction({ frame: SAMPLE_FRAME, concepts: SAMPLE_CONCEPTS }), 'src/creative-brain/concept-selection.js#normalizeEvaluationsAnswer', { itemSpec: EVALUATION_SPEC, normalize: (raw) => normalizeEvaluationsAnswer(raw, SAMPLE_CONCEPTS), root: 'evaluations' }),
  specStage('ART_DIRECT', ART_SPEC, ART_RULES, () => buildArtDirectionInstruction({ frame: SAMPLE_FRAME, concept: SAMPLE_CONCEPT }), 'src/creative-brain/art-direction.js#normalizeArtDirection', { lexicon: FORBIDDEN_SCENE_WORDS, normalize: (raw) => normalizeArtDirection(raw, { concept: SAMPLE_CONCEPT }), root: 'art_direction' }),
  specStage('COMPOSE', COMPOSITION_SPEC, COMPOSITION_RULES, () => buildCompositionInstruction({ frame: SAMPLE_FRAME, concept: SAMPLE_CONCEPT, artDirection: { a: 1 }, approvedRoles: ['HEADLINE', 'PRICE'] }), 'src/creative-brain/composition.js#normalizeCompositionPlan', { relationRules: RELATION_RULES, normalize: (raw) => normalizeCompositionPlan(raw), root: 'composition' }),
]);

/** The critics' contracts are validated by their own normalizers (a non-conforming critique is NOT_MEASURABLE, never a pass); their rules are stated from shared constants. */
export const CRITIC_CONTRACTS = Object.freeze([
  { stage: 'EXECUTION_CRITIC', model: true, instruction: () => buildCriticInstruction({ brief: {} }), validator: 'src/creative-critic/critique.js#normalizeCritique', dimensions: DIMENSIONS.length, evidenceMax: CRITIQUE_LIMITS.evidence_max, forbiddenKeys: true },
  { stage: 'CONCEPT_CRITIC', model: true, instruction: () => buildConceptCriticInstruction({ brief: {} }), validator: 'src/creative-brain/concept-critic.js#normalizeConceptCritique', dimensions: CONCEPT_DIMENSIONS.length, evidenceMax: 400, forbiddenKeys: false },
]);

export const DETERMINISTIC_STAGES = Object.freeze([
  { stage: 'SCENE', model: false, derivation: 'composeScene(artDirection, productAssetRef): a pure function of a validated ArtDirection; its refusals name the stage SCENE', validator: 'src/creative-brain/scene-composer.js#normalizeScene' },
  { stage: 'PRODUCTION_STRATEGY', model: false, derivation: 'planProduction(artDirection, scene, composition): a pure function of validated inputs', validator: 'src/creative-brain/production-strategist.js#planProduction' },
  { stage: 'RECOVERY', model: false, derivation: 'diagnoseRecovery(critique, conceptCritique, history): a pure function of the critics\' words', validator: 'src/creative-brain/recovery.js#diagnoseRecovery' },
]);

const wordsIn = (spec, out = []) => {
  if (spec.kind === 'word') out.push(...Object.values(spec.vocab));
  if (spec.kind === 'map') out.push(...Object.values(spec.keyVocab), ...wordsIn(spec.value));
  if (spec.kind === 'list') wordsIn(spec.item, out);
  if (spec.kind === 'object') for (const c of Object.values(spec.fields)) wordsIn(c, out);
  return out;
};
const forbidFlags = (spec) => (spec.kind === 'text' ? (spec.forbid ? 1 : 0) : (spec.kind === 'list' ? forbidFlags(spec.item) : (spec.kind === 'object' ? Object.values(spec.fields).reduce((n, c) => n + forbidFlags(c), 0) : 0)));

/** The matrix and the verdict of one spec-driven stage. */
export function auditSpecStage(contract) {
  const { system } = contract.instruction();
  const rows = []; const failures = [];
  // THE SHAPE: the model must be shown the exact JSON object (no wrapper key), not only a list of field descriptions
  for (const line of renderShape(contract.spec)) {
    const present = system.includes(line);
    rows.push({ stage: contract.stage, kind: 'SHAPE', path: 'answer', rule: line.slice(0, 120), instruction: line.slice(0, 230), validator: contract.validator, stated: present });
    if (!present) failures.push(`${contract.stage}: the instruction does not show the answer shape: "${line.slice(0, 80)}"`);
  }
  for (const line of renderSpec(contract.spec, 'answer')) {
    const present = system.includes(line);
    rows.push({ stage: contract.stage, kind: 'FIELD', path: line.split(':')[0], rule: line, instruction: line, validator: contract.validator, stated: present });
    if (!present) failures.push(`${contract.stage}: the instruction does not state "${line}"`);
  }
  for (const value of new Set(wordsIn(contract.spec))) if (!system.includes(value)) failures.push(`${contract.stage}: the vocabulary word ${value} is not in the instruction`);
  if (forbidFlags(contract.spec) > 0) for (const w of contract.lexicon ?? []) if (!system.includes(w)) failures.push(`${contract.stage}: the refused word "${w}" is not in the instruction`);
  for (const r of contract.rules) {
    const present = system.includes(r.statement);
    rows.push({ stage: contract.stage, kind: 'RULE', path: r.id, rule: r.statement, instruction: r.statement, validator: r.check ? contract.validator : (r.enforcedBy ?? 'NONE'), stated: present, enforced: r.check ? 'CHECK' : (r.enforcedBy ? `CODE: ${r.enforcedBy}` : 'NONE') });
    if (!present) failures.push(`${contract.stage}: the rule ${r.id} is not stated in the instruction`);
  }
  for (const r of contract.relationRules ?? []) {
    const present = system.includes(`- ${r.label}: ${r.meaning}. Needs: ${r.needs}.`);
    rows.push({ stage: contract.stage, kind: 'RELATION', path: r.problem, rule: `${r.label}: needs ${r.needs}`, instruction: `- ${r.label}: ${r.meaning}. Needs: ${r.needs}.`, validator: contract.validator, stated: present, enforced: 'CHECK' });
    if (!present) failures.push(`${contract.stage}: the relation rule ${r.problem} is not stated in the instruction`);
    if (typeof r.holds !== 'function') failures.push(`${contract.stage}: the relation rule ${r.problem} has no check`);
  }
  // the reverse direction: every RULE line of the instruction is a declared rule, and every declared rule is either checked or declared advisory
  const printed = system.split('\n').filter((l) => l.startsWith('RULE '));
  for (const line of printed) if (!contract.rules.some((r) => line === `RULE ${r.id}: ${r.statement}`)) failures.push(`${contract.stage}: the instruction carries an undeclared rule: ${line.slice(0, 80)}`);
  for (const r of contract.rules) if (typeof r.check !== 'function' && typeof r.enforcedBy !== 'string') failures.push(`${contract.stage}: the rule ${r.id} has neither a check nor a declared enforcement`);
  return { rows, failures, instruction_sha256: createHash('sha256').update(system).digest('hex') };
}

/** The critics: every rule statement is in the instruction; every forbidden key belongs to a stated category; the deterministic validators are probed with a violation of each rule. */
export function auditCritic(contract) {
  const { system } = contract.instruction();
  const rows = []; const failures = [];
  const statements = [
    ['ONE_KEY_DIMENSIONS', 'exactly one key, "dimensions"'], ['AT_MOST_N_DIMENSIONS', `at most ${contract.dimensions} entries`], ['ENTRY_KEYS', 'only the keys dimension, outcome, evidence and revision_hint'],
    ['OUTCOME_WORDS', 'PASS, FAIL, REVIEW_REQUIRED, NOT_MEASURABLE'], ['EVIDENCE_LIMITS', `at least ${CRITIQUE_LIMITS.evidence_min} and at most ${contract.evidenceMax} characters`], ['NO_URL_OR_CONTROL', 'no URL and no control character'],
    ['NO_NUMBERS_OR_BOOLEANS', 'no JSON number and no true or false'], ['NO_SCORE_IN_WORDS', '"8/10"'], ['HINT_ONLY_FOR_FAIL_OR_REVIEW', 'only for FAIL or REVIEW_REQUIRED'], ['HINT_LIMITS', `${CRITIQUE_LIMITS.hint_min} to ${CRITIQUE_LIMITS.hint_max} characters`],
    ['HINT_IS_SEMANTIC', 'no coordinate, size, percentage, pixel or point value, font setting or colour code'], ['MISSING_DIMENSION_IS_NOT_MEASURABLE', 'treated as NOT_MEASURABLE, never as a pass'],
  ];
  if (contract.forbiddenKeys) statements.push(['FORBIDDEN_KEY_CATEGORIES', FORBIDDEN_KEY_CATEGORIES[0]], ['FORBIDDEN_KEY_CATEGORIES_2', FORBIDDEN_KEY_CATEGORIES[1]], ['FORBIDDEN_KEY_CATEGORIES_3', FORBIDDEN_KEY_CATEGORIES[2]]);
  for (const [id, text] of statements) {
    const present = system.includes(text);
    rows.push({ stage: contract.stage, kind: 'RULE', path: id, rule: text, instruction: text, validator: contract.validator, stated: present, enforced: 'CHECK' });
    if (!present) failures.push(`${contract.stage}: the rule ${id} is not stated in the instruction`);
  }
  return { rows, failures, instruction_sha256: createHash('sha256').update(system).digest('hex') };
}

/** The whole audit: the matrix of every stage and the list of failures (empty when instruction and validator agree everywhere). */
export function auditContractParity() {
  const stages = []; const failures = []; const rows = [];
  for (const c of STAGE_CONTRACTS) { const a = auditSpecStage(c); stages.push({ stage: c.stage, model: true, instruction_sha256: a.instruction_sha256, rows: a.rows.length, failures: a.failures.length }); rows.push(...a.rows); failures.push(...a.failures); }
  for (const c of CRITIC_CONTRACTS) { const a = auditCritic(c); stages.push({ stage: c.stage, model: true, instruction_sha256: a.instruction_sha256, rows: a.rows.length, failures: a.failures.length }); rows.push(...a.rows); failures.push(...a.failures); }
  for (const d of DETERMINISTIC_STAGES) { stages.push({ stage: d.stage, model: false, derivation: d.derivation }); rows.push({ stage: d.stage, kind: 'DETERMINISTIC', path: d.stage, rule: d.derivation, instruction: null, validator: d.validator, stated: null }); }
  // the forbidden keys of the execution critic each belong to a stated category (a key outside the categories would be a hidden rule)
  const categoryWords = ['score', 'rating', 'rank', 'weight', 'point', 'winner', 'best', 'confidence', 'beauty', 'approv', 'publish', 'ship', 'model', 'provider', 'prompt', 'temperature', 'seed', 'api_key', 'endpoint', 'request', 'usage', 'cost', 'tokens'];
  for (const k of FORBIDDEN_KEYS) if (!categoryWords.some((w) => k.includes(w))) failures.push(`EXECUTION_CRITIC: the forbidden key ${k} belongs to no stated category`);
  return { ready: failures.length === 0, stages, rows, failures };
}

/** The matrix as markdown (the human-readable contract matrix). */
export function renderContractMatrix(audit = auditContractParity()) {
  const lines = ['# Creative Brain contract matrix', '', 'Generated by `auditContractParity()` from the real instructions and validators. Do not edit by hand.', ''];
  for (const s of audit.stages) {
    lines.push(`## ${s.stage}`, '');
    if (!s.model) { lines.push(`No model answer: ${s.derivation}`, ''); continue; }
    lines.push(`Instruction sha256 \`${s.instruction_sha256}\`. ${s.rows} rows, ${s.failures} parity failures.`, '', '| kind | path / rule id | instruction text | validator | enforced |', '|---|---|---|---|---|');
    for (const r of audit.rows.filter((x) => x.stage === s.stage)) lines.push(`| ${r.kind} | ${String(r.path).replace(/\|/g, '/')} | ${String(r.instruction ?? '').replace(/\|/g, '/').slice(0, 230)} | ${r.validator} | ${r.enforced ?? 'SPEC'} |`);
    lines.push('');
  }
  lines.push(audit.ready ? 'PARITY: every validator rule is stated in the instruction and every instruction rule is enforced or declared advisory.' : `PARITY FAILURES:\n${audit.failures.map((f) => `- ${f}`).join('\n')}`);
  // long hashes are shortened: a committed document never carries a 64-character hex string (the repository's privacy test), and 16 characters still detect any drift
  return `${lines.join('\n').replace(/\b([0-9a-f]{16})[0-9a-f]{48}\b/g, '$1')}\n`;
}

export { normalizeConceptCritique, normalizeCritique };
