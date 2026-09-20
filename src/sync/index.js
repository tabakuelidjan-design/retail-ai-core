#!/usr/bin/env node
// Entry point: `node src/sync/index.js <catalog|inventory|cost|all>`
// No Claude/MCP dependency - reads config from env vars only. See
// .env.example and docs/security/shopify-auth.md before running for real.

import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { syncCatalog } from './catalog.js';
import { syncInventory } from './inventory.js';
import { syncProductCosts } from './cost.js';

async function main() {
  const mode = process.argv[2];
  if (!['catalog', 'inventory', 'cost', 'all'].includes(mode)) {
    console.error('Usage: node src/sync/index.js <catalog|inventory|cost|all>');
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

  if (mode === 'inventory' || mode === 'cost' || mode === 'all') {
    // inventory/cost need the local merchant id - re-derive it deterministically
    // from the same Shopify identity catalog sync used, rather than assuming
    // catalog just ran in this process.
    const { shop } = await shopify.graphql((await import('../shopify/queries.js')).SHOP_QUERY);
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
    const summary = await syncInventory({ shopify, supabase }, { merchantId });
    console.log('inventory sync summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 1;
  }

  if (mode === 'cost' || mode === 'all') {
    const summary = await syncProductCosts({ shopify, supabase }, { merchantId });
    console.log('cost sync summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('sync failed:', err);
  process.exit(1);
});
