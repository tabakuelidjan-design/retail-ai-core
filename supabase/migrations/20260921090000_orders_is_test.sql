-- Additive migration: mark test orders so they are never counted as sales.
-- Found in Phase 2A validation: Shopify Analytics excludes test orders, the
-- Phase 1C sync stored one as real revenue. No data is deleted; the engine
-- excludes is_test rows and reports how many it excluded.

alter table orders add column is_test boolean not null default false;

comment on column orders.is_test is
  'True for source-system test orders (Shopify Order.test). Kept for traceability but excluded from every sales/profit metric.';
