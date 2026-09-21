#!/usr/bin/env node
// Entry point: `node src/sync/index.js <catalog|inventory|cost|orders|all>`
// No Claude/MCP dependency - reads config from env vars only. See
// .env.example and docs/security/shopify-auth.md before running for real.

import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { syncCatalog } from './catalog.js';
import { syncInventory } from './inventory.js';
import { syncProductCosts } from './cost.js';
import { syncOrders } from './orders.js';
import { loadCustomerKeySecret } from '../customers/pseudonym.js';
import { SHOP_CREATED_QUERY } from '../shopify/queries.js';
import { getGrantedScopes, nextCoverage, planOrdersSync, readCoverage, writeCoverage } from './history.js';

const MODES = ['catalog', 'inventory', 'cost', 'orders', 'all'];

async function main() {
  const mode = process.argv[2];
  if (!MODES.includes(mode)) {
    console.error(`Usage: node src/sync/index.js <${MODES.join('|')}>`);
    process.exit(1);
  }

  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());

  let merchantId;
  if (mode === 'catalog' || mode === 'all') {
    const summary = await syncCatalog({ shopify, supabase });
    console.log('catalog sync summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 1;
  }

  if (mode !== 'catalog') {
    // inventory/cost/orders need the local merchant id - re-derive it
    // deterministically from the same Shopify identity catalog sync used,
    // rather than assuming catalog just ran in this process.
    const { shop } = await shopify.graphql(SHOP_QUERY);
    const [merchant] = await supabase.select('merchants', {
      select: 'id',
      source_system: 'eq.shopify',
      source_id: `eq.${shop.id}`,
    });
    if (!merchant) {
      console.error('No merchant found for this shop - run catalog sync first.');
      process.exit(1);
    }
    merchantId = merchant.id;
  }

  if (mode === 'inventory' || mode === 'all') {
    // Merchant-local timezone for the one-snapshot-per-day rule. This is
    // merchant config, not architecture - HABB's value goes in .env, never
    // hardcoded here. Defaults to UTC for any merchant that hasn't set one.
    const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
    const summary = await syncInventory({ shopify, supabase }, { merchantId, timeZone });
    console.log('inventory sync summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 1;
  }

  if (mode === 'cost' || mode === 'all') {
    const summary = await syncProductCosts({ shopify, supabase }, { merchantId });
    console.log('cost sync summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 1;
  }

  if (mode === 'orders' || mode === 'all') {
    // --since YYYY-MM-DD, or --full-history (= since the store was created): needs the read_all_orders scope on the live token.
    const args = process.argv.slice(3);
    const sinceIdx = args.indexOf('--since');
    let since = sinceIdx > -1 ? args[sinceIdx + 1] : null;
    let storeCreatedOn = null;
    if (args.includes('--full-history') || since) {
      storeCreatedOn = (await shopify.graphql(SHOP_CREATED_QUERY)).shop.createdAt.slice(0, 10);
      if (args.includes('--full-history')) since = storeCreatedOn;
    }
    const plan = planOrdersSync({ since, grantedScopes: since ? await getGrantedScopes(loadShopifyConfigFromEnv()) : [] });
    if (!plan.ok) { console.error(JSON.stringify(plan)); process.exit(1); }
    const summary = await syncOrders({ shopify, supabase }, { merchantId, customerKeySecret: loadCustomerKeySecret(), since });
    console.log('orders sync summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 1;
    else await writeCoverage(nextCoverage(await readCoverage(), { plan, now: new Date(), storeCreatedOn }));
  }
}

main().catch((err) => {
  console.error('sync failed:', err);
  process.exit(1);
});
