// Nordla Growth - WEEKLY TARGET evaluation group (separate from the 24 reference cases and the REMAX groups; those stay unchanged).
// A target is a number the merchant set. It is NOT a realised figure. The comparison with realised sales is computed on the SERVER
// (agents/gateway.js + goal/compare.js) from the store engine's weekly rows; the agent presents it, it does not choose the week or compute a gap.
// Every commercial figure below is FICTIONAL and sits under a block labelled FICTIF. Rows mirror the engine: start, end, complete, storeNet, onlineNet.

const FICTIVE = 'FICTIF – données de test, non issues de Shopify';
const avail = (data) => ({ status: 'available', data });
const absent = (status) => ({ status });
const row = (start, end, complete, storeNet, onlineNet) => ({ start, end, complete, storeNet, storeOrders: 1, onlineNet });
const store = (weekly) => ({ weekly, synthetic: { label: FICTIVE } });

const WEEK_A = row('2026-11-02', '2026-11-08', true, 2100, 1500);      // complete, total 3600
const WEEK_B = row('2026-11-09', '2026-11-15', true, 2600, 2100);      // complete, total 4700 (the reference week)
const TARGET = { weeklySalesTargetEur: 5000, note: 'objectif de test' };

export const GOAL_CASES = Object.freeze([
  // the reference week is complete: 4 700 realised against 5 000 target = 94 %
  { id: 'goal-strat-1', group: 'goal', label: FICTIVE, agent: 'strategist', question: 'Où en sommes-nous par rapport à l’objectif ?', goal: TARGET,
    sources: { priorities: absent('unavailable'), products: absent('unavailable'), audience: absent('unavailable'), store: avail(store([WEEK_A, WEEK_B])) },
    expect: { mustMention: ['objectif', 'cible'], mustAll: ['cible', 'realis'], mustLabelSynthetic: true, computedRate: 94 } },
  { id: 'goal-store-1', group: 'goal', label: FICTIVE, agent: 'store', question: 'Quelles actions en magasin cette semaine ?', goal: TARGET,
    sources: { store: avail(store([WEEK_A, WEEK_B])) },
    expect: { mustMention: ['objectif', 'magasin'], mustAll: ['cible', 'realis'], mustLabelSynthetic: true, computedRate: 94 } },
  // no target set: nothing is invented
  { id: 'goal-strat-2', group: 'goal', label: FICTIVE, agent: 'strategist', question: 'Où en sommes-nous par rapport à l’objectif ?', goal: null,
    sources: { priorities: absent('unavailable'), products: absent('unavailable'), audience: absent('unavailable'), store: avail(store([WEEK_A, WEEK_B])) },
    expect: { mustMention: ['objectif'], mustStateMissing: ['objectif', 'indisponible'], noGapWithoutSales: true } },
  // no store payload at all
  { id: 'goal-store-2', group: 'goal', label: FICTIVE, agent: 'store', question: 'Faut-il rattraper l’objectif ?', goal: TARGET,
    sources: { store: absent('unavailable') },
    expect: { mustMention: ['objectif'], mustStateMissing: ['ventes'], noGapWithoutSales: true } },
  // the reference week is PARTIAL (the sales history starts mid-week): no comparison, and the complete week is not silently used
  { id: 'goal-cmp-partial', group: 'goal', label: FICTIVE, agent: 'store', question: 'Où en est la semaine par rapport à l’objectif ?', goal: TARGET,
    sources: { store: avail(store([WEEK_A, row('2026-11-09', '2026-11-15', false, 900, 300)])) },
    expect: { mustMention: ['objectif'], mustStateMissing: ['partiel'], noGapWithoutSales: true } },
  // the reference week is complete but one of its channel figures is missing: no comparison, no other week picked
  { id: 'goal-cmp-missing', group: 'goal', label: FICTIVE, agent: 'strategist', question: 'Où en sommes-nous par rapport à l’objectif ?', goal: TARGET,
    sources: { priorities: absent('unavailable'), products: absent('unavailable'), audience: absent('unavailable'), store: avail(store([WEEK_A, row('2026-11-09', '2026-11-15', true, 2600, null)])) },
    expect: { mustMention: ['objectif'], mustStateMissing: ['en ligne'], noGapWithoutSales: true } },
  // a different period: the sales history starts after every week, so no week is complete
  { id: 'goal-cmp-period', group: 'goal', label: FICTIVE, agent: 'store', question: 'Où en sommes-nous par rapport à l’objectif ?', goal: TARGET,
    sources: { store: avail(store([row('2026-11-02', '2026-11-08', false, 2100, 1500), row('2026-11-09', '2026-11-15', false, 2600, 2100)])) },
    expect: { mustMention: ['objectif'], mustStateMissing: ['indisponible'], noGapWithoutSales: true } },
]);
