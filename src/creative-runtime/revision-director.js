import { AGENT_ROLE, defineCreativeAgent } from '../creative-intelligence/index.js';
import { NOT_SEMANTIC } from '../creative-critic/critique.js';
import { REVISION_INTENT } from '../creative-critic/revision.js';
import { COMPONENT, DECISION } from './ledger.js';
import { buildDirectorInstruction } from './agents.js';

// The revision-side Creative Director. A revision is a NEW creative direction decided by the Director from CANONICAL evidence only:
//   - the original creative brief (public facts, approved text roles, format, the brand's expression system)
//   - the previous creative direction (its creative fields)
//   - the evidence of the previous candidate (facts: recipe, roles, gate outcomes; no pixel geometry)
//   - the normalized critique (dimension, outcome, evidence in words, semantic hint)
//   - the normalized revision request (closed semantic intents)
// Everything else is refused at the door: an unknown key (an owner's review, a layout coordinate, a colour, a font size, a design opinion) cannot reach the model, because this module
// accepts an explicit allow-list and nothing more, and because the text that does cross is re-checked for pixel/coordinate/font/colour literals. This module imports nothing from
// the owner-review module and never receives it.

export class RevisionInputError extends Error {
  constructor(code, message, field = null) { super(message); this.name = 'RevisionInputError'; this.code = code; this.field = field; }
}
const refuse = (code, message, field) => { throw new RevisionInputError(code, message, field); };

const INPUT_KEYS = ['brief', 'ids', 'revision'];
const REVISION_KEYS = ['previous_direction', 'candidate_evidence', 'critique', 'revision_request'];
const DIRECTION_FIELDS = ['concept', 'copy_intent', 'visual_intent', 'product_role', 'spatial_intent', 'negative_space_intent', 'hierarchy'];
const EVIDENCE_KEYS = ['candidate_sha256', 'recipe_id', 'spatial_intent', 'text_roles', 'product_height_share', 'plate_used', 'preflight', 'fidelity', 'guardian'];
const CRITIQUE_DIM_KEYS = ['dimension', 'outcome', 'evidence', 'revision_hint'];
const INTENT_KEYS = ['intent', 'dimension', 'outcome', 'hint'];
const INTENTS = new Set(Object.values(REVISION_INTENT));
const GATE_VALUES = new Set(['PASS', 'FAIL', 'REVIEW_REQUIRED', 'NOT_MEASURABLE', 'NOT_EVALUATED', null]);

const onlyKeys = (value, allowed, where) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('REVISION_INPUT_MALFORMED', `${where} must be an object`, where);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse('REVISION_INPUT_KEY_NOT_ALLOWED', `${where}.${key} is not part of the revision evidence`, `${where}.${key}`);
};
// a literal that would steer the layout: a pixel value, a coordinate, a font size/name setting or a colour code
const assertSemanticText = (value, where) => {
  if (typeof value !== 'string') refuse('REVISION_INPUT_MALFORMED', `${where} must be text`, where);
  if (NOT_SEMANTIC.test(value)) refuse('REVISION_INPUT_NOT_SEMANTIC', `${where} holds a coordinate, size, font or colour literal`, where);
  return value;
};

/**
 * The canonical revision evidence, from the raw inputs of a revision. Anything outside the allow-lists is refused; nothing is passed through unchecked.
 * @param {object} revision { previous_direction, candidate_evidence, critique, revision_request }
 */
export function normalizeRevisionEvidence(revision) {
  onlyKeys(revision, REVISION_KEYS, 'revision');
  const { previous_direction: previous, candidate_evidence: candidate, critique, revision_request: request } = revision;

  if (previous === null || typeof previous !== 'object') refuse('REVISION_INPUT_MALFORMED', 'previous_direction must be an object', 'previous_direction');
  onlyKeys({ ...previous }, [...DIRECTION_FIELDS, ...Object.keys(previous ?? {}).filter((k) => !DIRECTION_FIELDS.includes(k) && /^(direction_id|schema_version|merchant_id|brand_id|brief_ref|required_asset_refs|claim_refs|forbidden_transformations|evidence_refs)$/.test(k))], 'previous_direction');
  const previousDirection = Object.fromEntries(DIRECTION_FIELDS.map((k) => [k, previous[k]]));
  for (const k of ['concept', 'copy_intent', 'visual_intent']) assertSemanticText(previousDirection[k], `previous_direction.${k}`);

  onlyKeys(candidate, EVIDENCE_KEYS, 'candidate_evidence');
  if (!/^[0-9a-f]{64}$/.test(candidate.candidate_sha256 ?? '')) refuse('REVISION_INPUT_MALFORMED', 'the candidate evidence names its candidate by sha256', 'candidate_evidence.candidate_sha256');
  for (const gate of ['preflight', 'fidelity', 'guardian']) if (!GATE_VALUES.has(candidate[gate] ?? null)) refuse('REVISION_INPUT_MALFORMED', `candidate_evidence.${gate} is not a gate outcome`, `candidate_evidence.${gate}`);
  if (candidate.product_height_share != null && !(typeof candidate.product_height_share === 'number' && candidate.product_height_share > 0 && candidate.product_height_share <= 1)) refuse('REVISION_INPUT_MALFORMED', 'product_height_share is a share of the canvas', 'candidate_evidence.product_height_share');

  onlyKeys(critique, ['critique_id', 'schema_version', 'candidate_ref', 'candidate_sha256', 'dimensions'], 'critique');
  if (critique.candidate_sha256 !== candidate.candidate_sha256) refuse('REVISION_INPUT_MISMATCH', 'the critique is not about the candidate of the evidence', 'critique.candidate_sha256');
  if (!/^creative-critique@\d+$/.test(critique.schema_version ?? '') || !Array.isArray(critique.dimensions)) refuse('REVISION_INPUT_MALFORMED', 'a normalized critique is required', 'critique');
  const dimensions = critique.dimensions.map((d, i) => {
    onlyKeys(d, CRITIQUE_DIM_KEYS, `critique.dimensions[${i}]`);
    assertSemanticText(d.evidence, `critique.dimensions[${i}].evidence`);
    if (d.revision_hint != null) assertSemanticText(d.revision_hint, `critique.dimensions[${i}].revision_hint`);
    return { dimension: d.dimension, outcome: d.outcome, evidence: d.evidence, revision_hint: d.revision_hint ?? null };
  });

  onlyKeys(request, ['revision_id', 'from_candidate_ref', 'from_critique_id', 'iteration', 'intents'], 'revision_request');
  if (request.from_critique_id !== critique.critique_id) refuse('REVISION_INPUT_MISMATCH', 'the revision request does not come from this critique', 'revision_request.from_critique_id');
  if (!Array.isArray(request.intents) || !request.intents.length) refuse('REVISION_INPUT_MALFORMED', 'a revision needs at least one semantic intent', 'revision_request.intents');
  const intents = request.intents.map((i, n) => {
    onlyKeys(i, INTENT_KEYS, `revision_request.intents[${n}]`);
    if (!INTENTS.has(i.intent)) refuse('REVISION_INTENT_UNKNOWN', `revision_request.intents[${n}].intent is not a known semantic intent`, `revision_request.intents[${n}].intent`);
    if (i.hint != null) assertSemanticText(i.hint, `revision_request.intents[${n}].hint`);
    return { intent: i.intent, dimension: i.dimension, outcome: i.outcome, hint: i.hint ?? null };
  });

  return Object.freeze({
    previous_direction: previousDirection,
    candidate_evidence: Object.fromEntries(EVIDENCE_KEYS.filter((k) => candidate[k] !== undefined).map((k) => [k, candidate[k]])),
    critique: { critique_id: critique.critique_id, schema_version: critique.schema_version, dimensions },
    revision_intents: intents,
  });
}

/** What the revision Director model receives: the standard Director instruction plus the revision rules; the evidence is the canonical, normalized one. */
export function buildRevisionInstruction({ brief, evidence, constants }) {
  const base = buildDirectorInstruction({ brief, constants });
  const system = [
    base.system,
    'You are now REVISING a previous creative direction. The critique and the revision intents below are evidence from the Creative Critic about the previous candidate; the intents say WHAT QUALITY must improve, never how.',
    'Decide a NEW direction that addresses the intents: change what must change in the idea, the spatial intent, the negative space, the hierarchy and the environment, and keep what already works.',
    'Do not repeat the previous direction. Never use coordinates, sizes, pixel or percentage values, font names or sizes, or colour codes; decide the idea, the runtime decides the details.',
    'Return ONLY the same JSON object with the same keys as before.',
  ].join(' ');
  const user = JSON.stringify({
    brief: brief.public_facts, approved_text_roles: brief.approved_text_roles, format: brief.format, brand_expression: brief.expression,
    previous_direction: evidence.previous_direction, previous_candidate: evidence.candidate_evidence, critique: evidence.critique, revision_intents: evidence.revision_intents,
  });
  return { system, user };
}

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9àâçéèêëîïôûùüÿœ]+/i).filter((t) => t.length > 2));
const similarity = (a, b) => { const x = tokens(a); const y = tokens(b); if (!x.size && !y.size) return 1; const inter = [...x].filter((t) => y.has(t)).length; return inter / (x.size + y.size - inter); };
const TEXT_SIMILARITY_LIMIT = 0.7;

/** The fields that changed between two directions, and whether the change is meaningful: a structural field changed, or at least two of the three descriptive fields rewritten. */
export function directionDelta(previous, next) {
  const structural = ['product_role', 'spatial_intent', 'negative_space_intent'].filter((k) => previous[k] !== next[k]);
  if (JSON.stringify(previous.hierarchy) !== JSON.stringify(next.hierarchy)) structural.push('hierarchy');
  const descriptive = ['concept', 'copy_intent', 'visual_intent'].filter((k) => similarity(previous[k], next[k]) < TEXT_SIMILARITY_LIMIT);
  return Object.freeze({ structural, descriptive, meaningful: structural.length >= 1 || descriptive.length >= 2 });
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('the revision Director returned no JSON object');
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * @param {object} deps complete: async ({ system, user }) -> { text, request_id?, model? }  (live: the text-model lane, ONE completion; tests: a fake)
 */
export function createRevisionDirector({ ledger, complete, constants }) {
  return defineCreativeAgent(AGENT_ROLE.CREATIVE_DIRECTOR, async (input) => {
    onlyKeys(input, INPUT_KEYS, 'input');
    const { brief, ids, revision } = input;
    const evidence = normalizeRevisionEvidence(revision);
    const reply = await complete(buildRevisionInstruction({ brief, evidence, constants }));
    const raw = parseJsonObject(reply.text);
    const extra = Object.keys(raw).filter((k) => !DIRECTION_FIELDS.includes(k));
    if (extra.length) throw new Error('the revision Director returned fields that are not part of a direction');
    for (const k of ['concept', 'copy_intent', 'visual_intent']) assertSemanticText(raw[k], `revised_direction.${k}`);
    const delta = directionDelta(evidence.previous_direction, raw);
    if (!delta.meaningful) throw Object.assign(new Error('the revised direction does not differ meaningfully from the previous one'), { code: 'REVISED_DIRECTION_NOT_DIFFERENT' });
    const direction = {
      merchant_id: ids.merchant_id,
      brand_id: ids.brand_id,
      brief_ref: ids.brief_ref,
      ...Object.fromEntries(DIRECTION_FIELDS.map((k) => [k, raw[k]])),
      required_asset_refs: ids.asset_refs,
      claim_refs: ids.claim_refs,
      forbidden_transformations: ['REDRAW_PRODUCT', 'ALTER_PRODUCT_PIXELS', 'TEXT_IN_PROVIDER_PIXELS'],
      evidence_refs: ids.evidence_refs ?? [],
    };
    const basis = [ids.brief_ref, evidence.critique.critique_id];
    ledger.record({
      decision: DECISION.REVISION_DIRECTION, decided_by: COMPONENT.REVISION_DIRECTOR, rule: 'DIRECTION_REVISED_FROM_CANONICAL_EVIDENCE_AND_SEMANTIC_INTENTS', basis,
      outcome: { intents: evidence.revision_intents.map((i) => i.intent), changed_structural: delta.structural, changed_descriptive: delta.descriptive },
    });
    ledger.record({
      decision: DECISION.CREATIVE_DIRECTION, decided_by: COMPONENT.REVISION_DIRECTOR, rule: 'REVISED_DIRECTION', basis,
      outcome: { model: reply.model ?? null, request_id: reply.request_id ?? null, spatial_intent: raw.spatial_intent, negative_space_intent: raw.negative_space_intent, hierarchy: raw.hierarchy, product_role: raw.product_role },
    });
    return { directions: [direction] };
  });
}

/** The canonical facts of a produced candidate for the revision evidence (no pixel geometry): built from a runtime result (or its stored summary) and its recorded gates. */
export function buildCandidateEvidence({ result, candidate_sha256: sha }) {
  const recipe = result.ledger?.find((e) => e.decision === DECISION.LAYOUT_RECIPE)?.outcome?.recipe_id ?? null;
  const placement = result.ledger?.find((e) => e.decision === DECISION.PRODUCT_PLACEMENT)?.outcome ?? null;
  const share = placement?.product_height_share;
  const plate = result.ledger?.find((e) => e.decision === DECISION.TEXT_STYLE)?.outcome?.plates?.length > 0;
  return Object.freeze({
    candidate_sha256: sha,
    ...(recipe ? { recipe_id: recipe } : {}),
    ...(result.direction?.spatial_intent ? { spatial_intent: result.direction.spatial_intent } : {}),
    text_roles: (result.copy ?? []).map((c) => c.text_role),
    ...(typeof share === 'number' ? { product_height_share: Math.round(share * 100) / 100 } : {}),
    plate_used: Boolean(plate),
    preflight: result.preflight?.status ?? null,
    fidelity: result.fidelity?.gate ?? null,
    guardian: result.guardian?.outcome ?? 'NOT_EVALUATED',
  });
}
