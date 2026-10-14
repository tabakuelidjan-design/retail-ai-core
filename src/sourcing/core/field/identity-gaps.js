// IDENTIFICATION GAPS, told apart. "Is the model number known?" and "is the product identified well enough to decide?" are two different questions with two different remedies:
//   MODEL     ABSENT (nothing said) · PROPOSED (said, not confirmed) · CONFIRMED (accepted by the owner: still the supplier's word, not independent proof) · CONTRADICTORY
//   TECHNICAL the category and the safety traits (core/identity.js identificationConfidence): COMPLETE or INCOMPLETE (level LOW). A model number never completes it, and a complete identification never means the product is compliant.
// Pure and deterministic: it only reads the case; nothing here confirms, relaxes or invents anything.
import { effective } from '../identity.js';
import { KEY_TRAITS } from '../taxonomy.js';

export const MODEL_STATE = Object.freeze({ ABSENT: 'ABSENT', PROPOSED: 'PROPOSED', CONFIRMED: 'CONFIRMED', CONTRADICTORY: 'CONTRADICTORY' });
const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

/** @returns {{ state: string, value: string|null, level: string|null, proposed: string[], values: string[], conflictIds: string[] }} */
export function modelState(state) {
  const eff = effective(state.identity, 'model'); const conflicts = (state.conflicts ?? []).filter((c) => c.state === 'OPEN' && (c.type === 'MODEL_MISMATCH' || c.key === 'identifier.model'));
  const proposed = [...new Set((state.candidates ?? []).filter((c) => c.key === 'identifier.model' && c.state === 'PROPOSED' && c.value !== null && c.value !== undefined).map((c) => String(c.correctedValue ?? c.value)))];
  if (eff.contradiction || conflicts.length) return { state: MODEL_STATE.CONTRADICTORY, value: null, level: eff.level, proposed, values: [...new Set([...eff.evidence.map((e) => show(e.value)), ...conflicts.flatMap((c) => c.entries.map((e) => show(e.value)))])], conflictIds: conflicts.map((c) => c.id) };
  if (eff.known) return { state: MODEL_STATE.CONFIRMED, value: String(eff.value), level: eff.level, proposed, values: [String(eff.value)], conflictIds: [] };
  if (proposed.length) return { state: MODEL_STATE.PROPOSED, value: null, level: null, proposed, values: proposed, conflictIds: [] };
  return { state: MODEL_STATE.ABSENT, value: null, level: null, proposed: [], values: [], conflictIds: [] };
}

/** @param {object} state the case @param {{ identity?: { confidence?: object } }} a its assessment */
export function identificationStatus(state, a) {
  const model = modelState(state); const conf = a?.identity?.confidence ?? { level: 'LOW', categoryKnown: false, categoryConfirmed: false, unresolvedTraits: [...KEY_TRAITS], assumedFromProfileOnly: [], contradictoryTraits: [] };
  const incomplete = conf.level === 'LOW';
  const technical = { complete: !incomplete, level: conf.level, categoryKnown: conf.categoryKnown === true, categoryConfirmed: conf.categoryConfirmed === true, categoryLevel: conf.categoryLevel ?? null, unresolved: conf.unresolvedTraits ?? [], assumed: conf.assumedFromProfileOnly ?? [], contradictory: conf.contradictoryTraits ?? [] };
  const code = model.state === MODEL_STATE.CONTRADICTORY ? 'MODEL_CONTRADICTORY' : model.state === MODEL_STATE.ABSENT ? 'MODEL_NOT_ESTABLISHED' : model.state === MODEL_STATE.PROPOSED ? 'MODEL_NOT_CONFIRMED' : incomplete ? 'PRODUCT_IDENTITY_UNRESOLVED' : 'IDENTIFIED';
  return { model, technical, code, modelOk: model.state === MODEL_STATE.CONFIRMED };
}
