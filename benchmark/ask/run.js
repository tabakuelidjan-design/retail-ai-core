#!/usr/bin/env node
// Benchmark runner for "Demander à Nordla" providers.
//
//   node benchmark/ask/run.js --provider oracle [--repeats 3]                harness check: the scripted oracle, no model, no network (always allowed)
//   node benchmark/ask/run.js --provider ./adapters/<name>.js --repeats 3    a REAL provider adapter - refused unless NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1
//
// SAFETY: this file is not under test/ and is not part of `npm test` or CI. A real adapter needs BOTH an explicit `--provider <module>` and the environment
// variable above, so nothing can call a provider by accident. No adapter exists yet; adapters are added at benchmark time, one per provider.
//
// An adapter is an ES module exporting `createProvider(config) -> { name, plan(input), explain(input), drainUsage?(), metadata?() }` (the Nordla AI provider
// contract, see src/analytics-premium/server/ai/contract.js). `metadata()` may declare { model, modelVersion, temperature, ... } for the result file.
// `--config <file.json>` is passed to it (keys are read from the environment by the adapter, never stored; results are redacted anyway).
//
// --repeats N (1..10, default 1; 3 for the final comparison): N independent repetitions (fresh provider instance, dataset and orchestrators each time).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOracleProvider } from './lib/oracle-provider.js';
import { runBenchmark } from './lib/benchmark.js';
import { collectMetadata } from './lib/meta.js';
import { summarizeRuns } from './lib/score.js';
import { validateCases } from './lib/validate-cases.js';
import { createBenchmarkTools } from './lib/dataset.js';
import { verifyTruth } from './lib/truth.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

const providerArg = opt('provider');
if (!providerArg) fail('usage: node benchmark/ask/run.js --provider oracle | --provider <adapter module> [--repeats N] [--config file.json] [--only S01,P01] [--out file.json]');
const isOracle = providerArg === 'oracle';
if (!isOracle && process.env.NORDLA_BENCH_ALLOW_PROVIDER_CALLS !== '1') fail('Refusing to call a real provider: set NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 to confirm that this run may call an external AI service (and may cost money).');
const repeats = opt('repeats') === null ? 1 : Number(opt('repeats'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) fail('--repeats must be an integer from 1 to 10');

const dirPath = fileURLToPath(new URL('.', import.meta.url));
const casesFile = path.join(dirPath, 'cases.json');
const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
const problems = validateCases(cases); if (problems.length) fail(`cases.json is invalid:\n${problems.join('\n')}`, 3);
const only = opt('only')?.split(',') ?? null;

const { tools } = await createBenchmarkTools();
const truth = await verifyTruth(cases, tools); if (truth.drift.length) fail(`The fixed dataset drifted from the pinned truth:\n${JSON.stringify(truth.drift, null, 1)}`, 3);

const adapterFile = isOracle ? path.join(dirPath, 'lib/oracle-provider.js') : path.resolve(providerArg);
const config = opt('config') ? JSON.parse(readFileSync(opt('config'), 'utf8')) : {};
let mod = null; if (!isOracle) mod = await import(pathToFileURL(adapterFile).href);
const createProvider = async () => (isOracle ? createOracleProvider({ cases }) : mod.createProvider(config));    // a NEW instance for every repetition

const startedAt = new Date();
const { runs, provider, datasetFile } = await runBenchmark({
  cases, createProvider, repeats, only, timeoutMs: Number(opt('timeout-ms') ?? 60_000),
  onCase: ({ repeat, score: s }) => console.log(`#${repeat} ${s.pass ? 'PASS' : 'FAIL'}  ${s.id}  ${s.category.padEnd(13)} ${s.language}  ${s.status}  ${s.latency.totalMs} ms`),
});
const finishedAt = new Date();

const meta = collectMetadata({ provider, config, adapterFile, repeats, only, timeoutMs: Number(opt('timeout-ms') ?? 60_000), startedAt, finishedAt, casesFile, datasetFile, referenceDate: '2026-09-26' });
const report = { meta, ...summarizeRuns(runs, { provider: provider.name, truthChecked: truth.checked }) };
const out = opt('out') ?? path.join(dirPath, 'results', `${startedAt.toISOString().replace(/[:.]/g, '-')}-${provider.name.replace(/[^a-z0-9]+/gi, '_')}.json`);
mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2));

console.log('\nsub-scores (separate, no composite):');
for (const [k, v] of Object.entries(report.subScores)) console.log(`  ${k}: ${JSON.stringify(v)}`);
console.log(`\nstability over ${repeats} repetition(s):`);
console.log(`  case pass distribution: ${JSON.stringify(report.stability.casePassDistribution)}   mean per-case success: ${JSON.stringify(report.stability.meanPerCaseSuccessRate)}`);
console.log(`  unstable cases: ${report.stability.unstableCases.join(', ') || '-'}   latency std dev (ms): mean ${report.stability.latency.meanStdDevMs}, max ${report.stability.latency.maxStdDevMs}   cost: ${JSON.stringify(report.stability.cost)}`);
console.log(`\nreport written to ${out}`);
