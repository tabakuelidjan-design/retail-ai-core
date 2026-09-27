// Tenant + optional Shopify for the Nordla command-line tools (buying, customers, marketing - ADR 0003, step 7).
//   resolveToolTenant: NORDLA_MERCHANT_ID through the shared resolver. The legacy Shopify lookup (explicit flag, merchant_connectors,
//     logged) is the only other path; Shopify modules are imported lazily, only then. Never "the only merchant", never a created merchant.
//   openShopifyForTenant: for a feature that REALLY needs Shopify data: merchant -> its shopify connector (merchant_connectors) -> the
//     shop behind the credentials must be that connector's shop -> a guarded client. States, never a guess:
//       NOT_CONFIGURED (no credentials or no shopify connector) / MISCONFIGURED (wrong shop, connector status) / UNAVAILABLE / CONFIGURED.
// Nothing here writes anything.

import { resolveTenant, readMerchantIdFromEnv, isLegacyShopifyLookupEnabled } from './index.js';
import { createConnectorRepository } from './connectors.js';

const LEGACY_TIMEOUT_MS = 10_000;
const SHOPIFY_ENV = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
const hasShopifyCredentials = (env) => SHOPIFY_ENV.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');

/**
 * @param {{ env?: object, supabase: object, tool: string, log?: Function, createClient?: Function|null }} deps
 * @returns {Promise<{ merchantId: string, merchant: object, source: string }>}
 */
export async function resolveToolTenant({ env = process.env, supabase, tool, log = console.error, createClient = null }) {
  let legacyShopify;
  if (!readMerchantIdFromEnv(env) && isLegacyShopifyLookupEnabled(env) && hasShopifyCredentials(env)) {
    const client = await import('../shopify/client.js'); const { SHOP_QUERY } = await import('../shopify/queries.js');
    const { timeoutFetch } = await import('../connectors/shopify.js');
    const create = createClient ?? client.createShopifyClient;
    legacyShopify = { findShopId: async () => (await create(client.loadShopifyConfigFromEnv(env), { fetchImpl: timeoutFetch(LEGACY_TIMEOUT_MS) }).graphql(SHOP_QUERY))?.shop?.id };
  }
  const tenant = await resolveTenant({ supabase, env, legacyShopify, legacyTimeoutMs: LEGACY_TIMEOUT_MS });
  log(`${tool} tenant: ${tenant.merchant.name} (tenant source = ${tenant.source})`);
  if (tenant.source === 'legacy_shopify') log('WARNING: tenant resolved through the legacy Shopify lookup (migration only) - set NORDLA_MERCHANT_ID.');
  return tenant;
}

/**
 * The tenant's verified Shopify, for a feature that needs it. Returns { state, reason, shopify } - `shopify` (a guarded client with
 * graphql()) only when state is CONFIGURED; every other state means: do not call Shopify, and say so.
 */
export async function openShopifyForTenant({ env = process.env, supabase, merchantId, createClient = null, timeoutMs }) {
  if (!hasShopifyCredentials(env)) return { state: 'NOT_CONFIGURED', reason: 'NO_SHOPIFY_CREDENTIALS', shopify: null };
  const connectors = createConnectorRepository({ supabase });
  const own = (await connectors.listForMerchant(merchantId)).filter((c) => c.kind === 'shopify');
  if (!own.length) return { state: 'NOT_CONFIGURED', reason: 'NO_SHOPIFY_CONNECTOR_FOR_TENANT', shopify: null };
  const { createShopifyConnector } = await import('../connectors/shopify.js');
  const connector = createShopifyConnector({ env, merchantId, connectors, ...(createClient ? { createClient } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const state = await connector.state({ verify: true });
  return { state, reason: connector.describe().reason, shopify: state === 'CONFIGURED' ? connector : null };
}
