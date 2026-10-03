# Finance — Essential Treasury (V1)

`Observed cash → Calculated position → Committed in/out → Forecast 7/30/90 → Scenarios → Explainability`

Treasury is a **read model**. It owns no table, writes nothing and keeps no second version of a payment, balance, invoice, supplier debt or allocation. It consumes: Payments (`remaining_due` through `settlement()` / `invoiceAmounts`, the single amounts definition; supplier remaining = gross − net allocations), Bank (observed balances, accounts, later transactions, derived reconciliation state — never `matched_*`) and cash (last count + later movements). No migration, **0 new tables**.

Files: `src/finance/treasury-engine.js` (pure, deterministic), `src/finance/treasury-service.js` (gathers facts: one read per source), routes in `server/app.js`, UI in `ui/views-workspace.js` (`drawTreasuryV1`). The old `bank.treasury()` calculator was removed; the legacy `/api/treasury` summary is now **derived from the same model** (`legacyView`), so there is one calculation. `treasury.js` (`buildTreasury`) remains only as a unit-tested legacy function no service calls (technical debt: delete with its tests in a later cleanup).

## Definitions

| Label | Meaning |
|---|---|
| OBSERVED | bank balance (account, amount, currency, `observed_at`, source, freshness) or a person's cash count |
| CALCULATED | observed + bank transactions **strictly after** the observation civil day + cash movements after the count day. Never a new observation |
| FORECAST | known future flows applied to the calculated position |
| SCENARIO | a user hypothesis, ephemeral |

Freshness: bank = existing rule (`observedBalance`, FRESH ≤ 36 h / STALE / UNKNOWN); cash = FRESH ≤ 2 days since the count. The position's freshness is the worst component. Observation day = merchant civil day (`MERCHANT_TIMEZONE`), never the UTC day.

Certainty (no invented probability): COMMITTED = supplier invoice owed, customer invoice not yet due; EXPECTED = overdue customer invoice (may be paid, nobody knows when); SCENARIO = hypothesis.

Overdue never disappears and its date is never silently moved: overdue **receivable** stays visible with its original due date, is **not counted** in the projection (shown as "excluded") unless a scenario says when it is collected; overdue **payable** is counted **today** (earliest payment) and keeps its original due date. A supplier invoice without a due date is reported and not forecast (never invented).

Schedules: a customer document with a `dueSchedule` (shares in basis points or amounts, summing to the amount due) yields one item per instalment; money already paid is applied to the earliest instalments first. The frozen model stores no schedule today (`due_schedule` does not exist): the engine and tests support it, nothing was created for it. An inconsistent schedule is ignored (single due date).

Currencies: computed per currency, never summed; consolidation is refused (`NO_RELIABLE_FX_RATE`) when more than one currency is present. Cash has no currency of its own: it takes the merchant default.

## Double-counting guards

Receivable/payable = remaining after Payments (invoice+payment, credit note, partial). Bank: transactions up to and including the observation day are never added (same-day ones are reported, not added); a later transaction not reconciled is **reported** (`UNRECONCILED_LATER_TRANSACTIONS`) because the matching invoice may still look open. Cash: movements on or before the count day are never added. A payment already in the bank balance has already reduced `remaining_due`, so it is not forecast again.

## API

`GET /api/treasury/position`, `GET /api/treasury/forecast?horizon=7|30|90`, `GET /api/treasury/explain?id=…`, `POST /api/treasury/scenario {hypotheses}` (pure computation; types `ADD_EXPENSE`, `ADD_INCOME`, `DELAY_RECEIVABLE`, `DELAY_PAYABLE`, `REDUCE_INFLOW` (basis points), `COLLECT_OVERDUE`), `GET /api/treasury` (legacy summary). Item ids are `CUSTOMER_INVOICE:<id>[#n]`, `SUPPLIER_INVOICE:<id>`, `SCENARIO:<n>`; every item carries `sourceType`, `sourceId`, evidence (gross/paid/credited/remaining), certainty and treatment.

## Guarantees — SERVICE / POSTGRES / BOTH

- SERVICE: all forecast arithmetic, freshness, certainty, overdue treatment, risk, scenarios, explainability, currency separation. Deliberately **not** in PostgreSQL.
- POSTGRES: the facts it reads (payments/allocations/amounts, reconciliations, balances, merchant isolation, integer cents) — protected by Phase 0, P0, Essential Payments and Essential Bank.
- BOTH: the memory store and PostgreSQL give the same facts, pinned by contract scenario `treasury: position, forecast 7/30/90 and risk from real store facts` (identical on memory and PG17).
- No-write: the service receives a read-only store (a test proxy throws on any other method); a static test forbids write calls and I/O in the Treasury sources.
- No AI: no model is called or allowed to produce an amount, date, probability or obligation; a later explainer must receive these deterministic facts.

## Performance

Test volume: 3 000 open invoices, 2 000 supplier invoices, 3 000 payments, 20 000 bank transactions → ~5 000 items in under a second (≈0.75 s on the dev machine), exactly one read per source (5 store reads + the two document/inbox reads), no per-invoice query. Known limit: `listBankTransactions` reads the merchant's whole history; a `dateFrom` filter is the obvious next step if histories become very large.

## Remaining gaps

No `due_schedule` storage (engine ready); no recurring/known-future non-invoice flows (rent, payroll, VAT) except through scenarios; payments recorded but not yet seen in bank are not reported as such; no FX; no notifications; history chart on the page is still the realised-flow chart from before.
