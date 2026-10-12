import { createCampaignBudget, CampaignBudgetError } from '../creative-campaign/budget.js';
import { PRODUCTION_POLICY, PRODUCTION_UNIT_COSTS } from './constants.js';

// THE COST OF PRODUCING A LAYERED CAMPAIGN. Deterministic and auditable: every line has a label, a count and a unit cost, and every line is reserved BEFORE it is incurred against a hard ceiling. The cost of a
// generated layer is paid once however many assets reuse it, a deterministic layer costs nothing, and a quality parameter is never lowered to fit: the only lever is reuse (fewer distinct plates), and when
// even the most reuse does not fit, the production is BLOCKED BY BUDGET.

const round = (x) => Math.round(x * 1e9) / 1e9;

/**
 * @param {object} input { sharedStagesEur (the shared planning stages), assets: number, layers: [{ request_key, size_class, candidates }], unitCosts?, policy? }
 * @returns {{ lines: [{ label, count, unit_eur, eur }], total_eur }}
 */
export function estimateProduction({
  sharedStagesEur, assets, layers, unitCosts = PRODUCTION_UNIT_COSTS, policy = PRODUCTION_POLICY,
}) {
  const text = unitCosts.text_stage_eur;
  const lines = [{
    label: 'SHARED_PLANNING_STAGES', count: 1, unit_eur: sharedStagesEur, eur: round(sharedStagesEur),
  }];
  lines.push({
    label: 'ASSET_PLANNING_STAGES', count: assets * (policy.text_stages_per_asset + policy.protocol_repairs_per_asset), unit_eur: text, eur: round(assets * (policy.text_stages_per_asset + policy.protocol_repairs_per_asset) * text),
  });
  for (const layer of layers) {
    const unit = unitCosts.image_eur_by_size_class[layer.size_class];
    lines.push({
      label: `GENERATED_LAYER:${layer.request_key}`, count: layer.candidates, unit_eur: unit, eur: round(layer.candidates * unit),
    });
  }
  lines.push({
    label: 'CRITIC_CALLS', count: assets * policy.vision_calls_per_asset, unit_eur: unitCosts.vision_critic_eur, eur: round(assets * policy.vision_calls_per_asset * unitCosts.vision_critic_eur),
  });
  return { lines, total_eur: round(lines.reduce((n, l) => n + l.eur, 0)) };
}

/** Reserves every line against a fresh budget. Returns { ok, rows, reserved_eur, error }; a line that would pass the ceiling refuses the whole reservation. */
export function reserveProduction({ estimate, ceilingEur }) {
  const budget = createCampaignBudget({ ceilingEur });
  try {
    for (const line of estimate.lines) budget.reserve(line.label, line.eur);
    return { ok: true, rows: budget.rows(), reserved_eur: budget.reserved_eur(), error: null };
  } catch (error) {
    if (error instanceof CampaignBudgetError) return { ok: false, rows: budget.rows(), reserved_eur: budget.reserved_eur(), error: { code: error.code, ...error.detail } };
    throw error;
  }
}
