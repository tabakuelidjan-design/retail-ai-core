// Real-world wiring shared by the CLI and the dashboard server: Shopify (read-only) + Supabase + Retail Core loading.
// Nothing here is used by tests, which inject in-memory stores instead.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { addDays } from '../metrics/windows.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { readCoverage } from '../sync/history.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { createRetailAccess } from './retail-access.js';
import { createSupabaseFinanceStore } from './supabase-store.js';

export async function createRuntime() {
  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  if (!merchant) throw new Error('No merchant found - run the sync first.');
  const retailConfig = mergeConfig(existsSync('data/local/marketing-policy.json') ? JSON.parse(await readFile('data/local/marketing-policy.json', 'utf8')) : {});
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const store = createSupabaseFinanceStore(supabase, { merchantId: merchant.id });

  const loadRetail = async (sinceDate) => {
    const since = new Date(`${sinceDate ?? addDays(new Date().toISOString().slice(0, 10), -400)}T00:00:00Z`);
    const data = await loadDataset(supabase, merchant.id, { since });
    return { data, ledger: buildLedger(data, { config: retailConfig }) };
  };
  const listOrderRefs = async () => {
    const rows = await supabase.selectAll('orders', { select: 'id,source_id', merchant_id: `eq.${merchant.id}` });
    return new Map(rows.map((r) => [r.id, String(r.source_id ?? '').split('/').pop()]));
  };
  const retail = createRetailAccess({ loadRetail, listOrderRefs });
  return { shopify, supabase, merchant, retailConfig, timeZone, store, retail, loadRetail, listOrderRefs, retailHistory: () => readCoverage() };
}
