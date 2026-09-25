#!/usr/bin/env node
// Entry point: `node src/sync/index.js <catalog|inventory|cost|orders|all> [--since=YYYY-MM-DD]`
// No Claude/MCP dependency - reads config from env vars only. See
// .env.example and docs/security/shopify-auth.md before running for real.
//
// Every run is recorded in sync_runs (best effort): when it started, whether it finished, and counts of what it touched. A failed run
// never erases anything (the sync only upserts) and is recorded as FAILED so the modules can show the data as stale.

import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { syncCatalog } from './catalog.js';
import { syncInventory } from './inventory.js';
import { syncProductCosts } from './cost.js';
import { syncOrders } from './orders.js';
import { loadCustomerKeySecret } from '../customers/pseudonym.js';
import { finishRun, startRun } from './run-log.js';

const MODES = ['catalog', 'inventory', 'cost', 'orders', 'all'];
const sinceDays = Number(process.env.SYNC_ORDERS_SINCE_DAYS);
// Explicit --since wins; otherwise SYNC_ORDERS_SINCE_DAYS (a longer refresh window, so refunds on older orders are picked up too);
// otherwise the default 60-day window of the orders sync.
const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.slice('--since='.length)
  ?? (Number.isInteger(sinceDays) && sinceDays > 0 ? new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10) : undefined);

async function merchantIdOf(shopify, supabase) {
  // Re-derived deterministically from the same Shopify identity the catalog sync used, rather than assuming catalog just ran here.
  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  return merchant?.id ?? null;
}

async function main() {
  const mode = process.argv[2];
  if (!MODES.includes(mode)) {
    console.error(`Usage: node src/sync/index.js <${MODES.join('|')}>`);
    process.exit(1);
  }

  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());

  const summaries = {};
  let ok = true; let failure = null; let runId = null; let merchantId = null;
  const note = (name, summary) => {
    summaries[name] = summary;
    console.log(`${name} sync summary:`, JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) { process.exitCode = 1; ok = false; }
  };

  try {
    if (mode !== 'catalog') {
      merchantId = await merchantIdOf(shopify, supabase);
      if (!merchantId) { console.error('No merchant found for this shop - run catalog sync first.'); process.exit(1); }
      runId = await startRun(supabase, { merchantId, mode });
    }

    if (mode === 'catalog' || mode === 'all') note('catalog', await syncCatalog({ shopify, supabase }));

    if (mode === 'catalog') { // the merchant only exists once the catalog sync created it
      merchantId = await merchantIdOf(shopify, supabase);
      if (merchantId) runId = await startRun(supabase, { merchantId, mode });
    }

    if (mode === 'inventory' || mode === 'all') {
      // Merchant-local timezone for the one-snapshot-per-day rule. This is merchant config, not architecture - HABB's value goes in
      // .env, never hardcoded here. Defaults to UTC for any merchant that hasn't set one.
      const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
      note('inventory', await syncInventory({ shopify, supabase }, { merchantId, timeZone }));
    }
    if (mode === 'cost' || mode === 'all') note('cost', await syncProductCosts({ shopify, supabase }, { merchantId }));
    if (mode === 'orders' || mode === 'all') note('orders', await syncOrders({ shopify, supabase }, { merchantId, customerKeySecret: loadCustomerKeySecret(), since: sinceArg }));
  } catch (err) {
    ok = false; failure = err;
    throw err;
  } finally {
    await finishRun(supabase, runId, { ok, summaries, error: failure?.message });
  }
}

main().catch((err) => {
  console.error('sync failed:', err);
  process.exit(1);
});
