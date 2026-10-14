-- NORDLA CORE P0 - PREPARED, NOT APPLIED (supabase/migrations-pending/). Owner authorization required before it is moved to supabase/migrations.
--
-- Every public table has RLS on and NO policy (Supabase advisor: rls_enabled_no_policy). Today that already means "no access" for the anon and
-- authenticated roles - every Nordla server uses the service role, which bypasses RLS - but the intent is implicit, and the first permissive
-- policy someone adds would open the table to every merchant. This migration makes the intent explicit and tenant-bounded, WITHOUT opening anything:
--   - anon:          a RESTRICTIVE deny-all policy on every table;
--   - authenticated: a RESTRICTIVE tenant guard on every table that has a merchant_id (the row's merchant must be one of the caller's ACTIVE
--                    memberships), and a RESTRICTIVE deny-all on the others.
-- Restrictive policies grant nothing by themselves: with no permissive policy the client roles still read and write nothing. A permissive policy
-- added later (an explicit, reviewed decision) is then automatically limited to the caller's own merchants. The service role is unchanged.
-- Idempotent: a table that already has the policy is skipped; a table created later must call public.nordla_apply_rls_guards() (or be covered by
-- the next migration that does).

-- The caller's ACTIVE memberships (auth.uid() = the Supabase user of the request). SECURITY DEFINER so the check can read merchant_members, which
-- the caller itself cannot; fixed search_path; no argument other than the merchant id; returns false for an anonymous caller.
create function nordla_is_active_member(p_merchant uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.merchant_members m
    where m.merchant_id = p_merchant and m.user_id = auth.uid() and m.status = 'ACTIVE'
  )
$$;
revoke all on function nordla_is_active_member(uuid) from public;
grant execute on function nordla_is_active_member(uuid) to authenticated, service_role;

create function nordla_apply_rls_guards() returns integer language plpgsql set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in
    select c.oid, c.relname,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'merchant_id' and not a.attisdropped) as has_merchant
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
  loop
    if not exists (select 1 from pg_policy p where p.polrelid = r.oid and p.polname = 'nordla_deny_anon') then
      execute format('create policy nordla_deny_anon on public.%I as restrictive for all to anon using (false) with check (false)', r.relname);
      n := n + 1;
    end if;
    if r.has_merchant then
      if not exists (select 1 from pg_policy p where p.polrelid = r.oid and p.polname = 'nordla_tenant_guard') then
        execute format('create policy nordla_tenant_guard on public.%I as restrictive for all to authenticated using (public.nordla_is_active_member(merchant_id)) with check (public.nordla_is_active_member(merchant_id))', r.relname);
        n := n + 1;
      end if;
    elsif not exists (select 1 from pg_policy p where p.polrelid = r.oid and p.polname = 'nordla_deny_authenticated') then
      execute format('create policy nordla_deny_authenticated on public.%I as restrictive for all to authenticated using (false) with check (false)', r.relname);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function nordla_apply_rls_guards() from public, anon, authenticated;

-- Tables without RLS in public are refused here: they would be readable by the client roles through the default grants.
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace s on s.oid = c.relnamespace
  where s.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if missing is not null then raise exception 'RLS_NOT_ENABLED on: %', missing; end if;
  perform public.nordla_apply_rls_guards();
end $$;
