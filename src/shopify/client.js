// Minimal Shopify Admin GraphQL client. No SDK dependency - just fetch.
// Read-only by contract: this module never issues a mutation. If a future
// change needs one, it belongs in its own reviewed module, not here.
//
// Auth: apps created via the Shopify Dev Dashboard (mandatory for all new
// custom apps since 2026-01-01) authenticate with the OAuth 2.0 client
// credentials grant - there is no long-lived static token to copy from the
// UI anymore. See docs/security/shopify-auth.md for the full explanation
// and setup steps.

export class ShopifyConfigError extends Error {}

export function loadShopifyConfigFromEnv(env = process.env) {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  const apiVersion = env.SHOPIFY_API_VERSION || '2024-10';

  if (!shopDomain) throw new ShopifyConfigError('SHOPIFY_SHOP_DOMAIN is not set');
  if (!clientId) throw new ShopifyConfigError('SHOPIFY_CLIENT_ID is not set');
  if (!clientSecret) throw new ShopifyConfigError('SHOPIFY_CLIENT_SECRET is not set');

  return { shopDomain, clientId, clientSecret, apiVersion };
}

// Refresh this many seconds before actual expiry, so a slow request never
// straddles the token's real cutoff.
const TOKEN_REFRESH_SKEW_SECONDS = 60;

/**
 * Exchanges client_id/client_secret for a short-lived Admin API access
 * token via the client credentials grant. Only works when the app and the
 * target store are in the same Shopify organization (Dev Dashboard apps
 * are org-scoped by design).
 */
async function requestAccessToken(config, fetchImpl) {
  const res = await fetchImpl(`https://${config.shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Deliberately not including client_secret in the error - it's already
    // in the request, but never echo it back into logs.
    throw new Error(`Shopify token exchange HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Shopify token exchange succeeded but returned no access_token');
  }
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in ?? 0 };
}

/**
 * Create a Shopify Admin GraphQL client bound to one shop, using the client
 * credentials grant. Tokens are fetched lazily and cached in memory only -
 * never persisted, never logged.
 * @param {{shopDomain: string, clientId: string, clientSecret: string, apiVersion: string}} config
 * @param {{fetchImpl?: typeof fetch}} [deps] injectable fetch for tests
 */
export function createShopifyClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = `https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`;

  let cachedToken = null;
  let cachedTokenExpiresAt = 0; // epoch ms

  async function getValidAccessToken() {
    const now = Date.now();
    if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

    const { accessToken, expiresInSeconds } = await requestAccessToken(config, fetchImpl);
    cachedToken = accessToken;
    cachedTokenExpiresAt = now + Math.max(0, expiresInSeconds - TOKEN_REFRESH_SKEW_SECONDS) * 1000;
    return cachedToken;
  }

  async function graphql(query, variables = {}) {
    const accessToken = await getValidAccessToken();

    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Shopify GraphQL HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  return { graphql };
}
