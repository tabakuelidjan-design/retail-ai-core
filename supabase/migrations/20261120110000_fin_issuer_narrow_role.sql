-- PILOT (local only, not applied remotely): least-privilege runtime role for the narrow invoice path, v2.
-- Covers exactly what Finance needs to read one document and issue it:
--   reads   fin_documents (own merchant only)
--   writes  fin_documents (UPDATE through fin_issue_document), fin_number_sequences (fin_next_number), fin_events (INSERT)
--   calls   fin_issue_document, fin_next_number, extensions.digest
-- The role has NO BYPASSRLS, NO table ownership, NO CREATE, and no grant on any other table or function.
--
-- Identity (v2): the merchant comes from the PostgreSQL LOGIN identity (session_user), bound once in
-- nordla_runtime.fin_pilot_principals. The session setting app.merchant_id is never trusted: it may only repeat the bound
-- merchant, otherwise the statement is refused. A login that is not bound, disabled, or privileged is refused.
-- Restrictive guard: a restrictive policy keeps every row to the bound merchant even if a later permissive policy is added.
-- Rollback: supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nordla_fin_issuer_pilot') then
    create role nordla_fin_issuer_pilot nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

create schema if not exists nordla_runtime;
revoke all on schema nordla_runtime from public, anon, authenticated, service_role;

-- Immutable binding: login -> merchant. Only the enabled flag may change (containment). No delete.
create table if not exists nordla_runtime.fin_pilot_principals (
  login_role name primary key,
  merchant_id uuid not null references public.merchants(id) on delete restrict,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table nordla_runtime.fin_pilot_principals enable row level security;
revoke all on nordla_runtime.fin_pilot_principals from public, anon, authenticated, service_role;

create or replace function nordla_runtime.fin_pilot_binding_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'FIN_PILOT_BINDING_IMMUTABLE: bindings are not deleted, disable them' using errcode = '42501'; end if;
  if new.login_role is distinct from old.login_role or new.merchant_id is distinct from old.merchant_id or new.created_at is distinct from old.created_at then
    raise exception 'FIN_PILOT_BINDING_IMMUTABLE: login and merchant cannot change' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function nordla_runtime.fin_pilot_binding_guard() from public, anon, authenticated, service_role;
drop trigger if exists fin_pilot_binding_guard_trg on nordla_runtime.fin_pilot_principals;
create trigger fin_pilot_binding_guard_trg before update or delete on nordla_runtime.fin_pilot_principals
  for each row execute function nordla_runtime.fin_pilot_binding_guard();

-- The bound merchant for the current LOGIN identity. SECURITY DEFINER: the caller cannot read the binding table directly.
create or replace function nordla_runtime.fin_pilot_bound_merchant() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  b uuid;
  ctx text := nullif(current_setting('app.merchant_id', true), '');
begin
  select p.merchant_id into b from nordla_runtime.fin_pilot_principals p where p.login_role = session_user::name and p.enabled;
  if b is null then raise exception 'FIN_PILOT_PRINCIPAL_UNKNOWN_OR_DISABLED' using errcode = '42501'; end if;
  if ctx is not null and ctx::uuid <> b then raise exception 'FIN_PILOT_CONTEXT_FORBIDDEN' using errcode = '42501'; end if;
  return b;
end $$;

-- Refuses the transaction unless: the identity is bound to p_merchant, the login is not privileged, and the login is a
-- member of nothing but this pilot role (no service_role, no postgres, no admin role).
create or replace function nordla_runtime.fin_pilot_assert(p_merchant uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  pilot_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot');
  me_oid oid := (select oid from pg_roles where rolname = session_user::name);
begin
  if nordla_runtime.fin_pilot_bound_merchant() is distinct from p_merchant then
    raise exception 'FIN_PILOT_MERCHANT_MISMATCH: this login is not bound to the requested merchant' using errcode = '42501';
  end if;
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication into r from pg_roles where oid = me_oid;
  if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
    raise exception 'FIN_PILOT_LOGIN_PRIVILEGED' using errcode = '42501';
  end if;
  if exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid <> pilot_oid) then
    raise exception 'FIN_PILOT_LOGIN_MEMBERSHIP_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid = pilot_oid) then
    raise exception 'FIN_PILOT_LOGIN_NOT_MEMBER' using errcode = '42501';
  end if;
end $$;

revoke all on function nordla_runtime.fin_pilot_bound_merchant(), nordla_runtime.fin_pilot_assert(uuid) from public, anon, authenticated, service_role;
grant execute on function nordla_runtime.fin_pilot_bound_merchant(), nordla_runtime.fin_pilot_assert(uuid) to nordla_fin_issuer_pilot;

-- Schema reach: only what the path needs.
grant usage on schema public to nordla_fin_issuer_pilot;
grant usage on schema extensions to nordla_fin_issuer_pilot;
grant usage on schema nordla_runtime to nordla_fin_issuer_pilot; -- only the two binding functions are executable from it

alter table public.fin_documents enable row level security;
alter table public.fin_number_sequences enable row level security;
alter table public.fin_events enable row level security;

-- Tables: minimum.
grant select, update on public.fin_documents to nordla_fin_issuer_pilot;
grant select, insert, update on public.fin_number_sequences to nordla_fin_issuer_pilot;
grant insert on public.fin_events to nordla_fin_issuer_pilot;

-- Functions: exactly the three the path calls.
grant execute on function public.fin_issue_document(uuid, uuid, integer, text, text, integer, text, integer, text, text, timestamptz, jsonb) to nordla_fin_issuer_pilot;
grant execute on function public.fin_next_number(uuid, text, integer) to nordla_fin_issuer_pilot;
grant execute on function extensions.digest(text, text) to nordla_fin_issuer_pilot;

-- Restrictive guard (applies to this role whatever permissive policies exist): the row must belong to the bound merchant.
drop policy if exists nordla_fin_pilot_guard_documents on public.fin_documents;
create policy nordla_fin_pilot_guard_documents on public.fin_documents as restrictive for all to nordla_fin_issuer_pilot
  using (merchant_id = nordla_runtime.fin_pilot_bound_merchant())
  with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant());
drop policy if exists nordla_fin_pilot_guard_sequences on public.fin_number_sequences;
create policy nordla_fin_pilot_guard_sequences on public.fin_number_sequences as restrictive for all to nordla_fin_issuer_pilot
  using (merchant_id = nordla_runtime.fin_pilot_bound_merchant())
  with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant());
drop policy if exists nordla_fin_pilot_guard_events on public.fin_events;
create policy nordla_fin_pilot_guard_events on public.fin_events as restrictive for insert to nordla_fin_issuer_pilot
  with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant());

-- Permissive policies, same bound merchant (defence in depth: the restrictive guard above is the hard limit).
drop policy if exists nordla_fin_pilot_documents on public.fin_documents;
create policy nordla_fin_pilot_documents on public.fin_documents as permissive for all to nordla_fin_issuer_pilot
  using (merchant_id = nordla_runtime.fin_pilot_bound_merchant()) with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant());
drop policy if exists nordla_fin_pilot_sequences on public.fin_number_sequences;
create policy nordla_fin_pilot_sequences on public.fin_number_sequences as permissive for all to nordla_fin_issuer_pilot
  using (merchant_id = nordla_runtime.fin_pilot_bound_merchant()) with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant());
drop policy if exists nordla_fin_pilot_events on public.fin_events;
create policy nordla_fin_pilot_events on public.fin_events as permissive for insert to nordla_fin_issuer_pilot
  with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant());

commit;
