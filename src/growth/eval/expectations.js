// Nordla Growth - the EXPECTED coverage of each evaluation group, declared explicitly (no common threshold is deduced from the other groups).
// Each entry is one case: its id and the agent it must test. A group is valid only when its cases are exactly these: none lost, none duplicated,
// none in another group, none for an unexpected agent. Small groups are valid when their size is intentional.
// The counts below were read from the cases on 2026-11-27. Changing a case means changing this file on purpose.

const pairs = (agent, ids) => ids.map((id) => ({ id, agent }));

export const EXPECTED = Object.freeze({
  reference: Object.freeze({ group: 'reference', total: 24, perAgent: Object.freeze({ strategist: 3, products: 3, audience: 3, content: 3, store: 3, conversion: 3, ads: 3, experiments: 3 }),
    cases: Object.freeze([
      ...pairs('strategist', ['strat-1', 'strat-2', 'strat-3']), ...pairs('products', ['prod-1', 'prod-2', 'prod-3']),
      ...pairs('audience', ['aud-1', 'aud-2', 'aud-3']), ...pairs('content', ['cont-1', 'cont-2', 'cont-3']),
      ...pairs('store', ['store-1', 'store-2', 'store-3']), ...pairs('conversion', ['conv-1', 'conv-2', 'conv-3']),
      ...pairs('ads', ['ads-1', 'ads-2', 'ads-3']), ...pairs('experiments', ['exp-1', 'exp-2', 'exp-3']),
    ]) }),
  remax: Object.freeze({ group: 'remax', total: 5, perAgent: Object.freeze({ products: 3, strategist: 2 }),
    cases: Object.freeze([...pairs('products', ['remax-prod-1', 'remax-prod-2', 'remax-prod-3']), ...pairs('strategist', ['remax-strat-1', 'remax-strat-2'])]) }),
  'remax-synthetic': Object.freeze({ group: 'remax-synthetic', total: 3, perAgent: Object.freeze({ products: 2, strategist: 1 }),
    cases: Object.freeze([...pairs('products', ['remax-syn-prod-1', 'remax-syn-prod-2']), ...pairs('strategist', ['remax-syn-strat-1'])]) }),
  goal: Object.freeze({ group: 'goal', total: 7, perAgent: Object.freeze({ strategist: 3, store: 4 }),
    // NOTE: the brief of 2026-11-27 said 4 Stratège and 3 Boutique; the cases as written are 3 and 4. The declared count is the real one.
    cases: Object.freeze([
      ...pairs('strategist', ['goal-strat-1', 'goal-strat-2', 'goal-cmp-missing']),
      ...pairs('store', ['goal-store-1', 'goal-store-2', 'goal-cmp-partial', 'goal-cmp-period']),
    ]) }),
});

/**
 * The problems of a set of cases against the expected coverage of `groupName`. An empty list means the group is exactly as declared.
 * `cases` are the cases the CLI selected for the group (or for `all`, the union of the groups).
 */
export function coverageProblems(groupName, cases) {
  const problems = [];
  if (groupName === 'all') {
    const expectedAll = Object.values(EXPECTED).flatMap((e) => e.cases);
    const seen = new Map();
    for (const c of cases) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1) problems.push(`${id}: duplicated in the total (${n} times)`);
    const expectedIds = new Set(expectedAll.map((e) => e.id));
    for (const id of expectedIds) if (!seen.has(id)) problems.push(`${id}: missing from the total`);
    for (const id of seen.keys()) if (!expectedIds.has(id)) problems.push(`${id}: unexpected in the total`);
    if (cases.length !== expectedAll.length) problems.push(`total is ${cases.length} cases, expected ${expectedAll.length}`);
    return problems;
  }
  const exp = EXPECTED[groupName];
  if (!exp) return [`no declared coverage for group ${groupName}`];
  const expectedIds = new Map(exp.cases.map((e) => [e.id, e.agent]));
  const counts = {};
  const seen = new Map();
  for (const c of cases) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) problems.push(`${id}: duplicated (${n} times)`);
  for (const c of cases) {
    const g = c.group ?? 'reference';
    if (g !== exp.group) problems.push(`${c.id}: belongs to group ${g}, not ${exp.group}`);
    if (!expectedIds.has(c.id)) { problems.push(`${c.id}: unexpected case for group ${exp.group}`); continue; }
    if (expectedIds.get(c.id) !== c.agent) problems.push(`${c.id}: tests ${c.agent}, expected ${expectedIds.get(c.id)}`);
    counts[c.agent] = (counts[c.agent] ?? 0) + 1;
  }
  for (const [id, agent] of expectedIds) if (!seen.has(id)) problems.push(`${id}: lost (expected for ${agent})`);
  if (cases.length !== exp.total) problems.push(`group ${exp.group} has ${cases.length} cases, expected ${exp.total}`);
  for (const [agent, n] of Object.entries(exp.perAgent)) if ((counts[agent] ?? 0) !== n) problems.push(`${agent}: ${counts[agent] ?? 0} case(s), expected ${n}`);
  for (const agent of Object.keys(counts)) if (!(agent in exp.perAgent)) problems.push(`${agent}: unexpected agent in group ${exp.group}`);
  // the declaration itself must agree with its own list
  const declared = {};
  for (const e of exp.cases) declared[e.agent] = (declared[e.agent] ?? 0) + 1;
  for (const [agent, n] of Object.entries(exp.perAgent)) if ((declared[agent] ?? 0) !== n) problems.push(`declaration error: ${agent} listed ${declared[agent] ?? 0}, declared ${n}`);
  return problems;
}
