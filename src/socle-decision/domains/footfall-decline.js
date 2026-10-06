import { CONFIDENCE, FACT_QUALITY, REVERSIBILITY, RISK, SUBJECT_KIND, SUBJECT_TYPE } from '../constants.js';
import { createLever } from '../lever.js';
import { createSubject } from '../subject.js';
import { isNum } from '../util.js';

// Store-traffic domain: supplies FACTS (observed changes) and possible LEVERS.
// It does NOT diagnose and does NOT conclude "run a campaign": whether the
// decline is traffic, conversion, seasonality or measurement error is exactly
// what the missing_data below keeps open until the data can tell.
export const DOMAIN = 'footfall';
const T = [SUBJECT_TYPE.FOOTFALL_DECLINE];
const pct = (cur, prev) => (isNum(cur) && isNum(prev) && prev !== 0 ? ((cur - prev) / prev) * 100 : null);

export function buildFootfallDeclineSubject(input) {
  const visitsChange = pct(input.visits_current, input.visits_prior);
  const yoy = pct(input.visits_current, input.visits_same_period_last_year);
  const convChange = isNum(input.conversion_rate_current) && isNum(input.conversion_rate_prior)
    ? (input.conversion_rate_current - input.conversion_rate_prior) * 100
    : null;
  const missing_data = [];
  if (yoy === null) missing_data.push({ field: 'seasonality_baseline', reason: 'no same-period-last-year data: seasonality cannot be separated', blocking: true });
  if (convChange === null) missing_data.push({ field: 'conversion_rate', reason: 'conversion unknown: traffic vs conversion cannot be separated', blocking: true });
  if (input.counter_reliable === null || input.counter_reliable === undefined) {
    missing_data.push({ field: 'measurement_reliability', reason: 'counter reliability unknown: measurement error not excluded', blocking: true });
  }
  return createSubject({
    merchant_id: input.merchant_id,
    type: SUBJECT_TYPE.FOOTFALL_DECLINE,
    key: `${SUBJECT_TYPE.FOOTFALL_DECLINE}:${input.period_label}`,
    kind: SUBJECT_KIND.ANOMALY,
    title: input.title ?? `Footfall decline ${input.period_label}`,
    materiality: input.revenue_at_stake,
    currency: input.currency,
    confidence: input.confidence ?? CONFIDENCE.LOW,
    detected_at: input.detected_at,
    review_at: input.review_at,
    facts: [
      { key: 'visits_current', value: input.visits_current ?? null, unit: 'visits', quality: input.counter_reliable === false ? FACT_QUALITY.SUSPECT : FACT_QUALITY.OK },
      { key: 'visits_prior', value: input.visits_prior ?? null, unit: 'visits' },
      { key: 'visits_change_pct', value: visitsChange, unit: '%' },
      { key: 'yoy_change_pct', value: yoy, unit: '%' },
      { key: 'conversion_change_pts', value: convChange, unit: 'pts' },
      { key: 'counter_reliable', value: input.counter_reliable ?? null },
    ],
    missing_data,
    source_refs: input.source_refs ?? [],
  });
}

export function footfallLevers(subject, assumptions = {}) {
  const A = assumptions;
  const need = ['yoy_change_pct', 'conversion_change_pts', 'counter_reliable'];
  const out = [];
  if (A.local_campaign) {
    out.push(createLever({
      domain: DOMAIN, id: 'footfall.LOCAL_CAMPAIGN', label: 'Campagne locale',
      eligibility: { subject_types: T, requires_facts: need, conditions: [{ fact: 'yoy_change_pct', op: 'lt', value: 0 }] },
      estimated_effects: { cash_impact: A.local_campaign.expected_revenue ?? null, margin_impact: A.local_campaign.expected_margin ?? null, time_to_cash_days: A.local_campaign.days_to_cash ?? null, capacity_impact: 0, inventory_impact: null },
      estimated_cost: { amount: A.local_campaign.budget ?? null, currency: subject.currency },
      reversibility: REVERSIBILITY.PARTIALLY_REVERSIBLE, risk: RISK.MEDIUM, confidence: CONFIDENCE.LOW,
    }));
  }
  if (A.window_refresh) {
    out.push(createLever({
      domain: DOMAIN, id: 'footfall.WINDOW_REFRESH', label: 'Rafraîchir la vitrine',
      eligibility: { subject_types: T, requires_facts: need },
      estimated_effects: { cash_impact: A.window_refresh.expected_revenue ?? null, margin_impact: A.window_refresh.expected_margin ?? null, time_to_cash_days: A.window_refresh.days_to_cash ?? null, capacity_impact: 0, inventory_impact: null },
      estimated_cost: { amount: A.window_refresh.budget ?? null, currency: subject.currency },
      reversibility: REVERSIBILITY.REVERSIBLE, risk: RISK.LOW, confidence: CONFIDENCE.LOW,
    }));
  }
  return out;
}
