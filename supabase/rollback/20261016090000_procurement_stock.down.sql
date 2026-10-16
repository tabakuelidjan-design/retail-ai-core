-- Rollback of 20261016090000_procurement_stock.sql. Drops ONLY the proc_* objects that migration created.
-- DESTRUCTIVE: all procurement data (orders, receipts, the stock ledger) is lost. Never run on a database holding real data without an export and the owner's explicit approval.
drop table if exists proc_incidents, proc_approvals_used, proc_idempotency, proc_events, proc_stock_balances, proc_stock_movements, proc_receipts,
  proc_po_schedule, proc_po_lines, proc_purchase_orders, proc_quotes, proc_supplier_items, proc_suppliers, proc_locations, proc_items, proc_sequences cascade;
drop function if exists proc_apply_movement(), proc_forbid_change(), proc_next_number(uuid, text), proc_po_transition_guard();
