// Product Identity: evidence-based, trait by trait. Every trait keeps ALL its evidence (never merged); the EFFECTIVE value is the strongest evidence, and
// two different values at the strongest level make the trait CONTRADICTORY (effective value unknown). Unknown stays unknown.
import { IDENTITY_LEVEL, IDENTITY_RANK } from './levels.js';
import { CATEGORIES, KEY_TRAITS } from './taxonomy.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();

export function createIdentity({ workingName = '' } = {}) {
  return { workingName, evidence: {}, photos: [], hsCandidates: [], identifiers: { gtin: null, model: null, brand: null, manufacturer: null, supplier: null }, countryOfOrigin: null };
}

/**
 * Adds ONE evidence record to a trait. Returns a new identity (the input is never mutated).
 * @param {string} trait e.g. 'battery.present', 'category', 'model', 'manufacturer', 'brand'
 * @param {{ value: any, level: keyof typeof IDENTITY_LEVEL, source?: { kind: string, ref?: string, note?: string }, observedAt?: string }} ev
 */
export function addEvidence(identity, trait, ev) {
  if (!IDENTITY_RANK[ev.level]) throw new Error(`unknown identity level: ${ev.level}`);
  const next = clone(identity);
  (next.evidence[trait] ??= []).push({ value: ev.value, level: ev.level, source: ev.source ?? { kind: 'unspecified' }, observedAt: ev.observedAt ?? now() });
  return next;
}

/** The strongest evidence wins; equal-strength disagreement = contradiction (value null). */
export function effective(identity, trait) {
  const list = identity.evidence[trait] ?? [];
  if (!list.length) return { value: null, level: null, known: false, contradiction: false, evidence: [] };
  const top = Math.max(...list.map((e) => IDENTITY_RANK[e.level]));
  const best = list.filter((e) => IDENTITY_RANK[e.level] === top);
  // the owner correcting their OWN earlier answer is not a contradiction: the latest user statement wins (documents and suppliers can still contradict each other)
  if (best.every((e) => e.level === 'USER_STATED')) { const last = best[best.length - 1]; return { value: last.value, level: last.level, known: true, contradiction: false, evidence: list }; }
  const values = [...new Set(best.map((e) => JSON.stringify(e.value)))];
  if (values.length > 1) return { value: null, level: best[0].level, known: false, contradiction: true, evidence: list };
  return { value: best[0].value, level: best[0].level, known: true, contradiction: false, evidence: list };
}

/** Category: sets the category AND its profile traits at PROBABLE level only (they never override stronger evidence, and never read as facts). */
export function applyCategory(identity, categoryId, { level = IDENTITY_LEVEL.PROBABLE, source = { kind: 'category-profile' } } = {}) {
  const cat = CATEGORIES[categoryId]; if (!cat) throw new Error(`unknown category: ${categoryId}`);
  let next = addEvidence(identity, 'category', { value: categoryId, level, source });
  for (const [trait, value] of Object.entries(cat.traits)) next = addEvidence(next, trait, { value, level: IDENTITY_LEVEL.PROBABLE, source: { kind: 'category-profile', ref: categoryId, note: 'profile default, not observed' } });
  return next;
}

export function setIdentifier(identity, name, value, level, source) {
  const next = addEvidence(identity, name, { value, level, source });
  const eff = effective(next, name);
  next.identifiers = { ...next.identifiers, [name]: eff.known ? eff.value : null };
  return next;
}

/** The trait getter the rule engine reads. Unknown or contradictory = null. */
export function traitEnv(identity, ctx = {}) {
  return { trait: (name) => { const e = effective(identity, name); return e.known ? e.value : null; }, ctx: (name) => ctx[name] };
}

/**
 * How well is the product identified? HIGH needs the category and the model established by a person or a document AND the safety-relevant traits resolved
 * at user/document level (a category profile alone never reaches HIGH). MEDIUM: a category confirmed by a person or the supplier, and most key traits resolved (any level). A guessed category alone stays LOW.
 */
export function identificationConfidence(identity) {
  const cat = effective(identity, 'category'); const model = effective(identity, 'model');
  const strong = (e) => e.known && IDENTITY_RANK[e.level] >= IDENTITY_RANK.USER_STATED;
  const traits = KEY_TRAITS.map((t) => ({ trait: t, ...effective(identity, t) }));
  const resolvedStrong = traits.filter(strong).length; const resolvedAny = traits.filter((t) => t.known).length;
  const unresolved = traits.filter((t) => !t.known).map((t) => t.trait);
  const weak = traits.filter((t) => t.known && !strong(t)).map((t) => t.trait);
  let level = 'LOW';
  if (cat.known && strong(cat) && model.known && resolvedStrong >= Math.ceil(KEY_TRAITS.length * 0.8)) level = 'HIGH';
  else if (cat.known && IDENTITY_RANK[cat.level] >= IDENTITY_RANK.SUPPLIER_CLAIMED && resolvedAny >= Math.ceil(KEY_TRAITS.length * 0.6)) level = 'MEDIUM'; // a category only GUESSED from a photo or text stays LOW until a person or the supplier confirms it
  return { level, categoryKnown: cat.known, modelKnown: model.known, unresolvedTraits: unresolved, assumedFromProfileOnly: weak, contradictoryTraits: traits.filter((t) => t.contradiction).map((t) => t.trait) };
}
