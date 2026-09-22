-- Follow-up to merchant_id_gap_tables (20260922230000): applied only after verifying, on the stored data
-- itself (not just migration success), that all four tables were 100% backfilled with zero nulls, zero
-- ownership mismatches against their parent, and zero dangling FKs.
--
-- Post-backfill verification (read-only, run and reviewed immediately before this file was applied):
--   inventory_snapshots: 1019 total, 1019 backfilled, 0 null
--   order_lines:            90 total,   90 backfilled, 0 null
--   refunds:                  3 total,    3 backfilled, 0 null
--   refund_lines:             3 total,    3 backfilled, 0 null
--   ownership mismatch vs parent (all 4 tables): 0
--   dangling FK to merchants (all 4 tables): 0

alter table inventory_snapshots alter column merchant_id set not null;
alter table order_lines alter column merchant_id set not null;
alter table refunds alter column merchant_id set not null;
alter table refund_lines alter column merchant_id set not null;
