#!/usr/bin/env node
// Benchmark runner for "Demander à Nordla" providers.
//
//   node benchmark/ask/run.js --provider oracle [--repeats 3]                      harness check: the scripted oracle, no model, no network (always allowed)
//   node benchmark/ask/run.js --provider <adapter.js> --config <cfg> --smoke       the SMOKE test of a real provider: 3 fixed cases, 1 repetition, hard caps
//   node benchmark/ask/run.js --provider <adapter.js> --config <cfg> --max-requests N [--repeats 3]   a real-provider run with an explicit request cap
//
// SAFETY: this file is not under test/ and is not part of `npm test` or CI. A real adapter needs ALL of: an explicit `--provider <module>`, the environment
// variable NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1, and a request cap (`--smoke`, or `--max-requests N`). The cap counts every HTTP attempt (retries and corrective
// re-asks included) through a guard around the adapter's fetch, and ends the run when reached; `--max-cost-usd X` adds a soft cost cap.
//
// An adapter is an ES module exporting `createProvider(config, deps) -> { name, plan(input), explain(input), drainUsage?(), metadata?() }` (the Nordla AI
// provider contract, see src/analytics-premium/server/ai/contract.js). `--config <file.json>` is passed to it (keys are read from the environment by the adapter,
// never stored; results are redacted anyway).
//
// --repeats N (1..10, default 1; 3 for the final comparison): N independent repetitions (fresh provider instance, dataset and orchestrators each time).
// --smoke: the cases, the single repetition and the caps of smoke.json (the same for every provider); it cannot be combined with --only / --repeats.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOracleProvider } from './lib/oracle-provider.js';
import { runBenchmark } from './lib/benchmark.js';
import { createBudget } from './lib/budget-guard.js';
import { collectMetadata } from './lib/meta.js';
import { summarizeRuns } from './lib/score.js';
import { validateCases } from './lib/validate-cases.js';
import { createBenchmarkTools } from './lib/dataset.js';
import { verifyTruth } from './lib/truth.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

const providerArg = opt('provider');
if (!providerArg) fail('usage: node benchmark/ask/run.js --provider oracle | --provider <adapter module> (--smoke | --max-requests N) [--repeats N] [--max-cost-usd X] [--config file.json] [--only S01,P01] [--out file.json]');
const isOracle = providerArg === 'oracle';
if (!isOracle && process.env.NORDLA_BENCH_ALLOW_PROVIDER_CALLS !== '1') fail('Refusing to call a real provider: set NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 to confirm that this run may call an external AI service (and may cost money).');

const dirPath = fileURLToPath(new URL('.', import.meta.url));
const casesFile = path.join(dirPath, 'cases.json');
const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
const problems = validateCases(cases); if (problems.length) fail(`cases.json is invalid:\n${problems.join('\n')}`, 3);

// --- smoke preset and caps ---
const smoke = flag('smoke'); const spec = smoke ? JSON.parse(readFileSync(path.join(dirPath, 'smoke.json'), 'utf8')) : null;
if (smoke && (opt('only') !== null || opt('repeats') !== null)) fail('--smoke fixes the cases and a single repetition (the same for every provider): do not combine it with --only or --repeats');
if (spec) { const missing = spec.cases.filter((id) => !cases.some((c) => c.id === id)); if (missing.length) fail(`smoke.json names unknown cases: ${missing.join(', ')}`, 3); }
const intOpt = (name) => { const v = opt(name); if (v === null) return null; const n = Number(v); if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer`); return n; };
const numOpt = (name) => { const v = opt(name); if (v === null) return null; const n = Number(v); if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`); return n; };
const repeats = smoke ? spec.repeats : (opt('repeats') === null ? 1 : Number(opt('repeats')));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) fail('--repeats must be an integer from 1 to 10');
const only = smoke ? spec.cases : (opt('only')?.split(',') ?? null);
const maxRequests = intOpt('max-requests') ?? spec?.maxRequests ?? null; const maxCostUsd = numOpt('max-cost-usd') ?? spec?.maxCostUsd ?? null;
if (smoke && maxRequests > spec.maxRequests) fail(`--max-requests cannot exceed the smoke cap (${spec.maxRequests})`);
if (smoke && maxCostUsd > spec.maxCostUsd) fail(`--max-cost-usd cannot exceed the smoke cap (${spec.maxCostUsd})`);
if (!isOracle && maxRequests === null) fail('A real-provider run needs a request cap: use --smoke, or --max-requests N (every HTTP attempt counts, retries included).');
const budget = !isOracle ? createBudget({ maxRequests, maxCostUsd }) : null;

const { tools } = await createBenchmarkTools();
const truth = await verifyTruth(cases, tools); if (truth.drift.length) fail(`The fixed dataset drifted from the pinned truth:\n${JSON.stringify(truth.drift, null, 1)}`, 3);

const adapterFile = isOracle ? path.join(dirPath, 'lib/oracle-provider.js') : path.resolve(providerArg);
const config = opt('config') ? JSON.parse(readFileSync(opt('config'), 'utf8')) : {};
let mod = null; if (!isOracle) mod = await import(pathToFileURL(adapterFile).href);
// a NEW instance for every repetition; a real adapter only ever gets the budget-guarded fetch
const createProvider = async () => (isOracle ? createOracleProvider({ cases }) : budget.track(await mod.createProvider(config, { fetch: budget.wrapFetch(globalThis.fetch) })));

const startedAt = new Date();
const { runs, provider, datasetFile, repeatMetadata, aborted } = await runBenchmark({
  cases, createProvider, repeats, only, timeoutMs: Number(opt('timeout-ms') ?? 60_000), shouldStop: () => (budget ? budget.isExceeded() || budget.isExhausted() : false),
  onCase: ({ repeat, score: s }) => console.log(`#${repeat} ${s.pass ? 'PASS' : 'FAIL'}  ${s.id}  ${s.category.padEnd(13)} ${s.language}  ${s.status}  ${s.latency.totalMs} ms`),
});
const finishedAt = new Date();

const stopped = aborted || (budget?.isExceeded() ?? false);   // a refused request also means something was cut short
const runExtra = { smoke, budget: budget?.snapshot() ?? null, aborted: stopped };
const meta = collectMetadata({ provider, config, adapterFile, repeatMetadata, runExtra, repeats, only, timeoutMs: Number(opt('timeout-ms') ?? 60_000), startedAt, finishedAt, casesFile, datasetFile, referenceDate: '2026-09-26' });
const report = { meta, ...summarizeRuns(runs, { provider: provider.name, truthChecked: truth.checked }) };
const out = opt('out') ?? path.join(dirPath, 'results', `${startedAt.toISOString().replace(/[:.]/g, '-')}-${provider.name.replace(/[^a-z0-9]+/gi, '_')}${smoke ? '-smoke' : ''}.json`);
mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2));

console.log('\nsub-scores (separate, no composite):');
for (const [k, v] of Object.entries(report.subScores)) console.log(`  ${k}: ${JSON.stringify(v)}`);
console.log(`\nstability over ${report.stability.repeats} repetition(s):`);
console.log(`  case pass distribution: ${JSON.stringify(report.stability.casePassDistribution)}   mean per-case success: ${JSON.stringify(report.stability.meanPerCaseSuccessRate)}`);
console.log(`  unstable cases: ${report.stability.unstableCases.join(', ') || '-'}   latency std dev (ms): mean ${report.stability.latency.meanStdDevMs}, max ${report.stability.latency.maxStdDevMs}   cost: ${JSON.stringify(report.stability.cost)}`);
if (budget) console.log(`\nbudget: ${JSON.stringify(budget.snapshot())}`);
console.log(`\nreport written to ${out}`);
if (stopped) { console.error('\nRUN STOPPED: a budget cap was reached; the report covers only what completed.'); process.exit(4); }
