#!/usr/bin/env node
// Full-suite runner that respects the documented runtime contracts of each domain.
//
// China Sourcing requires Node 24 (owner decision 2026-10-12, see .github/workflows/china-sourcing.yml, which runs it on Node 24 only).
// On an older Node its tests are an UNSUPPORTED combination: some fail and test/sourcing-asr-bench.test.js hangs, which used to time out the
// Node 20 full-suite jobs (marketing-v1, creative-intelligence-v1). They are excluded here and the exclusion is PRINTED, never silent.
// On Node >= 24 nothing is excluded: this runner is then exactly `node --test test/*.test.js` (= `npm test`).
// `npm test` itself is unchanged.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
export const CONTRACTS = [
  { domain: 'China Sourcing', match: (f) => f.startsWith('sourcing-'), minNode: 24, ref: 'owner decision 2026-10-12; .github/workflows/china-sourcing.yml' },
];

const all = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();
const excluded = [];
const files = all.filter((f) => {
  const c = CONTRACTS.find((k) => k.match(f) && major < k.minNode);
  if (c) excluded.push({ f, c });
  return !c;
});
for (const c of CONTRACTS) {
  const n = excluded.filter((e) => e.c === c).length;
  if (n) console.log(`::notice title=unsupported combination excluded::${c.domain}: ${n} test files skipped on Node ${major} (requires Node >= ${c.minNode}; ${c.ref}). They run in their own workflow.`);
}
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => join('test', f))], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
