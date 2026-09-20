# Supabase Schema Proposal — Phase 1 scope (NOT APPLIED)

This is a design proposal only. No migration has been written to `supabase/migrations/` and nothing has been applied to any project, including the dev project `retail-ai-core-dev`. Per the safe-deployment discipline, this must be reviewed and explicitly approved before any migration file is created from it.

## Status (this revision)

- ✅ **Multi-merchant safety on `variants`** — added `merchant_id`, uniqueness is now `(merchant_id, source_system, source_id)`. An external ID is never assumed globally unique across future merchants/platforms.
- ✅ **Historical order lines** — `order_lines.variant_id` is now nullable, with `source_id` (the Shopify `LineItem` GID), `title_snapshot`, and nullable `sku_snapshot` added, so a line survives even if its variant/product is later deleted, or represents a custom item.
- ✅ **Refund attribution at line level** — new `refund_lines` table, justified by real HABB refund payloads (below): refunds can be traced to the specific line item, quantity, and amount refunded, not just an order-level total.
- ✅ **Tax representation** — real inspection confirmed HABB prices are tax-inclusive (`taxesIncluded: true`, 21% BE TVA). Added `orders.taxes_included` and `order_lines.tax_amount` (the real captured tax, never a guessed rate) so "Net sales HT" can be computed later without inventing VAT.
- ⏳ SQL shown for review — **not applied**. No migration run, no sync started.

## Inspection results (read-only, real HABB store)

### Line items — which identifiers are actually available

Queried real orders (`#1069`, `#1065`) via the Admin GraphQL API:

- `LineItem.id` (GID) — **always present**. This is the stable external reference for `order_lines.source_id`.
- `LineItem.title` — **always present** (non-nullable in the schema), captured at order time — this backs `title_snapshot`.
- `LineItem.sku` — **inconsistent**: `null` on the Remax accessory lines checked earlier, but **populated** (`"GEN-022"`) on a real refunded line ("Puzzle Photo 300 Pièces"). Confirms `sku_snapshot` must be nullable — some HABB products do carry a SKU, others don't.
- `LineItem.variant` — present when the variant still exists; this is exactly the reference that can go missing for historical/deleted variants, which is why `order_lines.variant_id` must be nullable rather than assumed always resolvable.

### Refunds — real payload structure

Found 3 real refunded HABB orders (`#1065`, `#1004`, `#1003`). Example (`#1065`, refund note "Commande annulée"):

```
Refund.totalRefundedSet = 26.99 EUR
  refundLineItems:
    - quantity: 1
      priceSet: 19.99 EUR
      subtotalSet: 19.99 EUR
      totalTaxSet: 3.47 EUR
      lineItem: { id, sku: "GEN-022", title: "Puzzle Photo 300 Pièces", variant: { id } }
```

`RefundLineItem` carries exactly what's needed to compute net revenue/margin per product from a refund, not just per order: `quantity`, `priceSet` (refunded price), `subtotalSet`, `totalTaxSet`, and a direct `lineItem` reference. **This justifies creating `refund_lines`** — without it, a refund could only ever be netted against the whole order, never against the specific product/variant it affects.

Note: `RefundLineItem.id` is a **nullable** field in Shopify's schema (unlike almost every other `id` in the API) — it cannot be relied on as a guaranteed external key. `refund_lines` uniqueness is therefore scoped to `(refund_id, order_line_id)`, not to a Shopify-provided refund-line ID.

### Tax / TVA — real structure

Queried `Order.taxesIncluded` and `LineItem.taxLines` on a real order (`#1069`):

```
Order.taxesIncluded = true
LineItem "Coque personnalisée – Samsung Galaxy S23+":
  originalUnitPriceSet = 25.00 EUR
  taxLines: [{ title: "BE TVA", rate: 0.21, priceSet: 4.34 EUR }]
```

**Confirmed: HABB's Shopify prices are TTC (tax-inclusive).** `order_lines.unit_price` must be documented as TTC, not HT — computing "Net sales HT" later means *subtracting* the real captured `tax_amount`, never applying a guessed 21% to a price that might already exclude tax for a different merchant/vertical. The real tax amount (`4.34 EUR`), not the rate, is what gets stored — the rate can vary by product/region and inferring HT from a hardcoded rate would violate "never invent missing data."

## Phase 1 required tables (this migration) — 11 tables

`merchants`, `locations`, `products`, `variants`, `inventory_snapshots`, `orders`, `order_lines`, `refunds`, `refund_lines`, `product_costs`, `data_quality_flags`.

(`refund_lines` is new this revision, justified by the real refund payload above — 10 → 11 tables.)

## Static review — original 8 rules, still holding

1. `sku` nullable, never a logical/primary key — ✅ (now also true for `sku_snapshot` on `order_lines`).
2. `barcode` nullable, never a reliable identifier — ✅ still not stored in Phase 1.
3. Shopify `source_id` is the stable external reference — ✅, and now also on `order_lines` and `refunds`.
4. Locations joinable via `source_system + source_id` — ✅.
5. `validation_status = 'estimated'` never presented as a certain margin — ✅ (`comment on column`, unchanged).
6. Missing cost = `UNCLASSIFIED` — ✅ unchanged.
7. Refunds cleanly attached to an order — ✅, and now also refund **lines** cleanly attached to the specific order line via `refund_lines.order_line_id`.
8. No unnecessary customer PII — ✅ unchanged.

## New rules checked this revision

9. **Multi-merchant safety** — no external ID (`source_id`) is trusted as globally unique on its own anywhere in the schema. It is always scoped: `variants` by `(merchant_id, source_system, source_id)`; `order_lines`/`refunds` by their parent `order_id` (which itself is merchant-scoped) — scoping through the parent avoids duplicating `merchant_id` on every child table while keeping the same guarantee.
10. **Historical order lines survive catalog changes** — `order_lines.variant_id` is nullable; `title_snapshot`/`sku_snapshot` preserve what was actually sold regardless of what happens to the catalog later.
11. **Tax amounts are captured, never inferred** — `order_lines.tax_amount` stores the real value from Shopify's `taxLines`; no VAT rate is hardcoded anywhere in the schema.

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
  merchant_id uuid not null references merchants(id),
  sku text,
  title text,
  attributes jsonb not null default '{}'::jsonb,
  source_system text not null,
  source_id text not null,
  unique (merchant_id, source_system, source_id)
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
  taxes_included boolean not null,
  unique (merchant_id, source_system, source_id)
);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  variant_id uuid references variants(id),
  source_system text not null,
  source_id text not null,
  title_snapshot text not null,
  sku_snapshot text,
  quantity integer not null,
  unit_price numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  unique (order_id, source_system, source_id)
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  source_system text not null,
  source_id text not null,
  amount numeric(12,2) not null,
  refunded_at timestamptz not null,
  reason text,
  unique (order_id, source_system, source_id)
);

create table refund_lines (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references refunds(id),
  order_line_id uuid not null references order_lines(id),
  quantity integer not null,
  amount numeric(12,2) not null,
  tax_amount numeric(12,2) not null default 0,
  currency text not null,
  unique (refund_id, order_line_id)
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
  'Nullable by design. Not a join key and never unique-constrained — confirmed null on some HABB variants and populated on others (e.g. SKU "GEN-022" on a Puzzle product). Identity for sync/joins is merchant_id + source_system + source_id.';

comment on column order_lines.variant_id is
  'Nullable: a historical order line must survive even if its variant/product is later deleted, or if the line represents a custom item with no catalog variant. Use title_snapshot/sku_snapshot to know what was actually sold when variant_id is null.';

comment on column order_lines.unit_price is
  'Captured exactly as Shopify recorded it at order time. Whether this is tax-inclusive (TTC) or exclusive (HT) is given by the parent orders.taxes_included — for HABB, confirmed true (TTC). Never assume HT without checking that flag.';

comment on column order_lines.tax_amount is
  'The real tax amount captured from Shopify taxLines for this line, never a rate applied after the fact. Used to derive Net sales HT without inventing a VAT rate.';

comment on column product_costs.validation_status is
  'Trust level for unit_cost, independent of source. estimated must never be displayed or computed as a certain margin — any metric built on an estimated or unverified cost must carry that same caveat forward, not present a clean number.';

comment on column refunds.order_id is
  'Not null and FK-enforced: a refund can only exist attached to a real order row. A refund with no matching source order is a data-quality violation to catch during sync, not a valid row to insert.';

comment on column refund_lines.order_line_id is
  'Links a refund to the specific order line it affects, enabling net revenue/margin per product/variant — not just per order. Shopify RefundLineItem.id is itself nullable and cannot be used as the external key, so uniqueness here is scoped to (refund_id, order_line_id) instead.';

alter table merchants enable row level security;
alter table locations enable row level security;
alter table products enable row level security;
alter table variants enable row level security;
alter table inventory_snapshots enable row level security;
alter table orders enable row level security;
alter table order_lines enable row level security;
alter table refunds enable row level security;
alter table refund_lines enable row level security;
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
| `Product.vendor`, `Product.productType` | — | **Missing** (not modeled in Phase 1) |
| `ProductVariant.id` | `variants.source_id` | Available |
| `ProductVariant.sku` | `variants.sku` / `order_lines.sku_snapshot` | Available as a column, **inconsistent in practice** — null on some HABB variants, populated on others. Never a required join key. |
| `ProductVariant.barcode` | — | **Missing** (not modeled) — looks auto-generated, not a real barcode. |
| `ProductVariant.price` (current catalog price) | — | **Missing** — only the historical transaction price is modeled (`order_lines.unit_price`). |
| `LineItem.id` | `order_lines.source_id` | Available — always present, confirmed on real orders. |
| `LineItem.title` | `order_lines.title_snapshot` | Available — always present at order time. |
| `LineItem.taxLines` | `order_lines.tax_amount` | Available — real captured amount, confirmed (e.g. 4.34 EUR at 21% BE TVA). |
| `Order.taxesIncluded` | `orders.taxes_included` | **Available and confirmed `true` for HABB** — prices are TTC. |
| `InventoryItem.unitCost` | `product_costs.unit_cost` (`source='shopify_unit_cost'`) | Available and confirmed populated (e.g. 10.06 EUR) — `validation_status` starts `'unverified'`. |
| `InventoryItem.tracked` | — | **Missing** (not modeled) |
| `Location.id` | `locations.source_id` | Available |
| `Location.name` | `locations.name` | Available |
| `InventoryLevel` (location × item quantity) | `inventory_snapshots.quantity` + `location_id` | Available |
| `Order.id` | `orders.source_id` | Available |
| `Order.name` (e.g. `#1070`) | — | **Missing** (not modeled) |
| `Order.createdAt` | `orders.ordered_at` | Available |
| `Order.currencyCode` | `orders.currency` | Available |
| `Order.financialStatus` | `orders.status` | Available |
| `Order.fulfillmentStatus` | — | **Missing** (not needed for revenue/margin/refund metrics) |
| `Order.customer` (any field) | — | **Missing by design** — no PII in Phase 1. |
| `Refund.id` | `refunds.source_id` | Available |
| `Refund.totalRefundedSet` | `refunds.amount` | Available |
| `RefundLineItem.id` | — | **Not usable as a key** — nullable in Shopify's own schema; `refund_lines` uniqueness uses `(refund_id, order_line_id)` instead. |
| `RefundLineItem.quantity`, `.priceSet`, `.subtotalSet`, `.totalTaxSet`, `.lineItem` | `refund_lines.quantity/amount/tax_amount` + `order_line_id` | **Available and confirmed** on a real refunded HABB order. |

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
