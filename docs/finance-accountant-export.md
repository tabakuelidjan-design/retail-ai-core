# Finance — Accountant Export (data package V1)

`Invoices → Payments → Bank → Treasury` is followed by `→ Accountant Export`. The export **extracts, assembles, controls and documents** existing truths; it creates none, writes nothing financial and never uses a Treasury forecast or scenario as an accounting fact (V1 includes no Treasury data at all). **0 new tables, no migration.**

The existing *Pack comptable* (French numbered folders, PDF/XLSX/UBL, report, history) is kept unchanged. The data package is an additional, machine-readable deliverable, offered on the same page (`#/pack`, "Exporter pour le comptable").

Files: `src/finance/accountant-export.js` (pure builder + `verifyExportPackage`), `src/finance/accountant-export-service.js` (one read per source), routes `GET /api/accountant-export/preview`, `POST /api/accountant-export/generate`, `GET /api/accountant-export/:id/download`, `GET /api/accountant-export/history`. A cash-count list read (`listCashCounts`) was added to both stores (read only).

## Package

```
accountant-export_<period label>/
  manifest.json            schema, version, merchant, period, timezone, generated_at, files (rows, bytes, SHA-256), row counts, missing artifacts, PDF archive status, warnings, contentFingerprint
  README.txt               explanation for the accountant (French), conventions, VAT status, hash verification
  SHA256SUMS.txt           standard format: sha256sum -c SHA256SUMS.txt
  sales.csv  credit-notes.csv  purchases.csv  payments.csv  payment-allocations.csv  refunds-reversals.csv
  bank-accounts.csv  bank-transactions.csv  bank-reconciliations.csv  cash.csv  vat-summary.csv  missing-artifacts.csv
  documents/sales|credit-notes|purchases/   only pieces that really exist
```

All CSVs always exist with their fixed header (predictable structure); an empty file means `0 rows` in the manifest.

## Conventions

UTF-8 with BOM, `,` delimiter, CRLF. Money: decimal with a dot and 2 decimals, explicit minus, no thousands separator (`-1234.50`), currency in its own column, never a float, never summed across currencies (totals per currency in the manifest; `MIXED_CURRENCIES` warning). Dates: civil `YYYY-MM-DD` (merchant calendar). Technical instants (`created_at`, `imported_at`): ISO 8601 UTC. A reversal row's period is its merchant **civil** day (`MERCHANT_TIMEZONE`), never the UTC day (DST-tested).

Whitelist only: each file has a fixed column list in `LAYOUT`; no table is dumped; no token, consent, vault or credential exists in the source of the builder. Own-bank identifiers are masked even if a store held a raw one (`masked()`); supplier IBAN/VAT numbers are invoice data and are carried.

## Truth sources

- Sales / credit notes: amounts and payment status through `settlement()` (= `invoiceAmounts`, the Payments definition): `gross, credited, effective_due, allocated, refunded, retained, remaining`. The stored lifecycle status (`document_status`) is shown but **never** used as authority (tested with a forged `PAID`). Status is as of generation.
- Purchases: remaining = gross − net allocations (`settlementOf`); validation state shown.
- Payments / allocations / refunds / reversals: payment registry and allocations only; the legacy `fin_payments` is not a source.
- Bank: accounts, transactions of the period, **derived** reconciliation state and linked payments from the reconciliation rows (`txAmounts`), never `matched_*`.

## Provenance

Every structured row carries its Nordla source id (`document_id`, `purchase_id`, `payment_id`, `allocation_id`, `transaction_id`, `reconciliation_id`, …); invoices carry `source_snapshot_sha256` (the issuance hash).

## Missing artifacts and PDF truth

`missing-artifacts.csv`: type, source id, document number, expected artifact, status, reason, alternative provided. Issued invoice/credit-note PDFs are **regenerated on demand**; no original is archived at issuance in this version. They are therefore always reported (`PDF_ARCHIVED_ORIGINAL`, `MISSING`, `NOT_ARCHIVED_AT_ISSUANCE`), and a regenerated PDF included in `documents/` is labelled `REGENERATED_COPY` (file name `…_REGENERATED-COPY.pdf`), never presented as the historical original. Statuses used: `ARCHIVED_ORIGINAL` (supplier file stored as received), `REGENERATED_COPY`, `MISSING`. A validated supplier document with no attachment (`NO_ATTACHMENT`) or whose stored file cannot be read (`ATTACHMENT_FILE_NOT_FOUND`) is missing. Peppol/UBL XML is not expected yet (not started) and says so in the README. **Gap for the invoice-compliance work:** archive the PDF (and later UBL) at issuance.

## VAT summary

`vat-summary.csv` is labelled **INFORMATIONAL VAT SUMMARY - not a VAT return**: base and VAT per stream (`SALES`, `CREDIT_NOTES`, `PURCHASES`, `PURCHASE_CREDIT_NOTES`), currency and rate, from the documents only. Credit notes are separate (nothing is netted). A purchase without a rate breakdown is `RATE_NOT_RECORDED` (never guessed). No deductibility, no regime logic, no Intervat.

## Integrity and reproducibility

`manifest.json` lists every file's rows, bytes and SHA-256; `verifyExportPackage` detects a modified, missing or unlisted file and a forged manifest line. `contentFingerprint` hashes the business CSVs only: identical data + parameters ⇒ identical CSV bytes and the same fingerprint; only `generated_at` (manifest, README) differs. Ordering is fixed (date, number, id). Generating records one audit event `ACCOUNTANT_EXPORT_GENERATED` in `fin_events` (id, period, fingerprint, ZIP SHA-256, row counts, warnings) so a package is identifiable later; the package itself is not stored (in-memory download for 30 minutes). No export-history table was created.

## Guarantees — SERVICE / POSTGRES / BOTH

SERVICE: assembly, formats, ordering, masking, missing-artifact rules, VAT summary, manifest/hashes. POSTGRES: the underlying facts (Payments, Bank, merchant isolation). BOTH: the same facts on memory and PG17, pinned by contract scenario `accountant export: package content from real store facts`. Merchant isolation: the builder drops any row whose `merchantId` differs.

## Performance

Builder volume tested: 3 000 invoices, 1 500 supplier invoices, 4 500 payments, 4 500 allocations, 15 000 bank transactions, 5 000 reconciliations → ≈1.3–1.5 s on the dev machine, 9 store reads (one per source), no per-row query. Including documents costs CPU per PDF (regeneration) and one file read per attachment, in bounded batches of 8.

## Remaining gaps

PDF/UBL not archived at issuance; no Peppol XML; no VCS/BBA field yet (nothing is invented: only stored references are exported); no accounting-software-specific import format; payment status is as of generation, not as of period end; the package is not persisted (only its identity is).
