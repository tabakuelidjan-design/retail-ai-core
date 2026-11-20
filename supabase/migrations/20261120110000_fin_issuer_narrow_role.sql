-- PILOT (local only, not applied remotely): least-privilege runtime role for the narrow invoice path.
-- Covers exactly what Finance needs to read one document and issue it:
--   reads   fin_documents (own row, by id and merchant)
--   writes  fin_documents (UPDATE through fin_issue_document), fin_number_sequences (fin_next_number), fin_events (INSERT)
--   calls   fin_issue_document, fin_next_number, extensions.digest
-- The role has NO BYPASSRLS, NO table ownership, NO CREATE, and no grant on any other table or function.
-- Tenant context is explicit: every policy compares merchant_id with app.merchant_id, which the adapter sets per
-- transaction. A missing or foreign context matches no row (nullif + equality), so the query is refused, never widened.
-- Rollback: supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nordla_fin_issuer_pilot') then
    create role nordla_fin_issuer_pilot nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

-- Tenant context: NULL when unset or empty, so every comparison is false.
create or replace function public.nordla_fin_pilot_merchant()
returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('app.merchant_id', true), '')::uuid
$$;
revoke all on function public.nordla_fin_pilot_merchant() from public;
grant execute on function public.nordla_fin_pilot_merchant() to nordla_fin_issuer_pilot;

alter table public.fin_documents enable row level security;
alter table public.fin_number_sequences enable row level security;
alter table public.fin_events enable row level security;

-- Schema reach: only what the path needs.
grant usage on schema public to nordla_fin_issuer_pilot;
grant usage on schema extensions to nordla_fin_issuer_pilot;

-- Tables: column-agnostic minimum.
grant select, update on public.fin_documents to nordla_fin_issuer_pilot;
grant select, insert, update on public.fin_number_sequences to nordla_fin_issuer_pilot;
grant insert on public.fin_events to nordla_fin_issuer_pilot;

-- Functions: exactly the three the path calls.
grant execute on function public.fin_issue_document(uuid, uuid, integer, text, text, integer, text, integer, text, text, timestamptz, jsonb) to nordla_fin_issuer_pilot;
grant execute on function public.fin_next_number(uuid, text, integer) to nordla_fin_issuer_pilot;
grant execute on function extensions.digest(text, text) to nordla_fin_issuer_pilot;

-- Row policies: the row must belong to the merchant in the transaction context. Permissive, scoped to this role only.
drop policy if exists nordla_fin_pilot_documents on public.fin_documents;
create policy nordla_fin_pilot_documents on public.fin_documents as permissive for all to nordla_fin_issuer_pilot
  using (merchant_id = public.nordla_fin_pilot_merchant())
  with check (merchant_id = public.nordla_fin_pilot_merchant());

drop policy if exists nordla_fin_pilot_sequences on public.fin_number_sequences;
create policy nordla_fin_pilot_sequences on public.fin_number_sequences as permissive for all to nordla_fin_issuer_pilot
  using (merchant_id = public.nordla_fin_pilot_merchant())
  with check (merchant_id = public.nordla_fin_pilot_merchant());

drop policy if exists nordla_fin_pilot_events on public.fin_events;
create policy nordla_fin_pilot_events on public.fin_events as permissive for insert to nordla_fin_issuer_pilot
  with check (merchant_id = public.nordla_fin_pilot_merchant());

commit;
