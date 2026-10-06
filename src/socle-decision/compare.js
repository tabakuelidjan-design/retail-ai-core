import { AXES, CONFIDENCE, REVERSIBILITY, RISK } from './constants.js';

// Explainable comparison. Units are never merged into one number:
//   1. Pareto dominance (an option that is no better on any axis is dominated)
//   2. lexicographic choice along a declared axis priority, with per-axis tolerance
// No "impact * confidence / risk" style formula exists anywhere.

const RISK_SCORE = { [RISK.LOW]: 3, [RISK.MEDIUM]: 2, [RISK.HIGH]: 1 };
const REV_SCORE = { [REVERSIBILITY.REVERSIBLE]: 3, [REVERSIBILITY.PARTIALLY_REVERSIBLE]: 2, [REVERSIBILITY.IRREVERSIBLE]: 1 };
const CONF_SCORE = { [CONFIDENCE.HIGH]: 3, [CONFIDENCE.MEDIUM]: 2, [CONFIDENCE.LOW]: 1 };

// Default priorities live in the common engine, never in a domain.
export const DEFAULT_PROFILE = Object.freeze({
  axis_priority: ['cash_impact', 'margin_impact', 'risk', 'reversibility', 'time_to_cash_days', 'confidence', 'capacity_impact', 'inventory_impact'],
  tolerances: {},
  inventory_direction: 'LOWER_BETTER',
});

export const DEFAULT_PROFILES = Object.freeze({
  DORMANT_INVENTORY: { ...DEFAULT_PROFILE },
  CASH_FLOOR_RISK: {
    ...DEFAULT_PROFILE,
    axis_priority: ['time_to_cash_days', 'cash_impact', 'risk', 'reversibility', 'margin_impact', 'confidence', 'capacity_impact', 'inventory_impact'],
  },
  FOOTFALL_DECLINE: {
    ...DEFAULT_PROFILE,
    axis_priority: ['risk', 'reversibility', 'cash_impact', 'margin_impact', 'confidence', 'time_to_cash_days', 'capacity_impact', 'inventory_impact'],
  },
});

export function resolveProfile(subjectType, config = {}) {
  const base = config.profiles?.[subjectType] ?? DEFAULT_PROFILES[subjectType] ?? DEFAULT_PROFILE;
  return { ...DEFAULT_PROFILE, ...base, tolerances: { ...(base.tolerances ?? {}) } };
}

// Higher utility = better, on that axis only. null = unknown (never guessed).
export function axisUtility(lever, axis, profile) {
  const e = lever.estimated_effects;
  switch (axis) {
    case 'cash_impact': return e.cash_impact;
    case 'margin_impact': return e.margin_impact;
    case 'time_to_cash_days': return e.time_to_cash_days === null ? null : -e.time_to_cash_days;
    case 'capacity_impact': return e.capacity_impact === null ? null : -e.capacity_impact;
    case 'inventory_impact':
      if (e.inventory_impact === null) return null;
      return profile.inventory_direction === 'HIGHER_BETTER' ? e.inventory_impact : -e.inventory_impact;
    case 'risk': return RISK_SCORE[lever.risk];
    case 'reversibility': return REV_SCORE[lever.reversibility];
    case 'confidence': return CONF_SCORE[lever.confidence];
    default: return null;
  }
}

export const axisRaw = (lever, axis) => (['risk', 'reversibility', 'confidence'].includes(axis) ? lever[axis] : lever.estimated_effects[axis]);
export const axisVector = (lever) => Object.fromEntries(AXES.map((a) => [a, axisRaw(lever, a)]));

// A dominates B: never worse on a shared known axis, strictly better on one,
// and not unknown where B is known.
export function dominates(a, b, profile) {
  let strict = false;
  for (const axis of AXES) {
    const ua = axisUtility(a, axis, profile);
    const ub = axisUtility(b, axis, profile);
    if (ua === null && ub !== null) return false;
    if (ua === null || ub === null) continue;
    if (ua < ub) return false;
    if (ua > ub) strict = true;
  }
  return strict;
}

export function rankLexicographic(candidates, profile) {
  let pool = [...candidates];
  const trace = [];
  for (const axis of profile.axis_priority) {
    if (pool.length <= 1) break;
    const utils = pool.map((l) => [l, axisUtility(l, axis, profile)]);
    const known = utils.filter(([, u]) => u !== null);
    if (known.length === 0) {
      trace.push({ axis, note: 'unknown for all remaining candidates - axis skipped' });
      continue;
    }
    const best = Math.max(...known.map(([, u]) => u));
    const tol = profile.tolerances[axis] ?? 0;
    const kept = known.filter(([, u]) => u >= best - tol).map(([l]) => l);
    trace.push({
      axis,
      best,
      tolerance: tol,
      kept: kept.map((l) => l.id),
      dropped_worse: known.filter(([, u]) => u < best - tol).map(([l]) => l.id),
      dropped_unknown: utils.filter(([, u]) => u === null).map(([l]) => l.id),
    });
    pool = kept;
  }
  const sorted = [...pool].sort((x, y) => (x.id < y.id ? -1 : 1));
  return { winner: sorted[0], tied_with: sorted.slice(1).map((l) => l.id), trace };
}

// Visible trade-offs of the winner against one alternative, axis by axis, raw units.
export function tradeoffsVs(winner, alt, profile) {
  const better = [];
  const worse = [];
  const unknown = [];
  for (const axis of AXES) {
    const uw = axisUtility(winner, axis, profile);
    const ua = axisUtility(alt, axis, profile);
    if (uw === null || ua === null) {
      if (uw !== ua) unknown.push(axis);
      continue;
    }
    const entry = { axis, winner: axisRaw(winner, axis), alternative: axisRaw(alt, axis) };
    if (ua > uw) better.push(entry);
    else if (ua < uw) worse.push(entry);
  }
  return { vs: alt.id, alternative_better_on: better, alternative_worse_on: worse, unknown_on: unknown };
}
