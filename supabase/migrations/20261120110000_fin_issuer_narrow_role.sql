-- PILOT (local only, not applied remotely): least-privilege runtime role for the narrow invoice path, v4.
-- Covers exactly what Finance needs to read one document and issue it:
--   reads   fin_documents (own merchant only)
--   writes  fin_documents (UPDATE through fin_issue_document), fin_number_sequences (fin_next_number), fin_events (INSERT)
--   calls   fin_issue_document, fin_next_number, extensions.digest
-- The role has NO BYPASSRLS, NO table ownership, NO CREATE, and no grant on any other table or function.
--
-- Identity: the merchant comes from the PostgreSQL LOGIN identity (session_user), bound once in
-- nordla_runtime.fin_pilot_principals. app.merchant_id may only repeat the bound merchant, otherwise the statement is refused.
-- Restrictive guard: a restrictive policy keeps every row to the bound merchant even if a later permissive policy is added.
--
-- PUBLIC EXECUTE on the extensions schema (v4): on the hosted project, 54 of 55 extensions functions are executable by PUBLIC,
-- and several platform roles (anon, authenticated, service_role, ...) have that right ONLY through PUBLIC. This migration
-- first makes explicit, for every role that can execute a function today, the same EXECUTE grant, and only then removes
-- PUBLIC. The effective rights of every existing role are therefore unchanged; only the pilot role loses its implicit right.
-- The state before the change is recorded in nordla_runtime.fin_pilot_ext_public_snapshot, so the rollback is exact.
--
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

-- PUBLIC EXECUTE on extensions functions: snapshot, make every existing right explicit, then remove PUBLIC.
create table if not exists nordla_runtime.fin_pilot_ext_public_snapshot (
  function_signature text primary key,
  had_public_execute boolean not null,
  recorded_at timestamptz not null default now()
);
revoke all on nordla_runtime.fin_pilot_ext_public_snapshot from public, anon, authenticated, service_role;

do $$
declare
  f record;
  r record;
  had boolean;
begin
  for f in
    select p.oid, p.oid::regprocedure::text as sig, coalesce(p.proacl, acldefault('f'::"char", p.proowner)) as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions'
  loop
    had := exists (select 1 from aclexplode(f.acl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE');
    insert into nordla_runtime.fin_pilot_ext_public_snapshot (function_signature, had_public_execute)
      values (f.sig, had) on conflict (function_signature) do nothing;
    -- every role that can execute this function today keeps the right, explicitly
    for r in select rolname from pg_roles where rolname <> 'nordla_fin_issuer_pilot' and has_function_privilege(rolname, f.oid, 'EXECUTE') loop
      execute format('grant execute on function %s to %I', f.sig, r.rolname);
    end loop;
    if had then execute format('revoke execute on function %s from public', f.sig); end if;
  end loop;
end $$;

-- Role audit (v4): what the pilot role can actually do, computed from the effective ACLs (NULL acl = platform default),
-- including rights granted to PUBLIC, and identified by exact signatures. Expected set is exact.
create or replace function nordla_runtime.fin_pilot_role_audit()
returns table (check_name text, ok boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  pilot oid := (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot');
  expected text[] := array[
    'f:extensions.digest(text,text):EXECUTE@pilot',
    'f:nordla_runtime.fin_pilot_assert(uuid):EXECUTE@pilot',
    'f:nordla_runtime.fin_pilot_bound_merchant():EXECUTE@pilot',
    'f:public.fin_issue_document(uuid,uuid,integer,text,text,integer,text,integer,text,text,timestamp with time zone,jsonb):EXECUTE@pilot',
    'f:public.fin_next_number(uuid,text,integer):EXECUTE@pilot',
    'n:extensions:USAGE@pilot', 'n:nordla_runtime:USAGE@pilot', 'n:public:USAGE@PUBLIC', 'n:public:USAGE@pilot',
    'r:public.fin_documents:SELECT@pilot', 'r:public.fin_documents:UPDATE@pilot',
    'r:public.fin_events:INSERT@pilot',
    'r:public.fin_number_sequences:INSERT@pilot', 'r:public.fin_number_sequences:SELECT@pilot', 'r:public.fin_number_sequences:UPDATE@pilot'];
  exp_norm text[];
  actual text[];
  missing text[];
  extra text[];
  attrs record;
  bad_members text;
begin
  -- signatures are compared without blanks on both sides (the catalog prints "timestamp with time zone", "text, text")
  select array_agg(regexp_replace(x, '\s', '', 'g') order by regexp_replace(x, '\s', '', 'g')) into exp_norm from unnest(expected) x;
  select coalesce(array_agg(x order by x), '{}') into actual from (
    -- tables and sequences in the three platform schemas, effective ACL, pilot or PUBLIC grantee
    select 'r:' || n.nspname || '.' || c.relname || ':' || a.privilege_type || '@' || case when a.grantee = pilot then 'pilot' else 'PUBLIC' end as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where n.nspname in ('public', 'extensions', 'nordla_runtime') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and (a.grantee = pilot or a.grantee = 0)
    union all
    -- functions in the same schemas (trigger functions cannot be called directly and are excluded), exact signature
    select 'f:' || regexp_replace(p.oid::regprocedure::text, '\s', '', 'g') || ':' || a.privilege_type || '@' || case when a.grantee = pilot then 'pilot' else 'PUBLIC' end
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where n.nspname in ('public', 'extensions', 'nordla_runtime') and p.prorettype <> 'trigger'::regtype and (a.grantee = pilot or a.grantee = 0)
    union all
    -- schemas: explicit pilot usage and the platform PUBLIC usage on public
    select 'n:' || n.nspname || ':' || a.privilege_type || '@' || case when a.grantee = pilot then 'pilot' else 'PUBLIC' end
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      where n.nspname in ('public', 'extensions', 'nordla_runtime') and (a.grantee = pilot or a.grantee = 0)
  ) s;
  check_name := 'privileges (direct and PUBLIC, effective ACL) are exactly the expected set';
  -- set comparison: nothing missing and nothing extra
  select array_agg(e order by e) into missing from unnest(exp_norm) e where not (e = any (actual));
  select array_agg(a order by a) into extra from unnest(actual) a where not (a = any (exp_norm));
  ok := missing is null and extra is null;
  detail := case when ok then 'exact' else 'missing: ' || coalesce(array_to_string(missing, ', '), 'none') || ' | extra: ' || coalesce(array_to_string(extra, ', '), 'none') end;
  return next;

  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolinherit into attrs from pg_roles where oid = pilot;
  check_name := 'no privileged attribute (super, bypassrls, createrole, createdb, replication, login, inherit)';
  ok := not (attrs.rolsuper or attrs.rolbypassrls or attrs.rolcreaterole or attrs.rolcreatedb or attrs.rolreplication or attrs.rolcanlogin or attrs.rolinherit);
  detail := format('super=%s bypassrls=%s createrole=%s createdb=%s replication=%s login=%s inherit=%s', attrs.rolsuper, attrs.rolbypassrls, attrs.rolcreaterole, attrs.rolcreatedb, attrs.rolreplication, attrs.rolcanlogin, attrs.rolinherit);
  return next;

  check_name := 'pilot is a member of no role (no indirect power, no SET ROLE target)';
  ok := not exists (select 1 from pg_auth_members where member = pilot);
  detail := coalesce((select string_agg(r.rolname, ',') from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = pilot), 'none');
  return next;

  check_name := 'nobody can grant the pilot role onward (no ADMIN OPTION)';
  ok := not exists (select 1 from pg_auth_members where roleid = pilot and admin_option);
  detail := 'checked'; return next;

  select string_agg(r.rolname, ',') into bad_members from pg_auth_members m join pg_roles r on r.oid = m.member
    where m.roleid = pilot and (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication
      or exists (select 1 from pg_auth_members m2 where m2.member = m.member and m2.roleid <> pilot));
  check_name := 'every member of the pilot role is unprivileged and in no other role';
  ok := bad_members is null;
  detail := coalesce(bad_members, 'members checked'); return next;

  check_name := 'the pilot role owns no object';
  ok := not exists (select 1 from pg_class where relowner = pilot) and not exists (select 1 from pg_proc where proowner = pilot)
     and not exists (select 1 from pg_namespace where nspowner = pilot);
  detail := 'checked'; return next;

  check_name := 'the protected finance tables are owned by the platform owner, not the pilot';
  ok := not exists (select 1 from pg_class c where c.relname like 'fin_%' and c.relowner = pilot);
  detail := 'checked'; return next;
end $$;
revoke all on function nordla_runtime.fin_pilot_role_audit() from public, anon, authenticated, service_role;

do $$
declare bad text;
begin
  select string_agg(check_name || ': ' || detail, ' | ') into bad from nordla_runtime.fin_pilot_role_audit() where not ok;
  if bad is not null then raise exception 'FIN_PILOT_ROLE_UNSAFE: %', bad; end if;
end $$;

commit;
