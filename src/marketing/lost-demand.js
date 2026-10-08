// Lost Demand producer (M1.5): a demand that was observed but could not be satisfied or found.
//
// It produces ONLY a MarketSignal (INTERNAL_MEASUREMENT). It never says "stock this", "buy N units" or "launch a campaign",
// reads no inventory (OUT_OF_STOCK_INTEREST means: the owning source states that the observed interest concerned an
// unavailable object), counts nothing and aggregates nothing: a trusted adapter hands over an already-aggregated record
// whose magnitude stays in the cited evidence until a Socle Evidence Registry exists. No number is invented here.

import { SIGNAL_CLASS } from './understand-constants.js';
import { PRODUCER_ERROR as P, produceMarketSignal, requireField } from './signal-producer.js';
import { fail } from './understand-validation.js';

// V1 sources. Human requests are NOT a Lost Demand kind: they go through the Manual Observation producer.
export const LOST_DEMAND_KIND = Object.freeze({
  ZERO_RESULT_SEARCH: 'ZERO_RESULT_SEARCH',
  UNAVAILABLE_PRODUCT_INTEREST: 'UNAVAILABLE_PRODUCT_INTEREST',
  OUT_OF_STOCK_INTEREST: 'OUT_OF_STOCK_INTEREST',
});

// One stable signal_type per kind, so no consumer ever parses source_ref to learn what the signal is.
export const LOST_DEMAND_SIGNAL_TYPE = Object.freeze({
  ZERO_RESULT_SEARCH: 'LOST_DEMAND_ZERO_RESULT_SEARCH',
  UNAVAILABLE_PRODUCT_INTEREST: 'LOST_DEMAND_UNAVAILABLE_PRODUCT_INTEREST',
  OUT_OF_STOCK_INTEREST: 'LOST_DEMAND_OUT_OF_STOCK_INTEREST',
});

/**
 * @param {object} p
 * @param {object} p.tenant resolved tenant
 * @param {object|null} [p.brand] resolved Brand Identity (merchant-wide when omitted)
 * Input (closed): kind, subject_refs[>=1], source_ref, evidence_refs[>=1], detected_at, observed_at?, expires_at,
 * effective_window?, locale?, market?, limitations[], provenance.
 */
export function produceLostDemandSignal({ tenant, brand = null, ...input } = {}) {
  return produceMarketSignal({
    tenant,
    brand,
    input,
    label: 'lostDemand',
    extraKeys: ['kind'],
    signalClass: SIGNAL_CLASS.INTERNAL_MEASUREMENT,
    resolve(i) {
      if (typeof i.kind !== 'string' || !Object.hasOwn(LOST_DEMAND_KIND, i.kind)) {
        fail(P.LOST_DEMAND_INVALID_KIND, 'lostDemand.kind is not a supported Lost Demand source');
      }
      requireField(i.subject_refs, P.LOST_DEMAND_SUBJECT_REQUIRED, 'a Lost Demand signal needs at least one subject_ref');
      requireField(i.evidence_refs, P.LOST_DEMAND_EVIDENCE_REQUIRED, 'a Lost Demand signal needs at least one evidence_ref');
      return { signalType: LOST_DEMAND_SIGNAL_TYPE[i.kind] };
    },
  });
}
