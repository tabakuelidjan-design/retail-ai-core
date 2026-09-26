-- Document intelligence, phase 1: the common purchase-document model on fin_supplier_invoices. NOT APPLIED: awaiting approval.
--
-- Additive only: new nullable columns (plus document_type with a default), no column removed or renamed, no existing value changed
-- except document_type on captured receipts (see the backfill below). Apply BEFORE deploying the code that writes these columns.
--
--   document_type        INVOICE | CREDIT_NOTE | RECEIPT | EXPENSE. Amounts stay POSITIVE for every type; the accounting direction
--                        comes from the type (credit note = -1), never from a negative stored amount.
--   supplier_enterprise_number, supplier_iban, order_reference, billing_reference (for a credit note: the credited invoice)
--   vat_breakdown        [{ taxableCents, vatCents, rateBp, category, exemptionReason }] as read from the document
--   lines                [{ position, id, description, quantity, unitCode, unitPrice, netCents, rateBp, category }] as read from the document
-- Per-field provenance and confidence live in the existing `extraction` jsonb (extraction.provenance).

alter table fin_supplier_invoices
  add column document_type text not null default 'INVOICE' check (document_type in ('INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'EXPENSE')),
  add column supplier_enterprise_number text,
  add column supplier_iban text,
  add column order_reference text,
  add column billing_reference text,
  add column vat_breakdown jsonb check (vat_breakdown is null or jsonb_typeof(vat_breakdown) = 'array'),
  add column lines jsonb check (lines is null or jsonb_typeof(lines) = 'array');

-- Captured receipts / tickets were implicitly receipts: say so explicitly (same meaning, same +1 direction, totals unchanged).
update fin_supplier_invoices set document_type = 'RECEIPT' where coalesce((extraction -> 'capture' ->> 'kind') = 'expense', false);

-- Amounts are never negative, whatever the type (the existing net + VAT = total check stays in place).
alter table fin_supplier_invoices add constraint fin_supplier_invoice_amounts_not_negative
  check (coalesce(net_cents, 0) >= 0 and coalesce(vat_cents, 0) >= 0 and coalesce(gross_cents, 0) >= 0);

-- Uniqueness per supplier, document number AND document type: an invoice and the credit note that cancels it may carry the same
-- number (both are distinct documents); the same invoice twice, or the same credit note twice, is still refused.
-- The new index is created BEFORE the old one is dropped, inside the same migration transaction: there is never a moment without
-- protection. Its key is a strict superset of the old key, so every row that satisfies the old index satisfies the new one
-- (it cannot fail on existing data). NULL numbers stay allowed, exactly as before (a document under review may not have one yet).
-- The file hash index (fin_supplier_invoice_sha_uq: same file = same record) is not touched.
create unique index fin_supplier_invoice_type_uq on fin_supplier_invoices (merchant_id, supplier_name, invoice_number, document_type);
drop index fin_supplier_invoice_uq;
