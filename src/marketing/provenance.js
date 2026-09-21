// Provenance for every marketing fact. Attribution is an OBSERVATION of a recorded
// journey under a stated model - never proof that a channel caused a sale.
//   observed     read directly from a recorded field (e.g. the order's sales channel, exported search rows)
//   attributed   assigned to a channel by a stated attribution model (e.g. last recorded visit)
//   inferred     derived by a configurable rule (e.g. a host list) from observed fields
//   derived      computed deterministically from observed values (a recomputed CTR, a share, a rule-based signal)
//   unavailable  the data needed does not exist here

export const EVIDENCE_KINDS = ['observed', 'attributed', 'inferred', 'derived', 'unavailable'];
export const NOT_CAUSAL = 'ATTRIBUTION_IS_NOT_CAUSAL_PROOF';

/**
 * @param {object} p
 * @param {object|null} [p.filters] e.g. { search_type, country, device, ... } - the filters the source data was pulled with
 */
export function provenance({ source_system, attribution_model = null, fields = [], window = null, filters = null, limitations = [], completeness, evidence_kind }) {
  if (!EVIDENCE_KINDS.includes(evidence_kind)) throw new Error(`invalid evidence_kind ${evidence_kind}`);
  if (!['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(completeness)) throw new Error(`invalid completeness ${completeness}`);
  return {
    source_system, attribution_model, source_fields: fields, window, filters,
    limitations: [...new Set([...(evidence_kind === 'attributed' || evidence_kind === 'inferred' ? [NOT_CAUSAL] : []), ...limitations])],
    completeness, evidence_kind, causal_claim: false,
  };
}

export const windowOf = (w) => (w ? { key: w.key ?? null, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(), timeZone: w.timeZone ?? null } : null);
