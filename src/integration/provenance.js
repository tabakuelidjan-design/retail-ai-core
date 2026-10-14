// One provenance vocabulary across Nordla (requirement 4). Every module keeps its own enum; this file maps each to the shared one and enforces
// that nothing is promoted silently: a SUPPLIER_CLAIM, an ESTIMATE or an UNKNOWN becomes VERIFIED only through an explicit, attributable verification.
import { PROVENANCE as P, ERR, fail, deepFreeze } from './constants.js';

/** module-local value -> shared value. A value missing from a table maps to UNKNOWN (never to something stronger). */
export const MAPPINGS = deepFreeze({
  // src/sourcing/core/provenance.js FACT_STATUS
  sourcing_fact_status: { SUPPLIER_CLAIM: P.SUPPLIER_CLAIM, USER_PROVIDED: P.USER_PROVIDED, DOCUMENT_RECEIVED: P.DOCUMENT_OBSERVED, DOCUMENT_MATCHED: P.DOCUMENT_OBSERVED, VERIFIED: P.VERIFIED, ESTIMATED: P.ESTIMATED, UNKNOWN: P.UNKNOWN, CONFLICT: P.CONFLICT },
  // src/sourcing/core/case-facts.js SOURCE_TYPE
  sourcing_source_type: { USER_PROVIDED: P.USER_PROVIDED, SUPPLIER_CLAIM: P.SUPPLIER_CLAIM, IMAGE_OBSERVED: P.IMAGE_OBSERVED, DOCUMENT_OBSERVED: P.DOCUMENT_OBSERVED, SYSTEM_DERIVED: P.SYSTEM_DERIVED, VERIFIED: P.VERIFIED, UNATTRIBUTED_LEGACY: P.UNKNOWN },
  // src/buying/contract.js BASIS_RANK keys: a QUOTED price is what the supplier said, not a verified fact
  buying_basis: { QUOTED: P.SUPPLIER_CLAIM, ESTIMATED: P.ESTIMATED, ASSUMPTION: P.ESTIMATED, MISSING: P.UNKNOWN },
  // src/marketing/provenance.js EVIDENCE_KINDS (lowercase) and src/branding/constants.js EVIDENCE_PROVENANCE
  marketing_evidence_kind: { observed: P.SYSTEM_DERIVED, derived: P.SYSTEM_DERIVED, attributed: P.ESTIMATED, inferred: P.ESTIMATED, unavailable: P.UNKNOWN },
  // src/creative-planning/constants.js FACT_STATUS
  creative_fact_status: { VERIFIED: P.VERIFIED, APPROVED_CLAIM: P.USER_PROVIDED, ESTIMATE: P.ESTIMATED, UNKNOWN: P.UNKNOWN },
  // src/metrics/costs.js COST_STATUS
  metrics_cost_status: { VERIFIED: P.VERIFIED, UNVERIFIED: P.USER_PROVIDED, ESTIMATED: P.ESTIMATED, STALE: P.ESTIMATED, MISSING: P.UNKNOWN },
  // src/finance/payables/due.js DUE_ORIGINS
  finance_due_origin: { MANUAL: P.USER_PROVIDED, PRINTED: P.DOCUMENT_OBSERVED, COMPUTED_FROM_TERMS: P.SYSTEM_DERIVED, UNKNOWN: P.UNKNOWN },
});

export function toShared(table, value) {
  const t = MAPPINGS[table];
  if (!t) fail(ERR.PROVENANCE_PROMOTION_REFUSED, `unknown provenance table ${table}`);
  return t[value] ?? P.UNKNOWN;
}

/** A fact crossing a module boundary: its value, where it came from, and how far it can be trusted. */
export function makeFact({ value, provenance, source_module, source_ref = null, unit = null, currency = null, note = null }) {
  if (!Object.values(P).includes(provenance)) fail(ERR.PROVENANCE_PROMOTION_REFUSED, `not a shared provenance value: ${provenance}`);
  if (typeof source_module !== 'string' || !source_module) fail(ERR.HANDOFF_INVALID, 'a fact names its source module');
  return deepFreeze({ value, provenance, source_module, source_ref, unit, currency, note });
}

/**
 * The only way up to VERIFIED. Needs a verification record naming a HUMAN or an OFFICIAL source and a reference to the evidence.
 * CONFLICT can only be left through an explicit resolution record. Nothing else is a promotion: DOCUMENT_OBSERVED stays DOCUMENT_OBSERVED.
 */
export function promote(fact, to, verification) {
  if (to !== P.VERIFIED) fail(ERR.PROVENANCE_PROMOTION_REFUSED, 'the only promotion is to VERIFIED', { from: fact.provenance, to });
  const v = verification ?? {};
  const humanOrOfficial = ['HUMAN', 'OFFICIAL_SOURCE'].includes(v.verifier_kind);
  if (!humanOrOfficial || typeof v.verifier !== 'string' || !v.verifier || typeof v.evidence_ref !== 'string' || !v.evidence_ref) {
    fail(ERR.PROVENANCE_PROMOTION_REFUSED, 'promotion needs {verifier_kind: HUMAN|OFFICIAL_SOURCE, verifier, evidence_ref}', { from: fact.provenance });
  }
  if (fact.provenance === P.CONFLICT && !v.resolves_conflict) fail(ERR.PROVENANCE_PROMOTION_REFUSED, 'a CONFLICT is left only by an explicit resolution', { from: fact.provenance });
  if (['SYSTEM', 'LLM', 'AI', 'ENGINE', 'MODEL'].includes(String(v.verifier).toUpperCase())) fail(ERR.PROVENANCE_PROMOTION_REFUSED, 'a machine cannot verify', { verifier: v.verifier });
  return deepFreeze({ ...fact, provenance: P.VERIFIED, promoted_from: fact.provenance, verification: { verifier_kind: v.verifier_kind, verifier: v.verifier, evidence_ref: v.evidence_ref } });
}

/** Combine two facts about the same thing: equal values keep the weaker provenance; different values become a CONFLICT that keeps both. */
export function reconcile(a, b) {
  const rank = { [P.VERIFIED]: 5, [P.DOCUMENT_OBSERVED]: 4, [P.USER_PROVIDED]: 4, [P.IMAGE_OBSERVED]: 3, [P.SYSTEM_DERIVED]: 3, [P.SUPPLIER_CLAIM]: 2, [P.ESTIMATED]: 1, [P.UNKNOWN]: 0, [P.CONFLICT]: -1 };
  if (a.currency !== b.currency) {
    return makeFact({ value: { a: a.value, b: b.value }, provenance: P.CONFLICT, source_module: `${a.source_module}|${b.source_module}`, note: `CURRENCY_MISMATCH ${a.currency} vs ${b.currency}: not converted` });
  }
  if (JSON.stringify(a.value) !== JSON.stringify(b.value)) {
    return makeFact({ value: { a: a.value, b: b.value }, provenance: P.CONFLICT, source_module: `${a.source_module}|${b.source_module}`, currency: a.currency, note: 'VALUE_MISMATCH' });
  }
  const weaker = rank[a.provenance] <= rank[b.provenance] ? a : b;
  return makeFact({ value: a.value, provenance: weaker.provenance, source_module: `${a.source_module}|${b.source_module}`, unit: a.unit, currency: a.currency });
}
