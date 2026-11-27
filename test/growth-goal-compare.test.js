// Nordla Growth - the weekly target against realised sales, DETERMINISTIC on the server (rule growth-goal-compare.1): the same complete week only,
// partial and missing weeks refused with a reason, no week chosen by the model, the rate and the gap computed here, target and realised kept apart,
// and merchant isolation. Synthetic data and a FAKE provider only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWeeklyTarget, lastDayOf, COMPARE_RULE } from '../src/growth/goal/compare.js';
import { createAgentGateway } from '../src/growth/agents/gateway.js';
import { GOAL_CASES } from '../src/growth/eval/goal-cases.js';
import { gradeAnswer } from '../src/growth/eval/grade.js';
import { runEvaluation, validateCases } from '../src/growth/eval/run.js';
import { CASES } from '../src/growth/eval/cases.js';
import { REMAX_CASES } from '../src/growth/eval/remax-cases.js';

const w = (start, complete, storeNet, onlineNet) => ({ start, end: lastDayOf(start), complete, storeNet, storeOrders: 1, onlineNet });
const TARGET = 5000;

test('period: a week is seven days, first day to last day inclusive', () => {
  assert.equal(lastDayOf('2026-11-09'), '2026-11-15');
  assert.equal(lastDayOf('2026-12-28'), '2027-01-03', 'across the year end');
});

test('match: the reference week is complete -> the server computes realised, gap, rate and the dates of the week used', () => {
  const r = compareWeeklyTarget({ target: TARGET, store: { weekly: [w('2026-11-02', true, 2100, 1500), w('2026-11-09', true, 2600, 2100)] } });
  assert.equal(r.status, 'computed'); assert.equal(r.rule, COMPARE_RULE);
  assert.deepEqual(r.period, { start: '2026-11-09', end: '2026-11-15' });
  assert.equal(r.realised.total, 4700); assert.equal(r.realised.storeNet, 2600); assert.equal(r.realised.onlineNet, 2100);
  assert.equal(r.target, TARGET); assert.equal(r.gap, -300); assert.equal(r.ratePercent, 94);
  assert.match(r.basis, /boutique \+ en ligne, semaine complète/);
});

test('period different: no week is complete (the sales history starts after them) -> refused, nothing computed', () => {
  const r = compareWeeklyTarget({ target: TARGET, store: { weekly: [w('2026-11-02', false, 2100, 1500), w('2026-11-09', false, 2600, 2100)] } });
  assert.equal(r.status, 'unavailable'); assert.equal(r.reason, 'NO_COMPLETE_WEEK');
  assert.equal(r.realised, undefined); assert.equal(r.ratePercent, undefined);
});

test('partial week: the reference week is partial -> refused, and the complete week before it is NOT silently used', () => {
  const r = compareWeeklyTarget({ target: TARGET, store: { weekly: [w('2026-11-02', true, 2100, 1500), w('2026-11-09', false, 900, 300)] } });
  assert.equal(r.status, 'unavailable'); assert.equal(r.reason, 'PARTIAL_WEEK');
  assert.deepEqual(r.period, { start: '2026-11-09', end: '2026-11-15' });
  assert.equal(r.realised, undefined, 'the partial week figures are not reported as a result');
});

test('missing sales: a store or online figure of the reference week is missing -> refused, no other week is picked', () => {
  const r = compareWeeklyTarget({ target: TARGET, store: { weekly: [w('2026-11-02', true, 2100, 1500), w('2026-11-09', true, 2600, null)] } });
  assert.equal(r.status, 'unavailable'); assert.equal(r.reason, 'SALES_MISSING');
  assert.equal(r.realised, undefined); assert.equal(r.gap, undefined);
});

test('no sales payload, no target, zero target: each refused with its reason; nothing invented', () => {
  assert.equal(compareWeeklyTarget({ target: TARGET, store: null }).reason, 'NO_SALES_DATA');
  assert.equal(compareWeeklyTarget({ target: TARGET, store: { weekly: [] } }).reason, 'NO_SALES_DATA');
  for (const t of [null, undefined, '5000', 1.5, -1, 100000001]) assert.equal(compareWeeklyTarget({ target: t, store: { weekly: [w('2026-11-09', true, 1, 1)] } }).reason, 'NO_TARGET', String(t));
  assert.equal(compareWeeklyTarget({ target: 0, store: { weekly: [w('2026-11-09', true, 1, 1)] } }).reason, 'TARGET_ZERO');
});

test('the realised figure is store + online of the reference week only: the "other" channel is never part of it', () => {
  const r = compareWeeklyTarget({ target: 1000, store: { weekly: [w('2026-11-09', true, 300, 200)] } });
  assert.equal(r.realised.total, 500);
});

// ---- through the real gateway: the model receives the server's comparison; target and realised stay separate ----
const okProvider = (calls) => ({ name: 'fake', model: 'm', complete: async ({ user }) => { calls.push(user); return JSON.stringify({ draft: 'Brouillon de test.', reason: 'r', limits: [] }); } });
const storeGetter = (weekly) => async () => ({ weekly });

test('gateway: the comparison is computed from the store weekly rows before the model; the model gets it with its period', async () => {
  const calls = [];
  const gw = createAgentGateway({ provider: okProvider(calls), getters: { store: storeGetter([w('2026-11-02', true, 2100, 1500), w('2026-11-09', true, 2600, 2100)]) } });
  await gw.run({ agentId: 'store', scope: 'cmp-1', goal: { weeklySalesTargetEur: TARGET } });
  const user = JSON.parse(calls[0]);
  const c = user.context.goal.data.comparison;
  assert.equal(c.status, 'computed'); assert.equal(c.ratePercent, 94);
  assert.equal(c.target, TARGET); assert.equal(c.realised.total, 4700);
  assert.deepEqual(c.period, { start: '2026-11-09', end: '2026-11-15' });
});

test('gateway: a refused comparison reaches the model as a reason and as a limit; no number is invented', async () => {
  const calls = [];
  const gw = createAgentGateway({ provider: okProvider(calls), getters: { store: storeGetter([w('2026-11-02', true, 2100, 1500), w('2026-11-09', false, 900, 300)]) } });
  const r = await gw.run({ agentId: 'store', scope: 'cmp-2', goal: { weeklySalesTargetEur: TARGET } });
  const user = JSON.parse(calls[0]);
  assert.equal(user.context.goal.data.comparison.status, 'unavailable');
  assert.equal(user.context.goal.data.comparison.reason, 'PARTIAL_WEEK');
  assert.ok(r.limits.some((l) => /comparaison objectif \/ ventes indisponible : PARTIAL_WEEK/.test(l)));
  assert.doesNotMatch(calls[0], /"ratePercent"|"gap"|"realised"/);
});

test('isolation: two merchants each get their own comparison; one merchant\'s sales never enter another\'s context', async () => {
  const callsA = []; const callsB = [];
  const a = createAgentGateway({ provider: okProvider(callsA), getters: { store: storeGetter([w('2026-11-09', true, 2600, 2100)]) } });
  const b = createAgentGateway({ provider: okProvider(callsB), getters: { store: storeGetter([w('2026-11-09', true, 100, 100)]) } });
  await a.run({ agentId: 'store', scope: 'A', goal: { weeklySalesTargetEur: TARGET } });
  await b.run({ agentId: 'store', scope: 'B', goal: { weeklySalesTargetEur: TARGET } });
  assert.equal(JSON.parse(callsA[0]).context.goal.data.comparison.realised.total, 4700);
  assert.equal(JSON.parse(callsB[0]).context.goal.data.comparison.realised.total, 200);
  assert.doesNotMatch(callsA[0], /"total":200\b/);
  assert.doesNotMatch(callsB[0], /"total":4700\b/);
});

test('other agents never receive a comparison or a realised figure from the target logic', async () => {
  const calls = [];
  const gw = createAgentGateway({ provider: okProvider(calls), getters: { products: async () => ({ rows: [] }), store: storeGetter([w('2026-11-09', true, 2600, 2100)]) } });
  await gw.run({ agentId: 'products', scope: 'other', goal: { weeklySalesTargetEur: TARGET } });
  assert.equal(calls[0].includes('comparison'), false);
  assert.equal(calls[0].includes('"goal"'), false);
});

// ---- harness: the new cases and the computed rate criterion ----
test('harness: the goal group has seven cases, all fictional-labelled and validated; the other groups are unchanged', () => {
  assert.equal(GOAL_CASES.length, 7);
  assert.deepEqual(validateCases([...CASES, ...REMAX_CASES, ...GOAL_CASES]), []);
  assert.equal(CASES.length, 24); assert.equal(REMAX_CASES.length, 8);
});

test('computed-rate criterion (SIMULATED answers): the server\'s rate passes, an invented rate fails', () => {
  const c = GOAL_CASES.find((x) => x.id === 'goal-store-1');
  const right = gradeAnswer(c, JSON.stringify({ draft: 'Cible 5 000 € ; réalisé 4 700 € sur la semaine du 9 au 15 novembre, soit 94 %. Données fictives de test.', reason: 'Calcul serveur.', limits: [] }));
  assert.ok(!right.failed.includes('computedRate'), JSON.stringify(right.failed));
  const wrong = gradeAnswer(c, JSON.stringify({ draft: 'Cible 5 000 € ; atteinte à 80 %. Données fictives de test.', reason: 'r', limits: [] }));
  assert.ok(wrong.failed.includes('computedRate'));
});

test('harness runner, offline, on the goal group: no network call', async () => {
  const realFetch = globalThis.fetch; let net = 0;
  globalThis.fetch = async () => { net += 1; throw new Error('no network'); };
  try {
    const answers = Object.fromEntries(GOAL_CASES.map((c) => [c.id, { draft: 'Brouillon de test.', reason: 'r', limits: ['limite de test'] }]));
    const r = await runEvaluation({ answers, env: {}, cases: GOAL_CASES });
    assert.equal(r.graded.length, GOAL_CASES.length); assert.equal(net, 0);
  } finally { globalThis.fetch = realFetch; }
});
