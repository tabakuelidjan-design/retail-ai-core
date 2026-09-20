// Synthetic fixture data only - no real HABB order/refund data. Shapes
// mirror ORDERS_PAGE_QUERY's real response closely enough to exercise the
// sync module, but every id/amount here is made up. No customer PII field
// exists in these fixtures because the real query never selects one.

// Order 1: two line items - one with a discount and a matching catalog
// variant, one representing a deleted/custom item (variant: null). No
// refunds. Mirrors HABB's confirmed taxesIncluded: true.
export const FAKE_ORDER_1 = {
  id: 'gid://shopify/Order/1',
  createdAt: '2026-08-01T10:00:00Z',
  currencyCode: 'EUR',
  taxesIncluded: true,
  displayFinancialStatus: 'PAID',
  retailLocation: { id: 'gid://shopify/Location/1' },
  lineItems: {
    edges: [
      {
        node: {
          id: 'gid://shopify/LineItem/1',
          title: 'Fixture Widget',
          sku: null,
          quantity: 2,
          variant: { id: 'gid://shopify/ProductVariant/1' },
          originalUnitPriceSet: { shopMoney: { amount: '25.00' } },
          totalDiscountSet: { shopMoney: { amount: '5.00' } },
          taxLines: [{ priceSet: { shopMoney: { amount: '8.68' } } }],
        },
      },
      {
        node: {
          id: 'gid://shopify/LineItem/2',
          title: 'Discontinued custom engraving (deleted product)',
          sku: 'OLD-SKU-001',
          quantity: 1,
          variant: null, // deleted/custom item - no catalog variant
          originalUnitPriceSet: { shopMoney: { amount: '15.00' } },
          totalDiscountSet: { shopMoney: { amount: '0.00' } },
          taxLines: [{ priceSet: { shopMoney: { amount: '2.60' } } }],
        },
      },
    ],
  },
  refunds: [],
};

// Order 2: single line item with quantity 3, used as the base for refund
// scenarios (partial line refund, full line refund, multiple refund lines).
export const FAKE_ORDER_2_BASE = {
  id: 'gid://shopify/Order/2',
  createdAt: '2026-08-05T14:00:00Z',
  currencyCode: 'EUR',
  taxesIncluded: true,
  displayFinancialStatus: 'PAID',
  retailLocation: null, // online order
  lineItems: {
    edges: [
      {
        node: {
          id: 'gid://shopify/LineItem/3',
          title: 'Fixture Gadget',
          sku: 'GAD-001',
          quantity: 3,
          variant: { id: 'gid://shopify/ProductVariant/2' },
          originalUnitPriceSet: { shopMoney: { amount: '10.00' } },
          totalDiscountSet: { shopMoney: { amount: '0.00' } },
          taxLines: [{ priceSet: { shopMoney: { amount: '5.21' } } }],
        },
      },
      {
        node: {
          id: 'gid://shopify/LineItem/4',
          title: 'Fixture Accessory',
          sku: 'ACC-001',
          quantity: 1,
          variant: { id: 'gid://shopify/ProductVariant/3' },
          originalUnitPriceSet: { shopMoney: { amount: '8.00' } },
          totalDiscountSet: { shopMoney: { amount: '0.00' } },
          taxLines: [{ priceSet: { shopMoney: { amount: '1.39' } } }],
        },
      },
    ],
  },
  refunds: [],
};

export function orderWithPartialLineRefund() {
  const order = JSON.parse(JSON.stringify(FAKE_ORDER_2_BASE));
  order.refunds = [
    {
      id: 'gid://shopify/Refund/1',
      createdAt: '2026-08-10T09:00:00Z',
      totalRefundedSet: { shopMoney: { amount: '10.00' } },
      refundLineItems: {
        edges: [
          {
            node: {
              quantity: 1, // 1 of 3 units refunded - partial
              subtotalSet: { shopMoney: { amount: '10.00' } },
              totalTaxSet: { shopMoney: { amount: '1.74' } },
              lineItem: { id: 'gid://shopify/LineItem/3' },
            },
          },
        ],
      },
    },
  ];
  return order;
}

export function orderWithFullLineRefundAndMultipleRefundLines() {
  const order = JSON.parse(JSON.stringify(FAKE_ORDER_2_BASE));
  order.refunds = [
    {
      id: 'gid://shopify/Refund/2',
      createdAt: '2026-08-11T09:00:00Z',
      totalRefundedSet: { shopMoney: { amount: '38.00' } },
      refundLineItems: {
        edges: [
          {
            node: {
              quantity: 3, // full quantity refunded
              subtotalSet: { shopMoney: { amount: '30.00' } },
              totalTaxSet: { shopMoney: { amount: '5.21' } },
              lineItem: { id: 'gid://shopify/LineItem/3' },
            },
          },
          {
            node: {
              quantity: 1,
              subtotalSet: { shopMoney: { amount: '8.00' } },
              totalTaxSet: { shopMoney: { amount: '1.39' } },
              lineItem: { id: 'gid://shopify/LineItem/4' },
            },
          },
        ],
      },
    },
  ];
  return order;
}

export function ordersPage(orderNodes) {
  return { orders: { edges: orderNodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } };
}
