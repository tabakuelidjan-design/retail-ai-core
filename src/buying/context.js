// Shared loading for the buying CLIs: synced data -> ledger -> Phase 2B demand
// facts (with sales reconciled against the source first) + merchant policy +
// stock-count records. The only I/O in the buying tooling.
// Tenant (ADR 0003, step 7): NORDLA_MERCHANT_ID through the shared resolver - Shopify never says which merchant this is. Shopify is
// used only for what really needs it - reconciling Nordla's sales with the shop - through the tenant's VERIFIED shopify connector;
// without it (NOT_CONFIGURED / MISCONFIGURED / UNAVAILABLE) the facts are built from Nordla's data and marked "not reconciled".

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { buildDemandFacts } from '../demand/build.js';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { validateAgainstShopify } from '../metrics/validate.js';
import { buildWindows } from '../metrics/windows.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { openShopifyForTenant, resolveToolTenant } from '../tenant/tool-context.js';
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

export async function loadBuyingContext({ policyPath = DEFAULT_PATHS.policy, verificationPath = DEFAULT_PATHS.verification, env = process.env, supabase: injectedSupabase = null, createClient = null, now = new Date(), log = console.error } = {}) {
  const timeZone = env.MERCHANT_TIMEZONE || 'UTC';
  const policy = existsSync(policyPath) ? await readJson(policyPath) : {};
  const config = mergeConfig(policy);
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  const tenant = await resolveToolTenant({ env, supabase, tool: 'buying', log, createClient });

  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, tenant.merchantId, { since: windows.available_window.start });
  const ledger = buildLedger(data, { config });
  // Sales reconciliation with the shop: only through the tenant's verified shopify connector; never a reason to fail the buying facts.
  const shop = await openShopifyForTenant({ env, supabase, merchantId: tenant.merchantId, createClient });
  let reconciliation;
  if (shop.state === 'CONFIGURED') {
    try {
      const validation = await validateAgainstShopify({ shopify: shop.shopify, ledger, windows });
      reconciliation = { status: 'CHECKED', checked_at: now.toISOString(), comparisons: validation.length, all_match: validation.every((v) => v.ok) };
    } catch { reconciliation = { status: 'UNAVAILABLE', checked_at: now.toISOString(), comparisons: 0, all_match: false }; }
  } else reconciliation = { status: shop.state, reason: shop.reason, checked_at: now.toISOString(), comparisons: 0, all_match: false };
  if (reconciliation.status !== 'CHECKED') log(`sales reconciliation with Shopify: ${reconciliation.status}${reconciliation.reason ? ` (${reconciliation.reason})` : ''} - facts built from Nordla's data, marked not reconciled`);
  const salesReconciled = reconciliation.all_match;
  const facts = buildDemandFacts({ ledger, data, now, timeZone, config, salesReconciled });
  facts.input_status.sales_reconciliation = reconciliation;

  const counts = existsSync(verificationPath) ? await readJson(verificationPath) : [];
  return {
    merchantId: tenant.merchantId, now, timeZone, config, policy, facts, ledger, preparedVerification: prepareStockVerification(counts, ledger),
    inputs: { policy_file: existsSync(policyPath) ? policyPath : null, stock_counts: counts.length },
  };
}
