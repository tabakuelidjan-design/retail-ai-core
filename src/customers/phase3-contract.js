// What Phase 3 may consume from customer facts: only blocks whose provenance says safe_for_phase3.
// Everything else is returned as GATED with the reasons and no numbers.

const BLOCKS = ['new_vs_returning', 'new_vs_returning_customers', 'repeat_behaviour', 'customer_value', 'customer_concentration', 'basket'];

export function phase3CustomerInputs(facts) {
  const out = {};
  for (const b of BLOCKS) {
    const s = facts?.[b]?.provenance?.safe_for_phase3;
    out[b] = s?.safe ? { status: 'SAFE', facts: facts[b] } : { status: 'GATED', reasons: s?.reasons ?? ['NO_FACTS'], facts: null };
  }
  return { ...out, causal_claims: false, predictive_claims: false };
}
