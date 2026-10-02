# Finance P0 financial integrity (Phase 1)

Migration: `supabase/migrations/20261003090000_finance_integrity_p0.sql` (additive, not applied to production). Proofs: `test/pg/` (real PostgreSQL 17) and `test/finance-payment-contract.test.js` (memory store).

## What is guaranteed, and where (S = service, P = PostgreSQL, B = both)

| Guarantee | Where | Mechanism |
|---|---|---|
| Credits of an invoice never exceed it (single, successive, simultaneous, retried, partial, full) | B | trigger `fin_credit_ceiling_guard` locks the invoice row `FOR UPDATE`; service pre-check gives the friendly error |
| A payment never exceeds the remaining of its target (customer invoice net of credits, supplier invoice) | B | trigger `fin_payment_allocation_guard`, target row locked |
| Allocations never exceed their payment (unallocated = payment - reversals - allocations) | P | same trigger, payment row locked |
| Idempotency: same key + same request = the committed operation; same key + other request = refused | B | unique `(merchant_id, idempotency_key)` + `request_hash` in `fin_record_payment`; service looks the key up before its own pre-checks |
| Direction (IN pays customers, OUT pays suppliers) and currency (no conversion) | B | trigger |
| Reversal: linked to the original, negative, bounded, idempotent, never a delete | P | `fin_reverse_allocations`, `fin_void_payment`, triggers, append-only |
| Supplier PAID / payment_status are derived from allocations, never written | P | `fin_supplier_invoice_truth_guard` (refuses PAID without net = gross, overwrites payment_status) + `fin_supplier_invoice_mirror` |
| Merchant isolation of the critical relations | P (+ S: every query carries merchant_id) | composite foreign keys `(child, merchant_id) -> (parent id, merchant_id)` |
| A handled bank transaction is claimed once (no last-writer-wins) | P (+ S: compare-and-set on status NEW) | `fin_bank_tx_guard`: `matched_*` frozen, target and payment must belong to the merchant, amount bounded |
| History is append-only | P | `fin_append_only` on registry and allocations |
| Nothing callable by anon/authenticated | P | RLS enabled, grants revoked, no SECURITY DEFINER |

## Transactions, locks, isolation, retries

- One operation = one RPC = one transaction (PostgreSQL READ COMMITTED; every statement of a plpgsql function sees the rows committed before it ran, after the row lock was granted).
- Locking order, always: 1 target document (customer invoice / supplier invoice), 2 payment, 3 bank transaction. Several targets are processed in ascending id. Credit issuance locks the credit note, then the invoice (a different table pair, no cycle with the above).
- Same-key retries of reversal/void serialise on a transaction advisory lock taken before any row lock; `fin_record_payment` serialises on the unique index of the key.
- A deadlock aborts the victim transaction and is reported to the caller. It is never retried automatically. The client library retries only transient transport errors (429/502/503/504/network), and only for the three idempotent RPCs (`{ retry: true }`); every other write keeps `retry: false`.
- After an ambiguous network result the caller repeats the same request with the same key and receives the committed operation (`duplicate: true`).

## Idempotency keys

- Dashboard: one key per opened payment form. API: `Idempotency-Key` header (wins) or `idempotencyKey` in the body. Absent or malformed = a fresh operation.
- Bank confirmation: the key is `bank:<bank transaction id>`, so one transaction can settle only one thing even when two confirmations race.

## Rollback (nothing is deployed; for the day it is)

The migration only adds objects and new constraints. Before the application code switches to the registry nothing reads them, so reverting the code is enough. To remove the database side: drop triggers/functions/tables `fin_payment_allocations`, `fin_payment_registry` (empty until cutover), the composite constraints (`*_same_merchant_fk`, `*_id_merchant_uq`), the triggers `fin_credit_ceiling_guard_trg`, `fin_supplier_invoice_truth_guard_trg`, `fin_payment_*_trg`, and restore `fin_bank_tx_guard()` to its body in `20260922220000_finance_bank_treasury.sql`. Legacy `fin_payments` is untouched.

## Not in this phase (explicitly)

`fin_allocate_payment` (allocating an existing payment later: Phase 2), refunds linked to credit notes (Phase 2), partial supplier payments in the service/UI (Phase 3), bank accounts and `fin_bank_reconciliations` N-M ledger (Bank phase: today a failed payment after a successful claim leaves a claimed transaction without payment; it cannot be re-claimed, only completed with the same key), French/Dutch texts for the new error codes, `fin_events` entity columns (Phase 9), freezing `fin_payments` by trigger (after the cutover observation).
