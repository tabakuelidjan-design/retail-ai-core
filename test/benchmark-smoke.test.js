import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBudget } from '../benchmark/ask/lib/budget-guard.js';
import { createBenchmarkTools } from '../benchmark/ask/lib/dataset.js';
import { createOracleProvider } from '../benchmark/ask/lib/oracle-provider.js';
import { runBenchmark } from '../benchmark/ask/lib/benchmark.js';
import { runCase } from '../benchmark/ask/lib/run-case.js';
import * as openai from '../benchmark/ask/adapters/openai.js';
import * as anthropic from '../benchmark/ask/adapters/anthropic.js';

// The real-provider SMOKE test: 3 fixed cases, one repetition, hard caps. Tested with mocks only - no key, no network, no real call.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cases = JSON.parse(readFileSync(path.join(ROOT, 'benchmark/ask/cases.json'), 'utf8'));
const spec = JSON.parse(readFileSync(path.join(ROOT, 'benchmark/ask/smoke.json'), 'utf8'));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
const KEYS = { OPENAI_API_KEY: 'sk-TESTOPENAIKEY1234567890', ANTHROPIC_API_KEY: 'sk-ant-TESTANTHROPICKEY123456' };
const PRICING = { inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 10 };
const cfg = (model, env, over = {}) => ({ model, reasoningEffort: 'high', apiKeyEnv: env, today: '2026-09-26', maxOutputTokens: 32000, timeoutMs: 2000, maxRetries: 2, maxFormatRetries: 1, pricing: PRICING, ...over });
const okResponse = (body, extra = {}) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), ...extra });

test('smoke.json: the same three representative cases for every provider - simple one-tool, multi-tool, false premise - one repetition, caps set above the expected calls', async () => {
  assert.deepEqual(spec.cases, ['S01', 'M03', 'P01']); assert.equal(spec.repeats, 1);
  assert.deepEqual(spec.cases.map((id) => byId[id].category), ['simple', 'multi_tool', 'premise']); assert.ok(byId.M03.expected.tools.minDistinct >= 2, 'a multi-tool case'); assert.equal(byId.P01.expected.verdict, 'contradicted');
  const { tools } = await createBenchmarkTools(); const oracle = createOracleProvider({ cases }); let requests = 0;
  for (const id of spec.cases) { const rec = await runCase({ testCase: byId[id], provider: oracle, tools }); requests += rec.turns.flatMap((t) => t.providerCalls).length; }
  assert.equal(requests, spec.expectedRequestsPerProvider, 'a well-behaved provider makes exactly this many API calls: S01 2 (plan + explain), M03 2, P01 1 (plan only: Nordla checks the premise itself)');
  assert.ok(spec.maxRequests >= 2 * spec.expectedRequestsPerProvider && spec.maxRequests <= 15, 'room for a few retries, no room for a runaway');
  assert.ok(spec.maxCostUsd > 0 && spec.maxCostUsd <= 1);
});

test('budget guard: it counts every HTTP attempt, refuses the one past the cap for good, and enforces the soft cost cap from the adapters\' reported cost', async () => {
  let real = 0; const b = createBudget({ maxRequests: 3 }); const f = b.wrapFetch(async () => { real += 1; return 'ok'; });
  assert.deepEqual([await f('u'), await f('u'), await f('u')], ['ok', 'ok', 'ok']);
  await assert.rejects(f('u'), (e) => e.code === 'BUDGET_EXCEEDED' && /MAX_REQUESTS/.test(e.message)); await assert.rejects(f('u'), (e) => e.code === 'BUDGET_EXCEEDED'); assert.equal(real, 3, 'nothing beyond the cap reaches the network');
  assert.equal(b.isExceeded(), true); assert.deepEqual(b.snapshot(), { maxRequests: 3, maxCostUsd: null, requests: 3, costUsd: 0, exceeded: { reason: 'MAX_REQUESTS', requests: 3, costUsd: 0 } });
  let cost = 0; const c = createBudget({ maxRequests: 100, maxCostUsd: 0.5 }); c.track({ metadata: () => ({ usageTotals: { costUsd: cost } }) }); const g = c.wrapFetch(async () => 'ok');
  await g('u'); cost = 0.49; await g('u'); cost = 0.5; await assert.rejects(g('u'), (e) => /MAX_COST/.test(e.message)); assert.equal(c.snapshot().costUsd, 0.5);
  assert.throws(() => createBudget({ maxRequests: 0 }), RangeError);
});

test('a format/retry problem cannot cause a flood of calls: retries, corrective re-asks and rate-limit loops all end at the cap, and the run stops', async () => {
  for (const [label, response] of [['rate limit loop', () => ({ ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'slow down' })], ['server errors', () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'down' })],
    ['no function call ever (format retry)', () => okResponse({ id: 'r', model: 'gpt-6-sol', status: 'completed', output: [{ type: 'message' }], usage: { input_tokens: 5000, output_tokens: 100 } })]]) {
    let real = 0; const budget = createBudget({ maxRequests: 4 }); const fetch = budget.wrapFetch(async () => { real += 1; return response(); });
    const { runs, aborted } = await runBenchmark({ cases, only: spec.cases, repeats: 1, shouldStop: () => budget.isExceeded() || budget.isExhausted(), createProvider: () => budget.track(openai.createProvider(cfg('gpt-6-sol', 'OPENAI_API_KEY'), { fetch, sleep: async () => {}, env: KEYS })) });
    assert.equal(real, 4, `${label}: exactly the cap reached the network, not one more`); assert.equal(aborted || budget.isExceeded(), true, label); assert.ok(runs[0].length < 3 || runs[0].every((s) => s.status === 'PLAN_FAILED'), 'the run ended early or failed cleanly'); assert.equal(budget.snapshot().requests, 4);
    assert.ok(runs[0].length <= 2, `${label}: the run stops as soon as the budget is exceeded (${runs[0].length} case(s) attempted)`);
  }
  // the expected smoke run fits well inside the cap: 5 calls through a well-behaved mock, nothing tripped
  let n = 0; const budget = createBudget({ maxRequests: spec.maxRequests, maxCostUsd: spec.maxCostUsd });
  const script = async (init) => { n += 1; const body = JSON.parse(init.body); const text = body.messages[0].content; const purpose = text.startsWith('PLAN request') ? 'plan' : 'explain';
    const facts = JSON.parse(/^facts: (.*)$/m.exec(text)?.[1] ?? 'null'); const q = /^question: (.*)$/m.exec(text)?.[1] ?? '';
    const args = purpose === 'explain' ? { claims: [{ kind: 'fact', text: 'Voici les faits disponibles.', factRefs: [facts[0].ref] }] }
      : /ventes ont baissé/.test(q) ? { premises: [{ kind: 'trend', metric: 'sales', direction: 'decrease', period: { period: 'last_30_days' } }], toolCalls: [] }
        : /canaux/.test(q) ? { premises: [], toolCalls: [{ tool: 'get_top_products', args: { period: { period: 'this_month' }, limit: 3 } }, { tool: 'get_channels', args: { period: { period: 'this_month' } } }] }
          : { premises: [], toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } }] };
    return okResponse({ id: 'm', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: purpose === 'plan' ? 'submit_plan' : 'submit_explanation', input: args }], usage: { input_tokens: 6000, output_tokens: 1500 } }); };
  const good = await runBenchmark({ cases, only: spec.cases, repeats: 1, shouldStop: () => budget.isExceeded() || budget.isExhausted(), createProvider: () => budget.track(anthropic.createProvider(cfg('claude-opus-5-5', 'ANTHROPIC_API_KEY'), { fetch: budget.wrapFetch(async (u, init) => script(init)), sleep: async () => {}, env: KEYS })) });
  assert.equal(good.aborted, false); assert.equal(n, 5, 'the expected number of calls'); assert.equal(good.runs[0].length, 3); assert.ok(budget.snapshot().requests === 5 && budget.snapshot().costUsd > 0 && budget.snapshot().costUsd < spec.maxCostUsd);
  assert.deepEqual(good.runs[0].map((s) => s.id), ['S01', 'M03', 'P01']); assert.ok(good.runs[0].every((s) => s.usage.inputTokens !== null), 'tokens and cost are really measured (here from the mock)');
});

const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), ...args], { encoding: 'utf8', env: { ...process.env, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '', ...env } });
function fakeAdapter() {   // an adapter that never touches the network: the oracle, behind the adapter interface
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-adapter-')); const file = path.join(dir, 'oracle-adapter.mjs');
  writeFileSync(file, `import { readFileSync } from 'node:fs';
import { createOracleProvider } from '${new URL('../benchmark/ask/lib/oracle-provider.js', import.meta.url).href}';
export function createProvider() { const cases = JSON.parse(readFileSync(new URL('${new URL('../benchmark/ask/cases.json', import.meta.url).href}'), 'utf8')); return { ...createOracleProvider({ cases }), name: 'oracle-behind-adapter' }; }
`);
  return { dir, file };
}

test('the runner: a real-provider run needs the opt-in AND a request cap; --smoke fixes cases/repetitions and cannot be widened', () => {
  const a = fakeAdapter(); const ALLOW = { NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1' };
  assert.match(run(['--provider', a.file, '--smoke']).stderr, /Refusing to call a real provider/);
  const nocap = run(['--provider', a.file, '--repeats', '3'], ALLOW); assert.equal(nocap.status, 2); assert.match(nocap.stderr, /needs a request cap: use --smoke, or --max-requests N/);
  for (const bad of [['--smoke', '--only', 'S01'], ['--smoke', '--repeats', '3']]) { const r = run(['--provider', a.file, ...bad], ALLOW); assert.equal(r.status, 2, bad.join(' ')); assert.match(r.stderr, /do not combine it with --only or --repeats/); }
  assert.match(run(['--provider', a.file, '--smoke', '--max-requests', '13'], ALLOW).stderr, /cannot exceed the smoke cap \(12\)/); assert.match(run(['--provider', a.file, '--smoke', '--max-cost-usd', '2'], ALLOW).stderr, /cannot exceed the smoke cap \(1\)/);
  assert.match(run(['--provider', a.file, '--max-requests', '0'], ALLOW).stderr, /positive integer/); assert.match(run(['--provider', a.file, '--max-requests', '5', '--max-cost-usd', 'abc'], ALLOW).stderr, /positive number/);
  const oracle = run(['--provider', 'oracle', '--only', 'S01', '--out', path.join(a.dir, 'o.json')]); assert.equal(oracle.status, 0, 'the oracle needs neither opt-in nor cap');
});

test('the runner --smoke end to end (through an adapter that makes no network call): the 3 cases, 1 repetition, budget and metadata recorded, no secret', () => {
  const a = fakeAdapter(); const out = path.join(a.dir, 'smoke.json');
  const r = run(['--provider', a.file, '--smoke', '--out', out], { NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'sk-SHOULDNEVERAPPEAR123456' }); assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(out, 'utf8')); assert.deepEqual(rep.perCase.map((c) => c.id), ['S01', 'M03', 'P01']); assert.equal(rep.meta.run.repeats, 1); assert.equal(rep.meta.run.smoke, true); assert.equal(rep.meta.run.aborted, false);
  assert.deepEqual(rep.meta.run.budget, { maxRequests: 12, maxCostUsd: 1, requests: 0, costUsd: 0, exceeded: null }, 'the guard was in place (this adapter used no fetch)');
  assert.equal(rep.subScores.successRate.value, 1); assert.equal(rep.cases, 3); assert.ok(rep.meta.benchmark.casesSha256 && rep.meta.nordla.commit && rep.meta.adapter.sha256); assert.ok(!JSON.stringify(rep).includes('SHOULDNEVERAPPEAR'));
  assert.match(r.stdout, /budget: \{"maxRequests":12/);
});

test('a run that hits the cap stops with exit code 4 and a partial report (loopback-only probe: the guard refuses the second request before any network access)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-probe-')); const file = path.join(dir, 'probe-adapter.mjs'); const out = path.join(dir, 'aborted.json');
  writeFileSync(file, `export function createProvider(config, deps) {
  return { name: 'budget-probe', metadata: () => ({ usageTotals: { costUsd: 0 } }),
    async plan() { try { await deps.fetch('http://127.0.0.1:9/probe'); } catch (e) { if (e.code === 'BUDGET_EXCEEDED') throw e; } await deps.fetch('http://127.0.0.1:9/probe'); throw new Error('unreachable'); },
    async explain() { throw new Error('unreachable'); } };
}
`);
  const r = run(['--provider', file, '--max-requests', '1', '--only', 'S01,S02,S03', '--out', out], { NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1' });
  assert.equal(r.status, 4, r.stderr); assert.match(r.stderr, /RUN STOPPED/);
  const rep = JSON.parse(readFileSync(out, 'utf8')); assert.equal(rep.meta.run.aborted, true); assert.equal(rep.meta.run.budget.exceeded.reason, 'MAX_REQUESTS'); assert.equal(rep.cases, 1, 'the run ended after the first case, S02 and S03 were never attempted');
  assert.equal(rep.perCase[0].status, 'PLAN_FAILED');
});

test('local configs: git-ignored, never tracked, hold env-var NAMES and the verified prices (when present on this machine)', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.local\.json$/.test(f)); assert.deepEqual(tracked, []);
  for (const p of ['openai', 'anthropic', 'kimi']) {
    const file = `benchmark/ask/adapters/configs/${p}.local.json`;
    assert.equal(spawnSync('git', ['check-ignore', '-q', file], { cwd: ROOT }).status, 0, `${file} is ignored by Git`);
    if (!existsSync(path.join(ROOT, file))) continue;
    const raw = readFileSync(path.join(ROOT, file), 'utf8'); const c = JSON.parse(raw);
    assert.ok(!/sk-[A-Za-z0-9-]{10,}|Bearer /.test(raw), `${p}: no key in the file`); assert.match(c.apiKeyEnv, /^[A-Z][A-Z0-9_]*$/); assert.equal(c.reasoningEffort, 'high'); assert.equal(c.today, '2026-09-26');
    assert.ok(c.pricing.inputPerMTok > 0 && c.pricing.outputPerMTok > 0, `${p}: prices filled`); assert.match(c.pricingSource.url, /^https:\/\/(developers\.openai\.com|platform\.claude\.com|platform\.kimi\.ai)\//); assert.equal(c.pricingSource.retrievedOn, '2026-09-26');
  }
});
