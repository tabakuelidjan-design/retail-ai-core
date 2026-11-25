// Shopify as an OPTIONAL connector of a Nordla tenant (ADR 0003 section 5.1). Nothing here runs at construction: Shopify is
// contacted only when a feature that really needs it asks, and every call is bounded by a timeout.
//
// Credentials, in this order, for the tenant passed in:
//   1. the merchant's own OAuth connection (credentialsFor: Vault token + its shop)             -> source 'oauth'
//   2. the legacy global SHOPIFY_* setup, ONLY for the merchant named by SHOPIFY_LEGACY_MERCHANT_ID -> source 'legacy'
//   3. nothing                                                                                    -> NOT_CONFIGURED (SHOPIFY_NOT_CONNECTED)
// Before the first real use the connector checks that the shop behind the credentials is one of THIS tenant's `shopify` connectors
// (merchant_connectors); otherwise it is MISCONFIGURED and every Shopify feature is refused. States are reported, never written.

import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { globalShopifySetupFor } from '../shopify/global-setup.js';

export const SHOPIFY_CREDENTIAL_ENV = Object.freeze(['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']);
export const DEFAULT_SHOPIFY_TIMEOUT_MS = 8_000;
export const DEFAULT_RECHECK_AFTER_MS = 60_000;
// A CONFIGURED verification is trusted this long, then re-checked on the next real use (lazy: no timer, no polling).
export const DEFAULT_CONFIGURED_TTL_MS = 5 * 60_000;

/** True when the Shopify credentials are all present (they configure the legacy connector; they never identify the tenant). */
export const hasShopifyCredentials = (env = process.env) => SHOPIFY_CREDENTIAL_ENV.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');

/** Raised when a Shopify feature is used while the connector is not CONFIGURED. `state` says why. */
export class ShopifyConnectorStateError extends Error {
  constructor(state, reason = null) { super(`Shopify connector is ${state}`); this.name = 'ShopifyConnectorStateError'; this.code = state; this.state = state; this.reason = reason; }
}

/** fetch that gives up after `ms` (AbortSignal.timeout), so a hanging Shopify can never hold a request or the process. */
export const timeoutFetch = (ms, fetchImpl = fetch) => (url, opts = {}) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(ms) });

/** True when a Shopify path exists for THIS merchant: its own OAuth connection is CONFIGURED, or the declared global setup applies. No Shopify call. */
export async function shopifyPathAvailable({ env = process.env, merchantId, credentialsFor = null }) {
  if (credentialsFor) {
    const c = await credentialsFor(merchantId);
    if (c?.state === 'CONFIGURED') return true;
    if (c?.state && c.state !== 'NOT_CONNECTED') return false;
  }
  return globalShopifySetupFor(env, merchantId) && hasShopifyCredentials(env);
}

// What the per-merchant resolver says -> what this connector reports.
const REFUSAL = Object.freeze({
  NOT_CONNECTED: 'NOT_CONFIGURED', NOT_CONFIGURED: 'NOT_CONFIGURED', AMBIGUOUS: 'MISCONFIGURED', MISCONFIGURED: 'MISCONFIGURED',
  MISSING_SCOPES: 'MISCONFIGURED', REAUTH_REQUIRED: 'REAUTH_REQUIRED', UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * @param {{
 *   env?: Record<string, string|undefined>, merchantId: string,
 *   connectors: { listForMerchant(merchantId: string): Promise<Array<{kind: string, externalId: string|null, status: string}>> },
 *   credentialsFor?: (merchantId: string) => Promise<object>,   // per-merchant OAuth credentials (shopify-credentials.js)
 *   createClient?: typeof createShopifyClient, fetchImpl?: typeof fetch, timeoutMs?: number, recheckAfterMs?: number,
 *   configuredTtlMs?: number, nowMs?: () => number,
 * }} options
 */
export function createShopifyConnector({
  env = process.env, merchantId, connectors, credentialsFor = null, createClient = createShopifyClient, fetchImpl = fetch,
  timeoutMs = DEFAULT_SHOPIFY_TIMEOUT_MS, recheckAfterMs = DEFAULT_RECHECK_AFTER_MS, configuredTtlMs = DEFAULT_CONFIGURED_TTL_MS, nowMs = Date.now,
}) {
  if (!merchantId) throw new TypeError('createShopifyConnector needs an explicit merchantId: there is no default shop');
  const legacyUsable = globalShopifySetupFor(env, merchantId) && hasShopifyCredentials(env);
  const configured = Boolean(credentialsFor) || legacyUsable; // without any path, Shopify is simply not connected
  let activeSource = null; // 'oauth' | 'legacy', set by the last resolution
  let authFailed = false; // Shopify answered 401: the token (or the credentials) is no longer accepted
  let httpDown = false; // the last answer was a 5xx or a 404
  let verified = null; // { state, reason, shopId?, at }
  let inFlight = null;
  let client = null;
  let clientKey = null; // one client per (source, shop, token): a rotated token gets a new client

  const watchedFetch = (url, opts) => timeoutFetch(timeoutMs, fetchImpl)(url, opts).then((res) => {
    if (res?.status === 401) authFailed = true;
    httpDown = res?.status >= 500 || res?.status === 404;
    return res;
  });

  /** Resolves the credentials of THIS merchant. Never falls back to another merchant's connection. */
  async function resolveConfig() {
    if (credentialsFor) {
      const c = await credentialsFor(merchantId);
      if (c?.state === 'CONFIGURED') return { source: 'oauth', config: { shopDomain: c.shopDomain, apiVersion: c.apiVersion, accessToken: c.accessToken } };
      if (c?.state && c.state !== 'NOT_CONNECTED') throw new ShopifyConnectorStateError(REFUSAL[c.state] ?? 'UNAVAILABLE', c.reason ?? c.state);
    }
    if (legacyUsable) return { source: 'legacy', config: loadShopifyConfigFromEnv(env) };
    throw new ShopifyConnectorStateError('NOT_CONFIGURED', 'SHOPIFY_NOT_CONNECTED');
  }

  /** The client for resolved credentials. Built only when they are used; a rotated token gets a new client. */
  function clientFor({ source, config }) {
    activeSource = source;
    const key = `${source}|${config.shopDomain}|${config.accessToken ?? ''}`;
    if (!client || clientKey !== key) { client = createClient(config, { fetchImpl: watchedFetch }); clientKey = key; }
    return client;
  }

  /** After an auth failure the client is dropped, so the next use resolves (and may rotate) the credentials again. */
  const onFailure = (e) => {
    if (authFailed) { client = null; clientKey = null; authFailed = false; return { state: 'UNAVAILABLE', reason: 'AUTH_FAILED' }; }
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : e instanceof TypeError || httpDown ? 'SHOPIFY_UNREACHABLE' : 'SHOPIFY_ERROR';
    httpDown = false;
    return { state: 'UNAVAILABLE', reason };
  };
  const withTimeout = (p) => {
    let t;
    return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('Shopify timeout'), { name: 'TimeoutError' })), timeoutMs); })]).finally(() => clearTimeout(t));
  };

  async function verify() {
    // 1. does this merchant have ANY Shopify path (its own connection, or the declared global setup)? No client is built here.
    let cfg;
    try { cfg = await resolveConfig(); } catch (e) {
      if (e instanceof ShopifyConnectorStateError) return { state: e.state, reason: e.reason };
      return onFailure(e);
    }
    // 2. which shops belong to this tenant (a Supabase read, no Shopify call)
    const shops = (await connectors.listForMerchant(merchantId)).filter((x) => x.kind === 'shopify' && x.externalId);
    if (!shops.length) return { state: 'MISCONFIGURED', reason: 'NO_SHOPIFY_CONNECTOR_FOR_TENANT' };
    // 3. which shop the credentials open (bounded Shopify call)
    const c = clientFor(cfg);
    let shopId;
    try { shopId = (await withTimeout(c.graphql(SHOP_QUERY)))?.shop?.id; } catch (e) { return onFailure(e); }
    const link = shops.find((x) => x.externalId === shopId);
    if (!link) return { state: 'MISCONFIGURED', reason: 'SHOP_NOT_LINKED_TO_TENANT' };
    if (link.status !== 'CONFIGURED') return { state: link.status, reason: 'CONNECTOR_STATUS', shopId };
    return { state: 'CONFIGURED', reason: null, shopId };
  }

  /** Current state. With `verify`, runs (or refreshes) the verification when needed; without it, never contacts Shopify. */
  async function state({ verify: doVerify = false } = {}) {
    if (!configured) return 'NOT_CONFIGURED';
    const stale = !verified || nowMs() - verified.at >= (verified.state === 'CONFIGURED' ? configuredTtlMs : recheckAfterMs);
    if (doVerify && stale) {
      inFlight ??= verify().then((v) => { verified = { ...v, at: nowMs() }; return verified; }).finally(() => { inFlight = null; });
      await inFlight;
    }
    return verified ? verified.state : 'CONFIGURED';
  }

  /** Shopify GraphQL for a feature that needs it: refused unless CONFIGURED; a network, HTTP 5xx/404 or auth failure marks it UNAVAILABLE. */
  async function graphql(query, variables) {
    const s = await state({ verify: true });
    if (s !== 'CONFIGURED') throw new ShopifyConnectorStateError(s, verified?.reason ?? null);
    const c = clientFor(await resolveConfig());
    try {
      return await withTimeout(c.graphql(query, variables));
    } catch (e) {
      if (authFailed || httpDown || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError) verified = { ...onFailure(e), at: nowMs() };
      throw e;
    }
  }

  return {
    kind: 'shopify',
    configured,
    state,
    graphql,
    /** 'oauth' only when this merchant's own connection is in use. Stock WRITES are never enabled for 'oauth' in V1 (see Finance). */
    source: () => activeSource,
    describe: () => ({
      kind: 'shopify', configured, source: activeSource, state: configured ? (verified?.state ?? 'UNVERIFIED') : 'NOT_CONFIGURED', reason: verified?.reason ?? null,
    }),
  };
}
