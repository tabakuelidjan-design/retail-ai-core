// What Phase 3 may consume from marketing facts. Conversion metrics (sessions -> orders) pass only when the
// traffic_conversion gate is OPEN; Shopify session traffic can be dominated by non-target markets, so a closed
// gate returns no numbers at all. Search facts are observations with provenance and never a conversion input.

export function phase3Inputs(facts) {
  const g = facts.gates ?? {};
  const conversion = g.traffic_conversion?.status === 'OPEN'
    ? { status: 'OPEN', traffic: facts.traffic }
    : { status: 'GATED', reasons: g.traffic_conversion?.reasons ?? ['NO_TRAFFIC_FACTS'], traffic: null };
  const v = facts.search?.visibility;
  const search = v
    ? {
      status: 'CONSUMABLE_AS_OBSERVATIONS', not_a_conversion_input: true,
      gates: v.gates, coverage: v.coverage, queries: v.queries, pages: v.pages, geography: v.geography, opportunity_signals: v.opportunity_signals,
      classified_only_if: { branded_split: v.gates.branded_split.status, intent_split: v.gates.intent_split.status },
    }
    : { status: 'ABSENT' };
  return { conversion, search, causal_claims: false };
}
