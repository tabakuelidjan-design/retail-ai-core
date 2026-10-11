import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import { list, obj, renderContract, text, validateAnswer } from './contract.js';
import { askAndNormalize } from './model-port.js';
import {
  BRAIN_ERROR, closed, deepFreeze, deriveId, enumOf, fail, listOf, noNumbers, oneLine,
} from './validation.js';

// OBSERVE and FRAME. The observation is a deterministic reading of the brief and of the asset's facts (never pixels). The CreativeProblemFrame is canonical Nordla domain data that answers, before any
// ideation: what is shown, for whom, what must be understood at once, what must be felt, what must be remembered, the commercial objective, what is FIXED, what MAY CHANGE, what would make the
// result generic and what would make it distinctive. What is fixed and what may change are decided by Nordla from the observation, never by the model; the rest is the model's judgment, normalized
// into a closed contract. The frame is not provider prompt text.

export const FIXED_KIND = Object.freeze({
  PRODUCT_PIXELS: 'PRODUCT_PIXELS', APPROVED_TEXT: 'APPROVED_TEXT', APPROVED_CLAIM: 'APPROVED_CLAIM', FORMAT: 'FORMAT', BRAND_HARD_RULES: 'BRAND_HARD_RULES', PRODUCT_FIDELITY: 'PRODUCT_FIDELITY',
});
export const MAY_CHANGE = Object.freeze({
  SCENE: 'SCENE', MATERIALS: 'MATERIALS', LIGHT: 'LIGHT', ATMOSPHERE: 'ATMOSPHERE', COMPOSITION: 'COMPOSITION', TYPOGRAPHIC_TREATMENT: 'TYPOGRAPHIC_TREATMENT', NARRATIVE_ELEMENTS: 'NARRATIVE_ELEMENTS',
});

const MODEL_FIELDS = ['what_we_show', 'audience', 'understood_immediately', 'felt', 'remembered', 'commercial_objective', 'occasion_context', 'generic_risks', 'distinctive_levers', 'rationale'];
/** The model's part of a frame: the contract the answer is validated against AND the contract the instruction states. */
export const FRAME_SPEC = obj({
  what_we_show: text(), audience: text(), understood_immediately: text(), felt: text(), remembered: text(), commercial_objective: text(), occasion_context: text(),
  generic_risks: list(text({ max: 200 }), { min: 1, max: 5 }), distinctive_levers: list(text({ max: 200 }), { min: 1, max: 5 }), rationale: text(),
});
export const FRAME_CONTRACT = Object.freeze({ stage: 'FRAME', spec: FRAME_SPEC, rules: Object.freeze([]) });
const FRAME_KEYS = ['frame_id', 'what_we_show', 'audience', 'understood_immediately', 'felt', 'remembered', 'commercial_objective', 'occasion_context', 'fixed', 'may_change', 'generic_risks', 'distinctive_levers', 'rationale'];

/** OBSERVE: the facts of the brief that a frame may rest on. Pure; holds references and words, never pixels. */
export function observeBrief({ brief }) {
  const roles = [...new Set([...brief.claims.map((c) => c.role), ...brief.approved_copy.map((c) => c.role)])].sort();
  return deepFreeze({
    product_ref: brief.ids.product_ref,
    asset_origin: brief.asset.origin,
    protected_region_count: (brief.identity_annotations?.text_regions?.length ?? 0) + (brief.identity_annotations?.artwork_region ? 1 : 0),
    approved_text_roles: roles,
    claim_refs: brief.claims.map((c) => c.ref).sort(),
    format: { content_kind: 'IMAGE', aspect_ratio: brief.format.aspect_ratio, locale: brief.format.locale ?? null },
    public_facts: brief.public_facts,
    expression_sections: Object.keys(brief.brand?.expression ?? {}).sort(),
  });
}

/** What is fixed, from the observation (Nordla's decision). */
export function fixedFrom(observation) {
  const fixed = [
    { kind: FIXED_KIND.PRODUCT_PIXELS, ref: observation.product_ref },
    { kind: FIXED_KIND.PRODUCT_FIDELITY, ref: observation.product_ref },
    { kind: FIXED_KIND.FORMAT, ref: observation.format.aspect_ratio },
    { kind: FIXED_KIND.BRAND_HARD_RULES, ref: 'brand-memory' },
    ...observation.approved_text_roles.map((role) => ({ kind: FIXED_KIND.APPROVED_TEXT, ref: role })),
    ...observation.claim_refs.map((ref) => ({ kind: FIXED_KIND.APPROVED_CLAIM, ref })),
  ];
  return fixed;
}

/**
 * The canonical frame from the model's fields and the deterministic part. Refuses unknown or missing fields, numbers anywhere, text that is not one line.
 * @param {object} input { observation, model }
 */
export function buildProblemFrame({ observation, model }) {
  const v = validateAnswer(FRAME_CONTRACT, model, 'frame');
  const body = {
    what_we_show: v.what_we_show,
    audience: v.audience,
    understood_immediately: v.understood_immediately,
    felt: v.felt,
    remembered: v.remembered,
    commercial_objective: v.commercial_objective,
    occasion_context: v.occasion_context,
    fixed: fixedFrom(observation),
    may_change: Object.values(MAY_CHANGE),
    generic_risks: v.generic_risks,
    distinctive_levers: v.distinctive_levers,
    rationale: v.rationale,
  };
  return deepFreeze({ frame_id: deriveId('cpf', body), ...body });
}

/** A stored frame is re-validated: closed, no figure, and its id must follow from its content. */
export function normalizeProblemFrame(frame) {
  noNumbers(frame, 'frame');
  closed(frame, FRAME_KEYS, 'frame');
  const { frame_id: id, ...body } = frame;
  const fixed = listOf(body.fixed, 'frame.fixed', { min: 1, max: 60 }, (f, w) => { closed(f, ['kind', 'ref'], w); enumOf(f.kind, FIXED_KIND, `${w}.kind`); oneLine(f.ref, `${w}.ref`, { max: 200 }); return f; });
  if (!fixed.some((f) => f.kind === FIXED_KIND.PRODUCT_PIXELS)) fail(BRAIN_ERROR.RULE_VIOLATION, 'a frame always fixes the product pixels', 'frame.fixed');
  listOf(body.may_change, 'frame.may_change', { min: 1, max: 12 }, (v, w) => enumOf(v, MAY_CHANGE, w));
  if (id !== deriveId('cpf', body)) fail(BRAIN_ERROR.RULE_VIOLATION, 'frame_id does not follow from the content', 'frame.frame_id');
  return deepFreeze(structuredClone(frame));
}

export function buildFramerInstruction({ observation }) {
  const system = [
    'You are the Nordla problem framer. Before any idea is sought, you frame the creative problem for a product visual from the observation you are given.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(FRAME_SPEC, 'answer'),
    'generic_risks name what would make the result generic or template-like for THIS product, audience and occasion; distinctive_levers name what could make it distinctive. occasion_context says what occasion or buying situation the product serves, or that none applies.',
    'You do not propose a concept, a layout or a scene here. You never use numbers. rationale is one concise sentence of why this framing, for the record; it is not a reasoning log.',
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.FRAME })),
  ].join('\n');
  return { system, user: JSON.stringify({ observation }) };
}

/** The FRAME stage: one model completion, then the closed contract. */
export function createProblemFramer({ complete }) {
  return Object.freeze({
    async frame({ observation }) {
      const { value, meta } = await askAndNormalize({ complete, instruction: buildFramerInstruction({ observation }), stage: 'FRAME', spec: FRAME_SPEC, normalize: (raw) => buildProblemFrame({ observation, model: raw }) });
      return { frame: value, meta };
    },
  });
}
