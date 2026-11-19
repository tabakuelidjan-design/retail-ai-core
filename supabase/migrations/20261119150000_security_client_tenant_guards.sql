-- Defence in depth for client roles. Does NOT protect requests using service_role/BYPASSRLS.
-- No permissive policies or new data grants are created: client access remains closed.
-- A later permissive policy cannot silently expose another merchant's rows.
begin;

create or replace function public.nordla_is_active_member(p_merchant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.merchant_members m
    where m.merchant_id = p_merchant and m.user_id = auth.uid()
      and m.status = 'ACTIVE' and m.removed_at is null
  )
$$;
revoke all on function public.nordla_is_active_member(uuid) from public, anon, authenticated;
grant execute on function public.nordla_is_active_member(uuid) to authenticated;

do $$
declare r record;
begin
  for r in
    select c.oid, c.relname, c.relrowsecurity,
      exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'merchant_id' and not a.attisdropped) as has_merchant
    from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    if not r.relrowsecurity then raise exception 'RLS_NOT_ENABLED: %', r.relname; end if;
    if not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = r.oid and p.polname = 'nordla_deny_anon') then
      execute format('create policy nordla_deny_anon on public.%I as restrictive for all to anon using (false) with check (false)', r.relname);
    end if;
    if r.has_merchant then
      if not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = r.oid and p.polname = 'nordla_tenant_guard') then
        execute format('create policy nordla_tenant_guard on public.%I as restrictive for all to authenticated using (public.nordla_is_active_member(merchant_id)) with check (public.nordla_is_active_member(merchant_id))', r.relname);
      end if;
    elsif not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = r.oid and p.polname = 'nordla_deny_authenticated') then
      execute format('create policy nordla_deny_authenticated on public.%I as restrictive for all to authenticated using (false) with check (false)', r.relname);
    end if;
  end loop;
end $$;
commit;
