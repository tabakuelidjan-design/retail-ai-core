-- Finance Inbox + Purchases: the supplier-invoice table becomes the record of every incoming financial document.
-- Workflow: RECEIVED -> TO_REVIEW -> VALIDATED -> TO_PAY -> PAID (or REJECTED). Attachments live in a PRIVATE storage bucket
-- (no public access); this table only holds the storage path and the SHA-256 of the file.

alter table fin_supplier_invoices
  add column status text not null default 'TO_REVIEW' check (status in ('RECEIVED', 'TO_REVIEW', 'VALIDATED', 'TO_PAY', 'PAID', 'REJECTED')),
  add column payment_reference text,
  add column file_name text,
  add column content_type text,
  add column size_bytes integer,
  add column sha256 text,
  add column received_at timestamptz not null default now(),
  add column from_address text,
  add column subject text,
  add column extraction jsonb,
  add column validated_at timestamptz,
  add column paid_at date,
  add column paid_amount_cents bigint,
  add column paid_reference text,
  add column rejected_reason text;

-- A document under review may be incomplete; a validated one may not.
alter table fin_supplier_invoices
  alter column supplier_name drop not null, alter column invoice_number drop not null, alter column issue_date drop not null,
  alter column net_cents drop not null, alter column vat_cents drop not null, alter column gross_cents drop not null, alter column currency drop not null;
alter table fin_supplier_invoices add constraint fin_supplier_invoice_validated_complete check (
  status in ('RECEIVED', 'TO_REVIEW', 'REJECTED')
  or (supplier_name is not null and invoice_number is not null and issue_date is not null and net_cents is not null and vat_cents is not null and gross_cents is not null and currency is not null));

-- The same file is ingested once per merchant (idempotent intake).
create unique index fin_supplier_invoice_sha_uq on fin_supplier_invoices (merchant_id, sha256) where sha256 is not null;
create index fin_supplier_invoice_status_idx on fin_supplier_invoices (merchant_id, status);

-- Private bucket for the attachments. Never public: the server reads it with the service role and streams it to an authenticated session.
insert into storage.buckets (id, name, public) values ('finance-inbox', 'finance-inbox', false) on conflict (id) do update set public = false;
