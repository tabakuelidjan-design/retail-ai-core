-- Additive migration (Phase 2B): the category / product-age dimensions demand
-- analysis needs. Nothing existing is altered or removed. Vendor and tags are
-- deliberately NOT captured: they are supplier / free-form concepts outside 2B.

alter table products add column product_type text;
alter table products add column source_created_at timestamptz;
alter table products add column source_status text;

comment on column products.product_type is
  'Single-valued category from the source system (Shopify productType). Nullable: empty means UNCLASSIFIED, never guessed.';
comment on column products.source_created_at is
  'When the product was created in the source system. Used so a recently added product is not judged slow-moving; not a sales date.';
comment on column products.source_status is
  'Source-system lifecycle status (e.g. ACTIVE, DRAFT, ARCHIVED).';

-- Collections overlap (one product can sit in several), so they are memberships,
-- not a partition. Identity is the source collection id, never the title.
create table product_collections (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  product_id uuid not null references products(id),
  source_system text not null,
  source_id text not null,
  title text not null,
  is_current boolean not null default true,
  synced_at timestamptz not null default now(),
  unique (product_id, source_system, source_id)
);

comment on column product_collections.is_current is
  'False when a later full catalog sync no longer saw this membership. Rows are kept, never deleted.';

alter table product_collections enable row level security;
