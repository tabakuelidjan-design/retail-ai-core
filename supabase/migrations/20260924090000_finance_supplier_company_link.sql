-- Phase 1 (unified Contact foundation): an additive, nullable link from a supplier invoice to the same
-- canonical fin_companies referential already used for customers (see customer_company_id on fin_documents).
-- No new "contacts" table: fin_companies becomes the shared store for both roles. supplier_name /
-- supplier_vat_number are NEVER touched by this migration or by linking - they remain the historical
-- snapshot of what the document actually said, independent of any later change to the linked company.

alter table fin_supplier_invoices
  add column supplier_company_id uuid references fin_companies(id);

-- Supports the /api/contacts aggregation (supplier document counts/amounts per company) without a
-- per-contact query: one indexed scan over the merchant's supplier invoices, grouped in memory.
create index fin_supplier_invoice_company_idx on fin_supplier_invoices (merchant_id, supplier_company_id) where supplier_company_id is not null;

-- No backfill data migration here: the merchant_id column already enforces tenant scoping on both sides,
-- and the actual linking (VAT-exact, then exact-normalized-name, ambiguous cases left null) is applied
-- by the application layer (src/finance/contacts.js), not by SQL, so every automatic link goes through
-- the same auditable, tested code path as a manual one - never a silent bulk UPDATE.
