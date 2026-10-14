// SYNTHETIC FIXTURES - NOT REAL DATA.
// Every number below is invented to exercise the Socle Decision engine.
// "habb-like" only means "a small physical + online gift retailer"; no real
// HABB figure, product, supplier or customer is used here.
export const SYNTHETIC_FIXTURE = true;
export const FIXTURE_NOTICE = 'SYNTHETIC FIXTURE - invented numbers, no real merchant data';

export const MERCHANT_A = 'synthetic-merchant-habb-like';
export const MERCHANT_B = 'synthetic-merchant-other';
export const NOW = '2026-10-06T09:00:00.000Z';

// Thresholds are configuration, not engine truth.
export const CONFIG = {
  materialityThreshold: 500,
  currency: 'EUR',
  maxPrioritySubjects: 3,
  cooldownDays: 30,
  aggravationFactor: 1.5,
  testSmall: { budget: 100, time_to_effect_days: 14 },
};

// Owner rules (merchant A).
export const RULES_A = [
  { id: 'owner.min_cash', type: 'MIN_CASH', label: 'Cash minimum du dirigeant', params: { min_cash: 5000, horizon_days: 30 }, applies_to_types: ['CASH_FLOOR_RISK'] },
  { id: 'owner.min_margin', type: 'MIN_MARGIN', label: 'Marge minimum', params: { min_margin_pct: 20 } },
  { id: 'owner.max_discount', type: 'MAX_DISCOUNT', label: 'Remise maximum', params: { max_discount_pct: 40 } },
  { id: 'owner.max_budget', type: 'MAX_BUDGET', label: 'Budget maximum', params: { max_budget: 1000 } },
  { id: 'owner.max_risk', type: 'MAX_RISK', label: 'Risque maximum', params: { max_risk: 'HIGH' } },
];

export const DORMANT_INPUT = {
  merchant_id: MERCHANT_A,
  product_ref: 'SYN-SKU-001',
  title: 'Synthetic dormant stock SYN-SKU-001',
  units_on_hand: 400,
  units_sold_90d: 12,
  immobilized_value: 6000,
  unit_price: 40,
  unit_cost: 15,
  reorder_planned_units: 200,
  reorder_planned_value: 3000,
  days_to_season_window: 75,
  currency: 'EUR',
  detected_at: '2026-10-05T08:00:00.000Z',
  source_refs: ['synthetic:inventory-snapshot'],
};

export const DORMANT_ASSUMPTIONS = {
  postpone_reorder: { risk: 'MEDIUM' },
  discount: { discount_pct: 30, expected_units_sold: 150, days_to_cash: 20, confidence: 'MEDIUM' },
  bundle: { discount_pct: 10, expected_units_sold: 80, days_to_cash: 30, confidence: 'MEDIUM' },
  marketing: { budget: 300, expected_units_sold: 60, days_to_cash: 30, confidence: 'MEDIUM' },
  b2b: { discount_pct: 50, expected_units_sold: 250, days_to_cash: 14, confidence: 'LOW' }, // breaks max discount
  wait_season: { expected_cash: 5000, expected_margin: 3000, expected_units_sold: 200 },
};

export const CASH_INPUT = {
  merchant_id: MERCHANT_A,
  currency: 'EUR',
  projected_cash: 1200,
  observed_floor: 5000,
  breach_in_days: 21,
  horizon_days: 30,
  payables_deferrable: 2500,
  receivables_accelerable: 1800,
  sellable_stock_value: 4000,
  purchases_deferrable: 3000,
  detected_at: '2026-10-05T08:00:00.000Z',
};

export const CASH_ASSUMPTIONS = {
  delay_payment: {},
  collections: { days_to_cash: 7 },
  sell_down: { discount_pct: 35, days_to_cash: 10, margin_impact: -600, resulting_margin_pct: 12, inventory_impact: -100, capacity_impact: 0 },
  defer_purchase: { inventory_impact: 0 },
};

// A lever offered by ANOTHER domain (marketing) that would worsen the cash floor.
export const AGGRAVATING_LEVER = {
  id: 'marketing.PAID_CAMPAIGN',
  domain: 'marketing',
  label: 'Campagne payante',
  estimated_effects: { cash_impact: 2000, margin_impact: 800, time_to_cash_days: 45, capacity_impact: 0, inventory_impact: 0 },
  estimated_cost: { amount: 900, currency: 'EUR' },
  reversibility: 'IRREVERSIBLE',
  risk: 'MEDIUM',
  confidence: 'MEDIUM',
};

// Footfall: data NOT sufficient to separate traffic / conversion / seasonality / measurement.
export const FOOTFALL_INCOMPLETE_INPUT = {
  merchant_id: MERCHANT_A,
  period_label: '2026-W40',
  visits_current: 310,
  visits_prior: 420,
  revenue_at_stake: 1800,
  currency: 'EUR',
  detected_at: '2026-10-05T08:00:00.000Z',
};

// Footfall: data sufficient (last-year baseline, conversion, reliable counter).
export const FOOTFALL_COMPLETE_INPUT = {
  ...FOOTFALL_INCOMPLETE_INPUT,
  visits_same_period_last_year: 400,
  conversion_rate_current: 0.12,
  conversion_rate_prior: 0.12,
  counter_reliable: true,
};

export const FOOTFALL_ASSUMPTIONS = {
  local_campaign: { budget: 400, expected_revenue: 1500, expected_margin: 600, days_to_cash: 21 },
  window_refresh: { budget: 80, expected_revenue: 400, expected_margin: 250, days_to_cash: 14 },
};

// Generic lever factory for engine-level tests.
export const lever = (over) => ({
  id: 'x.LEVER',
  domain: 'synthetic',
  label: 'Synthetic lever',
  estimated_effects: { cash_impact: 1000, margin_impact: 500, time_to_cash_days: 10, capacity_impact: 0, inventory_impact: 0 },
  estimated_cost: { amount: 0, currency: 'EUR' },
  reversibility: 'REVERSIBLE',
  risk: 'LOW',
  confidence: 'MEDIUM',
  ...over,
});
