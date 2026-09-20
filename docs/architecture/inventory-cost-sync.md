# Phase 1B — Inventory Snapshots + Product Costs Sync

Status: executed manually this session via the Shopify + Supabase MCP connectors (same interactive/dev channel as Phase 1A — see `CLAUDE.md` §6). Scope: `inventory_snapshots` and `product_costs` only. `orders`, `order_lines`, `refunds`, `refund_lines`, the Decision Ledger, the recommendation engine, and the email digest are explicitly out of scope and untouched.

## 1. Inventory snapshot strategy

Three options were considered before implementation:

| Strategy | Pros | Cons |
|---|---|---|
| **A. Snapshot every run** | Simplest to implement (pure append, no comparison logic). Gives a complete, uninterrupted time series at exactly the sync cadence. Directly supports stockout days (count/measure consecutive rows at qty=0), stockout-adjusted velocity (delta between consecutive snapshots ÷ elapsed time), and full stock history — no extra bookkeeping needed. | Storage grows linearly with sync frequency even when nothing changed. |
| **B. Snapshot only when quantity changes** | Less storage; only "interesting" points recorded. | Breaks stockout-days math on its own: a run of "still 0" doesn't produce new rows, so a gap between two real snapshots is ambiguous — did stock stay flat, or did the sync just not run? Needs a separate heartbeat/"last checked" record to fix, which is more moving parts for a problem this project doesn't have yet. |
| **C. Hybrid (change OR daily heartbeat)** | Keeps stockout/velocity math correct without a separate heartbeat table. | More logic now (day-boundary/timezone handling) for a sync that today runs interactively, not on a schedule — overkill for the current cadence. |

**Chosen: A — snapshot at every run.** It's the simplest option that doesn't silently break the future stockout-days / velocity / history calculations, and it matches the schema's own design intent (`inventory_snapshots` is explicitly append-only with a `synced_at` meant for staleness checks against "now", which implies a row per check, not per change). Implemented as a plain `INSERT`, never an upsert — no existing row is ever touched.

## 2. Product costs: source and validation

Per variant, `InventoryItem.unitCost` was read read-only via the Shopify Admin GraphQL API. Where it exists: `source = 'shopify_unit_cost'`, `validation_status = 'unverified'`, real `currency`, `effective_from = sync time`. Where it's missing: **no row is created** — the variant has no `product_costs` entry at all, which is what makes it `UNCLASSIFIED` for any future margin calculation (per the `retail-metrics` Skill's rule). Nothing was inferred or defaulted.

## 3. Cost coverage report

- Total variants: **339**
- With Shopify cost: **294**
- Without cost (`UNCLASSIFIED`): **45**
- Coverage: **86.7%**
- Cost values of exactly 0: **0**
- Negative inventory quantities: **0**

**Top variants without cost** (categorized, not itemized — see raw data for the full list):
- The entire newest batch of "Coque personnalisée" phone-case products (~37 variants) — the newest phone models added to the catalog (e.g. iPhone 18 Pro/Pro Max, Galaxy S26 family, Xiaomi 17T, OPPO Reno13/14, Galaxy A26/A27) have never had a cost set at all.
- 4 "Personnaliser sa coque" bundle/demo products.
- 2 variants of "Gourde Sitarayuri ZF-075" (Bleu Pastel, Violet).
- 1 variant of "Casque Bluetooth télescopique et pliable".

**Suspicious costs (reported, not judged — no `data_quality_flags` created yet):**
- **45 variants share the exact unit cost `1.78 EUR`**, and these span dozens of *distinct products* (different phone models entirely: Apple, Samsung, Xiaomi, OPPO), not color/size variants of one product. A real landed cost that varies by case size/material would not normally be identical across that many unrelated products — this looks like a single placeholder value applied in bulk when the "Coque personnalisée" collection was first set up, never revisited per model.
- Smaller uniform clusters exist too (`0.53` × 20, `4.34` × 16, `1.22` × 13, `0.19` × 12, `4.29` × 10), but these mostly correspond to color/size variants *of the same physical product*, where an identical cost is expected and not inherently suspicious.
- This is a pattern worth investigating in a future data-quality pass, not a conclusion — per instructions, no automatic correction or flag was applied.

## 4. Idempotency / history design

- `inventory_snapshots`: plain insert every run (see strategy A above) — by design, count grows every run.
- `product_costs`: a new row is inserted **only** when `(unit_cost, currency, source, validation_status)` differs from the most recent existing row for that variant (`ORDER BY effective_from DESC LIMIT 1`, compared via `IS DISTINCT FROM`). Same values on a re-run → no new row. This is the foundation for a future **COGS Drift** view: every real cost change becomes its own row, nothing else does.
- **Bug found and fixed during testing:** the row-comparison predicate (`(pc.unit_cost, pc.currency, pc.source, pc.validation_status) IS DISTINCT FROM (...)`) failed with `ERROR 42804: cannot compare dissimilar column types text and unknown` once a real product_costs row existed to compare against (it didn't fail on the very first insert, when the left-hand subquery returned no row at all — comparing a row-value against a *literal* `NULL` doesn't require per-column type unification, but comparing two constructed rows does). Fixed by explicitly casting every literal in the constructed row (`'shopify_unit_cost'::text`, `'unverified'::text`, `x.cur::text`). No schema change was needed — this was a SQL-authoring bug in the sync logic, not a data model issue.

## 5. Validation results

**Inventory**
- Variants with stock (`qty > 0`): 338
- Variants with `qty = 0`: 1 (Casque Bluetooth avec réduction de bruit, "Noir Nuit Sombre" — a real stockout, not a missing-sync artifact)
- Snapshots created (first full run): 339 (1 per variant × 1 location — "Habb" is the only Shopify location)
- Locations covered: 1 / 1
- Variants without any inventory snapshot: 0
- Negative quantities: 0

**Costs**
- Total variants: 339
- With cost: 294
- Without cost: 45
- Zero cost: 0
- Suspicious cost: the 45-variant `1.78 EUR` cluster described above (reported, not corrected)
- Coverage: 86.7%

**Database (after both runs)**
- `inventory_snapshots` row count: 680 (339 + 339 — two full runs, each strictly additive, exactly as designed)
- `product_costs` row count: 294 (unchanged between runs — confirms no duplication)

## 6a. Revision: merchant-local day, not UTC (runtime auth test round)

The application-level check now uses the **merchant's local calendar day** (`MERCHANT_TIMEZONE`, e.g. `Europe/Brussels` for HABB) instead of the UTC day used during the manual Phase 1B testing above. A retry late in the UTC day that has already crossed into the next Brussels day now correctly writes a new snapshot, and vice versa — see `src/sync/normalize.js` (`localCalendarDate`, `isSameLocalDay`, `shouldWriteInventorySnapshot`) and its tests.

**Proposed DB-level hardening (NOT applied — requires its own approval and migration):**

```sql
-- 0003_inventory_snapshot_local_day (PROPOSAL — DO NOT APPLY WITHOUT APPROVAL)
alter table inventory_snapshots add column observed_local_date date;
update inventory_snapshots set observed_local_date = (synced_at at time zone 'utc')::date; -- best-effort backfill for existing rows (see caveat below)
alter table inventory_snapshots alter column observed_local_date set not null;
alter table inventory_snapshots add constraint inventory_snapshots_variant_location_day_uq
  unique (variant_id, location_id, observed_local_date);
```

Why this is only proposed, not applied: the application-level check (`shouldWriteInventorySnapshot`) already prevents same-day duplicates in normal operation, but a DB-level constraint is what makes it *deterministic regardless of application bugs* — a stated goal of this task. It's deferred because:
1. The existing 680 rows from manual Phase 1B testing were stamped with UTC-day semantics, not Brussels-day — the backfill above is an approximation for those specific historical rows, not a precise reconstruction. That's an acceptable, disclosed limitation for test-phase data, but should be flagged if it ever matters for a real report.
2. Adding a `NOT NULL` + `UNIQUE` constraint to a live-ish table needs review of what happens to the app's insert path (it must now always set `observed_local_date`) before it's safe to apply — a one-line oversight there would turn every insert into a runtime error, not a silent skip.

## 6. Double-run test result

| Run | inventory_snapshots (total) | product_costs (total) | New product_costs rows this run |
|---|---|---|---|
| 1 | 339 | 294 | 294 (all new) |
| 2 | 680 (+339) | 294 (+0) | 0 |

`product_costs` grouped by `variant_id` with `count(*) > 1`: **0** — confirmed no variant has more than one cost row, since nothing changed between the two runs. Idempotency holds for costs; inventory history behaves exactly as designed (one snapshot per variant per run, no upsert, no data loss).
