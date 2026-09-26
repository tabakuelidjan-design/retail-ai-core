// The deterministic summary of what the tools returned: everything the UI needs to show a clean answer WITHOUT any model text (fallback after a rejected
// explanation), the "Données utilisées" area (period, metrics, comparison, freshness) and the limits of the data. Built from the tool results only.

const MAX_VALUES = 12;
const MAX_ITEMS = 5;
const MAX_ITEM_VALUES = 4;

export function buildSummary(executed, currency = 'EUR') {
  return {
    currency,
    calls: executed.filter((e) => e.result.ok).map((e, _i, _all) => {
      const r = e.result;
      return {
        id: `c${executed.indexOf(e) + 1}`, tool: r.tool, period: { from: r.period.from, to: r.period.to, days: r.period.days, includesToday: r.period.includesToday },
        values: r.values.slice(0, MAX_VALUES),
        items: (r.items ?? []).slice(0, MAX_ITEMS).map((i) => ({ label: i.label ?? null, status: i.status ?? null, values: (i.values ?? []).slice(0, MAX_ITEM_VALUES) })),
        comparison: r.comparison ? { reference: r.comparison.reference ?? null, basis: r.comparison.basis, rows: (r.comparison.rows ?? []).map((x) => ({ key: x.key, unit: x.unit, current: x.current, previous: x.previous, delta_abs: x.delta_abs, delta_pct: x.delta_pct })) } : null,
        completeness: { status: r.completeness.status, reasons: r.completeness.reasons.map((x) => x.code), missing: r.completeness.missing },
        freshness: { dataAsOf: r.freshness.dataAsOf, ageMinutes: r.freshness.ageMinutes, stale: r.freshness.stale },
      };
    }),
  };
}
