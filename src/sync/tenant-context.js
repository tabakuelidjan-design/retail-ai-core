// Core sync identity (ADR 0003, step 5). The tenant comes from NORDLA_MERCHANT_ID through the shared tenant resolver - never from
// Shopify. Shopify is only this tenant's `shopify` connector: before any write, the shop behind the credentials must be the shop
// recorded on that connector (merchant_connectors.external_id). Nothing here creates, updates or re-assigns a merchant or a connector.
//
//   NORDLA_MERCHANT_ID -> tenant resolver -> merchant -> its shopify connector -> shop identity check -> sync (guarded writes)

import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { resolveTenant, readMerchantIdFromEnv, isLegacyShopifyLookupEnabled } from '../tenant/index.js';
import { createConnectorRepository } from '../tenant/connectors.js';
import { hasShopifyCredentials, timeoutFetch } from '../connectors/shopify.js';

// Per-request bound for the sync's Shopify calls (a page of orders can be slow; the sync had no bound at all before).
export const DEFAULT_SYNC_SHOPIFY_TIMEOUT_MS = 60_000;

/** A sync that must not write: `state` is the connector state (MISCONFIGURED / UNAVAILABLE), `reason` says why. Never carries a secret. */
export class SyncConnectorError extends Error {
  constructor(state, reason, { merchantId = null } = {}) {
    super(`Shopify connector is ${state} (${reason})`);
    this.name = 'SyncConnectorError'; this.code = state; this.state = state; this.reason = reason; this.merchantId = merchantId;
  }
}

/**
 * The Core tenant. NORDLA_MERCHANT_ID is the normal path; the legacy Shopify lookup is offered to the resolver only when it is explicitly
 * enabled (NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP) and no merchant id is set - and it resolves through merchant_connectors, never
 * merchants.source_id. Refused (TenantResolutionError) before any write when the tenant cannot be resolved.
 */
export async function resolveSyncTenant({ env = process.env, supabase, createClient = createShopifyClient, timeoutMs = DEFAULT_SYNC_SHOPIFY_TIMEOUT_MS, log = console.log }) {
  const legacyShopify = !readMerchantIdFromEnv(env) && isLegacyShopifyLookupEnabled(env) && hasShopifyCredentials(env)
    ? { findShopId: async () => (await createClient(loadShopifyConfigFromEnv(env), { fetchImpl: timeoutFetch(timeoutMs) }).graphql(SHOP_QUERY))?.shop?.id }
    : undefined;
  const tenant = await resolveTenant({ supabase, env, legacyShopify, legacyTimeoutMs: timeoutMs });
  log(`Core tenant: ${tenant.merchant.name} (tenant source = ${tenant.source})`);
  if (tenant.source === 'legacy_shopify') log('WARNING: tenant resolved through the legacy Shopify lookup (migration only) - set NORDLA_MERCHANT_ID.');
  return tenant;
}

/**
 * Checks the tenant's Shopify connector before a sync. Returns
 *   { state: 'NOT_CONFIGURED', reason }                      -> the Shopify job is skipped (no write, nothing invented)
 *   { state: 'MISCONFIGURED' | 'UNAVAILABLE', reason }      -> the sync must fail without writing data
 *   { state: 'CONFIGURED', shopify, context }               -> `context` is the validated identity every write is checked against
 */
export async function prepareShopifySync({ env = process.env, supabase, tenant, createClient = createShopifyClient, timeoutMs = DEFAULT_SYNC_SHOPIFY_TIMEOUT_MS }) {
  const merchantId = tenant.merchantId;
  const out = (state, reason) => ({ state, reason, merchantId });
  if (!hasShopifyCredentials(env)) return out('NOT_CONFIGURED', 'NO_SHOPIFY_CREDENTIALS');

  const connectors = createConnectorRepository({ supabase });
  const connector = await connectors.getForMerchant(merchantId, 'shopify');
  if (!connector) return out('MISCONFIGURED', 'NO_SHOPIFY_CONNECTOR_FOR_TENANT');
  if (connector.status === 'NOT_CONFIGURED') return out('NOT_CONFIGURED', 'CONNECTOR_NOT_CONFIGURED');
  if (connector.status !== 'CONFIGURED') return out('MISCONFIGURED', `CONNECTOR_STATUS_${connector.status}`);
  if (!connector.externalId) return out('MISCONFIGURED', 'CONNECTOR_WITHOUT_EXTERNAL_ID');

  const shopify = createClient(loadShopifyConfigFromEnv(env), { fetchImpl: timeoutFetch(timeoutMs) });
  let shop;
  try { shop = (await shopify.graphql(SHOP_QUERY))?.shop; } catch (e) { return out('UNAVAILABLE', e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'SHOPIFY_ERROR'); }
  if (!shop?.id) return out('UNAVAILABLE', 'NO_SHOP_IDENTITY');
  if (shop.id !== connector.externalId) {
    // Only to explain the refusal: a shop linked to another merchant is NEVER used to switch tenant or to write.
    const owner = await connectors.findMerchantByExternal('shopify', shop.id).catch(() => null);
    return out('MISCONFIGURED', owner && owner.merchantId !== merchantId ? 'SHOP_LINKED_TO_ANOTHER_MERCHANT' : 'SHOP_NOT_LINKED_TO_TENANT');
  }
  const context = Object.freeze({ merchantId, connectorId: connector.id, kind: 'shopify', externalId: connector.externalId, shop: Object.freeze({ id: shop.id, name: shop.name ?? null, domain: shop.myshopifyDomain ?? null }) });
  return { state: 'CONFIGURED', reason: null, merchantId, shopify, context };
}
