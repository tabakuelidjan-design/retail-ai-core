-- NORDLA CORE P0 - PREPARED, NOT APPLIED (supabase/migrations-pending/). Owner authorization required before it is moved to supabase/migrations.
--
-- Persistence for the objects that only lived in memory (docs/architecture/nordla-integration-pre-china.md §6.2) and for the China Sourcing
-- cases (§6.5: single-tenant, file based). Every row belongs to ONE merchant (merchant_id, FK merchants, never null); nothing here is HABB
-- specific. The JSON body is the frozen object the integration code already builds (src/integration/handoffs.js, ledger.js); the columns
-- beside it are the keys the server queries and the invariants the database enforces on its own:
--   - a purchase plan never says an order was placed, an incoming expectation is never counted as available (this phase prepares, it never buys);
--   - a plan only moves PLANNED -> APPROVED_TO_ORDER, and an approval cannot be removed;
--   - the trace ledger is append-only and hash-chained per merchant (seq = previous + 1, prev = previous hash);
--   - a sourcing case keeps the optimistic revision of the file store (rev = previous + 1).
-- Access: the server's service role only (RLS on, anon/authenticated revoked; the restrictive tenant policies come with 20261015091000).

-- ------------------------------------------------------------------ integration objects
create table integration_buy_candidates (
  merchant_id uuid not null references merchants(id) on delete restrict,
  case_ref text not null,
  supplier_ref text,
  verdict text not null check (verdict in ('GO', 'CONDITIONAL_GO')),
  state text not null check (state = 'BUY_CANDIDATE'),
  approval jsonb not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, case_ref)
);

create table integration_purchase_plans (
  merchant_id uuid not null references merchants(id) on delete restrict,
  purchase_ref text not null,
  handoff_id text not null,
  sourcing_case_ref text,
  product_ref text,
  supplier_ref text,
  status text not null check (status in ('PLANNED', 'APPROVED_TO_ORDER')),
  owner_review text not null check (owner_review in ('PENDING', 'APPROVED')),
  qty integer not null check (qty > 0),
  eta date not null,
  order_placed boolean not null default false check (order_placed = false),   -- a plan is a preparation: never an order
  approval jsonb,
  body jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, purchase_ref),
  constraint integration_purchase_plans_approval_ck check ((status = 'APPROVED_TO_ORDER') = (approval is not null and owner_review = 'APPROVED'))
);

create table integration_incoming_expectations (
  merchant_id uuid not null references merchants(id) on delete restrict,
  expectation_id text not null,
  purchase_ref text not null,
  product_ref text,
  supplier_ref text,
  qty integer not null check (qty > 0),
  eta date not null,
  state text not null check (state = 'EXPECTED'),
  counted_in_available boolean not null default false check (counted_in_available = false), -- incoming goods are not stock
  received_qty integer not null default 0 check (received_qty = 0),                     -- receipts are not part of this phase
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, expectation_id),
  foreign key (merchant_id, purchase_ref) references integration_purchase_plans (merchant_id, purchase_ref) on delete restrict
);

create table integration_campaign_contracts (
  merchant_id uuid not null references merchants(id) on delete restrict,
  campaign_ref text not null,
  product_ref text not null,
  channel text,
  ready_for_creative boolean not null,
  owner_review text not null check (owner_review = 'PENDING'),
  published boolean not null default false check (published = false),
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, campaign_ref)
);

create table integration_tracking_definitions (
  merchant_id uuid not null references merchants(id) on delete restrict,
  tracking_id text not null,
  campaign_ref text not null,
  state text not null check (state = 'DEFINED_NOT_ACTIVE'),
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, tracking_id),
  foreign key (merchant_id, campaign_ref) references integration_campaign_contracts (merchant_id, campaign_ref) on delete restrict
);

create table integration_trace_ledger (
  merchant_id uuid not null references merchants(id) on delete restrict,
  seq bigint not null check (seq > 0),
  at timestamptz not null,
  workflow_id text not null,
  source_module text not null,
  destination_module text,
  action text not null,
  outcome text not null check (outcome in ('OK', 'BLOCKED', 'REVIEW_REQUIRED', 'APPROVAL_REQUIRED', 'ERROR', 'MODULE_NOT_AVAILABLE', 'NEEDS_CLARIFICATION')),
  entry jsonb not null,                                -- the entry exactly as src/integration/ledger.js built it (without its hash)
  prev text not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  primary key (merchant_id, seq)
);
create index integration_trace_ledger_workflow_idx on integration_trace_ledger (merchant_id, workflow_id);

-- ------------------------------------------------------------------ China Sourcing cases (the file store, per merchant)
create table sourcing_cases (
  merchant_id uuid not null references merchants(id) on delete restrict,
  case_id text not null check (case_id ~ '^[A-Za-z0-9_-]{1,80}$'),   -- same rule as src/sourcing/store/file-store.js
  rev integer not null check (rev > 0),
  state jsonb not null,
  working_name text,
  supplier_name text,
  last_verdict text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, case_id),
  constraint sourcing_cases_state_id_ck check (state ->> 'id' = case_id)
);
create index sourcing_cases_recent_idx on sourcing_cases (merchant_id, updated_at desc);

-- ------------------------------------------------------------------ guards
-- Keys never move to another merchant or another reference; a purchase plan only moves forward; an approval is never removed.
create function integration_purchase_plans_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merchant_id is distinct from old.merchant_id or new.purchase_ref is distinct from old.purchase_ref or new.handoff_id is distinct from old.handoff_id then
    raise exception 'INTEGRATION_KEY_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.status = 'APPROVED_TO_ORDER' and new is distinct from old then
    raise exception 'PURCHASE_PLAN_APPROVED_IS_FINAL' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger integration_purchase_plans_guard before update on integration_purchase_plans for each row execute function integration_purchase_plans_guard();

-- Objects that are written once (a new version is a new reference): no update, no delete.
create function integration_write_once() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'INTEGRATION_OBJECT_WRITE_ONCE: % on %', tg_op, tg_table_name using errcode = 'P0001';
end $$;
create trigger integration_buy_candidates_write_once before update or delete on integration_buy_candidates for each row execute function integration_write_once();
create trigger integration_incoming_write_once before update or delete on integration_incoming_expectations for each row execute function integration_write_once();
create trigger integration_campaigns_write_once before update or delete on integration_campaign_contracts for each row execute function integration_write_once();
create trigger integration_tracking_write_once before update or delete on integration_tracking_definitions for each row execute function integration_write_once();
create trigger integration_ledger_append_only before update or delete on integration_trace_ledger for each row execute function integration_write_once();
create trigger integration_ledger_no_truncate before truncate on integration_trace_ledger for each statement execute function integration_write_once();

-- The ledger chain: one writer at a time per merchant (advisory lock), seq = last + 1, prev = last hash ('GENESIS' for the first entry).
create function integration_trace_ledger_chain() returns trigger language plpgsql set search_path = '' as $$
declare last_seq bigint; last_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('integration_trace_ledger:' || new.merchant_id::text, 0));
  select l.seq, l.hash into last_seq, last_hash from public.integration_trace_ledger l where l.merchant_id = new.merchant_id order by l.seq desc limit 1;
  if new.seq <> coalesce(last_seq, 0) + 1 then raise exception 'LEDGER_SEQ_GAP: expected %, got %', coalesce(last_seq, 0) + 1, new.seq using errcode = 'P0001'; end if;
  if new.prev <> coalesce(last_hash, 'GENESIS') then raise exception 'LEDGER_CHAIN_BROKEN at seq %', new.seq using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger integration_trace_ledger_chain before insert on integration_trace_ledger for each row execute function integration_trace_ledger_chain();

-- Sourcing: the optimistic revision of the file store (two devices editing one case -> the second write is a CONFLICT, nothing is overwritten).
create function sourcing_cases_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merchant_id is distinct from old.merchant_id or new.case_id is distinct from old.case_id then
    raise exception 'SOURCING_CASE_KEY_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.rev <> old.rev + 1 then raise exception 'SOURCING_CASE_CONFLICT: stored rev %, written rev %', old.rev, new.rev using errcode = 'P0001'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger sourcing_cases_guard before update on sourcing_cases for each row execute function sourcing_cases_guard();

create function sourcing_cases_insert_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.rev <> 1 then raise exception 'SOURCING_CASE_FIRST_REV_IS_1' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger sourcing_cases_insert_guard before insert on sourcing_cases for each row execute function sourcing_cases_insert_guard();

-- ------------------------------------------------------------------ access: service role only
do $$
declare t text;
begin
  foreach t in array array['integration_buy_candidates', 'integration_purchase_plans', 'integration_incoming_expectations', 'integration_campaign_contracts',
                           'integration_tracking_definitions', 'integration_trace_ledger', 'sourcing_cases'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

comment on table integration_trace_ledger is 'Cross-module trace ledger (append-only, hash-chained per merchant). Mirrors src/integration/ledger.js.';
comment on table sourcing_cases is 'China Sourcing cases per merchant (replaces data/local/sourcing/cases/*.json when the hosted server is switched to the database store).';
