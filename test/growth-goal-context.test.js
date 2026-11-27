// Nordla Growth - the weekly target in the agents' context: only the two agents whose mission uses it (Stratège, Boutique locale); a target is
// a target, never a realised figure; absent or invalid -> "unavailable", never invented; the merchant's scope only; personal text masked.
// Synthetic data and a FAKE provider only. No network, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AGENTS, GOAL_AGENT_IDS } from '../src/growth/agents/registry.js';
import { createAgentGateway } from '../src/growth/agents/gateway.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { goalFromRows, goalKey, createMemoryFollowUpStore, agentDraftKey } from '../src/growth/server/follow-up-store.js';
import { GOAL_CASES } from '../src/growth/eval/goal-cases.js';
import { gradeAnswer } from '../src/growth/eval/grade.js';
import { runEvaluation, validateCases } from '../src/growth/eval/run.js';
import { CASES } from '../src/growth/eval/cases.js';
import { REMAX_CASES } from '../src/growth/eval/remax-cases.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const OTHER = '11111111-1111-4111-8111-111111111111';
const scopeOf = (id) => createHash('sha256').update(id).digest('hex');
const S = scopeOf(M); const SO = scopeOf(OTHER);
const okProvider = (calls) => ({ name: 'fake', model: 'm', complete: async ({ user }) => { calls.push(user); return JSON.stringify({ draft: 'Brouillon de test.', reason: 'r', limits: [] }); } });
const getters = (over = {}) => ({ priorities: async () => ({ items: [] }), products: async () => ({ rows: [] }), audience: async () => ({ segments: [] }), store: async () => ({ weekly: [] }), content: async () => ({ checks: [] }), social: async () => ({ posts: [] }), dropoff: async () => ({ steps: [] }), ads: async () => ({ status: 'NOT_CONNECTED' }), ...over });
const runWith = async (agentId, goal) => { const calls = []; const gw = createAgentGateway({ provider: okProvider(calls), getters: getters() }); const r = await gw.run({ agentId, scope: `g-${agentId}`, goal }); return { r, user: JSON.parse(calls[0]) }; };

test('registry: only the Stratège and the store agent are given the target; their rule says a target is not a result', () => {
  assert.deepEqual([...GOAL_AGENT_IDS].sort(), ['store', 'strategist']);
  assert.deepEqual(AGENTS.filter((a) => a.goal).map((a) => a.id).sort(), ['store', 'strategist']);
  for (const id of ['strategist', 'store']) assert.match(AGENTS.find((a) => a.id === id).system, /CIBLE/, id);
  for (const a of AGENTS.filter((x) => !x.goal)) assert.doesNotMatch(a.system, /CIBLE définie/, `${a.id} has no target rule`);
});

test('gateway: a goal agent receives the target as a target, with its basis; the other agents never receive it', async () => {
  const { user } = await runWith('strategist', { weeklySalesTargetEur: 5000 });
  assert.equal(user.context.goal.status, 'available');
  assert.equal(user.context.goal.data.kind, 'target');
  assert.equal(user.context.goal.data.weeklySalesTargetEur, 5000);
  assert.match(user.context.goal.data.basis, /pas un résultat/);
  for (const id of ['products', 'audience', 'content', 'conversion', 'ads', 'experiments']) {
    const { user: u } = await runWith(id, { weeklySalesTargetEur: 5000 });
    assert.equal(Object.hasOwn(u.context, 'goal'), false, `${id} must not receive the target`);
  }
});

test('gateway: no target -> "unavailable" and a limit that says so; an invalid target is treated as absent, never invented', async () => {
  for (const goal of [null, { weeklySalesTargetEur: '5000' }, { weeklySalesTargetEur: 1.5 }, { weeklySalesTargetEur: -10 }, {}]) {
    const { r, user } = await runWith('store', goal);
    assert.deepEqual(user.context.goal, { status: 'unavailable' });
    assert.ok(r.limits.some((l) => /objectif hebdomadaire indisponible/.test(l)), 'said as a limit');
    assert.doesNotMatch(JSON.stringify(user), /"weeklySalesTargetEur"/, 'no number is invented');
  }
});

test('gateway: a note holding personal formats is masked before it reaches the provider', async () => {
  const { user } = await runWith('strategist', { weeklySalesTargetEur: 5000, note: 'contact marque.test@example.test, BE68 5390 0754 7034' });
  assert.doesNotMatch(JSON.stringify(user), /marque\.test|BE68/);
  assert.match(user.context.goal.data.note, /\[courriel\]/);
});

test('store: a target is read from THIS merchant\'s key only; another scope, or a broken value, gives no target', () => {
  const ok = { key: goalKey(S), value: { v: 1, goals: { weeklySalesTargetEur: 5000, updatedAt: '2026-11-27T10:00:00.000Z' } }, version: 1 };
  assert.deepEqual(goalFromRows([ok], S), { weeklySalesTargetEur: 5000, updatedAt: '2026-11-27T10:00:00.000Z' });
  assert.equal(goalFromRows([{ ...ok, key: goalKey(SO) }], S), null, 'another merchant\'s target is never read');
  assert.equal(goalFromRows([{ key: goalKey(S), value: { v: 1, goals: { weeklySalesTargetEur: 1.5 } } }], S), null, 'a broken value is ignored');
  assert.equal(goalFromRows([{ key: agentDraftKey(S), value: { v: 1, drafts: [] } }], S), null);
  assert.equal(goalFromRows(undefined, S), null);
});

test('app: a hosted target is read at each run and reaches a goal agent; a failing read is "unavailable" and the draft still runs', async () => {
  const calls = [];
  const app = createGrowthApp({ merchantId: M, agentProvider: okProvider(calls), goalSource: async () => ({ weeklySalesTargetEur: 5000 }), ...{ priorities: undefined } });
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/growth/agents/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'store' }) });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(calls[0]).context.goal.data.weeklySalesTargetEur, 5000);
  } finally { s.close(); }
  const calls2 = [];
  const failing = createGrowthApp({ merchantId: M, agentProvider: okProvider(calls2), goalSource: async () => { throw new Error('db down SECRET-X'); } });
  const s2 = http.createServer(failing); await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/growth/agents/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'store' }) });
    assert.equal(r.status, 200, 'the draft still runs');
    assert.equal(JSON.parse(calls2[0]).context.goal.status, 'unavailable');
    assert.doesNotMatch(calls2[0], /SECRET-X/);
  } finally { s2.close(); }
});

test('local preview: no target is sent (the browser copy is not visible to the server), and the agents say it is unavailable', async () => {
  const calls = [];
  const s = http.createServer(createGrowthApp({ agentProvider: okProvider(calls) }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/growth/agents/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'strategist' }) });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(calls[0]).context.goal.status, 'unavailable');
  } finally { s.close(); }
});

test('the target is not a realised figure: the store payload keeps its own weekly sales and the target stays a separate block', async () => {
  const { user } = await runWith('store', { weeklySalesTargetEur: 5000 });
  assert.ok(Object.hasOwn(user.context.goal.data, 'weeklySalesTargetEur'));
  assert.ok(!Object.hasOwn(user.context.goal.data, 'realised'), 'no realised field is invented for the target');
});

test('goal cases: the group is validated, every figure is labelled FICTIF, the other groups are unchanged', () => {
  assert.deepEqual(validateCases([...CASES, ...REMAX_CASES, ...GOAL_CASES]), []);
  assert.equal(GOAL_CASES.length, 4);
  assert.equal(CASES.length, 24);
  assert.equal(REMAX_CASES.length, 8);
  for (const c of GOAL_CASES) assert.ok(['strategist', 'store'].includes(c.agent), c.id);
});

test('goal grader contract (SIMULATED answers, not a quality measure): a target stated as a target passes; an invented gap or achievement fails', () => {
  const honest = gradeAnswer(GOAL_CASES.find((c) => c.id === 'goal-store-1'), JSON.stringify({ draft: 'L’objectif hebdomadaire (cible) est de 5 000 €. Les ventes réalisées sur les semaines fournies sont distinctes de cette cible. Données fictives de test.', reason: 'Cible du marchand comparée aux ventes réalisées.', limits: [] }));
  assert.ok(!honest.failed.includes('mustAll'), JSON.stringify(honest.failed));
  const bogus = gradeAnswer(GOAL_CASES.find((c) => c.id === 'goal-store-2'), JSON.stringify({ draft: 'Vous avez atteint 94 % de l’objectif, avec un écart de 300 €.', reason: 'r', limits: [] }));
  assert.ok(bogus.failed.includes('noGapWithoutSales'), 'a gap stated without realised sales is refused');
  const unavail = gradeAnswer(GOAL_CASES.find((c) => c.id === 'goal-strat-2'), JSON.stringify({ draft: 'Objectif indisponible : aucune cible n’est enregistrée, donc aucun écart n’est calculé.', reason: 'r', limits: ['objectif hebdomadaire indisponible'] }));
  assert.ok(!unavail.failed.includes('statesMissing'), JSON.stringify(unavail.failed));
});

test('goal runner, offline: graded through the real gateway, the target passed in the prompt, no network call', async () => {
  const realFetch = globalThis.fetch; let net = 0;
  globalThis.fetch = async () => { net += 1; throw new Error('no network'); };
  try {
    const answers = Object.fromEntries(GOAL_CASES.map((c) => [c.id, { draft: 'Brouillon de test.', reason: 'r', limits: ['limite de test'] }]));
    const r = await runEvaluation({ answers, env: {}, cases: GOAL_CASES });
    assert.equal(r.graded.length, GOAL_CASES.length); assert.equal(net, 0);
  } finally { globalThis.fetch = realFetch; }
});
