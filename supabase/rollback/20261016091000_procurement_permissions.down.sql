-- Rollback of 20261016091000_procurement_permissions.sql: removes only the explicit deny policies and restores default function privileges and search_path.
-- It does NOT re-grant anything to anon / authenticated (the pre-migration state of those roles on the proc_ tables is "RLS on, no policy": no access).
-- Run it BEFORE 20261016090000_procurement_stock.down.sql if the whole module is being removed (that script drops the tables and their policies with them).
do $$
declare t text; r text;
begin
  foreach t in array array['proc_items', 'proc_locations', 'proc_suppliers', 'proc_supplier_items', 'proc_quotes', 'proc_purchase_orders', 'proc_po_lines', 'proc_po_schedule',
                           'proc_visits', 'proc_receipts', 'proc_stock_movements', 'proc_stock_balances', 'proc_events', 'proc_idempotency', 'proc_approvals_used', 'proc_incidents', 'proc_sequences']
  loop
    foreach r in array array['anon', 'authenticated'] loop
      execute format('drop policy if exists %I on %I', 'proc_deny_' || r, t);
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant update, delete on table proc_stock_movements, proc_events to service_role; -- back to the table-level grant (the append-only TRIGGERS still apply)
  end if;
end $$;
alter function proc_apply_movement() reset search_path;
alter function proc_forbid_change() reset search_path;
alter function proc_po_transition_guard() reset search_path;
alter function proc_next_number(uuid, text) reset search_path;
