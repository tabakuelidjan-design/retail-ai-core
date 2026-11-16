import { DEFAULT_UNIT_COSTS, DEV_CAMPAIGN_CEILING_EUR, PRODUCTION_BOUNDS } from './constants.js';

// THE CAMPAIGN BUDGET. A campaign is not a single asset: it has its own ceiling, configurable, that the plan can never exceed unnoticed. Two parts:
//   estimateCampaignCost   the worst-case cost of PRODUCING a planned campaign under a stated, bounded production shape (how many environment images each asset may use)
//   createCampaignBudget   a reservation ledger: every cost is reserved BEFORE it is incurred and a reservation that would pass the ceiling is refused (nothing is spent in this phase; the same guard
//                          is what a production run uses)
// The unit costs are by capability class, never by provider, and are to be recalibrated from measured production costs.

export class CampaignBudgetError extends Error {
  constructor(message, detail) { super(message); this.name = 'CampaignBudgetError'; this.code = 'CAMPAIGN_BUDGET_EXCEEDED'; this.detail = detail; }
}

const round = (x) => Math.round(x * 1e9) / 1e9;
export const imageSizeClass = (canvas) => (Math.max(canvas.width, canvas.height) > 1024 ? 'ABOVE_1024' : 'UP_TO_1024');

/**
 * @param {object} input { assets: [{ canvas }], environmentCandidates, unitCosts?, bounds? }
 * @returns {{ shared_eur, per_asset_eur: number[], total_eur, lines: [{ label, eur }], environment_candidates_per_asset }}
 */
export function estimateCampaignCost({ assets, environmentCandidates, unitCosts = DEFAULT_UNIT_COSTS, bounds = PRODUCTION_BOUNDS }) {
  const text = unitCosts.text_stage_eur;
  // FRAME; IDEATE + SELECT per round; ART DIRECT; and the protocol repairs the shared stages may use
  const sharedCalls = 1 + (2 * bounds.concept_rounds) + 1 + bounds.shared_protocol_repairs;
  const lines = [{ label: 'SHARED_STAGES', eur: round(sharedCalls * text) }];
  const perAsset = assets.map((asset, index) => {
    const image = unitCosts.image_eur_by_size_class[imageSizeClass(asset.canvas)];
    const eur = round((bounds.text_stages_per_asset + bounds.protocol_repairs_per_asset) * text + environmentCandidates * image + bounds.vision_calls_per_asset * unitCosts.vision_critic_eur);
    lines.push({ label: `ASSET_${index}`, eur });
    return eur;
  });
  const total = round(lines.reduce((n, l) => n + l.eur, 0));
  return { shared_eur: lines[0].eur, per_asset_eur: perAsset, total_eur: total, lines, environment_candidates_per_asset: environmentCandidates };
}

/** A reservation ledger with a hard ceiling. Reserving past the ceiling throws; nothing is ever silently clipped. */
export function createCampaignBudget({ ceilingEur = DEV_CAMPAIGN_CEILING_EUR } = {}) {
  if (!(Number.isFinite(ceilingEur) && ceilingEur > 0)) throw new RangeError('the campaign ceiling must be a positive amount');
  const rows = []; let reserved = 0;
  return Object.freeze({
    ceiling_eur: ceilingEur,
    reserve(label, eur) {
      if (!(Number.isFinite(eur) && eur >= 0)) throw new RangeError('a reservation must be a non-negative amount');
      if (round(reserved + eur) > ceilingEur + 1e-9) throw new CampaignBudgetError('the reservation would pass the campaign ceiling', { label, requested_eur: eur, reserved_eur: round(reserved), ceiling_eur: ceilingEur });
      reserved = round(reserved + eur); rows.push({ label, eur });
      return reserved;
    },
    reserved_eur: () => reserved,
    remaining_eur: () => round(ceilingEur - reserved),
    rows: () => rows.map((r) => ({ ...r })),
  });
}

/**
 * The richest bounded production shape whose worst case fits the ceiling: each asset may use up to 3, then 2, then 1 environment images. Returns { fits, environment_candidates_per_asset, estimate } where
 * `estimate` is the one chosen (or, if none fits, the cheapest).
 */
export function chooseProductionEnvelope({ assets, ceilingEur = DEV_CAMPAIGN_CEILING_EUR, unitCosts = DEFAULT_UNIT_COSTS, bounds = PRODUCTION_BOUNDS }) {
  let cheapest = null;
  for (const candidates of bounds.environment_candidates_options) {
    const estimate = estimateCampaignCost({ assets, environmentCandidates: candidates, unitCosts, bounds });
    cheapest = estimate;
    if (estimate.total_eur <= ceilingEur + 1e-9) return { fits: true, environment_candidates_per_asset: candidates, estimate };
  }
  return { fits: false, environment_candidates_per_asset: cheapest.environment_candidates_per_asset, estimate: cheapest };
}

/** Reserves an estimate line by line against a budget; true if everything fit, else the error that refused it. */
export function reserveEstimate(budget, estimate) {
  try { for (const line of estimate.lines) budget.reserve(line.label, line.eur); return { ok: true, error: null }; } catch (error) {
    if (error instanceof CampaignBudgetError) return { ok: false, error };
    throw error;
  }
}
