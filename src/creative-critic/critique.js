import { createHash } from 'node:crypto';

import {
  CREATIVE_STATUS, CRITIQUE_VERSION, DIMENSIONS, OUTCOME,
} from './dimensions.js';

// The trust boundary of the Creative Critic. A model's answer is UNTRUSTED text until it has been normalized here into a strict, closed, immutable Nordla object:
//   - only the 14 dimensions, each exactly once; an unknown or repeated dimension refuses the WHOLE critique (no silent repair); a dimension the model did not answer is NOT_MEASURABLE
//   - only the four outcomes; no number, no boolean, no score, no rating, no rank, no winner, no approval anywhere
//   - evidence in words for every judged dimension (a judgment with no visual evidence is not accepted)
//   - a revision hint is SEMANTIC guidance only: coordinates, sizes, fonts and colours are refused
//   - no provider, model, prompt, token or key can enter the canonical object (they live in the adapter's provenance record, outside it)
// The critic never decides publication: `finalizeVerdict` computes the creative status from the dimensions and keeps deterministic gates in charge.

export const CRITIQUE_ERROR = Object.freeze({
  MALFORMED: 'CRITIQUE_MALFORMED',
  UNKNOWN_DIMENSION: 'CRITIQUE_UNKNOWN_DIMENSION',
  DUPLICATE_DIMENSION: 'CRITIQUE_DUPLICATE_DIMENSION',
  UNKNOWN_OUTCOME: 'CRITIQUE_UNKNOWN_OUTCOME',
  FORBIDDEN_KEY: 'CRITIQUE_FORBIDDEN_KEY',
  NUMERIC_VALUE: 'CRITIQUE_NUMERIC_VALUE',
  EVIDENCE_MISSING: 'CRITIQUE_EVIDENCE_MISSING',
  NUMERIC_SCORE_IN_TEXT: 'CRITIQUE_NUMERIC_SCORE_IN_TEXT',
  HINT_NOT_SEMANTIC: 'CRITIQUE_HINT_NOT_SEMANTIC',
  TEXT_INVALID: 'CRITIQUE_TEXT_INVALID',
  INPUT_INVALID: 'CRITIQUE_INPUT_INVALID',
});

export class CritiqueError extends Error {
  constructor(code, message, field = null) {
    super(message); // never echoes the submitted value
    this.name = 'CritiqueError';
    this.code = code;
    this.field = field;
  }
}

const fail = (code, message, field) => { throw new CritiqueError(code, message, field); };

const FORBIDDEN_KEYS = Object.freeze([
  'score', 'scores', 'rating', 'ratings', 'rank', 'ranking', 'beauty', 'beauty_score', 'points', 'weight', 'weights', 'winner', 'best', 'overall_score', 'confidence', 'confidence_score',
  'model', 'model_id', 'provider', 'provider_id', 'prompt', 'system_prompt', 'temperature', 'seed', 'api_key', 'endpoint', 'request_id', 'usage', 'cost', 'tokens',
  'approved', 'approve', 'approval', 'publish', 'published', 'ship', 'shipped', 'owner_approved',
]);
const OUTCOMES = new Set(Object.values(OUTCOME));
const DIMENSION_KEYS = ['dimension', 'outcome', 'evidence', 'revision_hint'];

// a score hidden in words ("8/10", "score: 7", "rated 4 out of 5") is still a score
const SCORE_IN_TEXT = /\b\d+(\.\d+)?\s*(\/|out of)\s*(5|10|100)\b|\b(score|rating|rated|grade)\b\s*[:=]?\s*\d|\b\d{1,3}\s*(points?|pts)\b/i;
// a hint that micromanages the layout: coordinates, sizes, font settings, colour codes, "x = ...", "make it N% larger"
const NOT_SEMANTIC = /\b\d+(\.\d+)?\s*(px|pt|em|rem|percent|pixels?|points?)\b|\b\d+(\.\d+)?\s*%|\b[xy]\s*[=:]\s*\d|\b(width|height|size|margin|padding|offset|position)\s*[=:]\s*\d|font[-_ ]?(size|weight|family)|#[0-9a-f]{3,8}\b|\brgb\(|\b\d+\s*(x|by)\s*\d+\b|\b\d+(\.\d+)?\s*(times|x)\s*(larger|bigger|smaller)\b/i;
const URL_OR_CONTROL = /https?:\/\/|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function text(value, field, { min, max, code = CRITIQUE_ERROR.TEXT_INVALID }) {
  if (typeof value !== 'string') fail(code, `${field} must be text`, field);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < min || trimmed.length > max) fail(code, `${field} must be ${min}..${max} characters`, field);
  if (URL_OR_CONTROL.test(trimmed)) fail(code, `${field} holds a URL or a control character`, field);
  if (SCORE_IN_TEXT.test(trimmed)) fail(CRITIQUE_ERROR.NUMERIC_SCORE_IN_TEXT, `${field} holds a numeric score`, field);
  return trimmed;
}

/** Refuses any number / boolean / forbidden key anywhere in a raw value (deep). */
function assertPlain(value, path) {
  if (value === null || typeof value === 'string') return;
  if (typeof value === 'number' || typeof value === 'bigint') fail(CRITIQUE_ERROR.NUMERIC_VALUE, `${path} is a number: a critique holds words, never scores`, path);
  if (typeof value === 'boolean') fail(CRITIQUE_ERROR.NUMERIC_VALUE, `${path} is a boolean: an outcome is one of four words`, path);
  if (Array.isArray(value)) { value.forEach((v, i) => assertPlain(v, `${path}[${i}]`)); return; }
  if (typeof value !== 'object') fail(CRITIQUE_ERROR.MALFORMED, `${path} has an unsupported type`, path);
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) fail(CRITIQUE_ERROR.FORBIDDEN_KEY, `${path}.${key} is not allowed in a critique`, `${path}.${key}`);
    assertPlain(v, `${path}.${key}`);
  }
}

/** A revision hint must be semantic: what to change in terms of intent, never where, how big or in which font. */
export function assertSemanticHint(hint, field = 'revision_hint') {
  const value = text(hint, field, { min: 8, max: 300, code: CRITIQUE_ERROR.HINT_NOT_SEMANTIC });
  if (NOT_SEMANTIC.test(value)) fail(CRITIQUE_ERROR.HINT_NOT_SEMANTIC, `${field} is not semantic (no coordinates, sizes, fonts or colour codes)`, field);
  return value;
}

/**
 * @param {object} raw  the parsed model answer: { dimensions: [{ dimension, outcome, evidence, revision_hint? }] }
 * @param {object} context  { candidate_ref, candidate_sha256 }
 */
export function normalizeCritique(raw, context = {}) {
  if (typeof context.candidate_ref !== 'string' || !context.candidate_ref || !/^[0-9a-f]{64}$/.test(context.candidate_sha256 ?? '')) fail(CRITIQUE_ERROR.INPUT_INVALID, 'a critique is about one identified candidate (ref + sha256)', 'context');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(CRITIQUE_ERROR.MALFORMED, 'the critique must be an object', 'critique');
  assertPlain(raw, 'critique');
  const topKeys = Object.keys(raw);
  if (topKeys.length !== 1 || topKeys[0] !== 'dimensions') fail(CRITIQUE_ERROR.MALFORMED, 'the critique holds exactly one field: dimensions', 'critique');
  if (!Array.isArray(raw.dimensions) || raw.dimensions.length > DIMENSIONS.length) fail(CRITIQUE_ERROR.MALFORMED, 'dimensions must be a list of at most the 14 known dimensions', 'dimensions');
  const seen = new Map();
  raw.dimensions.forEach((d, i) => {
    const at = `dimensions[${i}]`;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) fail(CRITIQUE_ERROR.MALFORMED, `${at} must be an object`, at);
    for (const key of Object.keys(d)) if (!DIMENSION_KEYS.includes(key)) fail(CRITIQUE_ERROR.MALFORMED, `${at}.${key} is not part of a dimension`, `${at}.${key}`);
    if (!DIMENSIONS.includes(d.dimension)) fail(CRITIQUE_ERROR.UNKNOWN_DIMENSION, `${at}.dimension is not a known dimension`, `${at}.dimension`);
    if (seen.has(d.dimension)) fail(CRITIQUE_ERROR.DUPLICATE_DIMENSION, `${at}.dimension repeats a dimension`, `${at}.dimension`);
    if (!OUTCOMES.has(d.outcome)) fail(CRITIQUE_ERROR.UNKNOWN_OUTCOME, `${at}.outcome must be PASS, FAIL, REVIEW_REQUIRED or NOT_MEASURABLE`, `${at}.outcome`);
    const judged = d.outcome !== OUTCOME.NOT_MEASURABLE;
    if (judged && (typeof d.evidence !== 'string' || d.evidence.trim().length < 12)) fail(CRITIQUE_ERROR.EVIDENCE_MISSING, `${at}.evidence: a judgment needs visual evidence in words`, `${at}.evidence`);
    const evidence = typeof d.evidence === 'string' && d.evidence.trim()
      ? text(d.evidence, `${at}.evidence`, { min: 3, max: 500 })
      : 'No visual evidence was given for this dimension.';
    const needsHint = d.outcome === OUTCOME.FAIL || d.outcome === OUTCOME.REVIEW_REQUIRED;
    const hint = d.revision_hint == null || d.revision_hint === '' ? null : assertSemanticHint(d.revision_hint, `${at}.revision_hint`);
    if (!needsHint && hint) fail(CRITIQUE_ERROR.HINT_NOT_SEMANTIC, `${at}.revision_hint is only for a FAIL or REVIEW_REQUIRED dimension`, `${at}.revision_hint`);
    seen.set(d.dimension, { dimension: d.dimension, outcome: d.outcome, evidence, revision_hint: hint });
  });
  // a dimension the model did not answer was not assessed: NOT_MEASURABLE, never a guessed PASS
  const dimensions = DIMENSIONS.map((dimension) => seen.get(dimension) ?? { dimension, outcome: OUTCOME.NOT_MEASURABLE, evidence: 'The model gave no answer for this dimension.', revision_hint: null });
  return finish(context, dimensions);
}

function finish(context, dimensions) {
  const body = { schema_version: CRITIQUE_VERSION, candidate_ref: context.candidate_ref, candidate_sha256: context.candidate_sha256, dimensions };
  const id = `ccq_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}`;
  return deepFreeze({ critique_id: id, ...body });
}

/** A critique in which nothing could be judged (no image, provider failure, malformed answer): every dimension NOT_MEASURABLE, with the reason. Never a PASS. */
export function notMeasurableCritique(context, reason) {
  const evidence = `Not assessed: ${reason}.`;
  return finish(context, DIMENSIONS.map((dimension) => ({ dimension, outcome: OUTCOME.NOT_MEASURABLE, evidence, revision_hint: null })));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

/**
 * The creative status, computed by Nordla from the dimensions (the model never states it): FAIL dominates, then REVIEW_REQUIRED, then NOT_MEASURABLE, and CREATIVE_PASS only when
 * every one of the 14 dimensions passes (a model that says OVERALL_SHIPPABILITY passes while another dimension fails does not get a pass). Deterministic gates stay in charge:
 * a failed deterministic gate makes the candidate ineligible whatever the critic says, and nothing here can approve publication: the production status is at most AWAITING_OWNER_APPROVAL.
 * @param {object} input { critique, deterministic: { preflight, fidelity, guardian } } each 'PASS' | 'FAIL' | 'NOT_MEASURABLE' | 'REVIEW_REQUIRED' | null (null = not evaluated)
 */
export function finalizeVerdict({ critique, deterministic = {} }) {
  const outcomes = critique.dimensions.map((d) => d.outcome);
  const creativeStatus = outcomes.includes(OUTCOME.FAIL) ? CREATIVE_STATUS.CREATIVE_FAIL
    : (outcomes.includes(OUTCOME.REVIEW_REQUIRED) ? CREATIVE_STATUS.REVIEW_REQUIRED
      : (outcomes.includes(OUTCOME.NOT_MEASURABLE) ? CREATIVE_STATUS.NOT_MEASURABLE : CREATIVE_STATUS.CREATIVE_PASS));
  const gates = Object.entries({ preflight: deterministic.preflight ?? null, fidelity: deterministic.fidelity ?? null, brand_guardian: deterministic.guardian ?? null });
  const deterministicBlockers = gates.filter(([, outcome]) => outcome !== 'PASS').map(([gate, outcome]) => ({ gate, outcome: outcome ?? 'NOT_EVALUATED' }));
  const blockers = critique.dimensions.filter((d) => d.outcome === OUTCOME.FAIL).map((d) => d.dimension);
  const inconsistent = critique.dimensions.find((d) => d.dimension === 'OVERALL_SHIPPABILITY')?.outcome === OUTCOME.PASS && outcomes.some((o) => o === OUTCOME.FAIL);
  return deepFreeze({
    creative_status: creativeStatus,
    blockers,
    deterministic_blockers: deterministicBlockers,
    technically_eligible: deterministicBlockers.length === 0,
    inconsistent_overall: Boolean(inconsistent),
    // CREATIVE_PASS is an opinion about perception, not an approval: only the owner can set OWNER_APPROVED / SHIPPABLE, outside Nordla
    production_status: deterministicBlockers.length === 0 ? 'AWAITING_OWNER_APPROVAL' : 'BLOCKED_BY_A_DETERMINISTIC_GATE',
    owner_approval: 'PENDING',
  });
}
