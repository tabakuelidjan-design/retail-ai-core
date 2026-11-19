-- Analytics report child: two least-privilege roles that replace the service key for the report process.
-- Not applied anywhere by this file. Apply only after review (staging first), then production; see db/rollback for the way back.
--
-- analytics_report_reader : SELECT only, on the 13 tables the report loads (the 11 dataset tables, merchant_profile, merchants).
-- analytics_report_writer : SELECT, INSERT, UPDATE only, on data_quality_flags (no DELETE, no other table).
-- Both are scoped per transaction by set_config('app.merchant_id', '<uuid>', true). A missing or invalid merchant raises an error.
-- Login roles (passwords) are created out of band and must be members of these roles. Nothing secret is in this file.
-- Existing policies are unchanged: restrictive anon/authenticated rules do not apply to these roles; service_role keeps its bypass.
begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_report_reader') then
    create role analytics_report_reader nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'analytics_report_writer') then
    create role analytics_report_writer nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end $$;

create schema if not exists analytics_report;
revoke all on schema analytics_report from public;
grant usage on schema analytics_report to analytics_report_reader, analytics_report_writer;

create or replace function analytics_report.ctx_merchant() returns uuid
  language plpgsql stable set search_path = '' as $$
declare v text := nullif(current_setting('app.merchant_id', true), '');
begin
  if v is null then raise exception 'MERCHANT_CONTEXT_REQUIRED'; end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'MERCHANT_CONTEXT_INVALID'; end if;
  return v::uuid;
end $$;
revoke all on function analytics_report.ctx_merchant() from public, anon, authenticated;
grant execute on function analytics_report.ctx_merchant() to analytics_report_reader, analytics_report_writer;

-- Reader: the 13 tables of the report, each filtered on the merchant in context.
create policy analytics_report_read on public.merchants as permissive for select to analytics_report_reader
  using (id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.products as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.variants as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.orders as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.order_lines as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.order_attribution as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.refunds as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.refund_lines as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.product_costs as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.product_collections as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.locations as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.inventory_snapshots as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_read on public.merchant_profile as permissive for select to analytics_report_reader using (merchant_id = analytics_report.ctx_merchant());

-- Writer: data_quality_flags only, for the merchant in context. WITH CHECK keeps every written row in that merchant.
create policy analytics_report_flags_read on public.data_quality_flags as permissive for select to analytics_report_writer
  using (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_flags_insert on public.data_quality_flags as permissive for insert to analytics_report_writer
  with check (merchant_id = analytics_report.ctx_merchant());
create policy analytics_report_flags_update on public.data_quality_flags as permissive for update to analytics_report_writer
  using (merchant_id = analytics_report.ctx_merchant()) with check (merchant_id = analytics_report.ctx_merchant());

grant select on public.merchants, public.products, public.variants, public.orders, public.order_lines, public.order_attribution,
  public.refunds, public.refund_lines, public.product_costs, public.product_collections, public.locations, public.inventory_snapshots,
  public.merchant_profile to analytics_report_reader;
grant select, insert, update on public.data_quality_flags to analytics_report_writer;
-- explicit refusals (no-ops today): nothing else, and no delete for anyone here
revoke delete, truncate, references, trigger on public.data_quality_flags from analytics_report_writer;

commit;
