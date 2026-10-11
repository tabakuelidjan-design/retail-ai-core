import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import { askModel } from './model-port.js';
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

const textList = (value, where, max = 5) => listOf(value, where, { min: 1, max }, (v, w) => oneLine(v, w, { max: 200 }));

/**
 * The canonical frame from the model's fields and the deterministic part. Refuses unknown or missing fields, numbers anywhere, text that is not one line.
 * @param {object} input { observation, model }
 */
export function buildProblemFrame({ observation, model }) {
  noNumbers(model, 'frame');
  closed(model, MODEL_FIELDS, 'frame');
  const body = {
    what_we_show: oneLine(model.what_we_show, 'frame.what_we_show'),
    audience: oneLine(model.audience, 'frame.audience'),
    understood_immediately: oneLine(model.understood_immediately, 'frame.understood_immediately'),
    felt: oneLine(model.felt, 'frame.felt'),
    remembered: oneLine(model.remembered, 'frame.remembered'),
    commercial_objective: oneLine(model.commercial_objective, 'frame.commercial_objective'),
    occasion_context: oneLine(model.occasion_context, 'frame.occasion_context'),
    fixed: fixedFrom(observation),
    may_change: Object.values(MAY_CHANGE),
    generic_risks: textList(model.generic_risks, 'frame.generic_risks'),
    distinctive_levers: textList(model.distinctive_levers, 'frame.distinctive_levers'),
    rationale: oneLine(model.rationale, 'frame.rationale'),
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
    'Return ONLY one JSON object with exactly these keys: what_we_show, audience, understood_immediately, felt, remembered, commercial_objective, occasion_context, generic_risks, distinctive_levers, rationale.',
    'Each of what_we_show, audience, understood_immediately, felt, remembered, commercial_objective, occasion_context and rationale is ONE line of plain text of at most 300 characters. generic_risks and distinctive_levers are lists of one to five short one-line texts.',
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
      const { raw, meta } = await askModel({ complete, instruction: buildFramerInstruction({ observation }), stage: 'FRAME' });
      return { frame: buildProblemFrame({ observation, model: raw }), meta };
    },
  });
}
