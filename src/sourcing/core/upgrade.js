// Schema 2 = schema 1 + the V1 collections. The upgrade is ADDITIVE and lazy: it only adds missing empty collections (never rewrites a value), it is idempotent, and it never mutates
// its input. A V0 case therefore loads, assesses and accepts every V0 event exactly as before.
export const CASE_SCHEMA = 2;
export const V1_COLLECTIONS = Object.freeze(['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions']);

export const isComplete = (s) => s && s.schema >= CASE_SCHEMA && V1_COLLECTIONS.every((k) => Array.isArray(s[k]));

/** @template T @param {T} state @returns {T} the same object when nothing is missing, otherwise a copy with the collections added */
export function upgradeCase(state) {
  if (!state || typeof state !== 'object' || isComplete(state)) return state;
  const next = { ...state, schema: Math.max(CASE_SCHEMA, Number(state.schema) || 0) };
  for (const k of V1_COLLECTIONS) if (!Array.isArray(next[k])) next[k] = [];
  return next;
}
