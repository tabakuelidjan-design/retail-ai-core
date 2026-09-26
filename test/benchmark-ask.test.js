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
  const src = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) { if (f !== 'results') walk(p); } else if (/\.(js|json|md)$/.test(f)) src.push([p, readFileSync(p, 'utf8')]); } }; walk(path.join(ROOT, 'benchmark/ask'));
  for (const [p, s] of src.filter(([p]) => p.endsWith('.js'))) { assert.ok(!/\bfetch\(|node:https?|XMLHttpRequest|WebSocket|https?:\/\//.test(s), `${path.basename(p)}: no network`); assert.ok(!/openai|anthropic|claude|gemini|kimi|mistral|api[_-]?key|sk-[A-Za-z0-9]/i.test(s.replace(/\/\/.*$/gm, '')), `${path.basename(p)}: no provider named`); }
});

test('the runner works end to end with the oracle (no network) and writes a report with separate sub-scores', () => {
  const out = path.join(ROOT, 'benchmark/ask/results/_test-run.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', 'oracle', '--only', 'S01,P01,C01', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /PASS {2}S01/); assert.match(r.stdout, /sub-scores \(separate, no composite\)/);
  const rep = JSON.parse(readFileSync(out, 'utf8')); assert.equal(rep.cases, 3); assert.equal(rep.provider, 'oracle'); assert.ok(rep.subScores.premiseRecall && rep.perCase.length === 3);
});
