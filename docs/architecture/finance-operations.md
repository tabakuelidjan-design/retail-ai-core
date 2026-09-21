# Finance Operations Agent — V1

A merchant-generic, **optional** module on top of Retail Core. It handles the operational finance workflow around sales — *company → quote → invoice → payment status → accountant export* — and is **not** an accounting system. Isolated in `src/finance/`. Retail Core financial logic is untouched; the only shared-code changes are additive: two Supabase client methods (`rpc`, `delete`), capture of the source VAT rate per order line (query field, normaliser, loader select, one extra ledger field that no formula uses), and an optional `--since` window plus a coverage marker for the orders sync.

Run: `npm run finance -- help`. Merchant configuration lives in `data/local/finance/merchant.json` (gitignored); `finance init-config` writes a template of nulls, `finance config-check` lists what is missing.

## Principles

- **All money is deterministic integer code** (cents; quantity in thousandths; unit price in ten-thousandths; rates in basis points). The LLM never calculates or judges a total or a tax treatment.
- **The agent prepares, the merchant decides.** Creating, validating, calculating, listing missing fields, producing PDFs and Peppol payloads are agent actions. Approving, issuing, sending and marking sent require a `merchant` actor (`FINANCE_ACTOR=merchant:<name>`). **Nothing is ever transmitted externally in V1.**
- **Issued documents are immutable**, in three layers: the engine (locked documents are deep-frozen and reject edits), the store, and **database triggers** (verified against the real database in a rolled-back transaction). Corrections are credit notes.
- **One definition of sales.** The accountant pack reuses Phase 2A `windowFacts` + `aggregate`; a test asserts the pack equals `computeSalesMetrics` for the same window.

## Schema (migration `20260921200000_finance_operations.sql`)

| Table | Purpose | Enforced by the database |
|---|---|---|
| `fin_companies` | customers (business or individual), official identifiers, `source` (manual/vies) | unique VAT and enterprise number per merchant |
| `fin_documents` | quotes, invoices, credit notes: lifecycle columns + `body jsonb` (customer/seller snapshot, lines, VAT treatment, totals) | trigger: once `locked_at` is set, body/number/dates/amounts/basis/links cannot change and the row cannot be deleted; unique number per merchant+type; **one non-cancelled invoice per source order** |
| `fin_events` | audit trail: who, when, action, from/to status | append-only trigger |
| `fin_payments` | manual payments, negative entries only as referenced corrections | append-only trigger, non-zero amount |
| `fin_number_sequences` + `fin_next_number()` | atomic, gapless numbering per merchant/type/year | function |
| `fin_supplier_invoices` | incoming supplier invoices (model only) | net + VAT = total |

All tables have RLS enabled (service role only). A snapshot **SHA-256** of the commercial content is stored at lock time and re-verified in the pack.

## Numbering

Allocated **only at issue** (invoice, credit note) or **at send** (quote), inside the same database transaction that issues the document (see "Hardening" below), so drafts and rejected drafts consume nothing and a failure can never burn a number. Format is configurable (`{prefix}-{year}-{seq}` -> `INV-2026-0001`), one sequence per merchant, type and issue year. The pack still detects gaps and duplicates as an independent check.

## Lifecycles

- **Quote:** `DRAFT → SENT` (numbered, locked) `→ ACCEPTED → CONVERTED` (or `REJECTED`; `expired` is derived from `validUntil`). Conversion creates an invoice **draft** from the accepted quote (customer, lines, VAT, terms, notes copied, totals asserted equal), links `quote → invoice` and back. A quote is never revenue.
- **Invoice:** `DRAFT → READY_FOR_APPROVAL → ISSUED → SENT → PARTIALLY_PAID → PAID`. `OVERDUE` is **derived** (due date passed and something remains), not stored. `CANCELLED` exists only for unissued drafts. `CREDITED` when credit notes cover the whole invoice. **Approval** is `APPROVE` (validates, allocates the number, freezes) / `MODIFY` (back to draft) / `REJECT` (cancels, no number used).
- **Credit note:** drafted from an issued invoice (full or partial lines), needs a reason, references the original, can never credit more than the invoice gross in total, follows the same approval.

## VAT

Structure only, no tax-law judgement. The merchant **selects and confirms** a treatment per document (`domestic`, `intra_eu_b2b_exempt`, `reverse_charge`, `export_outside_eu`, `vat_exempt_small_business`) and a rate per line. There is **no default rate**; domestic rates must be in the merchant's `allowedRatesBp`. Validation blocks issuance when: treatment unconfirmed; a zero-rate treatment has non-zero lines; the customer VAT number is required but missing; the intra-EU treatment is used for a Belgian customer; the legal mention is missing where required. VAT is computed **once per rate group** (EN 16931 style), rounded half-up.

## Shopify / POS linkage and double-counting

Every issued invoice declares a **revenue basis**:

- `linked_source_order` — documents an existing shop/POS sale (needs `sourceOrderId`, verified against the Retail Core ledger, amount compared with a warning). **Never additive.**
- `standalone_b2b` — a new sale outside the shop. Additive.

Safeguards: basis is mandatory; a linked source order must exist in Retail Core; **one active invoice per source order** (service + unique index); a standalone invoice with the same gross as an *unlinked* shop order within `dupWindowDays` is **blocked until the merchant acknowledges** it is a separate sale; the accountant pack re-runs these checks at export time.

## Accountant pack

`finance pack --from YYYY-MM-DD --to YYYY-MM-DD` (any range). Retail (Phase 2A verbatim): gross sales, discounts, refunds, net sales, VAT, net excl. VAT, POS vs online. Finance: standalone B2B invoices and credit notes (net, VAT by rate, gross), linked invoices listed but excluded, payment status of period invoices, receivables aging, quotes count (not revenue). Combined totals = retail + standalone B2B. States period, source systems, generation time, **completeness** (`PARTIAL` when retail history starts after the period start or the period is not closed), unresolved anomalies (unissued documents, numbering gaps, integrity mismatches, other-currency documents, duplicates) and reconciliation status. Outputs: CSV set (configurable delimiter, formula-injection safe, UTF-8 BOM), PDF summary, JSON and XLSX. Retail VAT by rate is reported where the source rate was captured (see Hardening).

## Receivables

`days_overdue = today − due date`. Buckets: `not_due`, `0_7` (0–7, includes due today), `8_30`, `31_60`, `60_plus`. Also unpaid, due soon (configurable window), overdue and outstanding amounts. Credit notes reduce what is owed. **No reminders are sent**; a future reminder agent consumes these facts.

## Company lookup

Provider interface (`createCompanyLookup`), replaceable without touching invoice logic. Sources investigated (Sept 2026):

| Source | Status |
|---|---|
| **EU VIES** (official) | Free, no authentication (probed live). Validates a VAT number and returns the registered name and address; no name search, no legal form. **Implemented as the `vies` provider**, contacted only when you run `company lookup`. |
| KBO/BCE Public Search website | Free for people, but **automated/bulk scraping is prohibited**. Not used. |
| KBO/BCE official web service | Paid (per-request pricing). Not used; a possible future provider. |
| KBO Open Data | Free monthly CSV, registration required, attribution to FPS Economy. Possible future provider for name search against a local import. |

New settings default to `vies` with manual entry as the fallback (VIES is contacted only when the merchant clicks Look up). The Belgian mod-97 checksum is validated offline, and an invalid number is never sent to VIES.

## Peppol / structured e-invoicing

Belgium requires structured B2B e-invoices between VAT-registered businesses since **1 January 2026** (penalties since 1 April 2026), exchanged over **Peppol**; the target format is **Peppol BIS Billing 3.0 (UBL 2.1, EN 16931)**, Belgian participant scheme `0208`. `src/finance/peppol.js` builds the UBL Invoice/CreditNote payload from the deterministic totals and validates required structured fields **locally** (not the official Schematron). `AccessPointAdapter` is the boundary a provider implements (`submit`, `fetchStatus`, statuses `SENT/DELIVERED/REJECTED/FAILED`); `NullAccessPointAdapter` refuses to send. We do not operate an Access Point and have not subscribed to a provider.

## Deferred (design only)

Credit risk / solvency (`credit-risk.js`, imported by nothing), automatic reminders, recurring invoices, supplier-invoice intake, bank reconciliation, payment behaviour, cash forecast, anomaly detection, accounting integrations, e-reporting. The supplier-invoice table and validator exist as a data model only.

## Privacy and security

Finance data is more sensitive than retail data: merchant config, `.env` and `reports/` are gitignored; fixtures are synthetic (`BE0000000xxx`, example IBAN); no real invoice is committed; RLS on every table; immutable history and audit trail; the core has no provider names and only `company.js` touches the network (both asserted by tests). Individual (non-business) customers are supported minimally and are not Peppol-eligible.

## Owner decisions (`OWNER_DECISION_REQUIRED`)

1. **Seller identity and payment details** for `merchant.json` (legal name, VAT/enterprise number, address, IBAN, email).
2. **Allowed VAT rates** (`vat.allowedRatesBp`). Belgian domestic rates are commonly 21%, 12%, 6% and 0%, but the list is the merchant's decision; empty blocks issuance.
3. **Peppol Access Point provider** for sending B2B e-invoices (needed to comply for Belgian B2B customers).
4. **Shopify `read_all_orders`** if complete history before the 60-day window is needed for closed-period accountant packs (previously declined).
5. Whether to enable the free VIES lookup (`companyLookup.provider: "vies"`).


## Hardening and dashboard (second pass)

**Atomic issuance.** `fin_issue_document()` (migration `20260922090000`) locks the document row, allocates the number, formats it, freezes the document, computes the SHA-256 fingerprint and writes the audit event in one transaction. The application sends the canonical snapshot with a unique number placeholder; the database substitutes the number and hashes, so the stored hash equals the application's hash for the final document. A stale version or an already-issued document is refused. Tested: success, rollback (a failure after allocation leaves the counter unchanged), crash simulation (36 attempts with injected failures give a gapless series), concurrency (memory store) and **20 parallel calls on the real database** (unique, consecutive 1..20, 20 audit events).

**VAT by rate.** Retail Core now stores the VAT rate the source reported for each order line (`order_lines.tax_rate_bp`, additive; no Phase 2A formula changed; the ledger only carries the field). The pack groups retail base and VAT by that rate (refunds reduce the rate they were charged at); lines without a captured rate (older syncs, or several taxes on one line) are reported as **unavailable** and never spread across rates, which makes the breakdown and the pack `PARTIAL`. Standalone B2B is shown by rate and by treatment (domestic, intra-EU exempt, reverse charge, export, small-business), with exempt/reverse-charge bases and legal mentions. Re-syncing populates the rate for orders in the sync window; the `read_all_orders` backfill populates older ones.

**History readiness.** `planOrdersSync` refuses orders older than 60 days unless the live token carries `read_all_orders`. `sync orders --full-history` (or `--since`) backfills with the identical order fields. A coverage marker records the verified reach of the history and the last sync time; the pack treats a period as fully covered only if the marker reaches its start (or the store did not exist), and the last sync is after the period end.

**Dashboard** (`src/finance/server/`, `src/finance/ui/`). Framework-free Node HTTP app plus a vanilla-JS page (no build step, no innerHTML). The API cleans every input (`input.js`, whitelisted keys, strict number formats, control characters stripped), resolves company identity from the directory, scopes every lookup to the merchant, and runs every lifecycle action through the finance service as a merchant actor. Live totals are requested from `/api/calc`, which uses the same engine as saving (tested for zero drift). Security: loopback, token login + lockout, HttpOnly/SameSite=Strict cookie, CSRF token, Host/Origin checks, 1.2 MB body limit, strict CSP. Settings are validated (IBAN and Belgian number checksums, numbering format, VAT rates, logo checked by content) and saved atomically with a `.bak`; secrets are never part of settings.

**Exports.** The pack produces CSV (incl. `vat_by_rate`), a PDF summary, JSON and a multi-sheet **XLSX** (dependency-free writer, verified to open in a standard spreadsheet library; text is stored as strings so cell contents cannot execute as formulas).

**Peppol** is unchanged: UBL generation, local structural validation and the adapter boundary. Nothing is transmitted and no provider is selected.

## Still open

Peppol Access Point provider and adapter; official Schematron validation; `read_all_orders` for complete closed-period history; supplier-invoice intake; bank reconciliation; reminders; a second-person approval step if the business ever needs one.

## Company search (third pass)

`src/finance/company-search.js`: one pipeline over replaceable providers. Number input -> offline Belgian validation -> VIES (auto-fill on exactly one result). Name input -> saved companies, then a `CompanySearchProvider` (`peppol_directory`: OpenPeppol Directory public search, Belgian participants, de-duplicated per enterprise number, French > Dutch > English name preference) -> each hit is enriched through VIES (city, address, VAT confirmation) -> selection resolves via `POST /api/companies/resolve`. `toFormFields` is the single mapping that fills the form. Statuses: `FOUND`, `OK`, `NO_RESULT`, `INVALID_NUMBER`, `PROVIDER_UNAVAILABLE`, `SEARCH_NOT_CONFIGURED`, `QUERY_TOO_SHORT`; every one leaves manual entry available. Only these two provider files may touch the network (asserted by a test), calls have an 8 s timeout, and a test asserts the KBO public search is never referenced.
