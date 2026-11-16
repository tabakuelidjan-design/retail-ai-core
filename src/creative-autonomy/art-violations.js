// ART_DIRECT: EVERY rule that can refuse an answer before the image stage, checked on the COMPLETE answer, so that ONE authorised repair can name all the violations.
// The validators keep their authority (each throws at its first refusal, which is what stops a run); this module only reads the same answer through the same rules and collects.
// Rules, in the order the pipeline applies them:
//   1 CONTRACT            art-direction.js ART_SPEC via contract.js: keys, enums, list sizes, text length, no digit / colour code / unit, product vocabulary (SUBSTITUTE_LEXICON)
//   2 REASON_IN_THE_CONCEPT  art-direction.js ART_RULES: each narrative reason shares a significant word with the concept
//   3 BRAND               brand-guard.js: the merchant's forbidden decor, capabilities the verified facts do not state
// Hard stops (never repaired, never collected): an unreadable answer (the Brain's own single protocol re-ask), a provider failure, an exhausted repair or spend budget.
import { ART_SPEC, reasonInConcept, conceptAnchorWords } from '../creative-brain/art-direction.js';
import { collectSpecViolations } from '../creative-brain/contract.js';
import { BrainError } from '../creative-brain/validation.js';
import { collectArtDirectionGuard } from './brand-guard.js';

const WHERE = 'art_direction';

const ruleOf = (v) => {
  const problem = v.detail?.problem;
  if (problem === 'SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT') return 'PRODUCT_VOCABULARY';
  if (problem === 'ELEMENT_WITHOUT_REASON_IN_THE_CONCEPT') return 'REASON_IN_THE_CONCEPT';
  if (problem === 'BRAND_FORBIDDEN_DECOR') return 'BRAND_FORBIDDEN_DECOR';
  if (problem === 'INVENTED_CAPABILITY') return 'INVENTED_CAPABILITY';
  if (problem === 'SCENE_DETAIL_NAMES_THE_PRODUCT') return 'SCENE_VOCABULARY_PRODUCT';
  if (problem === 'SCENE_DETAIL_HAS_A_PERSON') return 'SCENE_VOCABULARY_PERSON';
  if (problem === 'GENERATOR_TEXT_NOT_ENGLISH') return 'GENERATOR_TEXT_NOT_ENGLISH';
  if (problem === 'FIGURE_NOT_A_VERIFIED_REFERENCE') return 'FIGURE_NOT_A_VERIFIED_REFERENCE';
  return v.code;
};

/** Every violation of an ART_DIRECT answer, grouped by field: [{ field, issues: [{ rule, message, words?, capabilities? }] }], in document order. [] when the answer is not readable JSON. */
export function collectArtViolations(answerText, { concept, facts, profile, productless = false, productVisible = false, spec = ART_SPEC } = {}) {
  let answer; try { answer = JSON.parse(answerText); } catch { return []; }
  if (answer && typeof answer === 'object' && !Array.isArray(answer) && Object.hasOwn(answer, WHERE)) answer = answer[WHERE];
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
  const raw = collectSpecViolations(spec, answer, WHERE);
  if (concept) {
    (Array.isArray(answer.narrative_elements) ? answer.narrative_elements : []).forEach((e, i) => {
      if (typeof e?.reason !== 'string' || !e.reason.trim()) return;
      try { reasonInConcept(e, `${WHERE}.narrative_elements[${i}]`, concept); } catch (err) {
        if (!(err instanceof BrainError)) throw err;
        raw.push({ field: `${WHERE}.narrative_elements[${i}].reason`, code: err.code, message: err.message, detail: err.detail ?? null });
      }
    });
  }
  if (profile) raw.push(...collectArtDirectionGuard(answer, facts, profile, { productless, productVisible }));
  const byField = new Map();
  for (const v of raw) {
    const issue = { rule: ruleOf(v), message: String(v.message).slice(0, 240), ...(v.detail?.words ? { words: v.detail.words } : {}), ...(v.detail?.word ? { words: [v.detail.word] } : {}), ...(v.detail?.capabilities ? { capabilities: v.detail.capabilities } : {}) };
    if (!byField.has(v.field)) byField.set(v.field, []);
    const issues = byField.get(v.field);
    if (!issues.some((x) => x.rule === issue.rule && x.message === issue.message)) issues.push(issue);
  }
  return [...byField].map(([field, issues]) => ({ field, issues }));
}

const quoted = (words) => words.map((w) => `"${String(w).slice(0, 40)}"`).join(', ');
const correction = (issue, concept) => {
  switch (issue.rule) {
    case 'PRODUCT_VOCABULARY': return `remove ${quoted(issue.words ?? [])} and any synonym: the real product is placed by Nordla and is never named or described (nor a device, a phone or a part of the product); say only what is seen around it`;
    case 'REASON_IN_THE_CONCEPT': return `write this reason in the SAME language as the concept and include at least one of these words of the concept: ${(concept ? conceptAnchorWords(concept) : []).join(', ')}`;
    case 'PROP_WITHOUT_REASON': return `write this reason in the SAME language as the concept and include at least one of these words of the concept: ${(concept ? conceptAnchorWords(concept) : []).join(', ')}`;
    case 'HEADLINE_TOO_LONG': return 'rewrite the headline with the same idea in the same language in at most eight words and 60 characters';
    case 'BRAND_FORBIDDEN_DECOR': return `remove ${quoted(issue.words ?? [])}: the merchant forbids it, and the word may not appear ANYWHERE in the field, not even to say that it is avoided or refused`;
    // IDEATE, route ENVIRONMENT_FIRST (concept-violations.js): the IDEA is kept, only the action the route cannot execute is replaced
    case 'ROUTE_PRODUCT_PART_ACTION': return `rewrite this field so that nothing needs a cable or a part of the product to be moved, laid out, shaped or connected${issue.clause ? ` (the clause "${issue.clause}")` : ''}: the real product is placed afterwards, unchanged, in the pose of its photograph. Keep the idea and its benefit, and carry them with the light, the architecture or the materials of the set alone`;
    case 'ROUTE_EXTRA_DEVICE': return `rewrite this field without any device, screen or second product drawn${issue.clause ? ` (the clause "${issue.clause}")` : ''}: the product itself is added later and is the only object. Keep the idea and say its benefit with light, architecture or materials`;
    case 'FRAME_PRESCRIBES_DECOR': return `rewrite this field WITHOUT ${quoted(issue.words ?? [])} or any other surface, material or light quality: the frame states the commercial intention and the physical constraints of the photograph, the set is decided later by the concepts`;
    case 'CONCEPT_COMPOSITION_MISSING': return `write this field: ${issue.message}`;
    case 'ROUTE_PRODUCT_CONTACT': return `rewrite this field so that nothing in the set touches, surrounds, covers, frames or reflects the product or follows its shape${issue.clause ? ` (the clause "${issue.clause}")` : ''}. Keep the idea and carry it with the set alone`;
    case 'SCENE_VOCABULARY_PRODUCT': return `rewrite this field WITHOUT ${quoted(issue.words ?? [])} or any synonym: the scene is built before the product exists and the image model is not shown it. Keep the IDEA (what the viewer remembers) and say it with a line, a band of light, a shadow, an edge, a surface or a mark`;
    case 'SCENE_VOCABULARY_PERSON': return `rewrite this field WITHOUT ${quoted(issue.words ?? [])}: no hand, finger or person in the scene; keep the idea and say it with light, shadow, a surface or a trace`;
    case 'INVENTED_CAPABILITY': return `remove the claim(s) ${(issue.capabilities ?? []).join(', ')}: the verified facts do not state them`;
    default: return issue.message;
  }
};

/** The ONE structured repair request: each field, the rule it breaks and the exact correction. */
export function repairRequest(violations, concept) {
  const lines = violations.map((v, i) => `${i + 1}. field ${v.field}: ${v.issues.map((x) => `rule ${x.rule} (${x.message}) -> ${correction(x, concept)}`).join(' | ')}`);
  // a repair that REWRITES a prop also rewrites its reason, and a reason in another language than the concept's has no word of the concept (real run 2026-11-05): say it up front
  const props = [...new Set(violations.flatMap((v) => { const m = /\.props\[(\d+)\]/.exec(v.field); return m ? [Number(m[1])] : []; }))];
  const anchors = concept ? conceptAnchorWords(concept) : [];
  const reminder = props.length && anchors.length ? `\nWhenever you change a prop, write its reason in the SAME language as the concept and include at least one of these words of the concept: ${anchors.join(', ')} (prop ${props.join(', ')}).` : '';
  return ` ALL the violations of your previous answer, to be fixed together in this one reply (there is no second repair):\n${lines.join('\n')}${reminder}`;
}
