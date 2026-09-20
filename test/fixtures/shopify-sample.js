// Synthetic fixture data only - no real HABB catalog/inventory/order data.
// Shapes mirror real Shopify Admin GraphQL responses closely enough to
// exercise the sync modules, but every id/title/value here is made up.

export const FAKE_SHOP = {
  id: 'gid://shopify/Shop/1',
  name: 'Fixture Test Shop',
  myshopifyDomain: 'fixture-test-shop.myshopify.com',
};

export const FAKE_LOCATION = { id: 'gid://shopify/Location/1', name: 'Fixture Store' };

// Product A: two color variants, no SKU on either (mirrors real HABB pattern
// where many variants have sku: null).
export const FAKE_PRODUCT_A = {
  id: 'gid://shopify/Product/1',
  title: 'Fixture Widget',
  handle: 'fixture-widget',
  variants: {
    edges: [
      { node: { id: 'gid://shopify/ProductVariant/1', title: 'Red', sku: null } },
      { node: { id: 'gid://shopify/ProductVariant/2', title: 'Blue', sku: null } },
    ],
  },
};

// Product B: single variant, SKU deliberately reused from Product C below -
// mirrors the real duplicate-SKU pattern found in HABB data.
export const FAKE_PRODUCT_B = {
  id: 'gid://shopify/Product/2',
  title: 'Fixture Gadget',
  handle: 'fixture-gadget',
  variants: {
    edges: [{ node: { id: 'gid://shopify/ProductVariant/3', title: 'Default Title', sku: 'DUP-001' } }],
  },
};

export const FAKE_PRODUCT_C = {
  id: 'gid://shopify/Product/3',
  title: 'Fixture Gizmo',
  handle: 'fixture-gizmo',
  variants: {
    edges: [{ node: { id: 'gid://shopify/ProductVariant/4', title: 'Default Title', sku: 'DUP-001' } }],
  },
};

export const FAKE_PRODUCTS_PAGE = {
  products: {
    edges: [{ node: FAKE_PRODUCT_A }, { node: FAKE_PRODUCT_B }, { node: FAKE_PRODUCT_C }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

// Inventory/cost fixture: variant 1 has a real cost + stock; variant 2 has
// no cost at all (must stay UNCLASSIFIED); variant 3 has zero stock.
export const FAKE_INVENTORY_COST_PAGE = {
  productVariants: {
    edges: [
      {
        node: {
          id: 'gid://shopify/ProductVariant/1',
          inventoryItem: {
            unitCost: { amount: '5.00', currencyCode: 'EUR' },
            inventoryLevels: {
              edges: [
                {
                  node: {
                    location: { id: 'gid://shopify/Location/1' },
                    quantities: [{ name: 'available', quantity: 10 }],
                  },
                },
              ],
            },
          },
        },
      },
      {
        node: {
          id: 'gid://shopify/ProductVariant/2',
          inventoryItem: {
            unitCost: null,
            inventoryLevels: {
              edges: [
                {
                  node: {
                    location: { id: 'gid://shopify/Location/1' },
                    quantities: [{ name: 'available', quantity: 3 }],
                  },
                },
              ],
            },
          },
        },
      },
      {
        node: {
          id: 'gid://shopify/ProductVariant/3',
          inventoryItem: {
            unitCost: { amount: '2.50', currencyCode: 'EUR' },
            inventoryLevels: {
              edges: [
                {
                  node: {
                    location: { id: 'gid://shopify/Location/1' },
                    quantities: [{ name: 'available', quantity: 0 }],
                  },
                },
              ],
            },
          },
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};
