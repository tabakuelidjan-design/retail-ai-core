# Phase 2E — Customer Intelligence Lite

Deterministic customer-behaviour facts: order-level always, customer-level through a keyed-hash pseudonym. Observed behaviour only: no prediction, no segmentation, no labels, no recommendations. Run: `npm run customers:report` → `reports/customer-facts-<date>.json` (gitignored).

## Identity: pseudonymous key only

Customer-level metrics need to know that two orders belong to the same customer, and nothing more. The design stores **no name, email, phone or address, and not even the source customer id**:

- The order query (`ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY`) adds one field, `customer { id }`, and only when customer keys are enabled. The default query requests no customer field at all.
- At sync time the id is replaced by `HMAC-SHA256(secret, id)` (hex) and stored in `orders.customer_key` (nullable, additive migration `20260921180000`). The id is never stored or logged. Anonymous orders (most POS sales) stay `NULL`.
- The secret is `CUSTOMER_HASH_KEY` in the local, gitignored `.env` (at least 32 characters). Keys are enabled only when `SYNC_CUSTOMER_KEY=1`; a missing or weak secret fails loudly. Without the secret the key can be neither recomputed nor reversed; losing it only breaks continuity of keys.
- **Requires the `read_customers` scope on the access token.** If the scope is missing the enabled sync stops on `ACCESS_DENIED` before writing anything; the default sync is unaffected.
- Reports are aggregate only: no key, no per-customer row, no ranking of individuals. Concentration numbers are withheld below the customer sample gate, because a top share over a handful of people is near-identifying.

## What is implemented

| Fact | Basis | Notes |
|---|---|---|
| New vs returning **orders**: counts, shares, revenue share, units, AOV | order index | Always available; POS index 1 is `first_recorded_pos`, never "new" |
| Repeat-order share | order index | Lower bound |
| Basket size, multi-product share, co-purchase pairs | order lines | Pairs only above sample thresholds |
| New vs returning **customers**: customers, orders, order/revenue share, AOV | customer key | `returning` = 2+ orders in the window or any recorded index above 1 |
| Customers with 1 / 2 / 3+ orders (window, and lifetime lower bound from the recorded index) | customer key | |
| Repeat customer rate | customer key | Lower bound; never a retention estimate |
| Days between purchases (median, mean, count) | customer key | Only gaps observed inside the dataset |
| Observed revenue / orders / units per customer (mean, median) | customer key | In-window observation, not lifetime value |
| Customer concentration (top-1, top-N share, HHI, risk flags) | customer key | Numbers withheld below `customers.minCustomers` |

Customer-level blocks are `BLOCKED` when no order carries a key. Coverage (identified vs anonymous orders and revenue) is reported with every customer-level block; shares are over identified revenue only.

## Provenance and gates

Every block carries `observation_window`, `completeness`, `sample_size`, `history_limitations`, `limitations`, `evidence_kind` and `safe_for_phase3 { safe, reasons }`.

- Customer groups: safe only when both groups have `customers.minOrdersPerGroup` customers.
- Repeat rate, value and concentration: need `customers.minCustomers` identified customers **and** a history of at least `customers.shortHistoryDays` (`SHORT_HISTORY` otherwise). Time between purchases also needs `customers.minIntervals` observed gaps.
- `src/customers/phase3-contract.js` returns a block's facts only when it is safe; otherwise `GATED` with reasons and no numbers.
- Eight weeks does not support retention or lifetime-value conclusions; those are out of scope and every block says so.

## Privacy

No customer field other than the opaque id (hashed immediately) is requested, stored or reported. Tests assert: the default query has no customer field; the opt-in query adds only the id; the stored value is the hash and the id appears nowhere; the report contains no key, secret, id or email. Fixtures are synthetic.

## Out of scope

Predictive CLV, churn prediction, demographic segmentation, email automation, loyalty, CRM, LLM-generated labels, recommendation engine.
