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
          productType
          createdAt
          status
          featuredImage {
            url
            altText
          }
          collections(first: 25) {
            edges {
              node {
                id
                title
              }
            }
            pageInfo {
              hasNextPage
            }
          }
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

// Orders + order lines + refunds + refund lines fetched together per order
// page. `query` is a Shopify search-string variable (e.g.
// "created_at:>=2026-07-22") - the caller supplies the 60-day window filter;
// this module never assumes it can see older orders (Order object caps
// access at 60 days without read_all_orders, which this project does not
// request - see docs/architecture/orders-refunds-sync.md).
//
// Deliberately NOT fetched: any customer name/email/phone/address field.
// The only customer field ever requested is the opaque id, in the opt-in variant below, and it is
// pseudonymized (keyed hash) before it is stored - see src/customers/pseudonym.js.
export const ORDERS_PAGE_QUERY = /* GraphQL */ `
  query ($cursor: String, $searchQuery: String) {
    orders(first: 25, after: $cursor, sortKey: CREATED_AT, query: $searchQuery) {
      edges {
        node {
          id
          createdAt
          test
          currencyCode
          taxesIncluded
          displayFinancialStatus
          sourceName
          channelInformation {
            channelDefinition {
              handle
              channelName
              subChannelName
            }
          }
          customerJourneySummary {
            ready
            customerOrderIndex
            daysToConversion
            firstVisit { ...VisitFields }
            lastVisit { ...VisitFields }
          }
          retailLocation {
            id
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                sku
                quantity
                variant {
                  id
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
                discountAllocations {
                  allocatedAmountSet {
                    shopMoney {
                      amount
                    }
                  }
                }
                taxLines {
                  priceSet {
                    shopMoney {
                      amount
                    }
                  }
                }
              }
            }
          }
          refunds {
            id
            createdAt
            totalRefundedSet {
              shopMoney {
                amount
              }
            }
            refundLineItems(first: 50) {
              edges {
                node {
                  quantity
                  subtotalSet {
                    shopMoney {
                      amount
                    }
                  }
                  totalTaxSet {
                    shopMoney {
                      amount
                    }
                  }
                  lineItem {
                    id
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

  fragment VisitFields on CustomerVisit {
    occurredAt
    source
    sourceType
    sourceDescription
    referrerUrl
    landingPage
    utmParameters {
      source
      medium
      campaign
      content
      term
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

// Order-level money totals as Shopify itself computes them, used only to
// validate the engine's line-level numbers. Read-only, read_orders scope, no PII fields.
export const ORDER_TOTALS_PAGE_QUERY = /* GraphQL */ `
  query ($cursor: String, $searchQuery: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT, query: $searchQuery) {
      edges {
        node {
          id
          createdAt
          test
          displayFinancialStatus
          subtotalPriceSet { shopMoney { amount } }
          currentSubtotalPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalRefundedSet { shopMoney { amount } }
          shippingLine { taxLines { priceSet { shopMoney { amount } } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Payment gateway + processor fees per order, used only to measure fee visibility
// (src/analysis/payment-fees.js). Read-only, read_orders scope, no customer fields.
export const PAYMENT_TRANSACTIONS_PAGE_QUERY = /* GraphQL */ `
  query ($cursor: String, $searchQuery: String) {
    orders(first: 25, after: $cursor, sortKey: CREATED_AT, query: $searchQuery) {
      edges {
        node {
          id
          createdAt
          test
          transactions(first: 10) {
            gateway
            kind
            status
            amountSet { shopMoney { amount } }
            fees { amount { amount } type }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Opt-in variant: identical selection plus the customer's opaque id (needs the read_customers scope).
// Used only when a local hash secret is configured; the id is hashed in normalizeOrder and never stored.
export const ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY = ORDERS_PAGE_QUERY.replace(/(\n\s*sourceName\n)/, '$1          customer { id }\n');
