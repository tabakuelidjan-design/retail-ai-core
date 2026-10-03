# Finance V1 — final end-to-end acceptance

Status of this document: written at the end of the acceptance phase. All data is **synthetic**. Nothing was run against production, nothing was pushed, Core / Brain / Identity / Security / Tenant and `feature/core-sync-cron` were not touched.

This is an acceptance phase, not an implementation phase. Two real defects were found by acceptance and fixed minimally (section 4); one regulatory point (BT-83) was closed from the official sources (section 3). Nothing else in Finance was changed.

## 1. How the acceptance is built

| Piece | File |
|---|---|
| World builder (memory store **or** the production store code over PostgreSQL 17) | `test/finance-acceptance-world.js` |
| Scenarios S3 – S10, S12 – S15 … (assert their own invariants, return deterministic evidence) | `test/finance-acceptance-scenarios.js`, `-scenarios-2.js`, `-scenarios-3.js` |
| Memory run (part of the full suite) | `test/finance-acceptance.test.js` |
| PostgreSQL 17 run: same scenarios, evidence must be **identical** to memory; concurrency; restart; performance | `test/pg/90-acceptance.pg.test.js` |
| Artifact-failure proof for the export | `test/finance-acceptance-artifacts.test.js` |
| Measurement script | `test/finance-acceptance-perf.mjs` |

Principles enforced by the scenarios:

* The same business fact is read through every module and must agree **to the cent**: invoice settlement → payment registry → allocations → bank transaction / reconciliation → Treasury item → accountant-export row. Every scenario also re-derives the figure **independently from the raw rows** (`independent()` in the world file: gross − credit notes − net allocations + refunds paid out; supplier gross − net allocations). No settlement, Treasury or export code is used by that recomputation.
* No LLM is involved anywhere in the money path; all amounts are integer cents.
* Scenarios on PostgreSQL run on `supabase-store.js` unchanged over a real PostgreSQL 17 (`test/pg/lib/pgrest.js`), each in its own freshly migrated database.

## 2. Scenario matrix

Legend: **PASS** = executed, assertions hold, and (where marked PG) identical on PostgreSQL 17. **BACKLOG** = outside V1 by design (not a failure, not claimed as PASS).

| § | Scenario | Evidence (what is asserted) | Memory | PG17 |
|---|---|---|---|---|
| 3 | Belgian B2B invoice end to end | seller/buyer identity; number; issue/due dates; gross 1 000.00 = 826.45 + 173.55; immutable snapshot hash; VCS valid and derived from the number; PDF original + UBL original hashes equal the stored bytes; UBL and PDF carry the same amounts and number; official validation OK (BIS 3.0.21); route `PEPPOL_REQUIRED`; Peppol `QUEUED → SUBMITTED → DELIVERED` (delivery only from the provider status); payment → allocation → remaining_due; bank transaction reconciled; Treasury and export agree | PASS | PASS |
| 4 | Partial payment 400 + 600 | paid 400 / remaining 600 in settlement, independent recomputation, Treasury item and export row; bank reconciled; then 600 → remaining 0; further allocation refused | PASS | PASS |
| 5 | Four payments on one invoice | remaining 750 / 500 / 250 / 0; reversing the last allocation re-opens the invoice (derived status follows the allocations, no stored flag overrides) | PASS | PASS |
| 6 | One 1 000.00 payment over three invoices | allocated 100 %; over-allocation and currency mismatch refused; unallocated rest later allocated | PASS | PASS |
| 7 | Partial credit note (one of two lines) | linked to the invoice; own number; VAT effect 84.00; remaining_due 484.00; PDF original + UBL `CreditNote` archived and validated; route follows the invoice; over-credit refused; export row | PASS | PASS |
| 8 | Refund after a credit note | OUT payment linked to the credit note and the original payment; idempotent retry; second refund refused (`REFUND_EXCEEDS_CREDIT_NOTE`); bank OUT reconciled; export shows the signed amount; Treasury item gone; net cash = amount still due | PASS | PASS |
| 9 | Supplier invoice from an inbound Peppol document | exact bytes archived; validation recorded; candidate is not payable; human acceptance; partial 20.00 then 51.90; bank; Treasury; export; supplier state derived from payment truth | PASS | PASS |
| 10 | Duplicate inbound | webhook twice; polling + webhook; provider retry; same document with another transport id; same business document with different bytes → exactly one logical supplier invoice, conflicting bytes kept as evidence | PASS | PASS |
| 11 | 30 / 40 / 30 schedule | **BACKLOG** — the frozen model has no `due_schedule` storage and none was created. The business case is served by three ordinary payments (used in the mixed dataset); Treasury items have `installment: null` | not tested as a feature | – |
| 12 / 13 | Overdue customer / supplier | civil-date overdue days (33 / 32); customer overdue excluded from the projection and reported separately; supplier overdue assumed paid today; cleared by payment | PASS | PASS |
| 14 | Cash | count + later movements only; a same-day movement is not counted twice; deposit moves cash to the bank without double counting | PASS | PASS |
| 15 | Bank position | observed ≠ calculated; provenance; same-civil-day transaction not added, with a warning | PASS | PASS |
| 16 | DST / civil date | Europe/Brussels: 2026-03-28T23:30Z (local 2026-03-29), 2026-10-24T22:30Z (local 10-25), 2026-10-25T23:30Z (local 10-26): issue/due dates, overdue by civil date (the UTC date would say otherwise), bank same-day boundary, export period of that civil day | PASS | PASS |
| 17 | Multi-currency | EUR + USD never summed; `CURRENCIES_NOT_CONSOLIDATED`; export warns `MIXED_CURRENCIES` and separates; cross-currency allocation refused both ways | PASS | PASS |
| 18 | Belgian B2C | `NON_STRUCTURED_ALLOWED`, PDF original + payment reference, no structured original | PASS | PASS |
| 19 | International | foreign business → `NON_STRUCTURED_ALLOWED`; with a Peppol id → `PEPPOL_PREFERRED` | PASS | PASS |
| 20 | B2G | own route `B2G_STRUCTURED`; thresholds / exceptions explicitly *not evaluated* (note recorded) | PASS (supported routing only) | PASS |
| 21 | VCS / BT-83 | see section 3 | PASS | PASS (SQL == JS check in 80-legal) |
| 22 | Peppol failure paths | provider unavailable → `SUBMISSION_FAILED` → explicit retry → `SUBMITTED`; timeout before acceptance → unknown, restarted worker re-queues and sends once; timeout after acceptance → recovered by idempotency key, exactly one submit; nothing `DELIVERED` without a provider status; validation failure → nothing queued or sent | PASS | PASS |
| 23 | Artifact failures | corrupted / missing / unreadable bytes detected (`HASH_MISMATCH`, `STORAGE_OBJECT_MISSING`); corrupted UBL never sent; storage failure at send time is safe and recoverable; the export lists a damaged original as `MISSING` with its reason | PASS | PASS |
| 24 | Security | DOCTYPE / external entity / entity bomb (nothing resolved, raw bytes archived only); malformed XML; > 5 MiB and empty payloads; unsafe attachment types / names; path traversal names; bad webhook auth; wrong recipient; cross-merchant isolation (documents, artifacts, payments, bank, Peppol, Treasury, export); repository secret / privacy scan (`finance-privacy.test.js`) | PASS | PASS |
| 25 | Concurrency (16 real connections) | see section 5 | – | PASS |
| 26 | Restart / recovery | new service instance sees identical settlement; idempotent retry; originals intact; Peppol timeout-after-accept recovered; inbound crash between registration and the review transition is completed by the provider's resend | PASS | PASS |
| 27 | Export proof | mixed dataset exported with documents; verifier OK; modifying `sales.csv`, modifying a PDF, removing a PDF → verification fails (`FILE_MODIFIED` / `FILE_MISSING`) | PASS | PASS |
| 28 | Cross-module reconciliation | unexplained difference **0 cents** (customer settlement, export, Treasury; supplier export, Treasury; net payments export vs raw allocations) | PASS | PASS |
| 29 | Gift-shop-shaped synthetic dataset | counter cash sales, card sales reconciled to the bank, a B2B order paid in two steps (third part open), a return with credit note + refund, an overdue corporate invoice, supplier invoices (one part-paid), cash count + deposit — all synthetic, no production fact | PASS | PASS |
| 30 | Performance | section 6 | measured | measured |

## 3. VCS / BT-83 — closed from the official sources

* **Peppol BIS Billing 3.0.21, BT-83 `cbc:PaymentID` “Payment identifier”**: *a textual value used to establish a link between the payment and the Invoice, issued by the Seller*; cardinality 0..1; type Text; no Belgian-specific format. Source: docs.peppol.eu (`…/syntax/ubl-invoice/cac-PaymentMeans/cbc-PaymentID/`), read 2026-10-03.
* **Febelfin / EPC “AOS1 OGM-VCS”** (read directly): electronic form = **12 digits**; visual form = `+++xxx/xxxx/xxxxx+++`; in SEPA messages the structured creditor reference (`CdtrRefInf`, `SCOR`/`BBA`) carries the 12 digits.
* **Decision**: the Peppol specification leaves the Belgian representation undefined, so this is Nordla's documented decision: **BT-83 carries the 12 canonical digits; the PDF prints the visual form; the stored value is the same canonical number everywhere.** (BT-83 feeds the buyer's payment instruction, which is the electronic channel.)
* **Implementation before acceptance** put the printed form in BT-83 → corrected (section 4). A new Nordla invariant `NORDLA-SNAPSHOT-PAYMENT-REFERENCE` refuses a UBL whose BT-83 differs from the stored reference. Rules `PEPPOL-BT83-PAYMENT-ID` and the extended `FEBELFIN-OGM-VCS` are in the rule registry and in `docs/finance-belgium-compliance.md`. Test: `BT-83: the UBL payment identifier carries the Febelfin ELECTRONIC form …`.
* Credit notes carry no BT-83. Inbound documents are read in either form.

## 4. Defects found by acceptance and fixed (protocol: failing test first, smallest fix, rerun)

| # | Defect | Severity | Failing test written first | Fix |
|---|---|---|---|---|
| 1 | BT-83 carried the printed `+++…+++` form (decision of section 3) | LOW (representation; validation passes either way) | `finance-belgium-compliance.test.js` “BT-83 …” | `legal-artifacts.js`: pass the canonical reference to the UBL; invariant added; rules/docs updated |
| 2 | The accountant export reported `ARCHIVED_ORIGINAL` from metadata even when the stored bytes were missing, corrupted or unreadable (the file was silently left out) | MEDIUM (report did not state the truth) | `finance-acceptance-artifacts.test.js` | `accountant-export-service.js`: with documents requested, bytes are read back and hash-verified; failures become `MISSING` with `ARTIFACT_BYTES_NOT_FOUND` / `ARTIFACT_HASH_MISMATCH` in `missing-artifacts.csv`; preview stays metadata-only (documented) |
| 3 | A payment is committed atomically, then the stored status mirror is re-derived with an optimistic version. Under concurrency the losing callers received `CONCURRENT_MODIFICATION` **after the money had committed** (16 simultaneous payments: 16 committed, 14 callers told “failed”; the same race made competing credit notes fail spuriously) | MEDIUM (false failure on committed money invites a duplicate attempt under a new key; money truth itself stayed correct) | PG control “payments that together settle an invoice …” | `service.js` `resettle()`: re-read, re-derive and retry on `CONCURRENT_MODIFICATION` (bounded). Idempotent by construction |
| 4 | A Peppol inbound message registered by an attempt that was killed before its review transition stayed `RECEIVED` forever; the provider's resend was ignored as a duplicate | LOW–MEDIUM (nothing lost, no second invoice, but the document could not be accepted) | scenario `S26` | `peppol-service.js` `receive()`: a resend of a still-`RECEIVED` message with the same bytes completes it (every step is idempotent); audited as `PEPPOL_INBOUND_RESUMED` |

No test was weakened or skipped. The only existing assertion that changed is the old BT-83 expectation (printed form) which encoded the decision that section 3 corrects.

## 5. Concurrency on real PostgreSQL 17 (16 simultaneous connections, one service instance each)

| Race | Result |
|---|---|
| numbering + VCS | 16/16 issued, 16 distinct consecutive numbers, 16 distinct valid references |
| same payment request (one idempotency key) | 16 calls answered, 1 payment, 1 registry row, 1 first writer |
| competing payments (600.00 each against 1 000.00) | exactly 1 accepted, remaining_due never negative |
| payments that together settle an invoice | 16 succeed, 16 committed, stored status = derived status |
| one payment spread by competing allocations | allocated never exceeds the payment |
| competing credit notes + refunds | credited ≤ invoice (exactly 2 × 484.00 on 968.00); exactly 1 refund of the credit note |
| competing reconciliations | exactly 3 × 300.00 against a 1 000.00 transaction, status `PARTIALLY_RECONCILED` |
| Peppol enqueue + send | 1 message, 1 provider submission |
| inbound dedup (webhook / other transport ids) | 1 supplier invoice, 1 candidate, others `DUPLICATE` |
| money invariants after a mixed race | 0 differences between settlement and the independent recomputation |

## 6. Performance (V1 acceptance: the known ~1–1.5 s synchronous issuance is accepted; an asynchronous artifact pipeline is BACKLOG)

Measured with `node test/finance-acceptance-perf.mjs` (memory) and the PG control (PostgreSQL 17, 20 invoices): issuance p50 ≈ 0.3–0.4 s, p95 ≈ 0.5–1.1 s (official XSD + Schematron validation + PDF/UBL archiving included); payment ≈ 1–31 ms; Treasury model ≈ 30–60 ms; export of 20 invoices with documents ≈ 20–60 ms; Peppol queue ≈ 1–10 ms. Ceilings in the PG control are deliberately generous (they detect regressions, not noise).

## 7. Invariants (the final list)

1. Customer remaining_due = gross − credit notes − net allocations (+ refunds paid out on those credit notes); supplier remaining = gross − net allocations. Status is derived; a stored status is only a mirror and is re-derived idempotently.
2. A payment, an allocation, a reconciliation, a refund and a credit note can never exceed what they apply to (PostgreSQL enforces it; the service refuses early).
3. The same payment request (idempotency key) is one payment, however many times and from however many workers it arrives.
4. Peppol: one OUT message per document; provider acceptance is `SUBMITTED`, never `DELIVERED`; an unknown outcome is resolved by the provider's idempotency lookup, never by a blind resend; an invalid or damaged structured document is never sent.
5. Inbound: exact bytes archived first; dedupe by provider id / document hash / business key; one logical supplier invoice; a candidate is never payable before human acceptance.
6. PDF original and UBL original are produced from the same immutable snapshot; their recorded hashes are the truth, the bytes are verified on read, and a report never claims an original it cannot read back.
7. Treasury and the export never add currencies; civil dates are the merchant's (Europe/Brussels), never the UTC date.
8. Merchant isolation: no read or write crosses merchants (documents, artifacts, payments, bank, Peppol, Treasury, export).

## 8. Test commands and results

```
node test/pg/run.mjs                      # PostgreSQL 17: migrations replayed from zero, schema drift, all suites incl. 90-acceptance
node --test test/finance-*.test.js        # Finance suite (includes the memory acceptance, privacy / merchant-name guards)
node --test test/*.test.js                # full suite
node test/finance-acceptance-perf.mjs     # measurement
```

Results (final run, see the report): PostgreSQL 17 165/165 (155 controls pass, 3 known legacy gaps unchanged); Finance 773/773; full suite 1301/1301; migration replay from zero and the schema-drift test are part of the PostgreSQL run (`00-infra`).

## 9. Limitations (V1, stated, not failures)

* No due-date schedule storage (30 / 40 / 30 is represented by ordinary payments).
* B2G: routing only; procurement thresholds / exceptions are not evaluated (explicit note).
* Issuance is synchronous (≈ 0.3–1.5 s).
* The Peppol provider is a deterministic fake behind the provider contract; no real network call was made.

## 10. Backlog (listed only; not started)

e-reporting; Intervat; general ledger; advanced B2G; self-billing; advanced FX; PSD2; payment initiation; accounting-software-specific exports; AI financial advice; asynchronous artifact pipeline; real Peppol provider procurement; due-date schedule storage.

## 11. Unresolved external dependencies

* **Peppol provider selection / contract and sandbox credentials**: the real network behaviour (delivery receipts, participant directory, certificates) cannot be exercised before a provider exists.
* **Confirmation of the BT-83 convention with the chosen provider / recipients' ERP** (the Peppol spec itself leaves it open; Nordla follows Febelfin's electronic form).
