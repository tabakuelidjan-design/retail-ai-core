// Nordla Growth - the evaluation groups the offline CLI can run. The groups are kept apart: the reference cases are NOT mixed with the
// REMAX or the weekly-target cases. `all` is the union of the four, each case keeping its own group.

import { CASES } from './cases.js';
import { REMAX_CASES } from './remax-cases.js';
import { GOAL_CASES } from './goal-cases.js';

export const DEFAULT_GROUP = 'reference';

export const GROUPS = Object.freeze({
  reference: { description: '24 synthetic reference cases (the original harness)', cases: CASES },
  remax: { description: 'REAL HABB REMAX catalogue facts (public fields only)', cases: REMAX_CASES.filter((c) => c.group === 'remax') },
  'remax-synthetic': { description: 'REMAX with FICTIONAL commercial figures, labelled FICTIF', cases: REMAX_CASES.filter((c) => c.group === 'remax-synthetic') },
  goal: { description: 'weekly target against realised sales (synthetic, labelled FICTIF)', cases: GOAL_CASES },
});

export const GROUP_NAMES = Object.freeze([...Object.keys(GROUPS), 'all']);

/** The cases of a group name, or of every group for 'all'. null for an unknown name. */
export function casesOfGroup(name) {
  if (name === 'all') return Object.entries(GROUPS).flatMap(([, g]) => g.cases);
  return GROUPS[name] ? GROUPS[name].cases : null;
}

/** The group name of each case id (ids are unique across the groups). */
export function groupOfCase(id) {
  for (const [name, g] of Object.entries(GROUPS)) if (g.cases.some((c) => c.id === id)) return name;
  return null;
}
