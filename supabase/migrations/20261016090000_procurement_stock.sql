-- 20261016090000_procurement_stock.sql
-- Stock / Achats / Fournisseurs (Chantier C). NOT APPLIED to any real database: awaiting owner approval (staging first).
-- Mirrors the rules of src/procurement (memory store = reference implementation). Additive only; touches no existing table.
-- Rollback: supabase/rollback/20261016090000_procurement_stock.down.sql (drops only the proc_* objects created here).
--
-- Guarantees enforced BY THE DATABASE (not just by application code):
--   * every row carries merchant_id; cross-table references are tenant-composite (id, merchant_id);
--   * the stock movement ledger is append-only (no UPDATE / DELETE / TRUNCATE) and unique per (merchant_id, idempotency_key);
--   * balances are maintained by a trigger on the ledger and can never go negative nor have reserved above on-hand
--     (a violating movement aborts its whole transaction; concurrent writers serialise on the balance row);
--   * purchase-order status follows the legal transition table; received quantities can never exceed ordered quantities;
--   * an approval id can be consumed once; an idempotency key stores the request fingerprint;
--   * RLS is enabled with NO policy: access is service-role only, as for fin_*.
-- Money: bigint minor units for totals, bigint micro units (1e-6) for unit prices, never floating point.

create table proc_items (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  sku text not null check (length(btrim(sku)) between 1 and 64),
  name text not null check (length(btrim(name)) between 1 and 200),
  barcode text check (barcode is null or length(barcode) between 1 and 32),
  variant_ref text,
  status text not null default 'ACTIVE' check (status in ('PROSPECT', 'ACTIVE', 'ARCHIVED')),
  reorder_point integer check (reorder_point is null or reorder_point >= 0),
  reorder_qty integer check (reorder_qty is null or reorder_qty > 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (id, merchant_id),
  unique (merchant_id, sku)
);
create unique index proc_items_barcode_uq on proc_items (merchant_id, barcode) where barcode is not null;

create table proc_locations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null check (length(btrim(name)) between 1 and 100),
  type text not null check (type in ('STORE', 'BACKROOM', 'WAREHOUSE', 'TRANSIT', 'QUARANTINE')),
  created_at timestamptz not null default now(),
  unique (id, merchant_id)
);
create unique index proc_locations_name_uq on proc_locations (merchant_id, lower(name));

create table proc_suppliers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  country char(2),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  incoterm_default text check (incoterm_default in ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  deposit_bps integer check (deposit_bps is null or deposit_bps between 0 and 10000),
  lead_time_days integer check (lead_time_days is null or lead_time_days between 0 and 730),
  -- soft link to Finance's identity record (fin_companies); Finance owns supplier identity, this table owns the commercial profile
  finance_company_id uuid,
  contacts jsonb not null default '[]'::jsonb check (jsonb_typeof(contacts) = 'array'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (id, merchant_id)
);
create unique index proc_suppliers_name_uq on proc_suppliers (merchant_id, lower(name));

create table proc_supplier_items (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  supplier_id uuid not null,
  item_id uuid not null,
  supplier_sku text,
  moq integer check (moq is null or moq > 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days between 0 and 730),
  created_at timestamptz not null default now(),
  foreign key (supplier_id, merchant_id) references proc_suppliers (id, merchant_id),
  foreign key (item_id, merchant_id) references proc_items (id, merchant_id),
  unique (merchant_id, supplier_id, item_id)
);

-- Every quote revision is kept: this table IS the negotiated-price history.
create table proc_quotes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  supplier_id uuid not null,
  item_id uuid not null,
  revision integer not null check (revision >= 1),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  tiers jsonb not null check (jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) between 1 and 20), -- [{minQty, unitPriceMicro}] strictly increasing minQty
  moq integer check (moq is null or moq > 0),
  incoterm text check (incoterm in ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  lead_time_days integer check (lead_time_days is null or lead_time_days between 0 and 730),
  valid_until date,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'SELECTED', 'SUPERSEDED')),
  provenance text not null check (provenance in ('SUPPLIER_CLAIM', 'USER_PROVIDED', 'DOCUMENT_OBSERVED')),
  reason text,
  recorded_by text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  foreign key (supplier_id, merchant_id) references proc_suppliers (id, merchant_id),
  foreign key (item_id, merchant_id) references proc_items (id, merchant_id),
  unique (id, merchant_id),
  unique (merchant_id, supplier_id, item_id, revision)
);

create table proc_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  number text not null,
  supplier_id uuid not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  incoterm text check (incoterm in ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  expected_date date not null,
  original_expected_date date not null,
  date_changes jsonb not null default '[]'::jsonb,
  destination_location_id uuid not null,
  deposit_bps integer not null default 0 check (deposit_bps between 0 and 10000),
  fx jsonb, -- {from, to:'EUR', rate, date, source}: explicit, never assumed
  total_minor bigint not null check (total_minor >= 0),
  supplier_reference text,
  ordered_at timestamptz,
  closed_short boolean not null default false,
  close_reason text,
  cancel_reason text,
  created_by text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  foreign key (supplier_id, merchant_id) references proc_suppliers (id, merchant_id),
  foreign key (destination_location_id, merchant_id) references proc_locations (id, merchant_id),
  unique (id, merchant_id),
  unique (merchant_id, number)
);

create table proc_po_lines (
  merchant_id uuid not null,
  po_id uuid not null,
  line_id text not null,
  item_id uuid not null,
  qty integer not null check (qty > 0),
  unit_price_micro bigint not null check (unit_price_micro > 0),
  total_minor bigint not null check (total_minor >= 0),
  quote_id uuid,
  price_source text not null check (price_source in ('QUOTE', 'MANUAL')),
  qty_received integer not null default 0,
  qty_defective integer not null default 0,
  primary key (po_id, line_id),
  foreign key (po_id, merchant_id) references proc_purchase_orders (id, merchant_id),
  foreign key (item_id, merchant_id) references proc_items (id, merchant_id),
  foreign key (quote_id, merchant_id) references proc_quotes (id, merchant_id),
  constraint proc_po_line_received_le_ordered check (qty_received between 0 and qty),
  constraint proc_po_line_defective_le_received check (qty_defective between 0 and qty_received),
  unique (po_id, item_id)
);

create table proc_po_schedule (
  merchant_id uuid not null,
  po_id uuid not null,
  kind text not null check (kind in ('DEPOSIT', 'BALANCE')),
  amount_minor bigint not null check (amount_minor >= 0),
  due_event text not null check (due_event in ('ON_ORDER', 'ON_RECEIPT')),
  status text not null default 'PLANNED' check (status in ('PLANNED', 'DUE', 'PAID_LINKED')),
  payment_ref text, -- a Finance payment reference: paying stays in Finance (FINANCE.pay_supplier)
  paid_amount_minor bigint check (paid_amount_minor is null or paid_amount_minor > 0),
  paid_at date,
  primary key (po_id, kind),
  foreign key (po_id, merchant_id) references proc_purchase_orders (id, merchant_id),
  check ((status = 'PAID_LINKED') = (payment_ref is not null))
);

create table proc_receipts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  po_id uuid not null,
  supplier_id uuid not null,
  received_at date not null,
  promised_date date not null,
  on_time boolean not null,
  location_id uuid not null,
  quarantine_location_id uuid,
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) > 0),
  idempotency_key text not null,
  approval_id text not null,
  recorded_by text not null,
  created_at timestamptz not null default now(),
  foreign key (po_id, merchant_id) references proc_purchase_orders (id, merchant_id),
  foreign key (location_id, merchant_id) references proc_locations (id, merchant_id),
  unique (merchant_id, idempotency_key)
);

-- THE LEDGER. Append-only. Every balance is derived from it.
create table proc_stock_movements (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  idempotency_key text not null,
  group_id uuid,
  at timestamptz not null default now(),
  item_id uuid not null,
  location_id uuid not null,
  bucket text not null check (bucket in ('ON_HAND', 'RESERVED')),
  delta integer not null check (delta <> 0),
  kind text not null check (kind in ('RECEIPT', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'DEFECT_QUARANTINE_OUT', 'DEFECT_QUARANTINE_IN', 'COUNT_ADJUST', 'RESERVE', 'RELEASE')),
  reason text,
  reference jsonb,
  cost_status text not null default 'UNKNOWN' check (cost_status in ('CONFIRMED', 'ESTIMATED', 'UNKNOWN')),
  unit_cost_eur_micro bigint check (unit_cost_eur_micro is null or unit_cost_eur_micro >= 0),
  actor_id text not null,
  approval_id text,
  foreign key (item_id, merchant_id) references proc_items (id, merchant_id),
  foreign key (location_id, merchant_id) references proc_locations (id, merchant_id),
  check ((kind in ('RESERVE', 'RELEASE')) = (bucket = 'RESERVED')),
  check (cost_status = 'UNKNOWN' or unit_cost_eur_micro is not null),
  unique (merchant_id, idempotency_key)
);
create index proc_stock_movements_item_idx on proc_stock_movements (merchant_id, item_id, location_id);

-- Balances: maintained ONLY by the trigger below. The constraints make an impossible state unrepresentable.
create table proc_stock_balances (
  merchant_id uuid not null,
  item_id uuid not null,
  location_id uuid not null,
  on_hand integer not null default 0,
  reserved integer not null default 0,
  primary key (merchant_id, item_id, location_id),
  foreign key (item_id, merchant_id) references proc_items (id, merchant_id),
  foreign key (location_id, merchant_id) references proc_locations (id, merchant_id),
  constraint proc_balance_nonneg check (on_hand >= 0 and reserved >= 0),
  constraint proc_balance_reserved_le_onhand check (reserved <= on_hand)
);

create function proc_apply_movement() returns trigger language plpgsql as $$
begin
  -- Two steps on purpose: INSERT .. ON CONFLICT DO UPDATE checks the table constraints on the PROPOSED row (a bare delta such as reserved = 6, on_hand = 0),
  -- which would refuse legal movements. So: make sure the row exists at (0, 0), then UPDATE it. The UPDATE takes the row lock, so concurrent movements
  -- for one (item, location) serialise here, and the constraints are evaluated on the resulting balance.
  insert into proc_stock_balances (merchant_id, item_id, location_id) values (new.merchant_id, new.item_id, new.location_id) on conflict do nothing;
  update proc_stock_balances
     set on_hand = on_hand + case when new.bucket = 'ON_HAND' then new.delta else 0 end,
         reserved = reserved + case when new.bucket = 'RESERVED' then new.delta else 0 end
   where merchant_id = new.merchant_id and item_id = new.item_id and location_id = new.location_id;
  return new;
end $$;
create trigger proc_stock_movements_apply before insert on proc_stock_movements for each row execute function proc_apply_movement();

create function proc_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op using errcode = 'restrict_violation';
end $$;
create trigger proc_stock_movements_immutable before update or delete on proc_stock_movements for each row execute function proc_forbid_change();
create trigger proc_stock_movements_no_truncate before truncate on proc_stock_movements for each statement execute function proc_forbid_change();

-- Audit journal (append-only) and one-shot tables
create table proc_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  at timestamptz not null default now(),
  type text not null,
  actor jsonb not null,
  object jsonb not null,
  approval jsonb,
  detail jsonb not null default '{}'::jsonb,
  idempotency_key text not null
);
create index proc_events_object_idx on proc_events (merchant_id, ((object ->> 'id')));
create trigger proc_events_immutable before update or delete on proc_events for each row execute function proc_forbid_change();
create trigger proc_events_no_truncate before truncate on proc_events for each statement execute function proc_forbid_change();

create table proc_idempotency (
  merchant_id uuid not null references merchants(id),
  idempotency_key text not null,
  command text not null,
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, idempotency_key)
);

create table proc_approvals_used (
  merchant_id uuid not null references merchants(id),
  approval_id text not null,
  consumed_at timestamptz not null default now(),
  primary key (merchant_id, approval_id) -- a second consumption violates the key: an approval is single-use
);

create table proc_incidents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  supplier_id uuid not null,
  po_id uuid,
  type text not null check (type in ('QUALITY', 'DELAY', 'DOCUMENT', 'OTHER')),
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH')),
  description text not null check (length(btrim(description)) between 5 and 1000),
  at timestamptz not null default now(),
  recorded_by text not null,
  foreign key (supplier_id, merchant_id) references proc_suppliers (id, merchant_id),
  foreign key (po_id, merchant_id) references proc_purchase_orders (id, merchant_id)
);

create table proc_sequences (
  merchant_id uuid not null references merchants(id),
  name text not null,
  value integer not null default 0,
  primary key (merchant_id, name)
);
-- Atomic gapless-per-year number: the upsert locks the row, so two sessions never get the same number.
create function proc_next_number(p_merchant uuid, p_name text) returns integer language sql as $$
  insert into proc_sequences as s (merchant_id, name, value) values (p_merchant, p_name, 1)
  on conflict (merchant_id, name) do update set value = s.value + 1
  returning value;
$$;

-- Purchase-order status: only the legal moves (mirror of PO_TRANSITIONS in src/procurement/service.js).
create function proc_po_transition_guard() returns trigger language plpgsql as $$
begin
  if new.status <> old.status then
    if not (
      (old.status = 'DRAFT' and new.status in ('PENDING_APPROVAL', 'CANCELLED')) or
      (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED', 'DRAFT', 'CANCELLED')) or
      (old.status = 'APPROVED' and new.status in ('ORDERED', 'CANCELLED')) or
      (old.status = 'ORDERED' and new.status in ('CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')) or
      (old.status = 'CONFIRMED' and new.status in ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')) or
      (old.status = 'PARTIALLY_RECEIVED' and new.status in ('RECEIVED', 'CLOSED')) or
      (old.status = 'RECEIVED' and new.status = 'CLOSED')
    ) then
      raise exception 'illegal purchase order transition % -> %', old.status, new.status using errcode = 'check_violation';
    end if;
  end if;
  new.version := old.version + 1;
  return new;
end $$;
create trigger proc_po_transition before update on proc_purchase_orders for each row execute function proc_po_transition_guard();

alter table proc_items enable row level security;
alter table proc_locations enable row level security;
alter table proc_suppliers enable row level security;
alter table proc_supplier_items enable row level security;
alter table proc_quotes enable row level security;
alter table proc_purchase_orders enable row level security;
alter table proc_po_lines enable row level security;
alter table proc_po_schedule enable row level security;
alter table proc_receipts enable row level security;
alter table proc_stock_movements enable row level security;
alter table proc_stock_balances enable row level security;
alter table proc_events enable row level security;
alter table proc_idempotency enable row level security;
alter table proc_approvals_used enable row level security;
alter table proc_incidents enable row level security;
alter table proc_sequences enable row level security;
