-- Bank & Treasury (READ ONLY). Account information only: no payment initiation exists anywhere in this schema or application.
-- The bank token (if a provider is connected) is stored ENCRYPTED (AES-256-GCM, key held outside the database and outside the repository)
-- and is only ever read by the server. Row-level security is enabled and no policy is created: the browser has no path to these tables.

create table fin_bank_connections (
  merchant_id uuid primary key references merchants(id),
  provider text not null,
  token_ciphertext text not null,
  token_fingerprint text not null,                 -- first 12 hex chars of the SHA-256 of the token: lets an operator tell tokens apart without seeing one
  scopes text[] not null,
  account_ids text[] not null default '{}',
  granted_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  check (scopes <@ array['accounts:read', 'balances:read', 'transactions:read'])   -- only read-only scopes can ever be stored
);

create table fin_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  account_id text not null,
  provider_tx_id text not null,
  date date not null,
  amount_cents bigint not null,
  currency text not null,
  counterparty_name text,
  reference text,
  structured_reference text,
  source text not null check (source in ('bank', 'csv')),
  status text not null default 'NEW' check (status in ('NEW', 'MATCHED', 'IGNORED')),
  matched_kind text check (matched_kind in ('INVOICE', 'SUPPLIER_INVOICE')),
  matched_document_id text,
  matched_payment_id uuid,
  matched_amount_cents bigint,
  matched_at timestamptz,
  imported_at timestamptz not null default now()
);
-- The same bank transaction is stored once: re-importing or re-syncing is idempotent.
create unique index fin_bank_tx_uq on fin_bank_transactions (merchant_id, account_id, provider_tx_id);
create index fin_bank_tx_status_idx on fin_bank_transactions (merchant_id, status);

create function fin_bank_tx_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'bank transactions are append-only'; end if;
  if new.merchant_id is distinct from old.merchant_id or new.account_id is distinct from old.account_id or new.provider_tx_id is distinct from old.provider_tx_id
     or new.date is distinct from old.date or new.amount_cents is distinct from old.amount_cents or new.reference is distinct from old.reference then
    raise exception 'bank transaction content is immutable';
  end if;
  if old.status <> 'NEW' and new.status is distinct from old.status then raise exception 'a handled bank transaction cannot change status'; end if;
  return new;
end $$;
create trigger fin_bank_tx_guard_trg before update or delete on fin_bank_transactions for each row execute function fin_bank_tx_guard();

create table fin_bank_balances (
  merchant_id uuid not null references merchants(id),
  account_id text not null,
  iban text,
  balance_cents bigint not null,
  currency text not null,
  as_of timestamptz not null,
  primary key (merchant_id, account_id)
);

-- Physical cash: only what a person confirmed (a count) and what a person recorded (movements). Never inferred from POS sales.
create table fin_cash_counts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  amount_cents bigint not null check (amount_cents >= 0),
  counted_on date not null,
  note text,
  created_at timestamptz not null default now()
);
create table fin_cash_movements (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  kind text not null check (kind in ('CASH_IN', 'CASH_OUT', 'DEPOSIT_TO_BANK')),
  amount_cents bigint not null check (amount_cents > 0),
  date date not null,
  note text,
  created_at timestamptz not null default now()
);

alter table fin_bank_connections enable row level security;
alter table fin_bank_transactions enable row level security;
alter table fin_bank_balances enable row level security;
alter table fin_cash_counts enable row level security;
alter table fin_cash_movements enable row level security;
