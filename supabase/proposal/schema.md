# Supabase Schema Proposal — Phase 1 scope (NOT APPLIED)

This is a design proposal only. No migration has been written to `supabase/migrations/` and nothing has been applied to any project, including the dev project `retail-ai-core-dev`. Per the safe-deployment discipline, this must be reviewed and explicitly approved before any migration file is created from it.

## Status

- ✅ Scope cut to **Phase 1 required tables only** — the "keep empty for later" tables (`metric_definitions`, `metric_values`, `decisions`, `decision_evidence`, `decision_outcomes`) are **not** in this migration. They stay documented below as a deferred design, created only when the metrics/decision engine work is actually approved.
- ✅ `product_costs.source` reworked — the real Shopify inspection (below) showed `unitCost` is itself a Shopify-provided number, which the old 3-value enum didn't account for.
- ✅ Added a cost trust/validation status, separate from `source` — knowing *where* a cost came from and *whether it's been validated* are two different questions.
- ✅ Real HABB Shopify structure inspected read-only (Admin GraphQL API, no write calls) — see mapping matrix below.
- ⏳ SQL shown for review — **not applied**.

## What was inspected (read-only, real HABB store)

Via the Shopify MCP connector (`get-shop-info`, `search_products`, `list-orders`, `graphql_schema`, and one read-only `graphql_query`):

- Store: `habb.be`, Basic plan, currency EUR, Belgium.
- 3 sample products, e.g. "Casque Bluetooth Remax RB-300HB" (2 variants), "Câble tressé USB-C 30W/65W" (4 variants).
- **`sku` is `null` on every observed variant.** HABB does not populate SKUs in Shopify today.
- **`barcode` is populated, but with what looks like a fragment of the internal variant ID** (e.g. variant `57206416703836` → barcode `16703836`), not a real manufacturer barcode. This looks like Shopify's own auto-fill, not real data — flagged as a candidate `data_quality_flags` case once the sync exists (a `suspicious_barcode`-type check), not something to silently trust.
- **`InventoryItem.unitCost` is real and populated** — e.g. `10.06 EUR` on the Remax headphones variant. So Shopify itself already carries a per-variant cost for at least some products. This changes `product_costs.source` (below): a cost row can legitimately originate from Shopify itself, not just from a manual entry or a vertical module computation.
- Orders: 70 total, recent ones fully `PAID`/`FULFILLED`, e.g. `#1070` (34.90 EUR, 1 line item).
- `Location` has no equivalent identifier stored anywhere in the original schema draft's `locations` table — fixed below (`source_system`/`source_id` added, matching how `products`/`orders` already do it).

## Phase 1 required tables (this migration)

Per the earlier classification, these are the tables the read-only Shopify sync cannot function without:

`merchants`, `locations`, `products`, `variants`, `inventory_snapshots`, `orders`, `order_lines`, `refunds`, `product_costs`, `data_quality_flags`.

### `product_costs` — reworked

Two previously-conflated ideas are now separate columns:

- **`source`** — *where the number came from*: `'shopify_unit_cost'` (read from `InventoryItem.unitCost`, confirmed to exist in real HABB data), `'manual_entry'` (typed in by a human), `'vendor_invoice'` (from a supplier document/import), `'vertical_module_computed'` (e.g. a future UV-production-cost module deriving a cost — HABB-specific, lives behind that module, never hardcoded here).
- **`validation_status`** — *how much to trust the number*, independent of where it came from: `'unverified'` (default — e.g. freshly pulled from Shopify but no one has confirmed it reflects real landed cost), `'verified'` (a human has checked it against an actual invoice/reality), `'estimated'` (a deliberate approximation, never silently treated as exact), `'stale'` (was verified once, but past its `effective_from` freshness window — see `data-quality-rules`).

This matters concretely for HABB: `unitCost = 10.06` exists in Shopify, but nothing confirms yet whether it's accurate or leftover/placeholder data — same suspicion as the barcode fragment above. Pulling it in as `source = 'shopify_unit_cost'`, `validation_status = 'unverified'` lets the data-quality layer treat it as real-but-unconfirmed, rather than either blindly trusting it or discarding it.

### `locations` — fixed

Added `source_system` + `source_id` (matching `products`/`orders`) so a Shopify `Location` can actually be joined to a local row — the original draft had no way to do this.

## Static review (this revision)

Checked against 8 explicit rules before sign-off:

1. `sku` nullable, never a logical/primary key — ✅ already the case (nullable, no unique constraint on it alone).
2. `barcode` nullable, never a reliable identifier — ✅ satisfied by not storing it at all in Phase 1 (see mapping matrix); if it's ever added later, it must stay nullable and never carry a unique constraint.
3. Shopify `source_id` is the stable external reference — ✅ every synced table carries `source_system` + `source_id`, unique together.
4. Locations joinable via `source_system + source_id` — ✅ (`unique (merchant_id, source_system, source_id)` on `locations`).
5. `product_costs.validation_status = 'estimated'` never presented as a certain margin — addressed with a `comment on column` in the SQL itself, and this is also the rule already stated in the `retail-metrics` Skill (a margin computed from a non-`'verified'` cost cannot be shown as exact — enforcement lives in the future metrics engine, since `metric_values` isn't part of Phase 1).
6. Missing cost = `UNCLASSIFIED` — ✅ structural: `product_costs` simply has no row for that variant; nothing defaults it to zero/average.
7. Refunds cleanly attached to an order — ✅ `refunds.order_id` is `not null references orders(id)`.
8. No unnecessary customer PII — ✅ no customer table, no PII column anywhere in Phase 1.

## Final SQL (Phase 1 only — draft, NOT applied)

```sql
-- 0001_phase1_schema.sql (PROPOSAL — DO NOT APPLY WITHOUT EXPLICIT APPROVAL)

create table merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vertical text not null default 'general_retail',
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null,
  type text not null,
  source_system text not null,
  source_id text not null,
  unique (merchant_id, source_system, source_id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  title text not null,
  handle text,
  source_system text not null,
  source_id text not null,
  unique (merchant_id, source_system, source_id)
);

create table variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  sku text,
  title text,
  attributes jsonb not null default '{}'::jsonb,
  source_system text not null,
  source_id text not null,
  unique (source_system, source_id)
);

create table inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id),
  location_id uuid not null references locations(id),
  quantity integer not null,
  synced_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  location_id uuid references locations(id),
  source_system text not null,
  source_id text not null,
  ordered_at timestamptz not null,
  currency text not null,
  status text not null,
  unique (merchant_id, source_system, source_id)
);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  variant_id uuid not null references variants(id),
  quantity integer not null,
  unit_price numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  amount numeric(12,2) not null,
  refunded_at timestamptz not null,
  reason text
);

create table product_costs (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id),
  merchant_id uuid not null references merchants(id),
  unit_cost numeric(12,2) not null,
  currency text not null,
  effective_from timestamptz not null default now(),
  source text not null check (source in ('shopify_unit_cost', 'manual_entry', 'vendor_invoice', 'vertical_module_computed')),
  validation_status text not null default 'unverified' check (validation_status in ('unverified', 'verified', 'estimated', 'stale'))
);

create table data_quality_flags (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  entity_type text not null,
  entity_id uuid not null,
  rule_code text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

comment on column variants.sku is
  'Nullable by design. Not a join key and never unique-constrained — confirmed null on every observed HABB variant. Identity for sync/joins is source_system + source_id.';

comment on column product_costs.validation_status is
  'Trust level for unit_cost, independent of source. estimated must never be displayed or computed as a certain margin — any metric built on an estimated or unverified cost must carry that same caveat forward, not present a clean number.';

comment on column refunds.order_id is
  'Not null and FK-enforced: a refund can only exist attached to a real order row. A refund with no matching source order is a data-quality violation to catch during sync, not a valid row to insert.';

alter table merchants enable row level security;
alter table locations enable row level security;
alter table products enable row level security;
alter table variants enable row level security;
alter table inventory_snapshots enable row level security;
alter table orders enable row level security;
alter table order_lines enable row level security;
alter table refunds enable row level security;
alter table product_costs enable row level security;
alter table data_quality_flags enable row level security;
```

RLS is turned **on** for every table with zero policies defined yet, so every table is fully locked down until policies are written and reviewed as a separate step.

## Mapping matrix: Shopify field → local DB field → available/missing

Based on the real read-only inspection above, not assumptions.

| Shopify field | Local DB field | Status |
|---|---|---|
| `Product.id` | `products.source_id` (+ `source_system='shopify'`) | Available |
| `Product.title` | `products.title` | Available |
| `Product.handle` | `products.handle` | Available |
| `Product.vendor`, `Product.productType` | — | **Missing** (not modeled in Phase 1 — no column; would need a schema change if needed later) |
| `ProductVariant.id` | `variants.source_id` | Available |
| `ProductVariant.sku` | `variants.sku` | Available as a column, but **empty in practice** — confirmed `null` on every HABB variant checked. `data_quality_flags` will need to tolerate SKU-less catalogs, not assume SKU is a usable join key for this merchant. |
| `ProductVariant.barcode` | — | **Missing** (not modeled) — and what exists looks auto-generated, not a real barcode; not worth ingesting as-is. |
| `ProductVariant.price` (current catalog price) | — | **Missing** — only the historical transaction price is modeled (`order_lines.unit_price`), not current catalog price. Acceptable for Phase 1 (margin is computed on what was actually sold), but note: no live "current price" table exists yet. |
| `InventoryItem.unitCost` | `product_costs.unit_cost` (`source='shopify_unit_cost'`) | **Available and confirmed populated** for at least some HABB variants (e.g. 10.06 EUR) — but `validation_status` starts `'unverified'`, see above. |
| `InventoryItem.tracked` | — | **Missing** (not modeled) |
| `Location.id` | `locations.source_id` | Available (schema fixed to store it) |
| `Location.name` | `locations.name` | Available |
| `InventoryLevel` (location × item quantity) | `inventory_snapshots.quantity` + `location_id` | Available |
| `Order.id` | `orders.source_id` | Available |
| `Order.name` (e.g. `#1070`) | — | **Missing** (not modeled) — human-readable order number isn't stored; only the GID is. Low priority, easy to add later if needed for support/debugging. |
| `Order.createdAt` | `orders.ordered_at` | Available |
| `Order.currencyCode` | `orders.currency` | Available |
| `Order.financialStatus` | `orders.status` | Available |
| `Order.fulfillmentStatus` | — | **Missing** (not modeled — not needed for revenue/margin/refund metrics) |
| `Order.customer` (any field) | — | **Missing by design** — no customer table in Phase 1, and per `CLAUDE.md`, no raw PII is sent to an LLM regardless. |
| `LineItem.variant`, `.quantity`, `.price`/`.discountedTotal` | `order_lines.variant_id/quantity/unit_price/discount_amount` | Available |
| `Refund` (amount, timing, note) | `refunds.amount/refunded_at/reason` | Available — actual amount requires summing refund line items/transactions during sync (an ETL detail, not a schema gap). |

## Explicitly deferred (not in this migration)

Kept as a design reference only — no table created until the metrics/decision engine is itself approved:

- **`metric_definitions`**, **`metric_values`** — versioned metric definitions and computed values; depends on a metrics engine that doesn't exist yet.
- **`decisions`**, **`decision_evidence`** — depends on a decision engine that doesn't exist yet.
- **`decision_outcomes`** (renamed from `future_outcomes`) — depends on decisions existing first; the Outcome Engine itself stays out of scope regardless of when this table is created.

## Next step (needs explicit approval before proceeding)

1. Review the Phase 1 SQL above.
2. Once approved, save it as `supabase/migrations/0001_phase1_schema.sql` and apply it to the **dev** project (`retail-ai-core-dev`) only.
3. Write and review RLS policies as a separate follow-up step before any application code reads/writes these tables.
4. The deferred tables get their own review + migration when the metrics/decision engine work is explicitly approved — not bundled into Phase 1.
