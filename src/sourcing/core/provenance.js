// Provenance vocabulary for V1. A material fact keeps WHO said it, WHEN, with WHAT evidence and whether a person confirmed it; it is never reduced to a bare value.
// Hard invariants (tested): a supplier statement can never rise above SUPPLIER_CLAIM by itself; a promised document is not a received document; a received document is not a matched one.
// V0 values are not migrated: they are interpreted through adapters (V0 identity levels already separate claim / user / document / official, see core/levels.js).
export const FACT_STATUS = Object.freeze({
  SUPPLIER_CLAIM: 'SUPPLIER_CLAIM', // the supplier said it (voice, text, WeChat, quotation): never evidence
  USER_PROVIDED: 'USER_PROVIDED', // the owner typed it or corrected it after looking at the product / paper
  DOCUMENT_RECEIVED: 'DOCUMENT_RECEIVED', // a document was added to the case (it may still be about another model)
  DOCUMENT_MATCHED: 'DOCUMENT_MATCHED', // a received document names the same model as the case
  VERIFIED: 'VERIFIED', // an official source (never produced by a conversation)
  ESTIMATED: 'ESTIMATED',
  UNKNOWN: 'UNKNOWN',
  CONFLICT: 'CONFLICT',
});
export const CANDIDATE_STATE = Object.freeze({ PROPOSED: 'PROPOSED', CONFIRMED: 'CONFIRMED', CORRECTED: 'CORRECTED', REJECTED: 'REJECTED', CONFLICT: 'CONFLICT' });
export const SPEAKER = Object.freeze({ SUPPLIER: 'supplier', ME: 'me' });
export const DECIDED = new Set([CANDIDATE_STATE.CONFIRMED, CANDIDATE_STATE.CORRECTED, CANDIDATE_STATE.REJECTED]);

/** The status a CONFIRMED statement can have. A conversation can never produce more than a claim (supplier) or a user-provided fact (the owner). */
export function confirmedStatus({ speaker, corrected = false }) { return corrected || speaker === SPEAKER.ME ? FACT_STATUS.USER_PROVIDED : FACT_STATUS.SUPPLIER_CLAIM; }

// which received documents can back which claim (the claim key comes from the extractor: docClaim.<KEY>)
const CLAIM_DOCS = { CE: ['EU_DOC'], UN383: ['UN383'], ROHS: ['ROHS_EVIDENCE'], REACH: ['REACH_EVIDENCE'], SDS: ['SDS'], IEC62133: ['BATTERY_DOC'], TEST_REPORT: ['TEST_REPORT'], FCC: [] };
const MODEL_BOUND = new Set(['EU_DOC', 'TEST_REPORT', 'CERTIFICATE', 'UN383', 'FCM_DOC', 'BATTERY_DOC']);

/**
 * Where does a supplier's document claim stand? Computed from the case, never stored: NONE / CLAIMED / PROMISED / NOT_AVAILABLE (supplier statements) ->
 * DOCUMENT_RECEIVED (a document of that type was added) -> DOCUMENT_MATCHED (it names the case model) or MISMATCH (it names another model).
 */
export function documentStatusOf(state, claim) {
  const entries = (state.documentLedger ?? []).filter((d) => d.claim === claim); const last = entries.at(-1) ?? null;
  const types = CLAIM_DOCS[claim] ?? []; const docs = (state.documents ?? []).filter((d) => types.includes(d.docType));
  const caseModel = state.identity?.identifiers?.model ?? null;
  if (!docs.length) return { claim, status: last?.status ?? 'NONE', claimStatus: last?.status ?? null, received: 0, matched: false };
  const bound = types.some((t) => MODEL_BOUND.has(t));
  const withModels = docs.filter((d) => (d.extraction?.models ?? []).length);
  if (!bound || !caseModel || !withModels.length) return { claim, status: FACT_STATUS.DOCUMENT_RECEIVED, claimStatus: last?.status ?? null, received: docs.length, matched: false };
  const matched = withModels.some((d) => d.extraction.models.some((m) => m === caseModel));
  return { claim, status: matched ? FACT_STATUS.DOCUMENT_MATCHED : 'MISMATCH', claimStatus: last?.status ?? null, received: docs.length, matched };
}
