// Shopify as an OPTIONAL connector of a Nordla tenant (ADR 0003 section 5.1). Nothing here runs at construction: Shopify is
// contacted only when a feature that really needs it asks (catalogue prices, stock adjustments), and every call is bounded by
// a timeout. Before the first real use the connector checks that the shop behind the credentials is one of THIS tenant's
// `shopify` connectors (merchant_connectors); otherwise it is MISCONFIGURED and every Shopify feature is refused - the rest of
// the module keeps working. States are reported, never written (verification results belong to a later connector-status layer).

import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';

export const SHOPIFY_CREDENTIAL_ENV = Object.freeze(['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']);
export const DEFAULT_SHOPIFY_TIMEOUT_MS = 8_000;
export const DEFAULT_RECHECK_AFTER_MS = 60_000;

/** True when the Shopify credentials are all present (they configure the connector; they never identify the tenant). */
export const hasShopifyCredentials = (env = process.env) => SHOPIFY_CREDENTIAL_ENV.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');

/** Raised when a Shopify feature is used while the connector is not CONFIGURED. `state` says why. */
export class ShopifyConnectorStateError extends Error {
  constructor(state, reason = null) { super(`Shopify connector is ${state}`); this.name = 'ShopifyConnectorStateError'; this.code = state; this.state = state; this.reason = reason; }
}

/** fetch that gives up after `ms` (AbortSignal.timeout), so a hanging Shopify can never hold a request or the process. */
export const timeoutFetch = (ms, fetchImpl = fetch) => (url, opts = {}) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(ms) });

/**
 * @param {{
 *   env?: Record<string, string|undefined>, merchantId: string,
 *   connectors: { listForMerchant(merchantId: string): Promise<Array<{kind: string, externalId: string|null, status: string}>> },
 *   createClient?: typeof createShopifyClient, timeoutMs?: number, recheckAfterMs?: number, nowMs?: () => number,
 * }} options
 */
export function createShopifyConnector({ env = process.env, merchantId, connectors, createClient = createShopifyClient, timeoutMs = DEFAULT_SHOPIFY_TIMEOUT_MS, recheckAfterMs = DEFAULT_RECHECK_AFTER_MS, nowMs = Date.now }) {
  const configured = hasShopifyCredentials(env);
  let client = null; // built on first real use only
  let verified = null; // { state, reason, shopId?, at }
  let inFlight = null;

  const getClient = () => { client ??= createClient(loadShopifyConfigFromEnv(env), { fetchImpl: timeoutFetch(timeoutMs) }); return client; };
  const withTimeout = (p) => {
    let t;
    return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('Shopify timeout'), { name: 'TimeoutError' })), timeoutMs); })]).finally(() => clearTimeout(t));
  };

  async function verify() {
    // 1. which shops belong to this tenant (a Supabase read, no Shopify call)
    const shops = (await connectors.listForMerchant(merchantId)).filter((c) => c.kind === 'shopify' && c.externalId);
    if (!shops.length) return { state: 'MISCONFIGURED', reason: 'NO_SHOPIFY_CONNECTOR_FOR_TENANT' };
    // 2. which shop the credentials open (bounded Shopify call)
    let shopId;
    try { shopId = (await withTimeout(getClient().graphql(SHOP_QUERY)))?.shop?.id; } catch (e) { return { state: 'UNAVAILABLE', reason: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'SHOPIFY_ERROR' }; }
    const link = shops.find((c) => c.externalId === shopId);
    if (!link) return { state: 'MISCONFIGURED', reason: 'SHOP_NOT_LINKED_TO_TENANT' };
    if (link.status !== 'CONFIGURED') return { state: link.status, reason: 'CONNECTOR_STATUS', shopId };
    return { state: 'CONFIGURED', reason: null, shopId };
  }

  /** Current state. With `verify`, runs (or refreshes) the verification when needed; without it, never contacts Shopify. */
  async function state({ verify: doVerify = false } = {}) {
    if (!configured) return 'NOT_CONFIGURED';
    const stale = !verified || (verified.state !== 'CONFIGURED' && nowMs() - verified.at >= recheckAfterMs);
    if (doVerify && stale) {
      inFlight ??= verify().then((v) => { verified = { ...v, at: nowMs() }; return verified; }).finally(() => { inFlight = null; });
      await inFlight;
    }
    return verified ? verified.state : 'CONFIGURED';
  }

  /** Shopify GraphQL for a feature that needs it: refused unless CONFIGURED; a network failure marks the connector UNAVAILABLE. */
  async function graphql(query, variables) {
    const s = await state({ verify: true });
    if (s !== 'CONFIGURED') throw new ShopifyConnectorStateError(s, verified?.reason ?? null);
    try {
      return await withTimeout(getClient().graphql(query, variables));
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError) verified = { state: 'UNAVAILABLE', reason: 'SHOPIFY_UNREACHABLE', at: nowMs() };
      throw e;
    }
  }

  return { kind: 'shopify', configured, state, graphql, describe: () => ({ kind: 'shopify', configured, state: configured ? (verified?.state ?? 'UNVERIFIED') : 'NOT_CONFIGURED', reason: verified?.reason ?? null }) };
}
