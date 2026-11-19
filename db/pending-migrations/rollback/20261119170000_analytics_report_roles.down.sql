-- Rollback of supabase/migrations/20261119170000_analytics_report_roles.sql. Owner (postgres), one transaction.
-- Removes only what that migration added. Login roles created out of band are kept (they hold no privilege afterwards).
begin;

do $$ declare r record; begin
  for r in select t.relname as tbl, p.polname as pol from pg_policy p join pg_class t on t.oid = p.polrelid
           where p.polname in ('analytics_report_read', 'analytics_report_flags_read', 'analytics_report_flags_insert', 'analytics_report_flags_update')
  loop
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
  end loop;
end $$;

revoke all on public.merchants, public.products, public.variants, public.orders, public.order_lines, public.order_attribution,
  public.refunds, public.refund_lines, public.product_costs, public.product_collections, public.locations, public.inventory_snapshots,
  public.merchant_profile, public.data_quality_flags from analytics_report_reader, analytics_report_writer;
revoke usage on schema analytics_report from analytics_report_reader, analytics_report_writer;

drop function if exists analytics_report.ctx_merchant();
drop schema if exists analytics_report;

-- retire memberships of both roles, then drop them (drop fails loudly if anything still depends on them)
do $$ declare m record; begin
  for m in
    select g.rolname as role_name, mem.rolname as member from pg_auth_members am
      join pg_roles g on g.oid = am.roleid join pg_roles mem on mem.oid = am.member
     where g.rolname in ('analytics_report_reader', 'analytics_report_writer')
  loop
    execute format('revoke %I from %I', m.role_name, m.member);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'analytics_report_reader') then drop role analytics_report_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'analytics_report_writer') then drop role analytics_report_writer; end if;
end $$;

commit;
