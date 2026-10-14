# Finance V1 — closure record

Written 2026-10-03 at the end of the "final validation & closure" phase. Nothing in this phase deployed, migrated, pushed or wrote to production. Production was read with **read-only SELECTs** (Supabase project `retail-ai-core-dev`, the project that holds the single real merchant). Facts that could not be read are marked **UNKNOWN** and are never counted as PASS.

Code baseline: branch `feature/finance-resume`, HEAD `8efc09f` (acceptance commits `d881c4f`, `8efc09f` on top of `d9482e2`). No implementation change was needed in this phase.

## 1. Architecture summary

| Layer | What it is | Where |
|---|---|---|
| Document model | invoice / credit note, integer cents, immutable once issued (snapshot hash), legal numbering per merchant/type/year | `document.js`, `service.js`, `fin_documents`, `fin_number_sequences` |
| Payment registry | append-only payments (IN / OUT) + allocations + reversal rows; idempotent by key | `payments.js`, `fin_payment_registry`, `fin_payment_allocations` |
| Bank | accounts, observed transactions, append-only reconciliations | `bank*.js`, `fin_bank_*` |
| Treasury | pure read model: observed → calculated → forecast 7/30/90 → scenarios, per currency, civil dates | `treasury-*.js` |
| Accountant Export | whitelisted CSV + manifest + SHA-256 + README, verifier, artifact bytes read back and verified | `accountant-export*.js` |
| Belgium & Peppol | route decision, VCS/OGM, legal artifacts (PDF + UBL originals), official validation (UBL XSD, EN16931, Peppol BIS 3.0.21 Schematron), Peppol messages behind a provider contract | `belgium-compliance.js`, `legal-artifacts.js`, `peppol*.js`, `fin_artifacts`, `fin_peppol_messages`, `fin_seller_profile_versions` |

Protection lives in PostgreSQL (triggers, constraints, RPCs); the service adds the same checks only for friendlier errors.

## 2. Final source-of-truth map

| Domain state | SOURCE OF TRUTH | DERIVED FROM | MUST NEVER BE AUTHORITATIVE |
|---|---|---|---|
| Invoice (content, number, totals) | `fin_documents` row at issuance (hash-locked snapshot) | — | the PDF bytes, a Shopify order, a re-render |
| Invoice status (PAID, PARTIALLY_PAID…) | derived `settlement()` | payment registry, allocations, credit notes, refunds | the stored `status` column (only a mirror, re-derived idempotently) |
| Payment | `fin_payment_registry` (append-only) | — | legacy `fin_payments`, Shopify payment evidence, bank line |
| Paid amount | net sum of allocations (reversals included) | allocations | any stored paid flag / `paid_amount_cents` mirror |
| Remaining amount | gross − credit notes − paid (+ refunds paid out) | document, credit notes, allocations | stored status |
| Credit note | issued `fin_documents` row linked to its invoice | — | free-text, Shopify refund |
| Refund | OUT payment allocated to the credit note | registry | Shopify refund object |
| Supplier liability | supplier invoice after human acceptance | `fin_supplier_invoices` | an inbound candidate, an OCR extraction |
| Supplier paid amount | net allocations to the supplier invoice | registry | `paid_at` / `paid_amount_cents` / PAID mirror |
| Bank transaction | `fin_bank_transactions` (observed fact) | provider / CSV | legacy `status`, `matched_*` |
| Reconciliation | `fin_bank_reconciliations` (append-only) | — | `matched_*` mirror, a payment's own claim |
| Cash position | last cash count + later movements | `fin_cash_counts`, `fin_cash_movements` | an estimate |
| Treasury position | observed balance + later transactions | bank, cash | forecast items, Shopify sales |
| Treasury forecast | model output (receivables / payables by civil date) | documents, supplier invoices, settlement | a stored figure; never a LLM |
| Accountant Export | generated package | all of the above, read back and hash-verified | — (never a source for anything) |
| PDF original | `fin_artifacts` hash (bytes in storage) | issue snapshot | a regenerated copy (labelled `REGENERATED_COPY`) |
| UBL original | `fin_artifacts` hash (bytes in storage) | same snapshot | the PDF text |
| Peppol state | `fin_peppol_messages` state machine | provider acknowledgements | document status; acceptance is never delivery |

## 3. Shopify ↔ Finance boundary

| Fact | Owner |
|---|---|
| Shopify order, customer, product, refund object, payment evidence | Shopify / Core (read by Finance as **evidence only**) |
| Invoice, credit note, Finance payment, allocation, bank transaction, reconciliation, cash, supplier invoice | Finance |

Finance never writes to Core tables or to Shopify; Core is not a ledger for V1. A Shopify refund or paid order is evidence that may prompt a Finance credit note / payment, but only a Finance record changes money truth. No competing monetary truth was found. Ambiguity noted (documented, not a blocker): a Shopify refund and a Finance refund are two records of the same real-world event until a person links them (V1.1 candidate: explicit link).

## 4. Production evidence (READ ONLY, 2026-10-03)

| Item | Result |
|---|---|
| Merchants | exactly **1**: id `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5`, name HABB, source `shopify`, domain `zmb5jr-wf.myshopify.com` — **READY** |
| Connectors | exactly **1**, `shopify`, same domain, status **CONFIGURED**; no duplicate |
| Finance rows on another merchant | none (the only merchant id present anywhere is HABB's) |
| `MERCHANT_TIMEZONE` | **UNKNOWN** (an environment variable of the hosting service; not readable from the database). Must be confirmed `Europe/Brussels` before activation |
| Tenant fallback | `NORDLA_MERCHANT_ID` resolver is shared with Core; confirmation of the deployed value is part of the preflight (UNKNOWN until then) |
| Applied migrations | 23, last `20260929130411 merchant_connectors` |
| Storage | bucket `finance-inbox`, private, 5 objects |
| RLS | enabled on all 12 existing `fin_*` tables |

Production Finance inventory (row counts):

| Table | Rows | Notes |
|---|---|---|
| `fin_documents` | 0 | |
| `fin_payments` (legacy) | 0 | |
| `fin_supplier_invoices` | 1 | HABB, `TO_REVIEW`, source `upload`, no amounts, no payment |
| `fin_bank_connections` / `fin_bank_transactions` / `fin_bank_balances` | 0 / 0 / 0 | |
| `fin_cash_counts` | 1 | 150.00, 2026-09-26 |
| `fin_cash_movements` | 0 | |
| `fin_events` | 4 | all `PACK_COMPTABLE_GENERATED` |
| `fin_companies`, `fin_number_sequences`, `fin_stock_movements` | 0 | |
| `fin_payment_registry`, `fin_payment_allocations`, `fin_bank_accounts`, `fin_bank_reconciliations`, `fin_artifacts`, `fin_peppol_messages`, `fin_seller_profile_versions` | **table absent** (pending migrations) | not assumed applied |

(The separate staging project holds only synthetic data for a different, synthetic merchant; it is not production.)

### Legacy data compatibility

Production Finance is **practically empty**: no document, no payment, no bank data. The single supplier invoice is an unvalidated upload with null amounts, so none of the new invariants (merchant isolation, registry truth, allocations, credit ceiling, refund, supplier-payment truth, reconciliation, status constraints, immutability, numbering, VCS uniqueness, currency, artifacts, Peppol) can be violated by existing rows; the cash count carries no new constraint. No migration complexity is invented. Cutover on legacy data (including messy data) is nevertheless proven on PostgreSQL 17 (`test/pg/60-cutover.pg.test.js`).

## 5. HABB seller profile readiness

Source: the public legal-notice page of the shop theme (`policy-legal-notice.html`, a draft containing editorial notes) — **not** a verified legal register. Sensitive values masked.

| Field | Status |
|---|---|
| Legal / business name | NEEDS CONFIRMATION (page: sole trader "HABB", holder named on the page) |
| Enterprise number | NEEDS CONFIRMATION (page: `10327…10`) — verify against the Crossroads Bank (BCE) |
| VAT number | NEEDS CONFIRMATION (page: `BE 10327…10`) and **VAT regime** (standard vs. small-business exemption) — decides every invoice's VAT lines |
| Registered address | NEEDS CONFIRMATION (Namur, Rue de Bruxelles) |
| Invoice contact e-mail / phone | NEEDS CONFIRMATION (present on the page; must be the address printed on invoices) |
| IBAN / BIC | **MISSING** (not found in any accessible source; required for Peppol and for invoices) |
| Payment terms | NEEDS CONFIRMATION (engine default 30 days) |
| Currency | READY (EUR) |
| Merchant timezone | UNKNOWN (see above) |
| Seller Peppol identifier | NOT REQUIRED for V1 internal use; MISSING until a provider registers HABB |
| Numbering configuration | READY (engine default `INV-{year}-{seq}`-style, per merchant/type/year; no prior numbers in production) — NEEDS CONFIRMATION of the desired prefix |

## 6. HABB business-shape validation

Supported by the model and demonstrated on synthetic data (acceptance S3–S29): Shopify-originated retail (as evidence), B2C invoices (no structured original), Belgian B2B invoices (Peppol route), supplier invoices (inbound + manual), cash (count + movements, deposits), bank (observed, reconciled), refunds and credit notes, partial and multiple payments, several payment methods, accountant export, Treasury. No HABB production transaction was fabricated; a gift-shop-shaped synthetic dataset reconciles to the cent (0 difference). Not modelled in V1: persistent due schedules (30/40/30 handled as ordinary payments).

## 7. Schema state and the production migration plan (NOT executed)

Production is at migration 23. Pending (local, in order) — all **additive**; none rewrites existing money data:

| # | Migration | Purpose | Affects | Additive? | Lock / risk | Data transformed | Precondition | Postcondition | Recovery |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `20261003090000_finance_integrity_p0` | credit ceiling, merchant-scoped FKs, payment registry + allocations (append-only), supplier truth guard, mirror re-derivation | 3 `unique (id, merchant_id)` + 6 composite FKs on existing tables; new tables `fin_payment_registry`, `fin_payment_allocations`; triggers/functions; RLS | additive (no column dropped, no row rewritten; one re-derivation `UPDATE` of supplier mirrors, 1 row, no payment) | short ACCESS EXCLUSIVE on tiny tables | supplier mirrors re-derived (none validated today) | the 4 preflight checks of §8 return 0 violations | new tables exist and empty; guards active | forward-safe: new tables empty → drop only the new objects by hand; never drop evidence once rows exist |
| 2 | `20261004090000_finance_essential_payments` | payment model (direction, method, provenance, refunds), allocation guards | `fin_payment_registry` columns; replaces function `fin_record_payment` (old signature dropped, same function + optional `p_meta`) | additive; the only DROP is a function signature that is re-created | trivial | none | #1 applied | RPC callable with and without `p_meta` | re-create the previous signature from migration history |
| 3 | `20261005090000_finance_essential_bank` | bank accounts, immutable observed transactions, append-only reconciliations, derived status | new `fin_bank_accounts`, `fin_bank_reconciliations`; new columns on `fin_bank_transactions` / `fin_bank_balances`; two backfills of NEW link columns | additive (legacy `status`, `matched_*` kept, no longer authoritative) | trivial (0 rows) | backfill of account links (0 rows) | #1, #2 applied | accounts/links consistent | drop only new empty objects; legacy columns untouched |
| 4 | `20261006090000_finance_belgium_peppol` | artifacts, Peppol messages, seller profile versions, VCS check function | 3 new tables + guards + RPCs | additive only | none (new tables) | none | #1–#3 applied | tables empty, RLS on | documented hand rollback of the three new tables (only while empty) |

Deprecated legacy fields stay (nothing destructive in the first activation): `fin_payments`, `fin_bank_transactions.status/matched_*`, supplier `paid_*` mirrors.

## 8. Pre-migration checks (READ ONLY, must all pass immediately before)

```sql
-- identity
select count(*) = 1 as one_merchant from merchants;
select id = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5' as habb from merchants;
select count(*) = 1 as one_connector, bool_and(status = 'CONFIGURED') from merchant_connectors where kind = 'shopify';
select count(*) = 0 as no_foreign_rows from fin_documents where merchant_id <> '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
-- state still as inventoried
select (select count(*) from fin_documents) docs, (select count(*) from fin_payments) pays, (select count(*) from fin_bank_transactions) tx, (select count(*) from fin_supplier_invoices) sup;
select count(*) = 0 as none_validated from fin_supplier_invoices where status in ('VALIDATED','TO_PAY','PAID');
-- would-violate checks (all must be 0)
select count(*) from fin_documents d join fin_documents r on r.id = d.related_document_id where r.merchant_id <> d.merchant_id;
select count(*) from fin_payments p join fin_documents d on d.id = p.document_id where d.merchant_id <> p.merchant_id;
select count(*) from fin_documents where number is not null group by merchant_id, doc_type, number having count(*) > 1;
select count(*) from fin_documents where currency !~ '^[A-Z]{3}$';
-- migrations: last applied must be 20260929130411
select max(version) from supabase_migrations.schema_migrations;
-- artifact tables must not exist yet (no hidden partial apply)
select count(*) = 0 from information_schema.tables where table_name in ('fin_payment_registry','fin_artifacts','fin_peppol_messages');
-- storage
select count(*) from storage.buckets where name = 'finance-inbox';
```

Also (outside SQL): `MERCHANT_TIMEZONE=Europe/Brussels`, `NORDLA_MERCHANT_ID` = HABB id on the Finance service, validation artifacts present (`vendor/MANIFEST.json` hash matches the pin in code), seller profile completed (§5).

## 9. Backup and recovery

| Item | Status |
|---|---|
| Production PostgreSQL data + schema | **BACKUP REQUIRED** before activation (provider backup / PITR status UNKNOWN — not readable here; take a logical dump of `public` + `storage.objects` metadata and record its checksum) |
| `finance-inbox` storage objects (5) | **BACKUP REQUIRED** (copy + hash) |
| Environment / configuration for recovery | **BACKUP REQUIRED** (variable *names* and non-secret values; secrets in the password manager) |
| Migration version / application commit / validation artifact hashes | known: migration 23 today; commit `8efc09f` (or a later reviewed commit); `vendor/MANIFEST.json` pinned |

Targets for the first activation: **RPO ≤ 24 h** (HABB has no Finance data of value today, a fresh dump immediately before the migration makes the effective RPO zero); **RTO ≤ 4 h** (restore dump or re-point the Finance service to the previous release). Nothing is claimed as verified until a restore of the dump has been tested on a scratch database.

## 10. Rollback and forward-safe recovery

| Case | Strategy |
|---|---|
| A. migration fails before completion | each migration is one transaction → automatic rollback; re-read the preflight; fix; retry. Nothing else changed |
| B. migration succeeds, application activation fails | keep the schema (additive, old code ignores new tables); redeploy the **previous Finance release**; legacy columns are untouched so the old code keeps working |
| C. application starts but gives an unexpected result | switch the Finance service back to the previous release; do **not** delete rows; any wrongly recorded fact is corrected by a reversal / credit note, never by deleting |
| D. Peppol provider fails later | keep Peppol outbound disabled or let messages stay `QUEUED` / `SUBMISSION_FAILED`; `recover()` resolves unknown outcomes by idempotency key; invoices stay valid and are delivered another way |
| E. artifact storage unavailable | issuance still succeeds (the failure is audited, a repair archives a `REGENERATED_COPY`, never an "original"); sends are refused until bytes verify; the export reports `MISSING` truthfully |
| F. bank import / reconciliation malfunction | reconciliations are append-only and reversible (`unreconcile`); imports are idempotent; disable the import, correct by reversal |

Never delete financial evidence to restore service; prefer forward fixes.

## 11. Deployment order (to be executed LATER, with explicit authorization)

1. Backup (dump + storage copy + checksums) and record the commit / migration version.
2. Read-only preflight (§8) — all green, seller profile complete, environment confirmed.
3. Apply migrations 1 → 4 in order, one by one, stop on the first error; verify after each (tables, RLS, functions present; counts unchanged).
4. Post-migration verification (counts, constraints, a guard rejects a deliberately invalid insert inside a rolled-back transaction).
5. Deploy **only the Finance service** (`SERVICE=finance` entry of `src/service-start.js`) from the reviewed commit; verify the Core service still runs its own release.
6. Smoke test (§13) with a controlled dataset.
7. Controlled HABB validation, then enable capabilities per §12.

**Core risk**: this repository's Railway start command is shared (`src/service-start.js` selects `core` or `finance`). Deploying the branch must be pinned to the Finance service and to a specific commit; `feature/core-sync-cron` (historical risk of redeploying an old Core) must remain untouched and must not be the deployed ref. Verified here only by reading the repo: the actual Railway service settings are **UNKNOWN**.

## 12. Feature activation

| Feature | Class |
|---|---|
| Invoices (draft, issue) | ACTIVATE AFTER SMOKE TEST |
| Belgian VCS | SAFE TO ACTIVATE (with invoices; deterministic, immutable) |
| PDF archival | ACTIVATE AFTER SMOKE TEST (needs the private bucket verified) |
| UBL generation + official validation | ACTIVATE AFTER SMOKE TEST (generation and validation only; no sending) |
| Payments | ACTIVATE AFTER SMOKE TEST |
| Bank (CSV import, balances) | ACTIVATE AFTER SMOKE TEST |
| Reconciliation | ACTIVATE AFTER SMOKE TEST |
| Treasury | SAFE TO ACTIVATE (read model) |
| Accountant Export | SAFE TO ACTIVATE (read-only) after the first documents exist |
| Peppol inbound | ACTIVATE AFTER EXTERNAL PROVIDER |
| Peppol outbound | ACTIVATE AFTER EXTERNAL PROVIDER (must stay disabled until a provider is selected and tested) |
| PSD2 bank connection, e-reporting, Intervat, general ledger | KEEP DISABLED / BACKLOG |

## 13. First HABB smoke test plan (after a future deployment; NOT run now)

| # | Step | Reversible? |
|---|---|---|
| 1 | Finance loads for HABB (dashboard opens, token auth) | yes |
| 2 | Resolved merchant = `36b1a1a7-…` and nothing else | yes |
| 3 | Timezone shown = Europe/Brussels | yes |
| 4 | Existing data readable (1 supplier invoice `TO_REVIEW`, cash count 150.00, events) | yes |
| 5 | Create a **draft** invoice (smallest dataset, test customer) | yes (draft can be cancelled) |
| 6 | Verify totals / VAT against hand calculation | yes |
| 7 | Verify the Belgian VCS preview (mod 97) | yes |
| 8 | **Issue** — only if explicitly authorized at that time | **NO: consumes a legal number, creates immutable evidence** (cancel by credit note only) |
| 9 | Verify the archived PDF + UBL (hashes, official validation OK, no Peppol send) | read-only |
| 10 | Record one controlled payment | **NO: append-only** (corrected by reversal) |
| 11 | Verify remaining_due | read-only |
| 12 | Import / enter one controlled bank line and reconcile it | reconciliation reversible; the bank line is permanent observed evidence |
| 13 | Treasury shows the expected item / position | read-only |
| 14 | Generate the accountant export, run the package verifier | read-only |
| 15 | Cross-module reconciliation: difference = 0 cents | read-only |

Steps 8, 10 and 12 create permanent financial evidence; use a clearly labelled test customer and amounts and have the accountant informed.

## 14. Observability

Visible today: audit events in `fin_events` (issuance, compliance / validation failure, artifact storage failure, archive hook failure, payment and credit actions, all Peppol transitions incl. outcome-unknown, inbound rejections and duplicates), the Peppol observability panel (queued, submitting, failures, inbound failures, duplicates, last success), HTTP errors returned to the operator, `console.error` without secrets (privacy tests prevent tokens/keys in code and docs). Not aggregated: payment refusal counts, allocation / reconciliation conflict rates, cross-merchant attempts (refused by the database; not specially logged), unexpected crash alerting (process restarts via the hosting policy `ON_FAILURE`). None of these is invisible to the operator at the time it happens and the money truth is guarded in PostgreSQL, so none is a **closure blocker**. V1.1 recommendation: aggregate refusals and add an alert on repeated failures.

## 15. Security closure

Confirmed by tests (acceptance §24/§25, PG17, privacy guards): merchant isolation at database level; no secrets / full IBANs in the repository (IBANs masked, private bucket); validation artifacts pinned and verified fail-closed; secure XML (DOCTYPE/entities refused, size and depth bounds); path-traversal-safe file names and attachment whitelist; artifact hash verified on every read; payment concurrency and idempotency; Peppol and inbound deduplication; immutable originals, append-only payments / allocations / reconciliations. The broader Nordla resilience / ransomware architecture is out of scope; Finance only needs to participate (backup of the bucket and database, §9).

## 16. Accountant handoff

| Item | Class |
|---|---|
| Export period, completeness of documents, correct VAT of each case, structured payment reference on invoices | LEGAL / TECHNICAL — already provided |
| Preferred CSV layout, extra columns, supporting-document packaging, accounting-software-specific import, treatment of unusual VAT cases | ACCOUNTANT PREFERENCE — to ask the real accountant (V1.1 adapter); the generic export is usable without it |
| Which VAT regime HABB applies (standard / exemption) and how to treat B2C Shopify sales | needs confirmation by HABB / the accountant (affects invoices, not the engine) |

## 17. Peppol

**INTERNAL IMPLEMENTATION READY, REAL NETWORK NOT CERTIFIED.** Remaining before real Peppol: Access Point / provider selection and contract; HABB participant registration (and its Peppol id); provider credentials / certificates; directory lookup; sandbox; verification of outbound receipts and inbound delivery against the real provider; retry behaviour under real failure; BT-83 interoperability confirmation (Nordla carries Febelfin's 12-digit electronic form); production enablement. Belgian B2B obligations in force remain the reason this is a V1.1 / external milestone, not a Finance domain gap (HABB may issue structured invoices only after this is done).

## 18. Frozen backlog (post-V1; none blocks safe HABB use)

| Item | Class |
|---|---|
| Real Peppol provider integration (selection, sandbox, certification) | EXTERNAL INTEGRATION |
| Accounting-software-specific export adapter | V1.1 |
| Persistent due schedules (30/40/30) | V1.1 |
| Explicit link Shopify refund ↔ Finance refund | V1.1 |
| Aggregated Finance alerts / refusal metrics | V1.1 |
| Asynchronous validation / artifact pipeline | LATER |
| Advanced FX | LATER |
| PSD2 bank connection / payment initiation | EXTERNAL INTEGRATION |
| Advanced B2G (thresholds, exceptions) | REGULATORY WATCH |
| e-reporting | REGULATORY WATCH |
| Intervat submission | REGULATORY WATCH |
| Self-billing | LATER |
| General ledger | LATER |
| AI financial advice | LATER |

## 19. Legacy / deprecated paths

| Path | Class |
|---|---|
| `fin_payments` (legacy payment truth, frozen at cutover) | KEEP FOR MIGRATION COMPATIBILITY |
| `fin_bank_transactions.status` / `matched_*` | KEEP FOR MIGRATION COMPATIBILITY (not authoritative; mirror) |
| Supplier `paid_at` / `paid_amount_cents` / PAID mirror | STILL USED as a mirror re-derived by trigger; SAFE TO REMOVE LATER |
| Stored invoice `status` | STILL USED as a mirror (re-derived idempotently); never authoritative |
| `treasury-service.legacyView` (old Treasury calculation) | STILL USED (compat view) — SAFE TO REMOVE LATER after UI confirmation; UNKNOWN whether any client calls it |
| Older legacy Peppol routes | delegate to the new service; SAFE TO REMOVE LATER |

No obsolete path is reachable in a way that can corrupt V1 truth (money truth is read only from the registry/allocations). No destructive cleanup was done.

## 20. Test evidence (final regression of this phase)

Migration replay from zero (27 migrations → 34 tables) and schema-drift against the production catalog fixture: PASS. PostgreSQL 17 suite 165/165; Finance 773/773; full suite 1301/1301; privacy / merchant-name guards green; unexplained cross-module money difference: **0 cents**. No test skipped or weakened.

## 21. Known limitations

No due-schedule storage; B2G thresholds not evaluated; synchronous issuance (≈ 0.3–1.5 s); Peppol only against a deterministic fake provider; Finance activation still needs (a) seller profile confirmation (IBAN missing, VAT regime), (b) `MERCHANT_TIMEZONE` and tenant id confirmation, (c) a verified backup.

## 22. Definition of Done

| Condition | Result |
|---|---|
| Final E2E acceptance green | PASS |
| PG17 / Finance / full suite green | PASS (165 / 773 / 1301) |
| Unexplained money difference 0 cents | PASS |
| Production data presents no unresolved migration blocker | PASS (practically empty; 4 additive migrations) |
| HABB merchant identity unambiguous | PASS (1 merchant, 1 connector, CONFIGURED); timezone / tenant env UNKNOWN until the preflight |
| Migration path documented | PASS |
| Rollback / recovery documented | PASS |
| No critical security blocker | PASS |
| No hidden competing source of truth | PASS |
| Peppol dependency isolated | PASS |
| Remaining items genuinely backlog / external | PASS |

Finance V1 (the internal domain) is **CLOSED**. Controlled production activation is **YES WITH PRECONDITIONS**: verified backup, completed seller profile (IBAN, VAT regime, legal identity), confirmed environment (`MERCHANT_TIMEZONE`, `NORDLA_MERCHANT_ID`, Finance-only deployment pinned to a commit), and explicit authorization at that time.
