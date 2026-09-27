// Analytics tenant (ADR 0003, step 6). Analytics serves ONE explicit Nordla merchant: NORDLA_MERCHANT_ID through the shared tenant
// resolver - never Shopify, never "the only merchant", never a created merchant. Its figures come from the data Core already synced
// into Nordla (Supabase), so Analytics works whether Shopify is configured, down or absent.
//
// The report files under reports/ (report-*.json, dataset.json) are a rebuildable cache: the generator stamps each file with the
// tenant it was built for, the server binds its reports directory to its tenant, and every reader serves a file only when the stamp
// matches. A file of another merchant (or an unstamped legacy file) is treated as missing, so it is rebuilt - never shown.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTenant, readMerchantIdFromEnv, isLegacyShopifyLookupEnabled } from '../../tenant/index.js';
import { createConnectorRepository } from '../../tenant/connectors.js';

export const SALES_CONNECTOR_KINDS = Object.freeze(['shopify', 'woocommerce', 'prestashop', 'odoo']);
const LEGACY_TIMEOUT_MS = 10_000;

/**
 * The Analytics tenant. The legacy Shopify lookup (merchant_connectors, never merchants.source_id) is offered to the resolver only when it
 * is explicitly enabled and no NORDLA_MERCHANT_ID is set; the Shopify modules are then imported lazily, so the normal path never loads them.
 */
export async function resolveAnalyticsTenant({ env = process.env, supabase, log = console.log, createClient = null } = {}) {
  let legacyShopify;
  if (!readMerchantIdFromEnv(env) && isLegacyShopifyLookupEnabled(env)) {
    const { hasShopifyCredentials, timeoutFetch } = await import('../../connectors/shopify.js');
    if (hasShopifyCredentials(env)) {
      const client = await import('../../shopify/client.js'); const { SHOP_QUERY } = await import('../../shopify/queries.js');
      const create = createClient ?? client.createShopifyClient;
      legacyShopify = { findShopId: async () => (await create(client.loadShopifyConfigFromEnv(env), { fetchImpl: timeoutFetch(LEGACY_TIMEOUT_MS) }).graphql(SHOP_QUERY))?.shop?.id };
    }
  }
  const tenant = await resolveTenant({ supabase, env, legacyShopify, legacyTimeoutMs: LEGACY_TIMEOUT_MS });
  log(`Analytics tenant: ${tenant.merchant.name} (tenant source = ${tenant.source})`);
  if (tenant.source === 'legacy_shopify') log('WARNING: tenant resolved through the legacy Shopify lookup (migration only) - set NORDLA_MERCHANT_ID.');
  return tenant;
}

/** The tenant's sales source, from merchant_connectors (no Shopify call): 'NONE' when the merchant has no sales connector at all. */
export async function salesSourceOf(supabase, merchantId) {
  const connectors = await createConnectorRepository({ supabase }).listForMerchant(merchantId);
  return connectors.some((c) => SALES_CONNECTOR_KINDS.includes(c.kind)) ? 'CONNECTED' : 'NONE';
}

// ---------- report files <-> tenant ----------
const bound = new Map(); // absolute reports directory -> merchant id
const dirKey = (dir) => path.resolve(dir instanceof URL ? fileURLToPath(dir) : String(dir));

/** The server binds its reports directory to its tenant once, at startup; from then on only that tenant's files are served from it. */
export function bindReportsTenant(reportsDir, merchantId) { bound.set(dirKey(reportsDir), merchantId); }
export function unbindReportsTenant(reportsDir) { bound.delete(dirKey(reportsDir)); }
export const reportsTenantOf = (reportsDir) => bound.get(dirKey(reportsDir)) ?? null;

/**
 * Cheap ownership check of reports/dataset.json for the refresher (every few minutes): the generator writes the tenant stamp FIRST, so
 * only the head of the (possibly large) file is read. Missing, unreadable, unstamped or foreign -> false (= rebuild it).
 */
export async function datasetOwnedBy(reportsDir, merchantId) {
  const { open } = await import('node:fs/promises');
  let fh;
  try {
    fh = await open(path.join(dirKey(reportsDir), 'dataset.json'), 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(512), 0, 512, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    return new RegExp(`^\\{"version":\\d+,"tenant":\\{"merchant_id":"${merchantId}"\\}`).test(head);
  } catch { return false; } finally { await fh?.close(); }
}

/** The stamp the generator writes into every report / dataset file. */
export const tenantStamp = (merchantId) => ({ merchant_id: merchantId });

/**
 * May this parsed report/dataset file be served from `reportsDir`? True when no tenant is bound to the directory (library use outside the
 * server) or when the file carries the bound tenant's stamp. An unstamped or foreign file is never served by a bound server.
 */
export function servesTenant(reportsDir, doc) {
  const merchantId = reportsTenantOf(reportsDir);
  return merchantId === null || doc?.tenant?.merchant_id === merchantId;
}
