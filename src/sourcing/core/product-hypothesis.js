// PRODUCT HYPOTHESIS (provider-independent). What Nordla currently believes a product IS, assembled from every source that said something about it, each with its provenance and confidence:
//   PRODUCT_NAME / IMAGE_OBSERVATION  (core/product-observer.js, recorded in case.productObservations)
//   OWNER                             (identity evidence at USER_STATED or above: the owner stronger than any inference)
//   SUPPLIER_SPEECH / DOCUMENT        (identity evidence from the conversation or an inspected document; statements still proposed are listed as SIGNALS, never as evidence)
//   BARCODE_MODEL_DATA                (future: the same shape)
// The model is a VIEW over the case: nothing here is a new store of truth. Traits are the product's characteristics (batteryPresent, capacityRelevant, ...), each KNOWN with a level, UNKNOWN, or
// CONTRADICTORY. A category is only a hypothesis (or the owner's confirmed choice); it can stay UNKNOWN while many traits are known. Inference is never turned into fact: PROBABLE / SUGGESTED stay labelled.
import { addEvidence, effective } from './identity.js';
import { IDENTITY_RANK } from './levels.js';
import { KEY_TRAITS, SPEC_TRAITS, CATEGORIES } from './taxonomy.js';
import { OBSERVATION_SOURCE, sanitizeObservations } from './product-observer.js';

const TRAIT_LIST = Object.freeze([...KEY_TRAITS, ...SPEC_TRAITS, 'electrical.mainsConnected']);
const nextId = (list) => `po-${1 + Math.max(0, ...list.map((o) => Number(String(o.id).slice(3)) || 0))}`;
const LEVEL_OF = (source) => (source === OBSERVATION_SOURCE.IMAGE_OBSERVATION ? 'AI_SUGGESTED' : 'PROBABLE');

function withoutObserver(identity, observer) {
  const next = JSON.parse(JSON.stringify(identity));
  for (const [t, list] of Object.entries(next.evidence ?? {})) { const keep = list.filter((e) => !(e.source?.kind === 'observer' && e.source.observer === observer)); if (keep.length) next.evidence[t] = keep; else delete next.evidence[t]; }
  return next;
}

/**
 * Records ONE observer result in the case (reducer helper). The same observer observing again (a renamed product, a new photo) SUPERSEDES its earlier record and its earlier evidence.
 * Only MEDIUM/HIGH observations become identity evidence, at PROBABLE (AI_SUGGESTED for an image): LOW ones stay in the record as hypotheses.
 */
export function recordObservation(s, result, at, input = {}) {
  const list = (s.productObservations ??= []); const observer = result.observer;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].observer === observer) list.splice(i, 1);
  s.identity = withoutObserver(s.identity, observer);
  const source = result.source ?? OBSERVATION_SOURCE.PRODUCT_NAME;
  const rec = { id: nextId(list), at, observer, version: result.version ?? null, source, status: result.status, input: { name: input.name ?? null, imageRef: input.imageRef ?? null }, observations: sanitizeObservations(result.observations, source), hypotheses: Array.isArray(result.hypotheses) ? result.hypotheses : [], ...(result.note ? { note: result.note } : {}) };
  list.push(rec);
  for (const o of rec.observations) if (o.confidence === 'MEDIUM' || o.confidence === 'HIGH') s.identity = addEvidence(s.identity, o.trait, { value: o.value, level: LEVEL_OF(source), confidence: o.confidence, source: { kind: 'observer', observer, observationId: rec.id, via: o.provenance?.via ?? null, note: o.provenance?.matched ? `matched: ${o.provenance.matched.join(', ')}` : null } });
  return rec;
}

const SIGNAL_TRAITS = { 'spec.capacity': ['capacity.relevant', true], 'spec.compatibility': ['compatibility.required', true] };
const statusOf = (e) => (!e.known ? (e.contradiction ? 'CONTRADICTORY' : 'UNKNOWN') : IDENTITY_RANK[e.level] >= IDENTITY_RANK.USER_STATED ? 'CONFIRMED' : e.level === 'SUPPLIER_CLAIMED' ? 'SUPPLIER_CLAIMED' : e.level === 'AI_SUGGESTED' ? 'SUGGESTED' : 'PROBABLE');
const sourceOf = (ev, observations) => {
  const k = ev.source?.kind; if (k === 'observer') return observations.find((o) => o.id === ev.source.observationId)?.source ?? OBSERVATION_SOURCE.PRODUCT_NAME;
  if (k === 'user') return OBSERVATION_SOURCE.OWNER; if (k === 'conversation' || k === 'supplier') return OBSERVATION_SOURCE.SUPPLIER_SPEECH; if (k === 'document') return OBSERVATION_SOURCE.DOCUMENT; return k ?? 'UNSPECIFIED';
};

/** @returns the hypothesis view: { category, traits, sources, signals, unknownTraits, summary } */
export function buildProductHypothesis(state) {
  const id = state.identity; const observations = state.productObservations ?? [];
  const traits = {};
  for (const t of TRAIT_LIST) {
    const e = effective(id, t); const list = id.evidence?.[t] ?? [];
    const best = list.filter((x) => IDENTITY_RANK[x.level] === Math.max(...list.map((y) => IDENTITY_RANK[y.level]), 0));
    traits[t] = { value: e.known ? e.value : null, known: e.known, contradiction: e.contradiction, level: e.level, status: statusOf(e), confidence: best.map((x) => x.confidence).filter(Boolean).sort().at(0) ?? (e.known ? 'CONFIRMED_BY_PERSON_OR_DOCUMENT' : null), sources: list.map((x) => ({ source: sourceOf(x, observations), level: x.level, value: x.value, confidence: x.confidence ?? null, provenance: x.source })) };
  }
  const cat = effective(id, 'category'); const nameRec = observations.find((o) => o.observer === 'name-cues');
  const hyps = [...observations.flatMap((o) => o.hypotheses.map((h) => ({ ...h, observer: o.observer })))].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const category = cat.known ? { value: cat.value, status: IDENTITY_RANK[cat.level] >= IDENTITY_RANK.USER_STATED ? 'CONFIRMED' : 'PROBABLE', level: cat.level, label: CATEGORIES[cat.value]?.label ?? cat.value, candidates: hyps }
    : { value: null, status: hyps[0] && hyps[0].confidence !== 'LOW' ? 'HYPOTHESIS' : 'UNKNOWN', best: hyps[0] ? { category: hyps[0].category, label: CATEGORIES[hyps[0].category]?.label ?? hyps[0].category, confidence: hyps[0].confidence } : null, candidates: hyps };
  // statements still PROPOSED in the conversation that imply a trait: signals, never evidence (nothing is promoted without the owner)
  const signals = (state.candidates ?? []).filter((c) => c.state === 'PROPOSED' && SIGNAL_TRAITS[c.key]).map((c) => ({ trait: SIGNAL_TRAITS[c.key][0], value: SIGNAL_TRAITS[c.key][1], source: OBSERVATION_SOURCE.SUPPLIER_SPEECH, status: 'PROPOSED', candidateId: c.id }));
  const sources = observations.map((o) => ({ observer: o.observer, source: o.source, status: o.status, at: o.at, note: o.note ?? null, observed: o.observations.length }));
  const unknownTraits = TRAIT_LIST.filter((t) => !traits[t].known);
  return { category, traits, sources, signals, unknownTraits, summary: { name: id.workingName || null, known: TRAIT_LIST.length - unknownTraits.length, unknown: unknownTraits.length, probable: TRAIT_LIST.filter((t) => ['PROBABLE', 'SUGGESTED'].includes(traits[t].status)).length, nameObserved: !!nameRec } };
}
