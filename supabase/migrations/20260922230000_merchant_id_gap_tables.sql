-- Additive migration: direct merchant_id on the 4 tables that previously carried tenant ownership only
-- indirectly (via a parent FK): inventory_snapshots, order_lines, refunds, refund_lines. Columns are added
-- NULLABLE and backfilled deterministically from their parent's merchant_id; NOT NULL is deliberately NOT
-- applied here - that is a follow-up step pending explicit owner review of the backfill results.
--
-- Pre-migration validation (read-only, run and reviewed before this file was written):
--   inventory_snapshots orphans (variant_id not in variants):                            0
--   order_lines orphans (order_id not in orders):                                        0
--   refunds orphans (order_id not in orders):                                            0
--   refund_lines orphans (refund_id not in refunds, or order_line_id not in order_lines): 0
--   refund_lines conflicting ownership (refund's order vs order_line's order disagree):   0
-- All zero on this database at migration time (single merchant, HABB). Had any been non-zero, this
-- migration would not proceed on those rows - the design stops rather than guesses (see refund_lines below).

alter table inventory_snapshots add column merchant_id uuid references merchants(id);
update inventory_snapshots s set merchant_id = v.merchant_id
  from variants v where v.id = s.variant_id and s.merchant_id is null;
create index inventory_snapshots_merchant_variant_location_idx
  on inventory_snapshots (merchant_id, variant_id, location_id, synced_at desc);

alter table order_lines add column merchant_id uuid references merchants(id);
update order_lines ol set merchant_id = o.merchant_id
  from orders o where o.id = ol.order_id and ol.merchant_id is null;
create index order_lines_merchant_order_idx on order_lines (merchant_id, order_id);

alter table refunds add column merchant_id uuid references merchants(id);
update refunds r set merchant_id = o.merchant_id
  from orders o where o.id = r.order_id and r.merchant_id is null;
create index refunds_merchant_order_idx on refunds (merchant_id, order_id);

alter table refund_lines add column merchant_id uuid references merchants(id);
-- Cross-checked through BOTH parents (refund and order_line): only backfills where they agree.
-- A disagreement leaves merchant_id null here rather than guess - validated zero disagreements above.
update refund_lines rl set merchant_id = r.merchant_id
  from refunds r, order_lines ol
  where r.id = rl.refund_id and ol.id = rl.order_line_id
    and r.merchant_id = ol.merchant_id
    and rl.merchant_id is null;
create index refund_lines_merchant_refund_idx on refund_lines (merchant_id, refund_id);

comment on column inventory_snapshots.merchant_id is
  'Direct tenant ownership, added 2026-09-22 (previously only derivable via variant_id -> variants.merchant_id). Backfilled deterministically; kept nullable pending owner review before NOT NULL is added.';
comment on column order_lines.merchant_id is
  'Direct tenant ownership, added 2026-09-22 (previously only derivable via order_id -> orders.merchant_id). Backfilled deterministically; kept nullable pending owner review before NOT NULL is added.';
comment on column refunds.merchant_id is
  'Direct tenant ownership, added 2026-09-22 (previously only derivable via order_id -> orders.merchant_id). Backfilled deterministically; kept nullable pending owner review before NOT NULL is added.';
comment on column refund_lines.merchant_id is
  'Direct tenant ownership, added 2026-09-22, backfilled only where the refund and order_line parents agree on merchant_id (cross-checked, never guessed). Kept nullable pending owner review before NOT NULL is added.';

-- Follow-up (NOT part of this migration, requires a separate explicit approval once reviewed):
--   alter table inventory_snapshots alter column merchant_id set not null;
--   alter table order_lines alter column merchant_id set not null;
--   alter table refunds alter column merchant_id set not null;
--   alter table refund_lines alter column merchant_id set not null;
