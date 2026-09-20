-- 20260920131858_phase1_schema.sql
-- Phase 1 schema for retail-ai-core — approved for first migration, DEV project only.
-- Source of truth / review history: supabase/proposal/schema.md
-- 11 tables. No metrics/decision/outcome tables. No customer PII.

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
