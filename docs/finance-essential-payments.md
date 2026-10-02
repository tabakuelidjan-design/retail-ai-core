# Finance Core - Essential Payments

Migrations (additive, not applied to production): `20261003090000_finance_integrity_p0.sql`, `20261004090000_finance_essential_payments.sql`. Cutover rehearsal script (not a migration): `supabase/cutover/payments-cutover.sql`.
Proofs: `test/pg/` on real PostgreSQL 17 (`node test/pg/run.mjs`), `test/finance-essential-payments.test.js`, `test/finance-payment-contract.test.js`, `test/finance-payments-api.test.js`.

## The model (single source of truth)

| Concept | Where | Rule |
|---|---|---|
| Payment | `fin_payment_registry` | a real monetary operation: IN or OUT, positive integer cents, one currency, one method, a provenance. Append-only |
| Allocation | `fin_payment_allocations` | part of ONE payment applied to ONE document. Negative = reversal of an earlier allocation. Append-only |
| Reversal | negative allocation, or a registry row with `reversal_of_id` | never a delete; bounded; linked to the original; idempotent |
| Refund | an OUT payment allocated to a customer **credit note** (+ optional `refund_of_payment_id`) | the money handed back FOR a credit note. A credit note alone moves no money |
| Document payment status | derived | customer invoice: from `fin_invoice_amounts` (the stored lifecycle status is re-derived by the service after every change). Supplier invoice: `payment_status` and `PAID` derived by triggers |

Credit note (legal/commercial reduction of the receivable) != refund (money returned) != reversal (technical cancellation of an earlier operation).
Unallocated surplus: `unallocated = amount - reversals - net allocations`. It never disappears and is never applied by itself; `fin_allocate_payment` applies it to documents a person names.
Legacy fields (`fin_payments`, `paid_at`/`paid_amount_cents`/`paid_reference`/`payment_status` of supplier invoices, `matched_*` of bank transactions) remain for compatibility; none is an authority any more.

## The amounts (one definition: `src/finance/amounts.js` = SQL `fin_invoice_amounts`, held equal by a randomised test)

```
document_total = gross + rounding        credited      = sum of document_total of the ISSUED credit notes
effective_due  = max(0, total - credited) allocated     = net IN allocations to the invoice
refunded       = net OUT allocations to its credit notes      retained = allocated - refunded
remaining_due  = max(0, effective_due - retained)             refundable = max(0, retained - effective_due)
```
Invariants: `retained >= 0` (money given back cannot be un-paid: reverse the refund first); an allocation never makes `retained > effective_due` (no over-payment by allocation; over-payment can only come from a credit note issued after payment, and then `refundable > 0`); `refund <= refundable`, `<=` its credit note, `<=` the payment it gives back. Worked cases: pay 100 then credit 30 -> remaining 0, refundable 30; refund 30 -> retained 70 = due; credit 30 before payment -> due 70, pay 70 -> PAID; reversal of 40 on a paid invoice -> remaining 40 (if nothing refunded).

## Guarantees (S = service, P = PostgreSQL, B = both) - `payment-ledger.js` GUARANTEES

| Guarantee | Class |
|---|---|
| credit ceiling per invoice (serialised by the invoice row lock) | B |
| allocation <= remaining of the document (`retained + new <= effective_due`), supplier: `net + new <= gross` | B |
| allocations <= unallocated of the payment | P |
| refund ceilings (credit note, refundable of the invoice, payment given back) | B |
| reversal bounds; reversal cannot take back refunded money | P |
| idempotency: unique (merchant, key) + request fingerprint (covers method, source, references); per (key, target) for allocate/reverse | B |
| direction (IN pays invoices, OUT pays credit notes and suppliers), currency (no conversion) | B |
| method vocabulary (`cash, bank_transfer, card, bancontact, direct_debit, other`; `unspecified` default) | B |
| supplier PAID both ways: refused without allocations, and a fully allocated invoice cannot be written away from PAID | P |
| merchant isolation (composite foreign keys, every query carries merchant_id) | P + S |
| customer stored status re-derived after each command | S |
| append-only history, no SECURITY DEFINER, RPC for service_role only | P |

Locking order (never reversed): 1 target document (refund: credit note, then its invoice), 2 payment (the new one, then the one it refunds), 3 bank transaction; several targets ascending by id; same-key retries of reverse/void/allocate serialise on an advisory lock taken before any row lock. A deadlock aborts the victim and is reported, never retried automatically.

## Provenance (no secret, no provider as business type)

`method` = business type. `source` = `manual | bank | provider:<name> | legacy:*`. `external_reference` (provider reference), `bank_reference` (bank transaction reference), `structured_reference` (Belgian structured communication: stored, NOT generated here), `reference` (free text). Audit answer for a payment: `GET /api/payments/:id` (who `actor`, when `createdAt`, source, amount, currency, every allocation and reversal, idempotency key) + the typed events `RECORD_PAYMENT | RECORD_REFUND | RECORD_SUPPLIER_PAYMENT | ALLOCATE_PAYMENT | REVERSE_PAYMENT_ALLOCATION | VOID_PAYMENT` written in the same transaction.

## Business API (intentions only)

`svc.payments`: `receive`, `pay`, `allocate`, `reverseAllocation`, `voidPayment`, `refund`, `get`, `list`. HTTP: `POST /api/payments`, `POST /api/supplier-payments`, `POST /api/payments/:id/allocate`, `POST /api/payments/:id/void`, `POST /api/payment-allocations/:id/reverse`, `POST /api/documents/:creditNoteId/refund`, `GET /api/payments[?unallocated=1&direction=]`, `GET /api/payments/:id`. `Idempotency-Key` header (or `idempotencyKey`) on every command. The detail of an invoice / credit note carries the derived truth (`settlementView`, `refund.maxCents`, `actions`), so the interface never recomputes it.

## Cutover to the new payment truth (NOT performed)

Production Finance data was reported empty at the P0 audit (0 payments, 0 validated supplier invoices) but this was **not re-verified here** (read access to production was refused by the environment); verify with the queries below before anything else.

### 0. Pre-flight (read-only, on production)
```sql
select version from supabase_migrations.schema_migrations where version in ('20261003090000', '20261004090000');                  -- expected: 0 rows (not applied yet)
select count(*) filter (where amount_cents > 0) as pos, count(*) filter (where amount_cents < 0) as neg, count(distinct document_id) as docs, coalesce(sum(amount_cents),0) as net from fin_payments;
select count(*) as paid, count(*) filter (where paid_amount_cents = gross_cents and paid_at is not null and currency is not null) as consistent from fin_supplier_invoices where status = 'PAID';
select (select count(*) from fin_documents) docs, (select count(*) from fin_supplier_invoices) sup, (select count(*) from fin_companies) companies, (select count(*) from fin_events) events;
-- rows that would VIOLATE the new composite foreign keys (all must be 0, otherwise migration 20261003090000 fails; fix the data first):
select count(*) from fin_documents d join fin_documents r on r.id = d.related_document_id where r.merchant_id <> d.merchant_id;
select count(*) from fin_documents d join fin_companies c on c.id = d.customer_company_id where c.merchant_id <> d.merchant_id;
select count(*) from fin_supplier_invoices s join fin_companies c on c.id = s.supplier_company_id where c.merchant_id <> s.merchant_id;
select count(*) from fin_events e join fin_documents d on d.id = e.document_id where d.merchant_id <> e.merchant_id;
select count(*) from fin_payments p join fin_documents d on d.id = p.document_id where d.merchant_id <> p.merchant_id;
-- legacy invoices overpaid in the old model (will be reported, not hidden):
select d.id, d.gross_cents, sum(p.amount_cents) from fin_payments p join fin_documents d on d.id = p.document_id group by 1, 2 having sum(p.amount_cents) > d.gross_cents;
```
Expected if the audit still holds: all counts 0 -> the backfill is a no-op and the cutover reduces to applying the two migrations and deploying.

### 1. Sequence (one maintenance window; PostgreSQL has no shadow mode for triggers)
1. Backup / restore point. Stop writes (or accept a short window). 2. Apply both migrations (`supabase db push` against staging first, then production). **From this moment the OLD application can no longer mark a supplier invoice PAID** (the truth guard refuses it); the old customer payment path still works (it writes `fin_payments`). So deploy the new code immediately after. 3. `begin; \i supabase/cutover/payments-cutover.sql; select pg_temp.cutover_plan(); select pg_temp.cutover_backfill(); select pg_temp.cutover_validate(); rollback;` (dry run; read the exceptions) then the same with `commit` if `problems` is empty. 4. Deploy the new code. 5. Re-run the backfill (idempotent) and the validation once more: any `fin_payments` row written by the old code between steps 3 and 4 is picked up. 6. Observe.

### 2. Legacy -> new mapping
`fin_payments > 0` -> registry IN + one allocation (key `legacy:fin_payments:<id>`, source `legacy:fin_payments`, unknown method -> `other`). `fin_payments < 0` -> negative allocations reversing the latest standing allocations of the invoice (LIFO, bounded). Supplier `PAID` with `paid_amount = gross` and `paid_at` -> registry OUT + one allocation. Everything else (corrections larger than paid, `PAID` with another amount or none, missing currency, overpaid beyond the invoice) is listed as an exception for a human decision; nothing is guessed. Bank `matched_payment_id` keeps pointing at legacy ids (accepted by the guard); no remap.

### 3. Rollback
Before step 2: nothing to do. After the migrations, before the new code: revert nothing (old code works except supplier PAID); drop the new objects only if abandoning (list in `docs/finance-p0-integrity.md`, plus `fin_invoice_amounts`, `fin_allocate_payment`, the v2 `fin_record_payment`, the added registry columns). After the new code ran: revert the code; payments recorded in the new tables since the cutover must be copied back into `fin_payments` by a reverse script **that does not exist yet and must be written only if a rollback is ever needed** (with production data this small, rolling back within the first hours is cheap). The legacy tables are never modified by the cutover, so they stay a valid fallback for everything before the cutover.

### 4. Compatibility period and freezing `fin_payments`
Keep `fin_payments` and the supplier `paid_*` columns read-only-by-convention for at least 14 days after the cutover. Conditions to FREEZE (a later migration, with the owner's explicit approval, draft: `create trigger fin_payments_frozen before insert on fin_payments for each row execute function fin_append_only();`): `cutover_validate()` clean; `select max(created_at) from fin_payments` older than the cutover and no insert for 14 days; reports, receivables, accountant pack and bank reconciliation verified on the new truth; no code path references `fin_payments` (`grep`); a restore point exists. Conditions to DEPRECATE (drop) the legacy columns/table: a further observation period and a separate explicit approval. Nothing is dropped by these migrations.

## Not in this step (explicit)

Bank/Reconciliation ledger (N-M, accounts, import), Treasury, Accountant export, Peppol, VCS/BBA generation (only the storage column `structured_reference`), reminders, vendor IBAN checks, payment initiation, supplier credit notes (IN allocated to supplier credit notes), `fin_events` entity columns, payment schedules.
