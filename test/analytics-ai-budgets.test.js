import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { createToolLayer } from '../src/analytics-premium/server/tools/index.js';
import { createOrchestrator } from '../src/analytics-premium/server/ai/orchestrator.js';
import { MAX_PREMISE_CALLS, MAX_TOOL_CALLS, PLAN_SCHEMA } from '../src/analytics-premium/server/ai/contract.js';
import { createPremiseBenchmark } from '../src/analytics-premium/server/ai/diagnostics.js';
import { validate } from '../src/analytics-premium/server/tools/contract.js';
import { NOW, writeDataset } from './fixtures/analytics-dataset.js';
import { createFakeProvider } from './fixtures/fake-ai-provider.js';

// Two separate tool budgets - PREMISE verification (2) and ANALYSIS (4) - with re-use of any identical call; a mandatory `premises` field; an internal benchmark of
// premise detection. FAKE provider, SYNTHETIC data (last 30 days vs previous: sales +1.72 %, average basket +1.71 %, refunds 10 -> 0).

const S_UP = { kind: 'trend', metric: 'sales', direction: 'increase' };      // supported
const AOV_UP = { kind: 'trend', metric: 'aov', direction: 'increase' };      // supported, same tool call as S_UP
const REF_DOWN = { kind: 'trend', metric: 'refunds', direction: 'decrease' }; // supported, needs get_sales_metrics + get_refunds
const RANK_WIDGET = { kind: 'ranking', scope: 'product', subject: 'fixture widget' }; // supported, needs get_top_products + find_product
const A = { top: { tool: 'get_top_products', args: { period: { period: 'last_30_days' }, limit: 3 } }, channels: { tool: 'get_channels', args: {} }, customers: { tool: 'get_customers', args: {} },
  compare: { tool: 'compare_sales', args: { periodA: { period: 'last_30_days' }, periodB: { period: 'previous_month' } } }, cats: { tool: 'get_categories', args: {} }, ship: { tool: 'get_shipping', args: {} }, vat: { tool: 'get_vat', args: {} } };

async function setup({ premises, toolCalls, ...opts }) {
  resetPeriodCache(); const dir = await writeDataset(); const executions = []; const diagnostics = [];
  const real = createToolLayer({ reportsDir: dir, now: () => NOW });
  const tools = { catalog: () => real.catalog(), has: (n) => real.has(n), call: async (name, args) => { executions.push(name); return real.call(name, args); } };   // counts what really runs
  const provider = createFakeProvider({ planner: () => ({ toolCalls, ...(premises ? { premises } : {}) }), ...opts });
  const ask = createOrchestrator({ provider, tools, timeoutMs: 400, onDiagnostic: (d) => diagnostics.push(d) });
  return { ask, provider, executions, diagnostics };
}

test('constants: 2 premise-verification calls, 4 analysis calls, theoretical maximum 6', () => { assert.equal(MAX_PREMISE_CALLS, 2); assert.equal(MAX_TOOL_CALLS, 4); });

test('TWO premises + FOUR analysis tools: both premises verified with ONE shared call, and all four analysis tools still run', async () => {
  const s = await setup({ premises: [S_UP, AOV_UP], toolCalls: [A.top, A.channels, A.customers, A.compare] });
  const r = await s.ask({ question: 'x' });
  assert.equal(r.status, 'OK');
  assert.deepEqual(s.executions, ['get_sales_metrics', 'get_top_products', 'get_channels', 'get_customers', 'compare_sales'], '1 verification call (shared by both premises) + 4 analysis calls');
  assert.equal(r.limits.truncated, false); assert.equal(r.limits.premiseBudgetExceeded, false); assert.deepEqual([r.limits.maxToolCalls, r.limits.maxPremiseCalls], [4, 2]);
});

test('the theoretical maximum: 2 premise calls + 4 analysis calls = 6 executions, nothing truncated', async () => {
  const s = await setup({ premises: [S_UP, REF_DOWN], toolCalls: [A.top, A.channels, A.customers, A.compare] });
  const r = await s.ask({ question: 'x' });
  assert.equal(r.status, 'OK'); assert.deepEqual(s.executions, ['get_sales_metrics', 'get_refunds', 'get_top_products', 'get_channels', 'get_customers', 'compare_sales']);
  assert.equal(r.limits.truncated, false); assert.equal(r.toolCalls.length, 6);
});

test('one result serves both: a premise-evidence call that the analysis also asks for is executed ONCE and does not use the analysis budget', async () => {
  const same = { tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } };   // = the evidence call (the default period is the last 30 days)
  const s = await setup({ premises: [REF_DOWN], toolCalls: [same, A.top, A.channels, A.customers, A.compare] });
  const r = await s.ask({ question: 'x' });
  assert.equal(s.executions.filter((n) => n === 'get_sales_metrics').length, 1, 'get_sales_metrics ran once');
  assert.equal(s.executions.length, 6, '2 for the premise (sales metrics, refunds) + 4 distinct analysis calls: the 5th planned call was the re-used one');
  assert.equal(r.status, 'OK'); assert.equal(r.limits.truncated, false, 'the re-used call did not consume the analysis budget');
  // and two premises that need the same call are verified with one execution (see the first test); re-running the same question re-uses nothing across questions
});

test('identical analysis calls are de-duplicated too, whatever the way the period is written', async () => {
  const s = await setup({ premises: [], toolCalls: [A.top, { tool: 'get_top_products', args: { limit: 3 } }, { tool: 'get_top_products', args: { period: { period: 'last_30_days' }, limit: 3 } }, A.channels] });
  const r = await s.ask({ question: 'x' });
  assert.deepEqual(s.executions, ['get_top_products', 'get_channels'], 'the same call three ways runs once'); assert.equal(r.status, 'OK');
});

test('PREMISE budget exceeded: a third dedicated call is refused, that premise becomes "cannot verify", and the analysis does not run', async () => {
  const s = await setup({ premises: [REF_DOWN, RANK_WIDGET], toolCalls: [A.top, A.channels] });
  const r = await s.ask({ question: 'x' });
  assert.equal(r.status, 'PREMISE_UNVERIFIABLE'); assert.equal(r.limits.premiseBudgetExceeded, true);
  assert.deepEqual(r.premise.checks.map((c) => [c.kind, c.verdict, c.reason ?? null]), [['trend', 'supported', null], ['ranking', 'unknown', 'CALL_BUDGET']]);
  assert.deepEqual(s.executions, ['get_sales_metrics', 'get_refunds'], 'exactly the 2 budgeted calls ran; nothing beyond them'); assert.equal(s.provider.seen.explain.length, 0);
});

test('ANALYSIS budget exceeded: 6 distinct analysis calls -> 4 run (premise calls are NOT taken from it), the rest is cut and reported', async () => {
  const s = await setup({ premises: [S_UP, REF_DOWN], toolCalls: [A.top, A.channels, A.customers, A.compare, A.cats, A.ship] });
  const r = await s.ask({ question: 'x' });
  assert.equal(r.status, 'OK'); assert.equal(r.limits.truncated, true);
  assert.deepEqual(s.executions, ['get_sales_metrics', 'get_refunds', 'get_top_products', 'get_channels', 'get_customers', 'compare_sales'], '2 premise + 4 analysis; categories and shipping were cut');
  const rejected = await setup({ premises: [S_UP], toolCalls: [{ tool: 'get_weather', args: {} }, { tool: 'get_top_products', args: { limit: 999 } }, A.top, A.channels, A.customers, A.compare] });
  const r2 = await rejected.ask({ question: 'x' }); assert.equal(r2.limits.truncated, true, 'unknown tools and invalid arguments count in the analysis budget');
  assert.deepEqual(rejected.executions, ['get_sales_metrics', 'get_top_products', 'get_top_products', 'get_channels'], 'the invalid call is validated (refused), then 2 of the 4 slots go to the rest; the unknown tool never runs');
});

test('`premises` is MANDATORY in every plan: a plan without it is invalid (and the omission is recorded); an explicit empty list is valid', async () => {
  assert.ok(PLAN_SCHEMA.required.includes('premises')); assert.match(validate(PLAN_SCHEMA, { toolCalls: [] }, 'plan'), /premises is required/); assert.equal(validate(PLAN_SCHEMA, { premises: [], done: true }, 'plan'), null);
  for (const plan of [{ toolCalls: [A.top] }, { clarification: { text: 'Quelle période ?' } }, { cannotAnswer: {} }, { done: true }]) {
    const s = await setup({ toolCalls: [], omitPremises: true, planner: undefined }); s.provider.plan = async () => plan;
    const r = await s.ask({ question: 'x' }); assert.deepEqual([r.status, r.code], ['PLAN_FAILED', 'PLAN_INVALID'], JSON.stringify(plan)); assert.ok(s.diagnostics.some((d) => d.type === 'PREMISES_MISSING'), 'omission recorded'); assert.deepEqual(s.executions, []);
  }
  const ok = await setup({ premises: [], toolCalls: [A.top] }); assert.equal((await ok.ask({ question: 'x' })).status, 'OK');
  const clar = await setup({ toolCalls: [] }); clar.provider.plan = async () => ({ premises: [], clarification: { text: 'Quelle période ?' } }); assert.equal((await clar.ask({ question: 'x' })).status, 'CLARIFICATION');
});

test('BENCHMARK (internal): declared vs forgotten premises and the detection rate; an omitted field is counted; nothing of it reaches a user', async () => {
  const CASES = [
    { question: 'Pourquoi mes ventes ont baissé ce mois-ci ?', expected: [{ kind: 'trend', metric: 'sales', direction: 'decrease' }] },
    { question: 'Pourquoi les remboursements ont augmenté ?', expected: [{ kind: 'trend', metric: 'refunds', direction: 'increase' }] },
    { question: 'Pourquoi mon meilleur produit est Fixture Gadget ?', expected: [{ kind: 'ranking', scope: 'product' }] },
    { question: 'Quel est mon chiffre d’affaires ?', expected: [] },
  ];
  const run = async (opts, wrap) => {
    resetPeriodCache(); const dir = await writeDataset(); const bench = createPremiseBenchmark();
    let provider = createFakeProvider(opts); if (wrap) provider = wrap(provider);
    const ask = createOrchestrator({ provider, tools: createToolLayer({ reportsDir: dir, now: () => NOW }), timeoutMs: 400, onDiagnostic: bench.onDiagnostic });
    return { report: await bench.measure(CASES, (question) => ask({ question })), ask };
  };
  const all = (await run({ declarePremises: true })).report;
  assert.deepEqual([all.questions, all.questionsWithExpectedPremise, all.expectedPremises, all.declaredPremises, all.matchedPremises, all.missedPremises, all.spuriousPremises, all.omittedField, all.detectionRate], [4, 3, 3, 3, 3, 0, 0, 0, 1]);
  const none = (await run({ declarePremises: true, forgetPremises: true })).report;
  assert.deepEqual([none.declaredPremises, none.matchedPremises, none.missedPremises, none.detectionRate, none.omittedField], [0, 0, 3, 0, 0], 'a model that returns [] for every question is measured at 0 %');
  const part = (await run({ declarePremises: true }, (inner) => ({ ...inner, plan: async (i) => { const p = await inner.plan(i); return /remboursements/.test(i.question) ? { ...p, premises: [] } : p; } }))).report;
  assert.deepEqual([part.matchedPremises, part.missedPremises, Number(part.detectionRate.toFixed(4))], [2, 1, 0.6667]); assert.deepEqual(part.perCase[1].missed, [{ kind: 'trend', metric: 'refunds', direction: 'increase' }]);
  const omit = (await run({ declarePremises: true, omitPremises: true })).report;
  assert.equal(omit.omittedField, 4, 'plans that left the field out are counted'); assert.equal(omit.detectionRate, 0);
  const spur = (await run({ planner: () => ({ done: true }) }, (inner) => ({ ...inner, plan: async () => ({ premises: [{ kind: 'trend', metric: 'sales', direction: 'decrease' }], done: true }) }))).report;
  assert.ok(spur.spuriousPremises >= 1, 'a premise declared for a question with none is counted as spurious');
  // never shown to a user, never a route
  const { ask } = await run({ declarePremises: true }); const shown = JSON.stringify(await ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' }));
  assert.ok(!/detectionRate|PREMISES_DECLARED|PREMISES_MISSING|matchedPremises/.test(shown));
  const server = new URL('../src/analytics-premium/', import.meta.url);
  const files = ['server/app.js', 'server/assistant.js', 'server/serve.js', 'ui/ask.js'].map((f) => readFileSync(new URL(f, server), 'utf8')).join('\n');
  assert.ok(!/diagnostics\.js|createPremiseBenchmark|detectionRate/.test(files), 'the benchmark is imported by no server file and no UI file');
  assert.ok(!readdirSync(new URL('ui/', server)).filter((f) => f.endsWith('.js')).some((f) => readFileSync(new URL(`ui/${f}`, server), 'utf8').includes('detectionRate')));
});
