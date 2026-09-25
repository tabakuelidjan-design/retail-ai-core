-- Corrective follow-up to 20260925120000_finance_expense_capture.sql. NOT APPLIED: awaiting approval.
--
-- Defect found while verifying 20260925120000 on the development project: when `extraction` is NULL (or has no `capture` key),
-- `(extraction -> 'capture' ->> 'kind') = 'expense'` evaluates to NULL, so the OR branch is NULL instead of false and a CHECK
-- constraint accepts a NULL result. A normal VALIDATED invoice without invoice number / net / VAT and with a NULL extraction was
-- therefore accepted. coalesce(..., false) makes the marker a strict yes/no.
--
-- Verified on the development project inside a rolled-back transaction: captured expense accepted; normal invoice without number,
-- without net/VAT, with NULL extraction, with an extraction lacking `capture`, or with another capture kind rejected;
-- unvalidated (RECEIVED) records and complete invoices unaffected.

alter table fin_supplier_invoices drop constraint fin_supplier_invoice_validated_complete;
alter table fin_supplier_invoices add constraint fin_supplier_invoice_validated_complete check (
  status in ('RECEIVED', 'TO_REVIEW', 'REJECTED')
  or (
    supplier_name is not null and issue_date is not null and gross_cents is not null and currency is not null
    and (
      (invoice_number is not null and net_cents is not null and vat_cents is not null)
      or coalesce((extraction -> 'capture' ->> 'kind') = 'expense', false)
    )
  ));
