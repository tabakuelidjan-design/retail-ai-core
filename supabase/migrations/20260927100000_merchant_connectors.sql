-- M1 (ADR 0003): merchant_connectors - optional connections between a Nordla tenant (merchants.id) and the outside world.
-- Additive only: creates one table, one trigger function and backfills one Shopify connector per existing Shopify merchant.
-- Does NOT touch merchants (no UUID change, merchants.source_system / source_id / source_domain untouched), no business table.
-- M2 (making merchants.source_* optional) is out of scope.

create table merchant_connectors (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: a merchant that still has connectors cannot be deleted (unlink first); a tenant is never removed implicitly.
  merchant_id uuid not null references merchants(id) on delete restrict,
  -- open set (shopify, woocommerce, prestashop, odoo, peppol, bank, csv, ...): a format check, not an enum, so a new connector
  -- needs no migration.
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- stable id in the external system (Shopify: shop GID). NULL for kinds without a natural id (bank, csv, ...); never blank.
  external_id text check (external_id is null or btrim(external_id) <> ''),
  external_domain text,  -- informational only, never used for identity
  -- persisted states only. UNAVAILABLE is a runtime state and is never written (ADR 0003 section 4.3).
  status text not null default 'NOT_CONFIGURED' check (status in ('CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED')),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),  -- non-secret settings only (enforced in code)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one external object (e.g. one Shopify shop) belongs to exactly one tenant. NULL external_id values do not collide.
  -- (UNIQUE(merchant_id, kind, external_id) is intentionally absent: it is implied by this constraint.)
  constraint merchant_connectors_kind_external_uq unique (kind, external_id)
);

-- "load this tenant's connectors" lookups
create index merchant_connectors_merchant_kind_idx on merchant_connectors (merchant_id, kind);

-- A connector can never be moved to another tenant or re-pointed to another external object; updated_at follows every update.
create function merchant_connectors_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merchant_id is distinct from old.merchant_id or new.kind is distinct from old.kind or new.external_id is distinct from old.external_id then
    raise exception 'merchant_connectors: merchant_id, kind and external_id are immutable (link a new connector instead)' using errcode = 'integrity_constraint_violation';
  end if;
  new.updated_at = now();
  return new;
end $$;
create trigger merchant_connectors_guard_trg before update on merchant_connectors for each row execute function merchant_connectors_guard();

comment on table merchant_connectors is
  'Optional connections of a Nordla tenant (merchants.id) to external systems. Never defines the tenant. config holds no secret (secrets stay in environment variables / a vault).';

alter table merchant_connectors enable row level security;  -- no policy: service role only, like every other table

-- Backfill: one Shopify connector per existing Shopify merchant. Idempotent (ON CONFLICT DO NOTHING), no duplicate, no delete,
-- no update of merchants. Merchants without a Shopify source get no connector.
insert into merchant_connectors (merchant_id, kind, external_id, external_domain, status)
select m.id, 'shopify', m.source_id, m.source_domain, 'CONFIGURED'
from merchants m
where m.source_system = 'shopify' and nullif(btrim(m.source_id), '') is not null
on conflict (kind, external_id) do nothing;
