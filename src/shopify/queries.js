// Read-only Admin GraphQL queries used by the sync modules. Kept as plain
// strings (no codegen) to match the project's minimal-tooling stance.

export const SHOP_QUERY = /* GraphQL */ `
  query {
    shop {
      id
      name
      myshopifyDomain
    }
  }
`;

export const LOCATIONS_QUERY = /* GraphQL */ `
  query {
    locations(first: 50) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  query ($cursor: String) {
    products(first: 50, after: $cursor, sortKey: ID) {
      edges {
        node {
          id
          title
          handle
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Inventory + cost are fetched together per variant page: they come from the
// same InventoryItem, so one page fetch serves both the inventory sync and
// the cost sync.
export const VARIANT_INVENTORY_COST_PAGE_QUERY = /* GraphQL */ `
  query ($cursor: String) {
    productVariants(first: 50, after: $cursor, sortKey: ID) {
      edges {
        node {
          id
          inventoryItem {
            unitCost {
              amount
              currencyCode
            }
            inventoryLevels(first: 10) {
              edges {
                node {
                  location {
                    id
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
