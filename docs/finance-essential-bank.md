# Finance — Essential Bank

Scope: `Bank Account → Bank Transaction → Reconciliation → Payment / Allocation`. Observed money (bank) is kept apart from Finance money (Payments). Nothing here initiates a payment, forecasts, exports or selects a PSD2 provider. Migration: `supabase/migrations/20261005090000_finance_essential_bank.sql` (additive; no production migration was run).

## Model

| Object | Table | Nature |
|---|---|---|
| Bank account | `fin_bank_accounts` | identity per merchant, one currency, `origin` PROVIDER / CSV, masked IBAN only (CHECK requires `*`), no credentials; a connection may expose several accounts |
| Bank transaction | `fin_bank_transactions` | an **observed** movement (not a payment). Stable identity `(merchant, account, provider_tx_id)`, integer cents, currency, generated `direction`, value date, counterparty, structured/unstructured reference, bank reference, fingerprint, `imported_at`, provenance |
| Reconciliation | `fin_bank_reconciliations` | append-only N↔M link transaction↔payment (`MATCH`) or deliberate set-aside (`IGNORE`); signed amounts; a negative row is an unreconcile linked by `reverses_id`; no DELETE/UPDATE |
| Balance | `fin_bank_balances` | an observation: account, amount, currency, `as_of`, `source`; freshness is computed (FRESH ≤ 36 h / STALE / UNKNOWN). The Finance cash position is a separate, CALCULATED figure |

Derived (never stored as truth): `matched` = net MATCH, `ignored` = net IGNORE, `remaining = |amount| − matched − ignored` (≥ 0), status UNRECONCILED / PARTIALLY_RECONCILED / RECONCILED / IGNORED. The legacy `status` and `matched_*` columns are a trigger-written **mirror**; `fin_bank_tx_guard` refuses any value the reconciliation rows do not imply (`FIN_BANK_STATUS_IS_DERIVED`). They were not removed.

## Guarantees — SERVICE / POSTGRES / BOTH

See `BANK_GUARANTEES` in `src/finance/bank-ledger.js` (tested to be classified). Money/integrity rules are BOTH: PostgreSQL decides, the service/memory store gives the friendlier error and keeps the same codes.

- no over-reconciliation (transaction row lock + remaining ceiling) — BOTH
- a payment cannot be reconciled beyond what is left of it; a reconciled payment cannot be voided — POSTGRES
- currency and direction compatibility, integer cents, non-zero amount — BOTH
- claim→payment atomicity: `fin_bank_reconcile_and_pay` creates the payment (`fin_record_payment`) and the reconciliation in **one** transaction — POSTGRES (memory store: snapshot rollback)
- no last-writer-wins: lock order document → payment → bank transaction; an advisory transaction lock per idempotency key first — POSTGRES
- idempotency: unique `(merchant, key)` per row; identical retry returns the same effect (the service no longer pre-checks the remaining amount, so a retry after a partial reconciliation is a duplicate, not an error) — BOTH
- merchant isolation: composite foreign keys (account/transaction/payment/reconciliation) + `merchant_id` on every query — BOTH
- suggestion has no authority (`authority: 'NONE'`; evidence is built server-side only and stored with an explicit reconciliation) — SERVICE

## Import identity (CSV and provider)

Fingerprint = sha256(date | amount | reference | counterparty [| currency if not EUR]), 24 hex (first-version formula kept so stored ids stay valid). Without a usable id column the id is the fingerprint, plus `#n` for the n-th identical line **in one file**: two genuinely identical lines are not merged and re-importing the same file creates 0. Documented limit: two files that each contain the same identical line once are indistinguishable from a re-import. Controlled partial import (`allowPartial`) with line-by-line errors; currency, sign/direction, date and amount validated; provenance `csv`.

## Belgian readiness

Structured communication, masked IBAN, counterparty (and masked counterparty account), bank reference and transaction reference are stored. There is no VCS engine (no generation, no validation beyond storage).

## Upgrade of existing rows

The migration links existing transactions/balances to accounts (created from distinct `(merchant, account_id)`), keeps legacy claims as facts of the past, and never rewrites payments. Legacy `matched_*` is dead (not authoritative). An optional cutover of old claims to real reconciliations is **not** automatic: a legacy MATCHED row has no payment to link, so it needs a human decision (see remaining gaps).

## Remaining gaps (not built, by design)

- legacy MATCHED claims without a payment stay as they are (no automatic reconciliation invented)
- no provider selection / PSD2 production connection; provider retry is covered at the identity level only
- UI is minimal (status, remaining, reconcile with a new payment, set aside, unreconcile, accounts with balance freshness); allocation of a bank payment to specific invoices is done from the suggestion flow (Justify)
- cross-currency reconciliation is refused, not converted
- no CODA/camt import (CSV only)
