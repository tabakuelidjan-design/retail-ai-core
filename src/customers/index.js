#!/usr/bin/env node
// node --env-file=.env src/customers/index.js [--policy file]
// Writes reports/customer-facts-<date>.json (gitignored). Order-level, pseudonymous; no customer identity is read.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { buildWindows } from '../metrics/windows.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { buildCustomerFacts } from './facts.js';

async function main() {
  const now = new Date();
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const i = process.argv.indexOf('--policy');
  const policyPath = i > -1 ? process.argv[i + 1] : 'data/local/marketing-policy.json';
  const config = mergeConfig(existsSync(policyPath) ? JSON.parse(await readFile(policyPath, 'utf8')) : {});
  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  if (!merchant) throw new Error('No merchant found - run the sync first.');
  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, merchant.id, { since: windows.available_window.start });
  const facts = buildCustomerFacts({ ledger: buildLedger(data, { config }), data, now, config });
  await mkdir('reports', { recursive: true });
  const file = `reports/customer-facts-${now.toISOString().slice(0, 10)}.json`;
  await writeFile(file, JSON.stringify(facts, null, 2));
  console.log(`customer facts written to ${file}`);
}
main().catch((e) => { console.error('customer facts failed:', e.message); process.exitCode = 1; });
