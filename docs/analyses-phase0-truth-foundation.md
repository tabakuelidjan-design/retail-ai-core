# Analyses — Phase 0: truth foundation

Branch `feature/analyses-v1` (from `e0047e3`). All data in tests and in the benchmark is **synthetic**. Nothing was run against production, no production migration, no deployment, no push. Finance, Brain, Identity, Security, Tenant and `feature/core-sync-cron` were not modified.

## 1. Defects closed (failing test first, then the smallest correct fix)

| # | Defect | Reproducer (test) | Fix |
|---|---|---|---|
| A | A refund issued inside the window on an order placed before it disappeared (the loader filtered orders by date and fetched refunds only through the loaded orders) | `test/analyses-truth-refund-boundary.test.js` (A1–A6) | `loadDataset` also reads refunds by `refunded_at` (merchant-scoped) and loads their parent orders and lines as **context only**; the ledger maps and classifies the refund but the old order is never a sale, never in history or customer scope. Refunds on excluded orders are counted (`excluded.refundsOnExcludedOrders`) |
| A (sync) | A refund added later to an order older than the 60-day sync window was never ingested | `test/analyses-truth-sync.test.js` (S1–S5) | `refundCatchUpQuery`: a second pass for orders **updated** in the window but **created** before it (`updated_at:>=D AND created_at:<D`), separate counters, failure surfaced as `catch-up: …`, enabled by the production runner, off by default in the library. **Behaviour against live Shopify is not verified** (offline fake only); without `read_all_orders` Shopify returns nothing older than 60 days |
| B | Only `VOIDED` was excluded; cancelled orders counted as sales; cancellation fields never fetched; exclusions not surfaced | `test/analyses-truth-orders-completeness.test.js` (B1–B3) | fetch `cancelledAt/closedAt/cancelReason`; `EXPIRED` and cancelled orders are not sales (their refunds are not counted either); every exclusion is counted (`excluded.{test,status,cancelled,otherCurrency,refundsOnExcludedOrders}`) and shown on the page; `PENDING`/`AUTHORIZED` remain sales |
| B (currency) | The ledger currency was the most common among ALL orders (test and voided included) | C1 in the same file | decided among countable orders only; a profile currency wins |
| — | Nested Shopify connections silently truncated (lines 50, refund lines 50, shipping 10) | N1–N6 | `pageInfo` requested on all four; follow-up pages complete them; a failed page flags the order (`lines_truncated`), counts it (`ordersTruncated`) and reports it in the sync errors |
| C | `MERCHANT_TIMEZONE` silently defaulted to UTC (7 entry points, ~12 function defaults) | `test/analyses-truth-timezone.test.js` (C1–C8) | `src/metrics/profile.js`: no default; `TIMEZONE_NOT_CONFIGURED` / `TIMEZONE_INVALID`; profile row first, environment as an explicit reported fallback; a snapshot without a valid zone is unavailable (rebuild), never served on a UTC day; a guard test forbids new silent UTC defaults outside Finance |
| D | Static "Data up to date" / "revenue comes from real, verified orders" | `test/analyses-truth-health-claims.test.js` (H1–H6) | the card is derived from the real sync status (OK / STALE / FAILED / UNKNOWN / NO_SOURCE) and the report's own exclusion counters; the revenue sentence now says it is **not** reconciled with Shopify; the placeholder "view sources" button was removed. Verified in the browser pane (ok, stale, failed states; mobile 375 px, no overflow) |

Equivalent defects found and handled (`test/analyses-truth-equivalents.test.js`): stock older than the inventory read window was read as zero stock (now `stockCoverage`: variants without a snapshot are counted, never invented); validation against Shopify ignored cancelled orders; a silent EUR default in the period engine and Ask; truncation and stock coverage were not in the report (now `order_history.completeness`, `order_history.stock_coverage`).

Found by the benchmark (section 4): a customer whose only activity in a window is a refund on an earlier order **crashed Explorer** and was counted as an active customer (`test/analyses-truth-explorer-refund-only.test.js`); now an explicit `refund_only` bucket, active customers are those who ordered.

## 2. Not done in Phase 0 (and why)

* Finance-owned items cannot be changed (Finance is closed): `refundRows` (accountant refund CSV) still ignores exclusions; Finance's own `?? 'UTC'` reads (`runtime.js`, `cli.js`, `server/app.js`); Finance's `accountant-pack` does not surface `excluded.status`. Finance benefits from the loader/ledger fixes automatically (its pack reads the same ledger), which is a correction, not a Finance code change.
* Growth "semantics A" vs Analytics (D1 two named metrics) and the metric registry are Phase 1.
* The inventory 2-day read window itself is unchanged (surfaced, not widened).

## 3. Schema (one additive migration, not applied anywhere)

`supabase/migrations/20261007090000_analyses_truth_foundation.sql`: `orders.cancelled_at / closed_at / cancel_reason / lines_truncated (not null default false)`; indexes `orders (merchant_id, ordered_at)` and `refunds (merchant_id, refunded_at)`; table `merchant_profile` (IANA timezone validated by a guard against `pg_timezone_names`, currency, country, exclusion list, channel handles and aliases, RLS, no policy). **Apply it before deploying the code** that selects the new order columns. PostgreSQL 17: `test/pg/95-analyses-truth.pg.test.js` plus the pinned infra expectations (28 migrations, 35 tables, schema drift vs the production fingerprint unchanged).

## 4. Benchmark (`node benchmark/analyses/serving.mjs all`)

Deterministic synthetic dataset, the real code of the current architecture (`dataset.json` read, ledger, Explorer/Products/Clients for a window). The database read is **not measured** (no network): requests are counted and the refresh time is an **ESTIMATE** at an assumed 60–150 ms round trip.

| Orders | Cold 30 d | Warm 90 d | Warm 365 d | Warm 3 y | Event-loop block | Peak heap | Snapshot | Refresh (estimate) |
|---|---|---|---|---|---|---|---|---|
| 10k | 0.7 s | 0.4 s | 0.6 s | 1.0 s | 0.65 s | 134 MB | 9.7 MB | 47–117 s |
| 25k | 1.4 s | 1.0 s | 1.7 s | 2.4 s | 1.7 s | 336 MB | 24 MB | 117–291 s |
| 50k | 2.6 s | 2.1 s | 3.6 s | 4.8 s | 3.6 s | 576 MB | 49 MB | 233–581 s |
| 100k | 6.2 s | 4.9 s | 7.5 s | 11.3 s | 7.5 s | 1 574 MB | 98 MB | 465–1 162 s |

What the benchmark changed (all outputs byte-identical, pinned by `test/analyses-truth-builders-golden.test.js`): customer labels were cubic (8 s for 6 000 customers) → sort-based; `Intl.DateTimeFormat` rebuilt on every call → reused (and my own zone validation is cached); `windowFacts` rescanned the whole ledger for every day → time-indexed; per-day loops in Explorer (channels, customers) and Products rewritten as one pass. Before: at 10k orders a 3-year window took 20 s and blocked the process 12 s.

**Verdict.** Targets (proposed): cold ≤ 3 s, warm ≤ 1 s, event-loop block ≤ 200 ms, refresh ≤ 300 s, heap ≤ 1 GB. Met up to roughly 10k orders for normal windows; the event-loop block (the cold request is one synchronous parse + build) exceeds 200 ms from 10k orders; long windows exceed 1 s from 25k; refresh (estimate) and heap exceed their limits from 50k–100k. Level 1 work (indexing, loops, formatters) is done. **Level 2 is required to reach the 100k-order scale target** (move the build out of the request thread and read with joined, keyset-paged requests); it was not started. HABB today holds about 91 orders.

## 5. Merged

`feature/ask-benchmark-smoke` (the linear superset of the six other Ask branches) and `1b52742` from `feature/ask-voice-input`. Conflicts: `package.json` (kept the Analytics script with `--env-file`, added `benchmark:ask`), `lang-fr/nl` (kept `topbar.noSalesSource`; the text assistant keeps the branch's **tested** name "Demander à Nordla" / "Vraag het Nordla" — this reverses the earlier plan note that kept "Parle à Nordla"; a naming decision for the owner, two strings plus one test). Compliance edits: the retina microphone icon file was renamed to `nordla-mic-2x.png` (the privacy guard reads an at-sign file name as an e-mail), fixture e-mail `x@y.example`, the tenant source scan now walks sub-folders. The Ask pipeline is merged but **not wired** (no provider): that is Phase 4.

## 6. Existing tests changed (set-up only, no expectation weakened)

Because the time zone is now mandatory, tests that never supplied one now do: `MERCHANT_TIMEZONE: 'UTC'` in the environments of the tenant-decoupling tests, `timeZone: 'UTC'` in the onboarding / inventory / sync-batching calls. `PENDING_DELTA`, the migration count (28) and table/RLS counts (35) in `test/pg/00-infra.pg.test.js` were extended for the new migration.
