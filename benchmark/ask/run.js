#!/usr/bin/env node
// Benchmark runner for "Demander à Nordla" providers.
//
//   node benchmark/ask/run.js --provider oracle                       harness check: the scripted oracle, no model, no network (always allowed)
//   node benchmark/ask/run.js --provider ./adapters/<name>.js         a REAL provider adapter - refused unless NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1
//
// SAFETY: this file is not under test/ and is not part of `npm test` or CI. A real adapter needs BOTH an explicit `--provider <module>` and the environment
// variable above, so nothing can call a provider by accident. No adapter exists yet; adapters are added at benchmark time, one per provider.
//
// An adapter is an ES module exporting `createProvider(config) -> { name, plan(input), explain(input), drainUsage?() }` (the Nordla AI provider contract, see
// src/analytics-premium/server/ai/contract.js). `--config <file.json>` is passed to it (model name, keys are read from the environment by the adapter, never stored).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBenchmarkTools } from './lib/dataset.js';
import { createOracleProvider } from './lib/oracle-provider.js';
import { runCase } from './lib/run-case.js';
import { scoreCase, summarize } from './lib/score.js';
import { validateCases } from './lib/validate-cases.js';
import { verifyTruth } from './lib/truth.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

const providerArg = opt('provider');
if (!providerArg) fail('usage: node benchmark/ask/run.js --provider oracle | --provider <adapter module> [--config file.json] [--only S01,P01] [--out file.json]');
const isOracle = providerArg === 'oracle';
if (!isOracle && process.env.NORDLA_BENCH_ALLOW_PROVIDER_CALLS !== '1') fail('Refusing to call a real provider: set NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 to confirm that this run may call an external AI service (and may cost money).');

const here = new URL('.', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('cases.json', here), 'utf8'));
const problems = validateCases(cases); if (problems.length) fail(`cases.json is invalid:\n${problems.join('\n')}`, 3);
const only = opt('only')?.split(',');
const selected = only ? cases.filter((c) => only.includes(c.id)) : cases;

const { tools } = await createBenchmarkTools();
const truth = await verifyTruth(cases, tools); if (truth.drift.length) fail(`The fixed dataset drifted from the pinned truth:\n${JSON.stringify(truth.drift, null, 1)}`, 3);

let provider;
if (isOracle) provider = createOracleProvider({ cases });
else { const mod = await import(pathToFileURL(path.resolve(providerArg)).href); const config = opt('config') ? JSON.parse(readFileSync(opt('config'), 'utf8')) : {}; provider = await mod.createProvider(config); }

const scores = [];
for (const c of selected) {
  const record = await runCase({ testCase: c, provider, tools, timeoutMs: Number(opt('timeout-ms') ?? 60_000) });
  const s = scoreCase(c, record); scores.push(s);
  console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.category.padEnd(13)} ${c.language}  ${s.status}  ${s.latency.totalMs} ms`);
}
const report = summarize(scores, { provider: provider.name, dataset: 'synthetic-fixed', referenceDate: '2026-09-26', truthChecked: truth.checked });
const out = opt('out') ?? path.join(new URL('results/', here).pathname.replace(/^\/([A-Za-z]:)/, '$1'), `${new Date().toISOString().replace(/[:.]/g, '-')}-${provider.name.replace(/[^a-z0-9]+/gi, '_')}.json`);
mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nsub-scores (separate, no composite):`);
for (const [k, v] of Object.entries(report.subScores)) console.log(`  ${k}: ${JSON.stringify(v)}`);
console.log(`\nreport written to ${out}`);
