#!/usr/bin/env node
// node --env-file=.env src/buying/index.js <candidate.json> [more.json ...]
//        [--policy <file>]              merchant buying policy (default data/local/buying-policy.json)
//        [--stock-verification <file>]  physical counts (default data/local/stock-verification.json)
// Reads the synced data, rebuilds the Phase 2B demand facts (reconciling sales with
// the source first), evaluates each candidate file and writes reports/buying-*.json.
// Candidate files are the only persistence until a Decision Ledger exists.
// Merchant policy and stock counts are real merchant data: keep them in data/local/ (gitignored).

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildDemandFacts } from '../demand/build.js';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { validateAgainstShopify } from '../metrics/validate.js';
import { buildWindows } from '../metrics/windows.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { evaluateCandidate } from './evaluate.js';
import { prepareStockVerification } from './inventory-trust.js';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

function parseArgs(argv) {
  const files = [];
  const opts = { policy: 'data/local/buying-policy.json', verification: 'data/local/stock-verification.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--policy') opts.policy = argv[++i];
    else if (argv[i] === '--stock-verification') opts.verification = argv[++i];
    else files.push(argv[i]);
  }
  return { files, opts };
}

async function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('Usage: node src/buying/index.js <candidate.json> [...] [--policy file] [--stock-verification file]');
    process.exit(1);
  }

  const now = new Date();
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const policy = existsSync(opts.policy) ? await readJson(opts.policy) : {};
  const config = mergeConfig(policy);
  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());

  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  if (!merchant) throw new Error('No merchant found - run the sync first.');

  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, merchant.id, { since: windows.available_window.start });
  const ledger = buildLedger(data, { config });
  const validation = await validateAgainstShopify({ shopify, ledger, windows });
  const salesReconciled = validation.every((v) => v.ok);
  const facts = buildDemandFacts({ ledger, data, now, timeZone, config, salesReconciled });
  facts.input_status.sales_reconciliation = { checked_at: now.toISOString(), comparisons: validation.length, all_match: salesReconciled };

  const counts = existsSync(opts.verification) ? await readJson(opts.verification) : [];
  const preparedVerification = prepareStockVerification(counts, ledger);

  await mkdir('reports', { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  for (const file of files) {
    const result = evaluateCandidate({ rawCandidate: await readJson(file), demandFacts: facts, config, preparedVerification, now });
    const id = (result.candidate_id ?? 'invalid').replace(/[^A-Za-z0-9_-]/g, '_');
    await writeFile(`reports/buying-${id}-${stamp}.json`, JSON.stringify(result, null, 2));
    console.log(`${file} -> ${result.verdict}${result.test_type ? ` (${result.test_type})` : ''} | ${result.reason_codes.join(', ')} | reports/buying-${id}-${stamp}.json`);
  }
}

main().catch((err) => {
  console.error('buying evaluation failed:', err);
  process.exit(1);
});
