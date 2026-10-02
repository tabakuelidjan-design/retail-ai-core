// Real-world wiring shared by the CLI and the dashboard server: tenant (Nordla identity) + Supabase + Retail Core loading, and
// Shopify as an OPTIONAL connector. The tenant comes from the shared resolver (ADR 0003): NORDLA_MERCHANT_ID, or - only during
// the migration and only when NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP is explicitly on - the legacy Shopify lookup through
// merchant_connectors. Nothing here contacts Shopify on the normal path.
// Tests inject `supabase` / `createShopifyClient` / `log`; production passes nothing.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { localMidnight } from '../metrics/windows.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { readCoverage } from '../sync/history.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { isLegacyShopifyLookupEnabled, readMerchantIdFromEnv, resolveTenant } from '../tenant/index.js';
import { createConnectorRepository } from '../tenant/connectors.js';
import { createShopifyConnector, hasShopifyCredentials, timeoutFetch, DEFAULT_SHOPIFY_TIMEOUT_MS } from '../connectors/shopify.js';
import { createRetailAccess } from './retail-access.js';
import { createSupabaseFinanceStore } from './supabase-store.js';

/** Sales-source connector kinds: their presence means the merchant's sales come from a synced source. */
export const SALES_CONNECTOR_KINDS = Object.freeze(['shopify', 'woocommerce', 'prestashop', 'odoo']);

/**
 * The Finance tenant, shared by the dashboard and the CLI: the resolver with, only when it may be used (legacy flag on, no
 * NORDLA_MERCHANT_ID, Shopify credentials present), the legacy Shopify shop reader - built lazily, bounded by a timeout.
 * Logs the tenant and its source (never a secret).
 */
export async function resolveFinanceTenant({ env = process.env, supabase, createShopifyClient: createClient = createShopifyClient, log = console.log, shopifyTimeoutMs = DEFAULT_SHOPIFY_TIMEOUT_MS }) {
  const legacyShopify = !readMerchantIdFromEnv(env) && isLegacyShopifyLookupEnabled(env) && hasShopifyCredentials(env)
    ? { findShopId: async () => (await createClient(loadShopifyConfigFromEnv(env), { fetchImpl: timeoutFetch(shopifyTimeoutMs) }).graphql(SHOP_QUERY))?.shop?.id }
    : undefined;
  const tenant = await resolveTenant({ supabase, env, legacyShopify, legacyTimeoutMs: shopifyTimeoutMs });
  log(`Finance tenant: ${tenant.merchant.name} (tenant source = ${tenant.source})`);
  if (tenant.source === 'legacy_shopify') log('WARNING: tenant resolved through the legacy Shopify lookup (migration only) - set NORDLA_MERCHANT_ID.');
  return tenant;
}

/**
 * @param {{ env?: Record<string, string|undefined>, supabase?: object, createShopifyClient?: typeof createShopifyClient,
 *           log?: (line: string) => void, shopifyTimeoutMs?: number }} [deps]
 */
export async function createRuntime({ env = process.env, supabase: injectedSupabase, createShopifyClient: createClient = createShopifyClient, log = console.log, shopifyTimeoutMs = DEFAULT_SHOPIFY_TIMEOUT_MS } = {}) {
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  const connectors = createConnectorRepository({ supabase });
  const tenant = await resolveFinanceTenant({ env, supabase, createShopifyClient: createClient, log, shopifyTimeoutMs });
  const merchant = { id: tenant.merchantId, name: tenant.merchant.name };

  // Optional Shopify connector: never contacted here; it verifies its shop against this tenant on first real use.
  const shopify = createShopifyConnector({ env, merchantId: merchant.id, connectors, createClient, timeoutMs: shopifyTimeoutMs });

  const retailConfig = mergeConfig(existsSync('data/local/marketing-policy.json') ? JSON.parse(await readFile('data/local/marketing-policy.json', 'utf8')) : {});
  const timeZone = env.MERCHANT_TIMEZONE || 'UTC';
  const store = createSupabaseFinanceStore(supabase, { merchantId: merchant.id });

  const loadRetail = async (sinceDate) => {
    // Lower bound of the load: the start of the merchant's first day (local midnight), else an instant 400 days back (a technical look-back, not a business date).
    const since = sinceDate ? localMidnight(sinceDate, timeZone) : new Date(Date.now() - 400 * 86_400_000);
    const data = await loadDataset(supabase, merchant.id, { since });
    return { data, ledger: buildLedger(data, { config: retailConfig }) };
  };
  const listOrderRefs = async () => {
    const rows = await supabase.selectAll('orders', { select: 'id,source_id', merchant_id: `eq.${merchant.id}` });
    return new Map(rows.map((r) => [r.id, String(r.source_id ?? '').split('/').pop()]));
  };
  /** True when the merchant has at least one sales-source connector (a Supabase read, no provider call). */
  // The tenant's sales source, as the sync pill shows it: NONE (no sales connector at all), NOT_CONFIGURED (only connectors that
  // Finance runs itself and whose credentials are missing here - Shopify), ACTIVE otherwise.
  const salesSource = async () => {
    const kinds = new Set((await connectors.listForMerchant(merchant.id)).map((c) => c.kind).filter((k) => SALES_CONNECTOR_KINDS.includes(k)));
    if (!kinds.size) return 'NONE';
    return [...kinds].some((k) => (k === 'shopify' ? shopify.configured : true)) ? 'ACTIVE' : 'NOT_CONFIGURED';
  };
  const hasSalesSource = async () => (await salesSource()) !== 'NONE';
  const retail = createRetailAccess({ loadRetail, listOrderRefs, timeZone });
  return { shopify, supabase, merchant, tenant, connectors, salesSource, hasSalesSource, retailConfig, timeZone, store, retail, loadRetail, listOrderRefs, retailHistory: () => readCoverage() };
}
