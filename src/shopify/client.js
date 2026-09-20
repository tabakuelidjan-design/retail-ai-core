// Minimal Shopify Admin GraphQL client. No SDK dependency - just fetch.
// Read-only by contract: this module never issues a mutation. If a future
// change needs one, it belongs in its own reviewed module, not here.

export class ShopifyConfigError extends Error {}

export function loadShopifyConfigFromEnv(env = process.env) {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = env.SHOPIFY_API_VERSION || '2024-10';

  if (!shopDomain) throw new ShopifyConfigError('SHOPIFY_SHOP_DOMAIN is not set');
  if (!accessToken) throw new ShopifyConfigError('SHOPIFY_ADMIN_ACCESS_TOKEN is not set');

  return { shopDomain, accessToken, apiVersion };
}

/**
 * Create a Shopify Admin GraphQL client bound to one shop.
 * @param {{shopDomain: string, accessToken: string, apiVersion: string}} config
 */
export function createShopifyClient(config) {
  const endpoint = `https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`;

  async function graphql(query, variables = {}) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': config.accessToken,
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
