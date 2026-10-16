-- 20261016091000_procurement_permissions.sql
-- Stock / Achats — explicit permissions. PREPARED, NOT APPLIED (supabase/migrations-pending/): apply only after 20261016090000_procurement_stock.sql and only with the owner's authorization.
-- Mirrors the convention of the Core P0 line (explicit RESTRICTIVE policies, fixed function search_path) for the proc_* objects. Opens nothing.
--
--   * tables: every privilege is revoked from PUBLIC, anon and authenticated; only service_role (the server) keeps access. RLS stays enabled.
--   * policies: one explicit RESTRICTIVE "deny" policy per table for anon and authenticated, so the Supabase advisor does not report `rls_enabled_no_policy`
--     and so that a future permissive policy cannot silently open a table (restrictive policies are ANDed).
--   * functions: a fixed search_path (function_search_path_mutable), execution revoked from PUBLIC/anon/authenticated.
-- The role checks make the file safe on plain PostgreSQL (throw-away test databases) where the Supabase roles do not exist.

do $$
declare t text; r text;
begin
  foreach t in array array['proc_items', 'proc_locations', 'proc_suppliers', 'proc_supplier_items', 'proc_quotes', 'proc_purchase_orders', 'proc_po_lines', 'proc_po_schedule',
                           'proc_visits', 'proc_receipts', 'proc_stock_movements', 'proc_stock_balances', 'proc_events', 'proc_idempotency', 'proc_approvals_used', 'proc_incidents', 'proc_sequences']
  loop
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table %I from %I', t, r);
        execute format('create policy %I on %I as restrictive for all to %I using (false) with check (false)', 'proc_deny_' || r, t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on table %I to service_role', t);
    end if;
  end loop;
end $$;

-- the ledger and the journal are append-only: even the service role gets no UPDATE / DELETE privilege on them (the triggers already forbid it; this is the second lock)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete, truncate on table proc_stock_movements, proc_events from service_role;
  end if;
end $$;

alter function proc_apply_movement() set search_path = public, pg_temp;
alter function proc_forbid_change() set search_path = public, pg_temp;
alter function proc_po_transition_guard() set search_path = public, pg_temp;
alter function proc_next_number(uuid, text) set search_path = public, pg_temp;
revoke all on function proc_apply_movement(), proc_forbid_change(), proc_po_transition_guard(), proc_next_number(uuid, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function proc_apply_movement(), proc_forbid_change(), proc_po_transition_guard(), proc_next_number(uuid, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function proc_apply_movement(), proc_forbid_change(), proc_po_transition_guard(), proc_next_number(uuid, text) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function proc_apply_movement(), proc_forbid_change(), proc_po_transition_guard(), proc_next_number(uuid, text) to service_role; end if;
end $$;
