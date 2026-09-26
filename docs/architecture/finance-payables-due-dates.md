# Finance — supplier due dates, payment terms and status axes (phase 4.7)

Deterministic, model-free. Code: `src/finance/payables/` (`payment-terms.js`, `due.js`, `status.js`, `index.js`). Nothing here reads a bank, writes a payment or notifies anyone.

## Rules

1. **No invented due date.** A due date exists only if the document prints one, or prints an explicit payment term of the closed grammar *and* the invoice date is valid. Otherwise it is `UNKNOWN`. The merchant's own invoicing terms (`defaults.paymentTermsDays`, which apply to invoices HABB *issues*) are never used for supplier documents.
2. **Origin** of a due date (`extraction.provenance.dueDate.source` + evidence in `extraction.due`):

   | Origin | Meaning | provenance source |
   |---|---|---|
   | `MANUAL` | a person typed/corrected/cleared it — never overwritten | `user` (the existing mechanism) |
   | `PRINTED` | printed on the document (PDF / UBL reader) | the reader's own (`PDF_TEXT`, `ubl`) |
   | `COMPUTED_FROM_TERMS` | computed from an explicit term; the original wording is kept | `computed` |
   | `UNKNOWN` | none of the above | — |

   Priority `MANUAL > PRINTED > COMPUTED_FROM_TERMS > UNKNOWN`. Printed and computed both present: the printed date stays the value, the computed one is kept as evidence; if they differ the difference is reported (`DUE_DATE_DIFFERS_FROM_TERMS`, shown in the review pane) — a person reviews every document.
3. **Closed grammar** (`GRAMMAR_VERSION`, FR / NL / EN): payable immediately (`due = invoice date`, D4), net N days, N days end of month, prepaid / paid at the source (no due date). Anything else (discounts, deposits, "selon contrat", a starting point other than the invoice date, an ambiguous text, N > 365) is reported and **not** interpreted. An unlabelled text must be a short whole phrase with a payment cue: warranties, return periods, dispute periods, reference ids and "every 30 days" are not terms. Extending the grammar means adding wordings **and** tests.
4. **Two status axes**, derived and never stored: settlement (`UNPAID / PARTIALLY_PAID / PAID`, plus `NOT_PAYABLE`, `UNKNOWN`) and calendar (`NOT_DUE / DUE_TODAY / OVERDUE`, plus `NO_DUE_DATE`, `NOT_APPLICABLE` once settled). They are independent: `PARTIALLY_PAID` + `OVERDUE` is representable. A validated or "to pay" document is never `PAID`; only a recorded payment settles it. In 4.7 the only payment is the existing full manual `pay()`; `PARTIALLY_PAID` is exercised with simulated allocations and becomes real in 4.8.
5. **Days remaining** = `due − today` (same convention as `receivables.js`, `daysOverdue = today − due`). `today` is always a parameter. Messages are structured objects worded by the interface translations (FR / NL / EN), never model-written.
6. **Treasury.** A computed due date enters the projection only if it comes from an explicit term and its wording is kept; `outgoingFromTermsCents / Count` count these apart from printed dates. `UNKNOWN` never enters.

## Storage (no migration)

`fin_supplier_invoices.due_date` stays the *effective* date, so every existing consumer is unchanged. Evidence is in the existing `extraction` jsonb:

```json
"extraction": { "due": { "version": 1, "issueDate": "…", "printed": { "value": "…", "page": 1, "rule": "…" } | null,
  "terms": { "raw": "wording as printed", "status": "PARSED", "parsed": { "kind": "NET_DAYS", "days": 30, "referencePoint": "INVOICE_DATE", "referenceExplicit": false, "endOfMonth": false }, "grammarVersion": "pt-1" } | null,
  "computed": { "value": "…", "referenceDate": "…", "days": 30, "endOfMonth": false } | null, "effective": { "value": "…", "origin": "…" }, "divergence": null, "suppressed": false } }
```

Records created before 4.7 have no `extraction.due`; their origin is derived at read time (no provenance ⇒ `MANUAL`, flagged `legacy`, never claimed to be printed) and they are never rewritten.

## Not in 4.7 (phase 4.8+)

Persisted payment allocations and real partial payments, the `TO_PAY / PAID` rework (today `TO_PAY` is a workflow step, `PAID` a final manual payment), bank matching, alerts.
