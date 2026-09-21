-- Finance Operations (V1): companies, quotes / invoices / credit notes, payments, audit events, numbering, supplier invoices.
-- Additive only: no existing table is altered. Finance data is more sensitive than retail data: every table has RLS enabled
-- (service role only, like the rest of the schema), and the rules below are enforced BY THE DATABASE, not just the app:
--   * a locked document (invoice issued / quote sent) cannot change commercially and cannot be deleted;
--   * audit events and payments are append-only;
--   * one active invoice per source order (double-counting guard);
--   * document numbers are unique per merchant and type, allocated atomically and gaplessly by fin_next_number().

create table fin_companies (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  kind text not null default 'business' check (kind in ('business', 'individual')),
  name text not null,
  enterprise_number text,
  vat_number text,
  legal_form text,
  street text, postal_code text, city text, country_code text,
  contact_email text,
  peppol_id text,
  source text not null default 'manual',
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index fin_companies_vat_uq on fin_companies (merchant_id, vat_number) where vat_number is not null;
create unique index fin_companies_enterprise_uq on fin_companies (merchant_id, enterprise_number) where enterprise_number is not null;

create table fin_documents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  doc_type text not null check (doc_type in ('quote', 'invoice', 'credit_note')),
  status text not null,
  number text,
  currency text,
  issue_date date,
  due_date date,
  net_cents bigint,
  vat_cents bigint,
  gross_cents bigint,
  revenue_basis text check (revenue_basis in ('linked_source_order', 'standalone_b2b')),
  source_order_id uuid references orders(id),
  related_document_id uuid references fin_documents(id),
  converted_invoice_id uuid references fin_documents(id),
  customer_company_id uuid references fin_companies(id),
  locked_at timestamptz,
  snapshot_hash text,
  version integer not null default 1,
  body jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fin_documents_number_uq on fin_documents (merchant_id, doc_type, number) where number is not null;
-- Double-counting guard: at most one non-cancelled invoice per shop/POS order.
create unique index fin_documents_one_invoice_per_order_uq on fin_documents (source_order_id)
  where doc_type = 'invoice' and status <> 'CANCELLED' and source_order_id is not null;
create index fin_documents_merchant_type_idx on fin_documents (merchant_id, doc_type, status);

comment on column fin_documents.body is
  'Commercial content (customer, seller, lines, VAT treatment, totals, notes). Immutable once locked_at is set.';

create table fin_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  document_id uuid references fin_documents(id),
  at timestamptz not null default now(),
  actor jsonb,
  action text not null,
  from_status text,
  to_status text,
  detail jsonb
);
create index fin_events_document_idx on fin_events (document_id, at);

create table fin_payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  document_id uuid not null references fin_documents(id),
  amount_cents bigint not null check (amount_cents <> 0),
  paid_on date not null,
  method text not null default 'unspecified',
  reference text,
  actor jsonb,
  created_at timestamptz not null default now()
);
create index fin_payments_document_idx on fin_payments (document_id);

create table fin_number_sequences (
  merchant_id uuid not null references merchants(id),
  doc_type text not null,
  year integer not null,
  last_number integer not null,
  primary key (merchant_id, doc_type, year)
);

create table fin_supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  supplier_name text not null,
  supplier_vat_number text,
  invoice_number text not null,
  issue_date date not null,
  due_date date,
  net_cents bigint not null,
  vat_cents bigint not null,
  gross_cents bigint not null,
  currency text not null,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'partially_paid', 'paid')),
  source text not null default 'manual' check (source in ('manual', 'upload', 'email', 'peppol')),
  attachment_ref text,
  created_at timestamptz not null default now(),
  check (net_cents + vat_cents = gross_cents)
);
create unique index fin_supplier_invoice_uq on fin_supplier_invoices (merchant_id, supplier_name, invoice_number);

-- Atomic, gapless numbering: one counter per merchant, document type and year.
create function fin_next_number(p_merchant uuid, p_type text, p_year integer) returns integer
language plpgsql as $$
declare v integer;
begin
  insert into fin_number_sequences (merchant_id, doc_type, year, last_number) values (p_merchant, p_type, p_year, 1)
  on conflict (merchant_id, doc_type, year) do update set last_number = fin_number_sequences.last_number + 1
  returning last_number into v;
  return v;
end $$;

-- A locked document cannot change commercially; only lifecycle columns (status, converted_invoice_id, version, updated_at) may.
create function fin_documents_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.locked_at is not null or old.number is not null then
      raise exception 'fin_documents: issued document % cannot be deleted', old.id using errcode = 'integrity_constraint_violation';
    end if;
    return old;
  end if;
  if old.locked_at is not null then
    if new.locked_at is distinct from old.locked_at or new.number is distinct from old.number or new.doc_type is distinct from old.doc_type
       or new.body is distinct from old.body or new.currency is distinct from old.currency or new.issue_date is distinct from old.issue_date
       or new.due_date is distinct from old.due_date or new.net_cents is distinct from old.net_cents or new.vat_cents is distinct from old.vat_cents
       or new.gross_cents is distinct from old.gross_cents or new.revenue_basis is distinct from old.revenue_basis
       or new.source_order_id is distinct from old.source_order_id or new.related_document_id is distinct from old.related_document_id
       or new.customer_company_id is distinct from old.customer_company_id or new.snapshot_hash is distinct from old.snapshot_hash
       or new.merchant_id is distinct from old.merchant_id then
      raise exception 'fin_documents: locked document % is immutable (issue a credit note or a new document)', old.id using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  new.updated_at = now();
  return new;
end $$;
create trigger fin_documents_guard_trg before update or delete on fin_documents for each row execute function fin_documents_guard();

create function fin_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only (% not allowed)', tg_table_name, tg_op using errcode = 'integrity_constraint_violation';
end $$;
create trigger fin_events_append_only_trg before update or delete on fin_events for each row execute function fin_append_only();
create trigger fin_payments_append_only_trg before update or delete on fin_payments for each row execute function fin_append_only();

alter table fin_companies enable row level security;
alter table fin_documents enable row level security;
alter table fin_events enable row level security;
alter table fin_payments enable row level security;
alter table fin_number_sequences enable row level security;
alter table fin_supplier_invoices enable row level security;
