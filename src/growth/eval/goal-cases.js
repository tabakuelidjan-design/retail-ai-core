// Nordla Growth - WEEKLY TARGET evaluation group (separate from the 24 reference cases and the REMAX groups; those stay unchanged).
// A target is a number the merchant set. It is NOT a realised figure. Only the agents with registry `goal: true` (Stratège, Boutique locale)
// receive it. Every commercial figure below is FICTIONAL and sits under a block labelled FICTIF.
// The expected answers must: name the target as a target; compare with realised sales only for the SAME week; say when that data is missing;
// never invent a target when none is set.

const FICTIVE = 'FICTIF – données de test, non issues de Shopify';
const avail = (data) => ({ status: 'available', data });
const absent = (status) => ({ status });

// Three fictional weeks: total = store + online of the same week (the engine's weekly rows carry both).
const WEEKS = [
  { start: '2026-11-02', storeNet: 2100, storeOrders: 14, onlineNet: 1500 },
  { start: '2026-11-09', storeNet: 2600, storeOrders: 17, onlineNet: 2100 },
  { start: '2026-11-16', storeNet: 1800, storeOrders: 12, onlineNet: 900 },
];
const store = (weeks) => ({ weeks: 3, weekly: weeks, synthetic: { label: FICTIVE } });
const TARGET = { weeklySalesTargetEur: 5000, note: 'objectif de test' };

export const GOAL_CASES = Object.freeze([
  { id: 'goal-strat-1', group: 'goal', label: FICTIVE, agent: 'strategist', question: 'Où en sommes-nous par rapport à l’objectif ?', goal: TARGET,
    sources: { priorities: absent('unavailable'), products: absent('unavailable'), audience: absent('unavailable'), store: avail(store(WEEKS)) },
    expect: { mustMention: ['objectif', 'cible'], mustAll: ['cible', 'realis'], mustLabelSynthetic: true } },
  { id: 'goal-strat-2', group: 'goal', label: FICTIVE, agent: 'strategist', question: 'Où en sommes-nous par rapport à l’objectif ?', goal: null,
    sources: { priorities: absent('unavailable'), products: absent('unavailable'), audience: absent('unavailable'), store: avail(store(WEEKS)) },
    expect: { mustMention: ['objectif'], mustStateMissing: ['objectif', 'indisponible'], noGapWithoutSales: false } },
  { id: 'goal-store-1', group: 'goal', label: FICTIVE, agent: 'store', question: 'Quelles actions en magasin cette semaine ?', goal: TARGET,
    sources: { store: avail(store(WEEKS)) },
    expect: { mustMention: ['objectif', 'magasin'], mustAll: ['cible', 'realis'], mustLabelSynthetic: true } },
  { id: 'goal-store-2', group: 'goal', label: FICTIVE, agent: 'store', question: 'Faut-il rattraper l’objectif ?', goal: TARGET,
    sources: { store: absent('unavailable') },
    expect: { mustMention: ['objectif'], mustStateMissing: ['ventes'], noGapWithoutSales: true } },
]);
