// Shared loading for the buying CLIs: synced data -> ledger -> Phase 2B demand
// facts (with sales reconciled against the source first) + merchant policy +
// stock-count records. The only I/O in the buying tooling.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { buildDemandFacts } from '../demand/build.js';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { validateAgainstShopify } from '../metrics/validate.js';
import { buildWindows } from '../metrics/windows.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { prepareStockVerification } from './inventory-trust.js';

export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

export const DEFAULT_PATHS = { policy: 'data/local/buying-policy.json', verification: 'data/local/stock-verification.json' };

/** Splits argv into positional args and `--flag value` options. */
export function parseArgs(argv, valueFlags = ['policy', 'stock-verification']) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      opts[name] = valueFlags.includes(name) ? argv[++i] : true;
    } else positional.push(argv[i]);
  }
  return { positional, opts };
}

export async function loadBuyingContext({ policyPath = DEFAULT_PATHS.policy, verificationPath = DEFAULT_PATHS.verification } = {}) {
  const now = new Date();
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const policy = existsSync(policyPath) ? await readJson(policyPath) : {};
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

  const counts = existsSync(verificationPath) ? await readJson(verificationPath) : [];
  return {
    now, timeZone, config, policy, facts, ledger, preparedVerification: prepareStockVerification(counts, ledger),
    inputs: { policy_file: existsSync(policyPath) ? policyPath : null, stock_counts: counts.length },
  };
}
