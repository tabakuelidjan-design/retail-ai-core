-- PREPARED ONLY. Bind each ordinary runtime LOGIN to one immutable merchant.
-- Apply after the three Analytics pilot migrations. No password or LOGIN is created here.
begin;
create schema if not exists nordla_runtime;
revoke all on schema nordla_runtime from public,anon,authenticated,service_role;
create table nordla_runtime.principals(
 login_role name primary key,
 merchant_id uuid not null references public.merchants(id) on delete restrict,
 kind text not null check(kind in('analytics_reader','analytics_report_reader','analytics_report_writer','analytics_access_checker','finance_runtime','growth_runtime','core_business_reader')),
 enabled boolean not null default true,
 created_at timestamptz not null default now()
);
alter table nordla_runtime.principals enable row level security;
revoke all on nordla_runtime.principals from public,anon,authenticated,service_role;
create function nordla_runtime.immutable_binding() returns trigger language plpgsql set search_path='' as $$
begin
 if new.login_role is distinct from old.login_role or new.merchant_id is distinct from old.merchant_id or new.kind is distinct from old.kind or new.created_at is distinct from old.created_at then raise exception 'RUNTIME_BINDING_IMMUTABLE' using errcode='42501';end if;
 return new;
end $$;
create trigger immutable_binding before update on nordla_runtime.principals for each row execute function nordla_runtime.immutable_binding();
revoke all on function nordla_runtime.immutable_binding() from public,anon,authenticated,service_role;

do $$declare r text;begin
 foreach r in array array['analytics_reader','analytics_report_reader','analytics_report_writer','analytics_access_checker','finance_runtime','growth_runtime','core_business_reader'] loop
  if not exists(select 1 from pg_roles where rolname=r) then execute format('create role %I nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication',r);end if;
  if exists(select 1 from pg_roles where rolname=r and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication or rolcanlogin)) then raise exception 'RUNTIME_GROUP_UNSAFE';end if;
  execute format('grant usage on schema public,nordla_runtime to %I',r);
 end loop;
end $$;

create function nordla_runtime.identity() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('merchantId',p.merchant_id,'kind',p.kind,'enabled',p.enabled,
 'safe',not(r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication)
 and not exists(select 1 from pg_roles x where x.rolname not in(p.kind,p.login_role::text) and pg_has_role(session_user::text,x.oid,'MEMBER')))
 from nordla_runtime.principals p join pg_roles r on r.rolname=p.login_role
 where p.login_role=session_user;
$$;
create function nordla_runtime.bound_merchant() returns uuid language plpgsql stable security definer set search_path='' as $$
declare p nordla_runtime.principals;ctx text:=nullif(current_setting('app.merchant_id',true),'');begin
 select * into p from nordla_runtime.principals where login_role=session_user and enabled;
 if p.login_role is null then raise exception 'RUNTIME_PRINCIPAL_DISABLED_OR_UNKNOWN' using errcode='42501';end if;
 if ctx is null or ctx !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'RUNTIME_CONTEXT_REQUIRED' using errcode='42501';end if;
 if ctx::uuid<>p.merchant_id then raise exception 'RUNTIME_CONTEXT_FORBIDDEN' using errcode='42501';end if;
 return p.merchant_id;
end $$;
revoke all on function nordla_runtime.identity(),nordla_runtime.bound_merchant() from public,anon,authenticated,service_role;
grant execute on function nordla_runtime.identity(),nordla_runtime.bound_merchant() to analytics_reader,analytics_report_reader,analytics_report_writer,analytics_access_checker,finance_runtime,growth_runtime,core_business_reader;

-- SQL-administrator-only provisioning. Principals remain NOLOGIN until credentials are set via a secure operator channel.
create function nordla_runtime.provision(p_login name,p_merchant uuid,p_kind text) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_login::text !~ '^nordla_[a-z0-9_]{1,45}$' or p_kind not in('analytics_reader','analytics_report_reader','analytics_report_writer','analytics_access_checker','finance_runtime','growth_runtime','core_business_reader') then raise exception 'RUNTIME_PROVISION_INVALID';end if;
 if not exists(select 1 from public.merchants where id=p_merchant) then raise exception 'RUNTIME_MERCHANT_UNKNOWN';end if;
 if exists(select 1 from pg_roles where rolname=p_login) then raise exception 'RUNTIME_PRINCIPAL_EXISTS';end if;
 execute format('create role %I nologin inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication connection limit 5',p_login);
 execute format('grant %I to %I',p_kind,p_login);
 insert into nordla_runtime.principals(login_role,merchant_id,kind) values(p_login,p_merchant,p_kind);
end $$;
revoke all on function nordla_runtime.provision(name,uuid,text) from public,anon,authenticated,service_role,analytics_reader,analytics_report_reader,analytics_report_writer,analytics_access_checker,finance_runtime,growth_runtime,core_business_reader;

-- Restrictive guards survive a mistakenly broad future permissive policy for these roles.
do $$declare t record;k text;begin
 for t in select c.relname,exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='merchant_id' and not a.attisdropped) scoped from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p') loop
  if t.scoped or t.relname='merchants' then
   k:=case when t.relname='merchants' then 'id' else 'merchant_id' end;
   execute format('create policy runtime_principal_guard on public.%I as restrictive for all to analytics_reader,analytics_report_reader,analytics_report_writer,analytics_access_checker,finance_runtime,growth_runtime,core_business_reader using (%I=nordla_runtime.bound_merchant()) with check (%I=nordla_runtime.bound_merchant())',t.relname,k,k);
  end if;
 end loop;
end $$;

-- Access to existing session proof: metadata only, never token_hash or other-user journal rows.
grant select(id,merchant_id,user_id,module,created_at,last_seen_at,expires_at,revoked_at) on public.app_sessions to analytics_access_checker,finance_runtime,growth_runtime;
grant select(merchant_id,user_id,session_id,module,event_type,outcome,correlation_id,occurred_at,detail) on public.identity_events to analytics_access_checker,finance_runtime,growth_runtime;
grant select(merchant_id,user_id,role,status,removed_at) on public.merchant_members to finance_runtime,growth_runtime;
grant select(merchant_id,module_code,status) on public.module_entitlements to finance_runtime,growth_runtime;
do $$declare t text;begin
 foreach t in array array['app_sessions','identity_events','merchant_members'] loop
  execute format('create policy runtime_person_read on public.%I for select to analytics_access_checker,finance_runtime,growth_runtime using(merchant_id=nordla_runtime.bound_merchant() and user_id=analytics_checker.ctx_uuid(''app.user_id''))',t);
 end loop;
end $$;
create policy runtime_entitlement_read on public.module_entitlements for select to finance_runtime,growth_runtime using(merchant_id=nordla_runtime.bound_merchant());
grant usage on schema analytics_checker to finance_runtime,growth_runtime;
grant execute on function analytics_checker.ctx_uuid(text) to finance_runtime,growth_runtime;
create or replace function analytics_checker.mfa_status(p_merchant uuid,p_user uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_merchant is distinct from nordla_runtime.bound_merchant() or p_user is distinct from analytics_checker.ctx_uuid('app.user_id') then raise exception 'CHECKER_PAIR_OUT_OF_CONTEXT' using errcode='42501';end if;
 if not exists(select 1 from public.merchant_members where merchant_id=p_merchant and user_id=p_user and status='ACTIVE' and removed_at is null) then raise exception 'CHECKER_MEMBER_REQUIRED' using errcode='42501';end if;
 return public.security_mfa_status(p_merchant,p_user);
end $$;
revoke all on function analytics_checker.mfa_status(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function analytics_checker.mfa_status(uuid,uuid) to analytics_access_checker,finance_runtime,growth_runtime;

-- Invoice snapshot hashing uses pgcrypto; grant only its digest overloads.
grant usage on schema extensions to finance_runtime;
grant execute on function extensions.digest(text,text),extensions.digest(bytea,text) to finance_runtime;

-- Ordinary Finance/retail reads. Finance routines must remain SECURITY INVOKER.
do $$declare t record;col text;r text;begin
 for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname like 'fin\_%' escape '\' or c.relname in('merchants','merchant_profile','merchant_connectors','sync_runs','products','variants','orders','order_lines','order_attribution','refunds','refund_lines','product_costs','product_collections','locations','inventory_snapshots','data_quality_flags')) loop
  col:=case when t.relname='merchants' then 'id' else 'merchant_id' end;
  foreach r in array array['finance_runtime','core_business_reader'] loop
   execute format('grant select on public.%I to %I',t.relname,r);
   execute format('create policy %I on public.%I for select to %I using(%I=nordla_runtime.bound_merchant())',r||'_read',t.relname,r,col);
  end loop;
  if t.relname like 'fin\_%' escape '\' then
   execute format('grant insert,update,delete on public.%I to finance_runtime',t.relname);
   execute format('create policy finance_runtime_write on public.%I for all to finance_runtime using(merchant_id=nordla_runtime.bound_merchant()) with check(merchant_id=nordla_runtime.bound_merchant())',t.relname);
  end if;
 end loop;
 for t in select p.oid,p.proname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'fin\_%' escape '\' loop
  if t.prosecdef then raise exception 'FINANCE_DEFINER_REQUIRES_REVIEW';end if;
  execute format('grant execute on function %s to finance_runtime',t.oid::regprocedure);
 end loop;
end $$;

-- UUID foreign keys must stay inside a merchant, including SECURITY INVOKER Finance routines.
-- PostgreSQL's ordinary FK existence check alone does not enforce tenant equality.
create function nordla_runtime.assert_finance_reference_owner() returns trigger language plpgsql set search_path='' as $$
declare ref text:=to_jsonb(new)->>tg_argv[0];tenant uuid:=(to_jsonb(new)->>'merchant_id')::uuid;found_owner boolean;begin
 if ref is null then return new;end if;
 execute format('select exists(select 1 from public.%I where %I=$1::uuid and %I=$2)',tg_argv[1],tg_argv[2],tg_argv[3]) into found_owner using ref,tenant;
 if not found_owner then raise exception 'FIN_REFERENCE_OUTSIDE_MERCHANT' using errcode='23503';end if;
 return new;
end $$;
revoke all on function nordla_runtime.assert_finance_reference_owner() from public,anon,authenticated,service_role;
do $$declare f record;begin
 for f in select con.oid,c.relname child,p.relname parent,a.attname child_col,b.attname parent_col,
 case when p.relname='merchants' then 'id' else 'merchant_id' end parent_scope
 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace cn on cn.oid=c.relnamespace
 join pg_class p on p.oid=con.confrelid join pg_namespace pn on pn.oid=p.relnamespace
 join pg_attribute a on a.attrelid=c.oid and a.attnum=con.conkey[1]
 join pg_attribute b on b.attrelid=p.oid and b.attnum=con.confkey[1]
 where con.contype='f' and cardinality(con.conkey)=1 and cardinality(con.confkey)=1 and cn.nspname='public' and pn.nspname='public'
 and left(c.relname,4)='fin_' and a.atttypid='uuid'::regtype and b.atttypid='uuid'::regtype
 and exists(select 1 from pg_attribute x where x.attrelid=c.oid and x.attname='merchant_id' and not x.attisdropped)
 and (p.relname='merchants' or exists(select 1 from pg_attribute x where x.attrelid=p.oid and x.attname='merchant_id' and not x.attisdropped))
 loop
 execute format('create trigger %I before insert or update on public.%I for each row execute function nordla_runtime.assert_finance_reference_owner(%L,%L,%L,%L)','runtime_ref_'||f.oid,f.child,f.child_col,f.parent,f.parent_col,f.parent_scope);
 end loop;
end $$;

commit;
