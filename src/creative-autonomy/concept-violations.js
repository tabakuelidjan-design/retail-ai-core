// IDEATE: EVERY defect of EVERY concept, attached to its own concept and collected in ONE pass, so that ONE authorised repair can name them all (the repair limits are unchanged: one repair of the stage).
// Same shape as art-violations.js (which this mirrors): the validators keep their authority and stop at their first refusal; this module reads the same answer through the same rules and collects.
//   1 BRAND   brand-guard.js: the merchant's forbidden words, capabilities the verified facts do not state (all six fields of each concept)
//   2 ROUTE   route-executability.js: an action the decor-first route cannot execute (only with route ENVIRONMENT_FIRST). A product WORD alone is never a violation: it triggers the verification of the ACTION.
// A concept without a defect is not touched: its fields are never in the repair, so the scoped merge keeps them byte for byte.
import { BrainError, BRAIN_ERROR, fail } from '../creative-brain/validation.js';
import { collectConceptsGuard } from './brand-guard.js';
import { examineConceptSetRoute, ROUTE_ENVIRONMENT_FIRST, ROUTE_PRODUCT_VISIBLE, ROUTE_RULES } from './route-executability.js';

const WHERE = 'concepts';
const ROUTE_MESSAGES = Object.freeze({
  [ROUTE_RULES.PART_ACTION]: 'the idea needs a cable or a part of the product to be moved, laid out, shaped or connected',
  [ROUTE_RULES.EXTRA_DEVICE]: 'the idea needs a device, a screen or a second product to be drawn',
  [ROUTE_RULES.CONTACT]: 'the idea needs something that touches, surrounds, covers or reflects the product',
});

const ruleOf = (v) => {
  const problem = v.detail?.problem;
  if (problem === 'BRAND_FORBIDDEN_DECOR') return 'BRAND_FORBIDDEN_DECOR';
  if (problem === 'INVENTED_CAPABILITY') return 'INVENTED_CAPABILITY';
  if (problem && String(problem).startsWith('ROUTE_')) return problem;
  return v.code;
};

const COMPOSITION_MIN_WORDS = 8; const VALUE_MIN_WORDS = 6;
const words = (t) => String(t ?? '').trim().split(/\s+/).filter(Boolean).length;
/** In the decor-first route every concept states its composition and how it raises the value of the product (a line of the brief, and a concept without them is not a concept for this route). */
export function collectConceptCompositionViolations(concepts, route) {
  if (route !== ROUTE_ENVIRONMENT_FIRST && route !== ROUTE_PRODUCT_VISIBLE) return [];
  const out = [];
  (Array.isArray(concepts) ? concepts : []).forEach((c, i) => {
    const visible = route === ROUTE_PRODUCT_VISIBLE; // the generator SEES the product: the composition frames the product itself, not an empty place
    for (const [key, min, what] of [['composition', COMPOSITION_MIN_WORDS, `the recognisable COMPOSITION of the ${visible ? 'scene around the product' : 'set'} (its spatial structure: where the weight sits, how depth and scale are organised, where the light leads, what frames ${visible ? 'the product and makes it the focal point' : 'the empty place of the product'}), in one or two sentences a set designer could build from`], ['value_lever', VALUE_MIN_WORDS, visible ? 'how that composition makes THIS product desirable (what the scene does FOR it)' : 'how that composition raises the perceived value of the product (what the set does FOR it)']]) {
      if (words(c?.[key]) < min) out.push({ field: `${WHERE}[${i}].${key}`, code: BRAIN_ERROR.RULE_VIOLATION, message: `${what}`, detail: { problem: 'CONCEPT_COMPOSITION_MISSING' } });
    }
  });
  return out;
}

/** The route findings of a set as violations: [{ field: 'concepts[i].central_idea', code, message, detail }], with the clause that asks the action. */
export function collectConceptRouteViolations(concepts, route) {
  if (route === ROUTE_PRODUCT_VISIBLE) return collectConceptCompositionViolations(concepts, route); // the generator sees the product: only the composition is required, none of the decor-first executability rules
  if (route !== ROUTE_ENVIRONMENT_FIRST) return [];
  return [...collectConceptCompositionViolations(concepts, route), ...examineConceptSetRoute(concepts).flatMap((r) => r.findings.map((f) => ({
    field: `${WHERE}[${r.index}].${f.field}`, code: BRAIN_ERROR.RULE_VIOLATION,
    message: `${WHERE}[${r.index}].${f.field}: ${ROUTE_MESSAGES[f.rule]} ("${f.clause}")`, detail: { problem: f.rule, words: f.words, clause: f.clause },
  }))) ];
}

/** Every violation of an IDEATE answer, grouped by field: [{ field, issues: [{ rule, message, words? }] }] in document order; [] when the answer is not readable JSON. */
export function collectConceptViolations(answerText, { facts, profile, route = null } = {}) {
  let answer; try { answer = JSON.parse(answerText); } catch { return []; }
  const concepts = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer[WHERE] : null;
  if (!Array.isArray(concepts)) return [];
  const raw = [...(profile ? collectConceptsGuard(concepts, facts, profile) : []), ...collectConceptRouteViolations(concepts, route)];
  const byField = new Map();
  for (const v of raw) {
    const issue = { rule: ruleOf(v), message: String(v.message).slice(0, 240), ...(v.detail?.words ? { words: v.detail.words } : {}), ...(v.detail?.word ? { words: [v.detail.word] } : {}), ...(v.detail?.capabilities ? { capabilities: v.detail.capabilities } : {}), ...(v.detail?.clause ? { clause: v.detail.clause } : {}) };
    if (!byField.has(v.field)) byField.set(v.field, []);
    const issues = byField.get(v.field);
    if (!issues.some((x) => x.rule === issue.rule && x.message === issue.message)) issues.push(issue);
  }
  const order = (f) => { const m = /^concepts\[(\d+)\]\.(\w+)/.exec(f); return m ? [Number(m[1]), m[2]] : [999, f]; };
  return [...byField].map(([field, issues]) => ({ field, issues })).sort((a, b) => { const [ai, af] = order(a.field); const [bi, bf] = order(b.field); return ai - bi || (af < bf ? -1 : af > bf ? 1 : 0); });
}

/** The refusal of the stage for the route: the FIRST finding, as a Brain contract refusal (repairable), exactly as the brand guard refuses at its first violation. */
export function assertConceptsRoute(concepts, route) {
  const [first] = collectConceptRouteViolations(concepts, route);
  if (first) fail(first.code, first.message, first.field, first.detail);
  return concepts;
}

/** What SELECT is told per concept: the state and the clauses to verify (never a verdict: the judgment stays the selector's, in words). null when there is no route. */
export function routeNotesForSelection(concepts, route) {
  if (route !== ROUTE_ENVIRONMENT_FIRST) return null;
  return examineConceptSetRoute(concepts).map((r) => ({ concept_index: r.index, state: r.state, to_verify: r.to_verify.map((x) => ({ field: x.field, clause: x.clause })), incompatible: r.findings.map((x) => ({ field: x.field, clause: x.clause, rule: x.rule })) }));
}

export { BrainError };
