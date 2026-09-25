-- Expense capture (Pack comptable v1 / Achats). NOT APPLIED AUTOMATICALLY: review, then apply with the other migrations.
--
-- A captured receipt or ticket (hotel, taxi, restaurant...) may be validated without an invoice number and without a net / VAT split:
-- a taxi receipt has neither, and nothing may be guessed. Every other document keeps the full invoice rule.
-- The captured record marks itself with extraction -> capture -> kind = 'expense' (written by the application, see src/finance/inbox.js).
-- Amounts stay in their ORIGINAL currency (currency column); no exchange rate is stored or computed anywhere.

alter table fin_supplier_invoices drop constraint fin_supplier_invoice_validated_complete;
alter table fin_supplier_invoices add constraint fin_supplier_invoice_validated_complete check (
  status in ('RECEIVED', 'TO_REVIEW', 'REJECTED')
  or (
    supplier_name is not null and issue_date is not null and gross_cents is not null and currency is not null
    and (
      (invoice_number is not null and net_cents is not null and vat_cents is not null)
      or (extraction -> 'capture' ->> 'kind') = 'expense'
    )
  ));
