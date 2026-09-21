#!/usr/bin/env node
// node --env-file=.env src/buying/index.js <candidate.json> [more.json ...]
//        [--policy <file>]              merchant buying policy (default data/local/buying-policy.json)
//        [--stock-verification <file>]  physical counts (default data/local/stock-verification.json)
// Evaluates each candidate file independently (no ranking) against the Phase 2B
// demand facts and writes reports/buying-*.json. Candidate files are the only
// persistence until a Decision Ledger exists. Merchant policy and stock counts are
// real merchant data: keep them in data/local/ (gitignored).

import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_PATHS, loadBuyingContext, parseArgs, readJson } from './context.js';
import { evaluateCandidate } from './evaluate.js';

async function main() {
  const { positional: files, opts } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('Usage: node src/buying/index.js <candidate.json> [...] [--policy file] [--stock-verification file]');
    process.exit(1);
  }
  const ctx = await loadBuyingContext({ policyPath: opts.policy ?? DEFAULT_PATHS.policy, verificationPath: opts['stock-verification'] ?? DEFAULT_PATHS.verification });
  if (!ctx.inputs.policy_file) console.warn(`No policy file found (${opts.policy ?? DEFAULT_PATHS.policy}): every merchant policy value is unset, so results will be NEED MORE DATA.`);

  await mkdir('reports', { recursive: true });
  const stamp = ctx.now.toISOString().slice(0, 10);
  for (const file of files) {
    const result = evaluateCandidate({ rawCandidate: await readJson(file), demandFacts: ctx.facts, config: ctx.config, preparedVerification: ctx.preparedVerification, now: ctx.now });
    const id = (result.candidate_id ?? 'invalid').replace(/[^A-Za-z0-9_-]/g, '_');
    await writeFile(`reports/buying-${id}-${stamp}.json`, JSON.stringify(result, null, 2));
    console.log(`${file} -> ${result.verdict}${result.test_type ? ` (${result.test_type})` : ''} | ${result.reason_codes.join(', ')} | reports/buying-${id}-${stamp}.json`);
  }
}

main().catch((err) => {
  console.error('buying evaluation failed:', err);
  process.exit(1);
});
