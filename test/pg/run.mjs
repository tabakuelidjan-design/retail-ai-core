// One command for the whole bench: node test/pg/run.mjs   (starts the disposable PostgreSQL 17 if needed, runs the suites one after the other, prints the summary)
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { up } from './pgctl.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const results = `${here}.results/results.jsonl`;
if (existsSync(results)) rmSync(results);
up();
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...['00-infra', '10-concurrency-infra', '20-controls', '30-p0-regression', '35-legacy-gaps', '40-contract', '50-essential-payments', '60-cutover', '70-bank', '80-legal'].map((n) => `${here}${n}.pg.test.js`)], { stdio: 'inherit' });
if (existsSync(results)) {
  const rows = readFileSync(results, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const by = {}; for (const x of rows) (by[x.tag] ??= []).push(x.id);
  console.log('\n===== PHASE 0 SUMMARY =====');
  for (const [tag, ids] of Object.entries(by)) { console.log(`${tag}: ${ids.length}`); }
}
process.exit(r.status ?? 1);
