// Tenant + optional Shopify for the Nordla command-line tools (buying, customers, marketing - ADR 0003, step 7).
//   resolveToolTenant: NORDLA_MERCHANT_ID through the shared resolver - the only path (C6-F). Never Shopify, never "the only
//     merchant", never a created merchant.
//   openShopifyForTenant: for a feature that REALLY needs Shopify data: merchant -> its shopify connector (merchant_connectors) -> the
//     shop behind the credentials must be that connector's shop -> a guarded client. States, never a guess:
//       NOT_CONFIGURED (no credentials or no shopify connector) / MISCONFIGURED (wrong shop, connector status) / UNAVAILABLE / CONFIGURED.
// Nothing here writes anything.

import { resolveTenant } from './index.js';
import { createConnectorRepository } from './connectors.js';

const SHOPIFY_ENV = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
const hasShopifyCredentials = (env) => SHOPIFY_ENV.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');

/**
 * @param {{ env?: object, supabase: object, tool: string, log?: Function }} deps
 * @returns {Promise<{ merchantId: string, merchant: object, source: string }>}
 */
export async function resolveToolTenant({ env = process.env, supabase, tool, log = console.error }) {
  const tenant = await resolveTenant({ supabase, env });
  log(`${tool} tenant: ${tenant.merchant.name} (tenant source = ${tenant.source})`);
  return tenant;
}

/**
 * The tenant's verified Shopify, for a feature that needs it. Returns { state, reason, shopify } - `shopify` (a guarded client with
 * graphql()) only when state is CONFIGURED; every other state means: do not call Shopify, and say so.
 */
export async function openShopifyForTenant({ env = process.env, supabase, merchantId, createClient = null, timeoutMs, credentialsFor = null }) {
  // No default shop: the merchant must be stated, and it is the only one whose Shopify is read.
  if (typeof merchantId !== 'string' || !merchantId.trim()) throw new TypeError('openShopifyForTenant needs an explicit merchantId: there is no default shop');
  const connectors = createConnectorRepository({ supabase });
  // No Shopify connection row for this merchant at all: not connected (the tool says so, and never calls Shopify).
  if (!(await connectors.listForMerchant(merchantId)).some((c) => c.kind === 'shopify')) return { state: 'NOT_CONFIGURED', reason: 'NO_SHOPIFY_CONNECTOR_FOR_TENANT', shopify: null };
  const { createShopifyConnector } = await import('../connectors/shopify.js');
  const { createShopifyCredentialResolver } = await import('../provider-connections/shopify-credentials.js');
  const { createProviderConnectionsRuntime } = await import('../provider-connections/runtime.js');
  const resolver = credentialsFor ?? createShopifyCredentialResolver({ connectorRepository: connectors, tokenManagerFor: () => createProviderConnectionsRuntime({ supabase, env }).tokenManager });
  const connector = createShopifyConnector({ env, merchantId, connectors, credentialsFor: resolver, ...(createClient ? { createClient } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const state = await connector.state({ verify: true });
  return { state, reason: connector.describe().reason, shopify: state === 'CONFIGURED' ? connector : null };
}
