-- Stock movement ledger for Finance sales (standalone B2B invoices, credit-note restocks).
-- Shopify / Retail Core stays the inventory source of truth; this table only records what Finance asked Shopify to adjust, once.
-- Audit chain: document -> line -> variant -> location -> quantity -> Shopify adjustment. Append-only: only the status fields may change.

create table fin_stock_movements (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  document_id uuid not null references fin_documents(id),
  document_number text,
  document_type text not null check (document_type in ('invoice', 'credit_note')),
  line_position integer not null,
  kind text not null check (kind in ('SALE_DECREMENT', 'RETURN_RESTOCK')),
  variant_id uuid,
  variant_source_id text,
  sku text,
  location_id uuid,
  location_source_id text,
  quantity integer not null check (quantity >= 0),
  delta integer not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPLYING', 'APPLIED', 'FAILED', 'UNCERTAIN', 'SKIPPED')),
  error text,
  idempotency_key text not null,
  shopify_adjustment_id text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  check ((kind = 'SALE_DECREMENT' and delta <= 0) or (kind = 'RETURN_RESTOCK' and delta >= 0))
);
-- The same document line can produce a given kind of movement only once: this is the idempotency guarantee.
create unique index fin_stock_movements_key_uq on fin_stock_movements (merchant_id, idempotency_key);
create index fin_stock_movements_doc_idx on fin_stock_movements (merchant_id, document_id);
create index fin_stock_movements_status_idx on fin_stock_movements (merchant_id, status);

create function fin_stock_movements_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'stock movements are append-only'; end if;
  if new.merchant_id is distinct from old.merchant_id or new.document_id is distinct from old.document_id
     or new.line_position is distinct from old.line_position or new.kind is distinct from old.kind
     or new.variant_id is distinct from old.variant_id or new.variant_source_id is distinct from old.variant_source_id
     or new.quantity is distinct from old.quantity or new.delta is distinct from old.delta
     or new.idempotency_key is distinct from old.idempotency_key or new.created_at is distinct from old.created_at then
    raise exception 'stock movement content is immutable';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'PENDING' and new.status in ('APPLYING', 'SKIPPED', 'FAILED'))
    or (old.status = 'APPLYING' and new.status in ('APPLIED', 'FAILED', 'UNCERTAIN'))
    or (old.status = 'FAILED' and new.status = 'PENDING')
    or (old.status = 'UNCERTAIN' and new.status in ('PENDING', 'APPLIED'))) then
    raise exception 'invalid stock movement transition % -> %', old.status, new.status;
  end if;
  return new;
end $$;
create trigger fin_stock_movements_guard_trg before update or delete on fin_stock_movements
  for each row execute function fin_stock_movements_guard();

alter table fin_stock_movements enable row level security;
