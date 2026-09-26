import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { createToolLayer } from '../src/analytics-premium/server/tools/index.js';
import { createOrchestrator } from '../src/analytics-premium/server/ai/orchestrator.js';
import { PREMISE_METRICS, premiseProblem } from '../src/analytics-premium/server/ai/premise.js';
import { NOW, writeDataset } from './fixtures/analytics-dataset.js';
import { createFakeProvider } from './fixtures/fake-ai-provider.js';

// False-premise detection: what a question takes for granted is checked against the facts BEFORE any analysis. The fake provider states the premise in structure
// AND keeps trying to run the cause analysis (tool calls + hypotheses): Nordla must stop it. SYNTHETIC data; in the last 30 days sales +1.72 %, average basket
// +1.71 %, refunds 10 -> 0, discounts 8 -> 8 (unchanged), best product "Fixture Widget".

async function setup(opts = {}) {
  resetPeriodCache(); const dir = await writeDataset(); const diagnostics = [];
  const provider = createFakeProvider({ declarePremises: true, explainMode: 'hyp', ...opts });
  const ask = createOrchestrator({ provider, tools: createToolLayer({ reportsDir: dir, now: () => NOW }), timeoutMs: 400, onDiagnostic: (d) => { if (!d.type.startsWith('PREMISES_')) diagnostics.push(d); } /* the premise-declaration events are benchmark data, not rejections */ });
  return { provider, ask, diagnostics };
}
const check = (r) => r.premise.checks[0];

test('a drop is claimed, sales actually rose: the premise is CONTRADICTED, corrected with the facts, and NO cause analysis is produced', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
  assert.equal(r.status, 'PREMISE_CONTRADICTED'); const c = check(r);
  assert.deepEqual([c.kind, c.metric, c.direction, c.verdict], ['trend', 'sales', 'decrease', 'contradicted']);
  assert.equal(c.actual.direction, 'increase'); assert.equal(c.actual.delta_pct, 0.0172); assert.equal(c.actual.current, 489.25); assert.equal(c.actual.previous, 480.98); assert.deepEqual(c.actual.reference, { from: '2026-07-28', to: '2026-08-26' });
  assert.deepEqual(r.premise.suggestion, { kind: 'explain_change', metric: 'sales', direction: 'increase' });
  // the fake provider also asked for the whole cause analysis (3 tools) and would have produced hypotheses: none of it ran
  assert.equal(s.provider.seen.explain.length, 0, 'the explanation is never requested'); assert.equal(r.answer, undefined); assert.equal(r.explanation.status, 'SKIPPED');
  assert.equal(r.toolCalls.length, 1, 'only the evidence call ran, not the provider\'s tool calls'); assert.equal(r.toolCalls[0].tool, 'get_sales_metrics');
  assert.ok(!/cause possible|hypoth/i.test(JSON.stringify(r)), 'no causal hypothesis about the false premise');
  assert.ok(r.facts.some((f) => f.ref === 'c1.comparison.net_sales_ex_tax.delta_pct' && f.value === 0.0172), 'the facts that contradict the premise are delivered');
  assert.equal(s.diagnostics[0].type, 'PREMISE_CONTRADICTED');
});

test('an increase is claimed, it actually decreased: refunds 10 -> 0 (metric outside the sales block: two calls, same engine figures)', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Pourquoi les remboursements ont augmenté ?' });
  assert.equal(r.status, 'PREMISE_CONTRADICTED'); assert.deepEqual([check(r).metric, check(r).direction, check(r).actual.direction, check(r).actual.previous, check(r).actual.current], ['refunds', 'increase', 'decrease', 10, 0]);
  assert.deepEqual(r.toolCalls.map((c) => c.tool), ['get_sales_metrics', 'get_refunds']); assert.equal(s.provider.seen.explain.length, 0);
  assert.deepEqual(r.premise.suggestion, { kind: 'explain_change', metric: 'refunds', direction: 'decrease' });
});

test('"it went up" when it did not move at all: unchanged contradicts both directions (discounts 8 -> 8), and there is no "explain this change" offer', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Pourquoi les remises ont augmenté ?' });
  assert.equal(r.status, 'PREMISE_CONTRADICTED'); assert.equal(check(r).actual.direction, 'unchanged'); assert.equal(r.premise.suggestion, undefined);
});

test('average basket: a drop claimed while it rose is contradicted', async () => {
  const r = await (await setup()).ask({ question: 'Pourquoi le panier moyen a baissé ?' });
  assert.equal(r.status, 'PREMISE_CONTRADICTED'); assert.deepEqual([check(r).metric, check(r).actual.direction], ['aov', 'increase']);
});

test('best product: "why is X my best product" when another product is the best -> contradicted with the real best product; when X really is the best -> the analysis goes on', async () => {
  const wrong = await (await setup()).ask({ question: 'Pourquoi mon meilleur produit est Fixture Gadget ?' });
  assert.equal(wrong.status, 'PREMISE_CONTRADICTED'); assert.deepEqual([check(wrong).kind, check(wrong).scope, check(wrong).subject, check(wrong).actual.top], ['ranking', 'product', 'fixture gadget', 'Fixture Widget']);
  assert.deepEqual(wrong.toolCalls.map((c) => c.tool), ['get_top_products', 'find_product']);
  const s = await setup(); const right = await s.ask({ question: 'Pourquoi mon meilleur produit est Fixture Widget ?' });
  assert.equal(right.status, 'OK'); assert.equal(right.explanation.status, 'VERIFIED'); assert.equal(s.provider.seen.explain.length, 1);
});

test('"my sales are zero" while there are sales -> contradicted with the actual value', async () => {
  const r = await (await setup()).ask({ question: 'Pourquoi mes ventes sont nulles ?' });
  assert.equal(r.status, 'PREMISE_CONTRADICTED'); assert.deepEqual([check(r).kind, check(r).level, check(r).actual], ['level', 'zero', { value: 489.25, unit: 'EUR' }]);
});

test('VAT "higher" when it is not: contradicted on a period where it fell; supported on the period where it really rose (the analysis then proceeds)', async () => {
  const s = await setup(); const no = await s.ask({ question: 'Pourquoi la TVA est plus élevée ?', selected: { period: 'yesterday' } });
  assert.equal(no.status, 'PREMISE_CONTRADICTED'); assert.equal(check(no).metric, 'vat'); assert.equal(check(no).actual.direction, 'decrease'); assert.deepEqual(check(no).actual.reference, { from: '2026-09-24', to: '2026-09-24' });
  const yes = await (await setup()).ask({ question: 'Pourquoi la TVA est plus élevée ?' }); assert.equal(yes.status, 'OK');
});

test('a CORRECT premise is supported and the analysis continues normally (the evidence call is re-used, the provider still gets its hypotheses through verification)', async () => {
  const s = await setup(); const r = await s.ask({ question: 'Pourquoi mes ventes ont augmenté ?' });
  assert.equal(r.status, 'OK'); assert.equal(r.toolCalls.length, 3, 'the evidence call and the provider\'s identical call are one'); assert.ok(r.toolCalls.length <= 4);
  assert.deepEqual(s.provider.seen.explain[0].premises, [{ kind: 'trend', metric: 'sales', verdict: 'supported' }]);
  assert.ok(r.answer.parts.some((p) => p.type === 'hypothesis'), 'hypotheses are allowed once the premise holds');
});

test('a premise Nordla CANNOT verify: it says so, builds no analysis on it, and gives the reason it knows (unknown product; history too short for a comparison)', async () => {
  const s = await setup(); const p = await s.ask({ question: 'Pourquoi mon meilleur produit est Licorne ?' });
  assert.equal(p.status, 'PREMISE_UNVERIFIABLE'); assert.deepEqual([check(p).verdict, check(p).reason], ['unknown', 'NOT_IN_CATALOG']); assert.equal(s.provider.seen.explain.length, 0); assert.equal(p.answer, undefined);
  const h = await setup(); const r = await h.ask({ question: 'Pourquoi mes ventes ont baissé ?', selected: { period: 'custom', from: '2026-06-12', to: '2026-07-12' } });
  assert.equal(r.status, 'PREMISE_UNVERIFIABLE'); assert.equal(check(r).reason, 'COMPARISON_UNAVAILABLE'); assert.ok(r.limitations.some((l) => l.code === 'COMPARISON_HISTORY_INSUFFICIENT'), 'the data limit is shown too'); assert.equal(h.provider.seen.explain.length, 0);
  assert.ok(!/cause possible/i.test(JSON.stringify(r)));
});

test('the provider keeps pursuing the false premise (more tool calls, a second planning turn, hypotheses): none of it is executed or shown', async () => {
  const planner = () => ({ toolCalls: [{ tool: 'get_sales_metrics', args: {} }, { tool: 'get_top_products', args: { limit: 3 } }, { tool: 'get_channels', args: {} }], more: true });
  const s = await setup({ planner, explainMode: 'hyp' });
  const r = await s.ask({ question: 'Pourquoi mes ventes ont baissé ce mois-ci ?' });
  assert.equal(r.status, 'PREMISE_CONTRADICTED'); assert.equal(s.provider.seen.plan.length, 1, 'no second planning turn'); assert.equal(s.provider.seen.explain.length, 0); assert.equal(r.toolCalls.length, 1);
  assert.equal(JSON.stringify(r).includes('Une cause possible'), false);
});

test('premise guard limits: at most 2 premises, well-formed only (malformed or unknown metric -> the plan is invalid, nothing runs); the budgets are tested in analytics-ai-budgets.test.js', async () => {
  const bad = [{ kind: 'trend', metric: 'sales' }, { kind: 'trend', metric: 'weather', direction: 'decrease' }, { kind: 'ranking', scope: 'product' }, { kind: 'level', metric: 'sales' }, { kind: 'mystery' }];
  for (const premise of bad) { const s = await setup({ planner: () => ({ toolCalls: [{ tool: 'get_sales_metrics', args: {} }], premises: [premise] }) }); const r = await s.ask({ question: 'x' }); assert.deepEqual([r.status, r.code], ['PLAN_FAILED', 'PLAN_INVALID'], JSON.stringify(premise)); }
  const three = await setup({ planner: () => ({ toolCalls: [{ tool: 'get_sales_metrics', args: {} }], premises: Array(3).fill({ kind: 'trend', metric: 'sales', direction: 'increase' }) }) });
  assert.equal((await three.ask({ question: 'x' })).status, 'PLAN_FAILED');
  assert.equal(premiseProblem({ kind: 'trend', metric: 'sales', direction: 'increase' }), null);
});

test('premise checks come from the structured plan and the engine, never from wording: the AI layer contains no trend words and every metric maps to a tool + fact key', () => {
  const dir = new URL('../src/analytics-premium/server/ai/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\s\/\/.*$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(!/baiss|hausse|augment|recul|pourquoi|dropped|decreas|why did/i.test(code.replace(/'decrease'|'increase'|"decrease"|"increase"|direction[^\n]*/g, '')), `${f}: no hard-coded phrase list`);
  }
  const tools = createToolLayer({ reportsDir: '.' });
  for (const [metric, m] of Object.entries(PREMISE_METRICS)) assert.ok(tools.has(m.tool) && m.key, metric);
});
