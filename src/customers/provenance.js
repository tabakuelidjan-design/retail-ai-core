// Every customer fact block carries this envelope. Facts are order-level and pseudonymous by construction:
// no customer identity is stored, so nothing here can name, list or rank a person.

export function customerProvenance({ window, sample, completeness, historyLimitations = [], limitations = [], evidence_kind = 'derived', safe, unsafeReasons = [] }) {
  return {
    source_system: 'shopify (orders, read-only)',
    observation_window: window,
    completeness,
    sample_size: sample,
    history_limitations: historyLimitations,
    limitations: ['ORDER_LEVEL_ONLY_NO_CUSTOMER_IDENTITY', 'OBSERVED_BEHAVIOUR_NOT_PREDICTION', ...limitations],
    evidence_kind,
    safe_for_phase3: { safe, reasons: safe ? [] : unsafeReasons },
    causal_claim: false,
  };
}
