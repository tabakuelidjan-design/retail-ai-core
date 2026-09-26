import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, LANGUAGES, validateCases } from '../benchmark/ask/lib/validate-cases.js';
import { createBenchmarkTools } from '../benchmark/ask/lib/dataset.js';
import { verifyTruth } from '../benchmark/ask/lib/truth.js';
import { createOracleProvider } from '../benchmark/ask/lib/oracle-provider.js';
import { runCase } from '../benchmark/ask/lib/run-case.js';
import { scoreCase, summarize, windowsOfArgs } from '../benchmark/ask/lib/score.js';

// The "Demander à Nordla" benchmark (benchmark/ask/). NO real provider here: only the scripted ORACLE, which validates the benchmark itself.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cases = JSON.parse(readFileSync(new URL('../benchmark/ask/cases.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));

async function play(providerFor, only = null) {
  const { tools } = await createBenchmarkTools(); const provider = providerFor();
  const list = only ? cases.filter((c) => only.includes(c.id)) : cases; const scores = [];
  for (const c of list) scores.push(scoreCase(c, await runCase({ testCase: c, provider, tools })));
  return { scores, report: summarize(scores, { provider: provider.name }) };
}

test('cases.json: exactly 30 valid cases with the requested distribution (categories and languages)', () => {
  assert.deepEqual(validateCases(cases), []);
  assert.equal(cases.length, 30);
  const tally = (key) => { const t = {}; for (const c of cases) t[c[key]] = (t[c[key]] ?? 0) + 1; return t; };
  assert.deepEqual(tally('category'), CATEGORIES); assert.deepEqual(tally('language'), LANGUAGES);
  assert.deepEqual(CATEGORIES, { simple: 4, quantitative: 4, multi_tool: 4, premise: 6, clarification: 3, conversation: 3, refusal: 3, trap: 3 }); assert.deepEqual(LANGUAGES, { fr: 24, nl: 3, en: 3 });
  assert.equal(new Set(cases.map((c) => c.id)).size, 30);
});

test('every case carries the required structure, and NO expected natural-language answer (the structure of the reasoning is evaluated, not the style)', () => {
  for (const c of cases) {
    for (const k of ['id', 'category', 'language', 'turns', 'selectedPeriod', 'expected', 'notes']) assert.ok(k in c, `${c.id}.${k}`);
    for (const k of ['premises', 'status', 'tools', 'gaps', 'quantities']) assert.ok(k in c.expected, `${c.id}.expected.${k}`);
    assert.ok(['required', 'forbidden'].every((k) => k in c.expected.tools), `${c.id}.expected.tools`);
    assert.ok(!('answer' in c.expected) && !('text' in c.expected) && !('response' in c.expected), `${c.id}: no expected wording`);
  }
});

test('the categories contain what was asked: 4 false premises + 1 correct + 1 unverifiable; one clarification that must NOT clarify; 3 conversations of 2-3 turns; the three refusal kinds; the three traps', () => {
  const premise = cases.filter((c) => c.category === 'premise');
  assert.deepEqual(premise.map((c) => c.expected.verdict).sort(), ['contradicted', 'contradicted', 'contradicted', 'contradicted', 'supported', 'unknown']);
  assert.deepEqual(new Set(premise.map((c) => c.expected.premises[0].kind)), new Set(['trend', 'ranking', 'level']));
  const clar = cases.filter((c) => c.category === 'clarification'); assert.equal(clar.filter((c) => c.expected.clarification).length, 2); assert.equal(clar.filter((c) => !c.expected.clarification).length, 1);
  const conv = cases.filter((c) => c.category === 'conversation'); assert.ok(conv.every((c) => c.turns.length >= 2 && c.turns.length <= 3)); assert.deepEqual(conv.map((c) => c.turns.length).sort(), [2, 2, 3]);
  const refusal = cases.filter((c) => c.category === 'refusal'); assert.ok(refusal.some((c) => c.expected.gaps.includes('traffic')) && refusal.some((c) => c.expected.gaps.includes('history')) && refusal.some((c) => c.expected.caveats.includes('COSTS_PARTIAL')));
  const trap = cases.filter((c) => c.category === 'trap'); assert.ok(trap.some((c) => c.expected.privacy.mustNotReachProvider.length === 3) && trap.some((c) => c.expected.forbiddenQuantities.length) && trap.some((c) => c.expected.tools.forbidden.includes('*') && c.expected.unknownToolCalls === 0));
  assert.ok(cases.filter((c) => c.language !== 'fr').every((c) => !/^(Quel|Combien|Pourquoi)/.test(c.turns[0].user)), 'NL/EN cases are written in their language');
  assert.notEqual(byId.S03.turns[0].user, byId.S01.turns[0].user);
});

test('reproducible: the pinned quantities of every case equal what the real Tool Layer returns on the fixed synthetic dataset', async () => {
  const { tools } = await createBenchmarkTools(); const truth = await verifyTruth(cases, tools);
  assert.deepEqual(truth.drift, []); assert.ok(truth.checked >= 16, `${truth.checked} quantities checked`);
  const bad = structuredClone(cases); bad[0].expected.quantities[0].value = 1; assert.equal((await verifyTruth(bad, tools)).drift.length, 1, 'a drifted expectation is detected');
});

test('ORACLE run: the expectations are achievable through the real orchestrator - all 30 cases pass, every rate is 100 %, nothing leaks, no rejected call', async () => {
  const { scores, report } = await play(() => createOracleProvider({ cases }));
  assert.deepEqual(scores.filter((s) => !s.pass).map((s) => [s.id, s.checks.filter((c) => c.applicable && !c.pass).map((c) => c.id)]), []);
  const s = report.subScores;
  for (const k of ['successRate', 'planValidity', 'premiseRecall', 'premiseVerdictAccuracy', 'toolSelectionRate', 'statusAccuracy', 'explanationVerificationPassRate', 'quantityCitationRate', 'clarificationAccuracy', 'honestRefusalRate', 'noCausalAfterContradictionRate']) assert.equal(s[k].value, 1, k);
  assert.equal(s.premiseFalsePositiveRate.value, 0); assert.deepEqual(s.privacyViolations, { total: 0, cases: 0 }); assert.equal(s.unknownToolCalls, 0);
  assert.equal(s.premiseRecall.den, 7, '7 expected premises: 6 premise cases + the follow-up of V03'); assert.equal(s.premiseFalsePositiveRate.den, 23);
  assert.equal(s.averageCostPerQuestionUsd, null, 'cost is null until an adapter reports usage'); assert.deepEqual(s.tokens, { input: null, output: null });
  assert.deepEqual(Object.keys(report.byCategory).sort(), Object.keys(CATEGORIES).sort()); assert.deepEqual(Object.keys(report.byLanguage).sort(), ['en', 'fr', 'nl']);
});

test('NO composite score: sub-scores are separate entries with numerator and denominator, and a provider weak on ONE behaviour cannot hide it in an average', async () => {
  const { report: oracle } = await play(() => createOracleProvider({ cases }));
  assert.ok(!Object.keys(oracle).some((k) => /^(score|overall|composite|weighted|total)/i.test(k))); assert.ok(!Object.keys(oracle.subScores).some((k) => /^(score|overall|composite|weighted|mean)/i.test(k)));
  for (const v of Object.values(oracle.subScores)) if (v && typeof v === 'object' && 'value' in v) assert.ok('num' in v && 'den' in v);
  // each degradation breaks ONE behaviour: the matching sub-score falls, the unrelated ones stay at 100 %
  const forget = (await play(() => createOracleProvider({ cases, degrade: 'forgetPremises' }))).report.subScores;
  assert.equal(forget.premiseRecall.value, 0); assert.equal(forget.clarificationAccuracy.value, 1); assert.equal(forget.explanationVerificationPassRate.value, 1); assert.ok(forget.successRate.value < 1);
  const hallu = (await play(() => createOracleProvider({ cases, degrade: 'hallucinate' }))).report.subScores;
  assert.ok(hallu.explanationVerificationPassRate.value < 1); assert.equal(hallu.premiseRecall.value, 1); assert.equal(hallu.clarificationAccuracy.value, 1); assert.equal(hallu.toolSelectionRate.value, 1);
  const over = (await play(() => createOracleProvider({ cases, degrade: 'overClarify' }))).report.subScores;
  assert.ok(over.clarificationAccuracy.value < 1); assert.ok(over.statusAccuracy.value < 1);
  const wrong = (await play(() => createOracleProvider({ cases, degrade: 'wrongTools' }))).report.subScores;
  assert.ok(wrong.toolSelectionRate.value < 1); assert.equal(wrong.premiseRecall.value, 1); assert.equal(wrong.privacyViolations.total, 0);
});

test('scorer: privacy leaks, invented forbidden numbers, unknown tools, exact windows of tool arguments, false-positive premises', async () => {
  const { tools } = await createBenchmarkTools(); const oracle = createOracleProvider({ cases });
  const rec = await runCase({ testCase: byId.T02, provider: oracle, tools });
  assert.equal(scoreCase(byId.T02, rec).checks.find((c) => c.id === 'privacy').pass, true, 'Nordla redacts the personal data before the provider sees it');
  rec.turns[0].providerCalls[0].input.question = 'mail marie.dupont@example.com'; const leaked = scoreCase(byId.T02, rec).checks.find((c) => c.id === 'privacy');
  assert.equal(leaked.pass, false); assert.ok(leaked.leaked >= 1 || leaked.personalLooking >= 1);
  const t3 = await runCase({ testCase: byId.T03, provider: oracle, tools }); t3.turns[0].response.answer.text += ' Soit 10 000 €.';
  assert.equal(scoreCase(byId.T03, t3).checks.find((c) => c.id === 'forbiddenQuantities').pass, false);
  const t1 = await runCase({ testCase: byId.T01, provider: oracle, tools }); t1.turns[0].response.toolCalls = [{ ok: false, tool: 'get_conversion_rate', errorCode: 'UNKNOWN_TOOL', rejected: true }];
  const s1 = scoreCase(byId.T01, t1); assert.equal(s1.checks.find((c) => c.id === 'toolSelection').unknownToolCalls, 1); assert.equal(s1.checks.find((c) => c.id === 'toolSelection').pass, false);
  assert.deepEqual(windowsOfArgs('get_sales_metrics', { period: { period: 'last_30_days' } }), [{ from: '2026-08-27', to: '2026-09-25' }]);
  assert.deepEqual(windowsOfArgs('get_top_products', {}), [{ from: '2026-08-27', to: '2026-09-25' }], 'the tool default');
  assert.deepEqual(windowsOfArgs('compare_sales', { periodA: { period: 'this_month' }, periodB: { period: 'custom', from: '2026-07-01', to: '2026-07-31' } }), [{ from: '2026-09-01', to: '2026-09-26' }, { from: '2026-07-01', to: '2026-07-31' }]);
  const s = scoreCase(byId.S01, await runCase({ testCase: byId.S01, provider: oracle, tools })); assert.equal(s.premises.declared, 0);
  const fp = await runCase({ testCase: byId.S01, provider: { ...oracle, plan: async () => ({ premises: [{ kind: 'trend', metric: 'sales', direction: 'decrease' }], toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } }] }) }, tools });
  assert.equal(scoreCase(byId.S01, fp).checks.find((c) => c.id === 'noSpuriousPremise').pass, false, 'a premise declared for a question that takes nothing for granted');
});

test('latency, tokens and cost are measured through the adapter contract (drainUsage) - here with a fake adapter; without it they are null, never invented', async () => {
  const { tools } = await createBenchmarkTools(); const oracle = createOracleProvider({ cases });
  const slow = { ...oracle, name: 'slow-fake', setContext: oracle.setContext, plan: async (i) => { await new Promise((r) => setTimeout(r, 15)); return oracle.plan(i); }, explain: async (i) => { await new Promise((r) => setTimeout(r, 5)); return oracle.explain(i); }, drainUsage: () => ({ inputTokens: 100, outputTokens: 20, costUsd: 0.001 }) };
  const scores = []; for (const id of ['S01', 'S02', 'C01']) scores.push(scoreCase(byId[id], await runCase({ testCase: byId[id], provider: slow, tools })));
  assert.ok(scores[0].latency.planMs >= 14 && scores[0].latency.explainMs >= 4 && scores[0].latency.providerCalls === 2); assert.equal(scores[2].latency.providerCalls, 1, 'a clarification needs no explanation');
  assert.deepEqual(scores[0].usage, { inputTokens: 200, outputTokens: 40, costUsd: 0.002 });
  const r = summarize(scores, { provider: 'slow-fake' }); assert.equal(r.subScores.averageCostPerQuestionUsd, 0.001667); assert.deepEqual(r.subScores.tokens, { input: 500, output: 100 }, '5 provider calls over 3 cases');
  assert.ok(r.subScores.medianLatencyMs >= 5 && r.subScores.p95LatencyMs >= r.subScores.medianLatencyMs);
  const none = summarize([scoreCase(byId.S01, await runCase({ testCase: byId.S01, provider: oracle, tools }))]); assert.equal(none.subScores.averageCostPerQuestionUsd, null);
});

test('SAFETY: the benchmark lives outside test/, npm test never reaches a provider, the runner refuses a real provider without an explicit opt-in, and nothing here can make a network call', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.js', 'the normal test command only runs test/*.test.js');
  assert.ok(!readdirSync(path.join(ROOT, 'test')).some((f) => f === 'ask'), 'no benchmark run inside test/');
  const run = (a, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), ...a], { encoding: 'utf8', env: { ...process.env, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '', ...env } });
  const noArg = run([]); assert.equal(noArg.status, 2); assert.match(noArg.stderr, /usage/);
  const real = run(['--provider', './adapters/does-not-exist.js']); assert.equal(real.status, 2); assert.match(real.stderr, /Refusing to call a real provider/);
  const src = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) { if (f !== 'results' && f !== 'adapters') walk(p); /* adapters: policed by test/benchmark-adapters.test.js */ } else if (/\.(js|json|md)$/.test(f)) src.push([p, readFileSync(p, 'utf8')]); } }; walk(path.join(ROOT, 'benchmark/ask'));
  for (const [p, s] of src.filter(([p]) => p.endsWith('.js'))) { assert.ok(!/\bfetch\(|node:https?|XMLHttpRequest|WebSocket|https?:\/\//.test(s), `${path.basename(p)}: no network`); assert.ok(!/openai|anthropic|claude|gemini|kimi|mistral|api[_-]?key|\bsk-[A-Za-z0-9]{10,}/i.test(s.replace(/\/\/.*$/gm, '')), `${path.basename(p)}: no provider named`); }
});

test('the runner works end to end with the oracle (no network) and writes a report with separate sub-scores', () => {
  const out = path.join(ROOT, 'benchmark/ask/results/_test-run.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', 'oracle', '--only', 'S01,P01,C01', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /PASS {2}S01/); assert.match(r.stdout, /sub-scores \(separate, no composite\)/);
  const rep = JSON.parse(readFileSync(out, 'utf8')); assert.equal(rep.cases, 3); assert.equal(rep.provider, 'oracle'); assert.ok(rep.subScores.premiseRecall && rep.perCase.length === 3);
});

// ---------- acceptable plans, repetitions, reproducibility metadata ----------
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runBenchmark } from '../benchmark/ask/lib/benchmark.js';
import { summarizeRuns } from '../benchmark/ask/lib/score.js';
import { collectMetadata, redact, adapterInfo, BENCHMARK_VERSION } from '../benchmark/ask/lib/meta.js';

const withPlan = (oracle, toolCalls) => ({ ...oracle, plan: async () => ({ premises: [], toolCalls }) });
const sm = (period) => ({ tool: 'get_sales_metrics', args: { period } });
const run1 = async (id, provider) => { const { tools } = await createBenchmarkTools(); return scoreCase(byId[id], await runCase({ testCase: byId[id], provider, tools })); };
const chk = (s, id) => s.checks.find((c) => c.id === id);

test('acceptable plans: several valid strategies are declared in the case; the schema rejects malformed plan lists', () => {
  for (const id of ['M01', 'M02', 'M04', 'Q01']) { const t = byId[id].expected.tools; assert.ok(t.acceptablePlans.length >= 2, id); assert.deepEqual([t.required, t.minDistinct], [[], 0], `${id}: the plans replace required/minDistinct`); }
  for (const id of ['S01', 'P01', 'C01']) assert.equal(byId[id].expected.tools.acceptablePlans, undefined, `${id} keeps required/forbidden/minDistinct: they suffice`);
  const bad = (mutate) => { const c = structuredClone(cases); mutate(c.find((x) => x.id === 'M02').expected.tools); return validateCases(c); };
  assert.ok(bad((t) => { t.acceptablePlans = [{ required: ['compare_sales'] }]; }).some((e) => /at least 2 plans/.test(e)));
  assert.ok(bad((t) => { t.acceptablePlans[0].required = ['get_weather']; }).some((e) => /unknown tool get_weather/.test(e)));
  assert.ok(bad((t) => { t.required = ['compare_sales']; }).some((e) => /plans replace them/.test(e)));
  assert.ok(bad((t) => { t.acceptablePlans[0].required = []; }).some((e) => /needs required tools/.test(e)));
});

test('acceptable plans: any valid strategy passes, in any order; missing data, a forbidden tool or a broken budget fails', async () => {
  const oracle = createOracleProvider({ cases });
  // M02 (compare July and September): one compare_sales OR two get_sales_metrics are both fine
  assert.equal((await run1('M02', oracle)).pass, true);
  const two = await run1('M02', withPlan(oracle, [sm({ period: 'this_month' }), sm({ period: 'custom', from: '2026-07-01', to: '2026-07-31' })]));
  assert.equal(two.pass, true, 'the second acceptable plan'); assert.equal(chk(two, 'toolSelection').planMatched, 1);
  assert.equal((await run1('M02', withPlan(oracle, [sm({ period: 'custom', from: '2026-07-01', to: '2026-07-31' }), sm({ period: 'this_month' })]))).pass, true, 'the order of the calls does not matter');
  // M04 (three topics): the three dedicated tools in ANY order, or the single sales tool that already carries the three figures
  const pm = { period: 'previous_month' }; const tri = (order) => order.map((t) => ({ tool: t, args: { period: pm } }));
  assert.equal((await run1('M04', withPlan(oracle, tri(['get_sales_metrics', 'get_refunds', 'get_discounts'])))).pass, true); assert.equal((await run1('M04', withPlan(oracle, tri(['get_refunds', 'get_discounts', 'get_sales_metrics'])))).pass, true);
  assert.equal((await run1('M04', withPlan(oracle, tri(['get_sales_metrics'])))).pass, true, 'one tool that returns all three figures is valid');
  const partial = await run1('M04', withPlan(oracle, tri(['get_discounts']))); assert.equal(chk(partial, 'toolSelection').pass, false, 'the data for two of the three topics was never obtained');
  // Q01: discounts from the dedicated tool or from the sales tool; a different, unrelated tool fails
  assert.equal((await run1('Q01', withPlan(oracle, [sm(pm)]))).pass, true); assert.equal(chk(await run1('Q01', withPlan(oracle, [{ tool: 'get_shipping', args: { period: pm } }])), 'toolSelection').pass, false);
  // M01: a combination among the accepted ones
  assert.equal(chk(await run1('M01', withPlan(oracle, [sm({ period: 'this_week' }), { tool: 'get_channels', args: { period: { period: 'this_week' } } }])), 'toolSelection').pass, true);
  assert.equal(chk(await run1('M01', withPlan(oracle, [sm({ period: 'this_week' })])), 'toolSelection').pass, false, 'a single tool is not a multi-tool answer');
  // forbidden tools apply to every plan, budgets are checked, and "data obtained" means the tool answered (unless a refusal is expected)
  const forbid = structuredClone(byId.M02); forbid.expected.tools.forbidden = ['get_channels'];
  const { tools } = await createBenchmarkTools(); const rec = await runCase({ testCase: forbid, provider: withPlan(oracle, [{ tool: 'compare_sales', args: { periodA: { period: 'this_month' }, periodB: { period: 'custom', from: '2026-07-01', to: '2026-07-31' } } }, { tool: 'get_channels', args: {} }]), tools });
  const f = chk(scoreCase(forbid, rec), 'toolSelection'); assert.equal(f.requiredOk, true); assert.equal(f.forbiddenOk, false); assert.equal(f.pass, false);
  const over = await run1('S01', withPlan(oracle, [1, 2, 3, 4, 5, 6].map((limit) => ({ tool: 'get_top_products', args: { limit } })).concat([sm({ period: 'last_30_days' })])));
  assert.equal(chk(over, 'budgets').pass, false, 'more than 4 analysis calls asked'); assert.equal(chk(over, 'budgets').truncated, true);
  assert.equal(chk(await run1('S01', oracle), 'budgets').pass, true);
  const s01 = await runCase({ testCase: byId.S01, provider: oracle, tools }); s01.turns[0].response.toolCalls.forEach((c) => { c.ok = false; c.errorCode = 'NO_DATA'; });
  assert.equal(chk(scoreCase(byId.S01, s01), 'toolSelection').pass, false, 'the tool failed: the data was not obtained');
  const r02 = await runCase({ testCase: byId.R02, provider: oracle, tools }); assert.equal(chk(scoreCase(byId.R02, r02), 'toolSelection').pass, true, 'a refusal case expects the tool error');
});

/** an independent oracle per repetition, made to fail on chosen (case, repetition) pairs: 'x' = fails that time */
const flakyFactory = (matrix, extra = {}) => (repeat) => {
  const oracle = createOracleProvider({ cases }); let current = null;
  return { ...oracle, setContext(id, turn) { current = id; oracle.setContext(id, turn); },
    plan: async (i) => { if (extra.delayMs) await new Promise((r) => setTimeout(r, extra.delayMs * repeat)); return matrix[current]?.[repeat - 1] === 'x' ? { premises: [], clarification: { text: 'Précisez ?' } } : oracle.plan(i); },
    drainUsage: extra.cost ? () => ({ inputTokens: 10, outputTokens: 5, costUsd: extra.cost * repeat }) : undefined };
};

test('repetitions: independent runs, and a stability report next to the existing sub-scores (3/3, 2/3, 1/3, 0/3; latency and cost spread)', async () => {
  const made = []; const matrix = { S01: 'ooo', S02: 'oox', S03: 'oxx', S04: 'xxx' };
  const factory = flakyFactory(matrix, { delayMs: 8, cost: 0.001 });
  const { runs, provider } = await runBenchmark({ cases, repeats: 3, only: ['S01', 'S02', 'S03', 'S04'], createProvider: (r) => { const p = factory(r); made.push(p); return p; } });
  assert.equal(made.length, 3); assert.equal(new Set(made).size, 3, 'a fresh provider instance for each repetition'); assert.equal(runs.length, 3); assert.ok(runs.every((r) => r.length === 4)); assert.equal(provider, made[0]);
  const rep = summarizeRuns(runs, { provider: 'flaky' }); const st = rep.stability;
  assert.deepEqual(st.casePassDistribution, { '3/3': 1, '2/3': 1, '1/3': 1, '0/3': 1 }); assert.equal(st.repeats, 3);
  assert.deepEqual(st.meanPerCaseSuccessRate, { value: 0.5, num: 6, den: 12 }); assert.deepEqual(st.unstableCases, ['S02', 'S03']); assert.deepEqual(st.statusChanged, ['S02', 'S03'], 'S04 fails the same way every time: unstable = passes sometimes, statusChanged = status differs between repetitions');
  assert.deepEqual(st.perCase.map((c) => [c.id, c.passes, c.of]), [['S01', 3, 3], ['S02', 2, 3], ['S03', 1, 3], ['S04', 0, 3]]);
  assert.ok(st.latency.meanStdDevMs > 0 && st.latency.maxStdDevMs >= st.latency.meanStdDevMs, 'latency varies between repetitions'); assert.ok(st.cost.meanStdDevUsd > 0, 'cost varies between repetitions (0.001, 0.002, 0.003 per call)');
  assert.deepEqual([rep.repeats, rep.cases], [3, 12], 'the existing sub-scores are pooled over all case x repetition samples'); assert.deepEqual(rep.subScores.successRate, { value: 0.5, num: 6, den: 12 });
  for (const k of [...Object.keys(rep), ...Object.keys(st)]) assert.ok(!/^(score|overall|composite|weighted)/i.test(k), `no composite key: ${k}`);
  const stable = summarizeRuns((await runBenchmark({ cases, repeats: 1, only: ['S01', 'C01'], createProvider: () => createOracleProvider({ cases }) })).runs); assert.deepEqual(stable.stability.casePassDistribution, { '1/1': 2, '0/1': 0 }); assert.equal(stable.stability.cost, null, 'no cost reported, none invented');
  await assert.rejects(runBenchmark({ cases, repeats: 0, createProvider: () => oracleFor() }), /repeats/); await assert.rejects(runBenchmark({ cases, repeats: 11, createProvider: () => oracleFor() }), /repeats/);
});
const oracleFor = () => createOracleProvider({ cases });

test('repetitions: the oracle stays 30/30 on every repetition, and the runner takes --repeats (default 1, refuses anything else than 1..10)', () => {
  const run = (a) => spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', 'oracle', '--out', path.join(tmpdir(), `bench-${Date.now()}-${Math.random()}.json`), ...a], { encoding: 'utf8' });
  for (const bad of ['0', '11', 'abc', '2.5']) { const r = run(['--repeats', bad]); assert.equal(r.status, 2, bad); assert.match(r.stderr, /--repeats must be an integer from 1 to 10/); }
  const out = path.join(tmpdir(), `bench-full-${Date.now()}.json`);
  const full = spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', 'oracle', '--repeats', '3', '--out', out], { encoding: 'utf8' }); assert.equal(full.status, 0, full.stderr);
  const rep = JSON.parse(readFileSync(out, 'utf8')); assert.equal(rep.meta.run.repeats, 3); assert.deepEqual(rep.stability.casePassDistribution, { '3/3': 30, '2/3': 0, '1/3': 0, '0/3': 0 });
  assert.deepEqual(rep.subScores.successRate, { value: 1, num: 90, den: 90 }); assert.equal(rep.cases, 90); assert.equal(rep.stability.perCase.length, 30); assert.match(full.stdout, /stability over 3 repetition/);
  const def = spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', 'oracle', '--only', 'S01', '--out', out], { encoding: 'utf8' }); assert.equal(def.status, 0); assert.equal(JSON.parse(readFileSync(out, 'utf8')).meta.run.repeats, 1, 'default: 1');
});

test('reproducibility metadata: benchmark version/hashes, run times, Nordla commit, provider/model/version/temperature, config, adapter commit - and NEVER a secret', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-adapter-')); const adapter = path.join(dir, 'fake-adapter.mjs');
  const oracleUrl = new URL('../benchmark/ask/lib/oracle-provider.js', import.meta.url).href; const casesUrl = new URL('../benchmark/ask/cases.json', import.meta.url).href;
  writeFileSync(adapter, `import { readFileSync } from 'node:fs';
import { createOracleProvider } from '${oracleUrl}';
export function createProvider(config) {
  const cases = JSON.parse(readFileSync(new URL('${casesUrl}'), 'utf8'));
  const p = createOracleProvider({ cases });
  return { ...p, name: 'fake-adapter', metadata: () => ({ model: config.model, modelVersion: 'm-1-2026-01-01', temperature: config.temperature, apiKey: 'sk-LEAKYLEAKYLEAKY123456', region: 'eu' }) };
}
`);
  const cfg = path.join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ model: 'm-1', temperature: 0.2, apiKey: 'sk-SECRETSECRETSECRET1234', apiKeyEnv: 'MY_PROVIDER_KEY', headers: { Authorization: 'Bearer abc123def456ghi789' }, nested: { token: 'zzz-top-secret' }, note: 'sk-INLINEINLINEINLINE9999' }));
  const out = path.join(dir, 'result.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', adapter, '--config', cfg, '--only', 'S01,C01', '--repeats', '2', '--out', out], { encoding: 'utf8', env: { ...process.env, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1', MY_PROVIDER_KEY: 'sk-ENVSECRETVALUE99999999' } });
  assert.equal(r.status, 0, r.stderr);
  const raw = readFileSync(out, 'utf8'); const rep = JSON.parse(raw); const m = rep.meta;
  for (const secret of ['sk-SECRETSECRETSECRET1234', 'abc123def456ghi789', 'zzz-top-secret', 'sk-INLINEINLINEINLINE9999', 'sk-LEAKYLEAKYLEAKY123456', 'sk-ENVSECRETVALUE99999999']) assert.ok(!raw.includes(secret), `no secret in the result: ${secret.slice(0, 8)}...`);
  assert.ok(raw.includes('[redacted]') && raw.includes('MY_PROVIDER_KEY'), 'redacted, but the NAME of the environment variable is kept'); assert.ok(!raw.includes('"PATH"') && !/USERPROFILE|APPDATA/i.test(raw), 'the environment is never dumped');
  assert.deepEqual([m.benchmark.name, m.benchmark.version, m.benchmark.cases, m.benchmark.dataset, m.benchmark.referenceDate], ['nordla-ask-benchmark', BENCHMARK_VERSION, 30, 'synthetic-fixed', '2026-09-26']);
  assert.equal(m.benchmark.casesSha256, createHash('sha256').update(readFileSync(path.join(ROOT, 'benchmark/ask/cases.json'))).digest('hex')); assert.match(m.benchmark.datasetSha256, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(m.run.startedAt) <= Date.parse(m.run.finishedAt)); assert.equal(m.run.repeats, 2); assert.deepEqual(m.run.only, ['S01', 'C01']);
  assert.equal(m.nordla.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()); assert.equal(typeof m.nordla.dirty, 'boolean'); assert.ok(m.nordla.branch);
  assert.deepEqual([m.provider.name, m.provider.model, m.provider.modelVersion, m.provider.temperature], ['fake-adapter', 'm-1', 'm-1-2026-01-01', 0.2]); assert.equal(m.provider.config.apiKey, '[redacted]'); assert.equal(m.provider.config.apiKeyEnv, 'MY_PROVIDER_KEY'); assert.equal(m.provider.metadata.region, 'eu');
  assert.equal(m.adapter.path, 'fake-adapter.mjs'); assert.equal(m.adapter.commit, null, 'an adapter outside the repository has no commit'); assert.match(m.adapter.sha256, /^[0-9a-f]{64}$/);
  const oracle = adapterInfo(path.join(ROOT, 'benchmark/ask/lib/oracle-provider.js')); assert.match(oracle.commit, /^[0-9a-f]{40}$/, 'an adapter inside the repository carries its last commit'); assert.equal(oracle.path, 'benchmark/ask/lib/oracle-provider.js');
  assert.equal(rep.subScores.successRate.den, 4, '2 cases x 2 repetitions');
});

test('redaction and metadata units: by key name and by value shape, env-var NAMES kept, provider/adapter metadata redacted too', () => {
  assert.deepEqual(redact({ apiKey: 'x', api_key: 'y', token: 't', password: 'p', secret: 's', Authorization: 'Bearer q', model: 'ok', apiKeyEnv: 'OPENAI_KEY', list: [{ accessToken: 'a' }, 'sk-ABCDEFGHIJKLMNOP1234', 'plain'], n: 3, empty: null }),
    { apiKey: '[redacted]', api_key: '[redacted]', token: '[redacted]', password: '[redacted]', secret: '[redacted]', Authorization: '[redacted]', model: 'ok', apiKeyEnv: 'OPENAI_KEY', list: [{ accessToken: '[redacted]' }, '[redacted]', 'plain'], n: 3, empty: null });
  const fake = { name: 'p', metadata: () => ({ model: 'm', apiKey: 'sk-ABCDEFGHIJKLMNOP1234' }) };
  const meta = collectMetadata({ provider: fake, config: { temperature: 0.7, token: 'zzz' }, repeats: 3, startedAt: new Date('2026-01-01T00:00:00Z'), finishedAt: new Date('2026-01-01T00:00:05Z'), casesFile: path.join(ROOT, 'benchmark/ask/cases.json'), referenceDate: '2026-09-26' });
  assert.equal(meta.run.durationMs, 5000); assert.equal(meta.provider.temperature, 0.7, 'falls back to the config'); assert.equal(meta.provider.metadata.apiKey, '[redacted]'); assert.equal(meta.provider.config.token, '[redacted]'); assert.equal(meta.adapter, null); assert.equal(meta.benchmark.datasetSha256, null);
  const t1 = createHash('sha256'); void t1; mkdirSync(tmpdir(), { recursive: true });
});

test('the dataset used by every repetition is byte-identical (same hash), so runs are comparable', async () => {
  const hash = async () => { const { dir } = await createBenchmarkTools(); return createHash('sha256').update(readFileSync(path.join(dir, 'dataset.json'))).digest('hex'); };
  assert.equal(await hash(), await hash());
});
