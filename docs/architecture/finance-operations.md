# Finance Operations Agent — V1

A merchant-generic, **optional** module on top of Retail Core. It handles the operational finance workflow around sales — *company → quote → invoice → payment status → accountant export* — and is **not** an accounting system. Isolated in `src/finance/`; Retail Core financial logic is untouched (the one shared-code change is two additive methods on the Supabase client, `rpc` and `delete`).

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

Allocated **only at issue** (invoice, credit note) or **at send** (quote), after validation succeeds, so drafts and rejected drafts consume nothing. Format is configurable (`{prefix}-{year}-{seq}` → `INV-2026-0001`), one sequence per merchant, type and issue year. The pack detects gaps and duplicates. *Known limit:* allocation and the save are two calls; a crash between them could burn a number, which the pack would then report as a gap (never silently).

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

`finance pack --from YYYY-MM-DD --to YYYY-MM-DD` (any range). Retail (Phase 2A verbatim): gross sales, discounts, refunds, net sales, VAT, net excl. VAT, POS vs online. Finance: standalone B2B invoices and credit notes (net, VAT by rate, gross), linked invoices listed but excluded, payment status of period invoices, receivables aging, quotes count (not revenue). Combined totals = retail + standalone B2B. States period, source systems, generation time, **completeness** (`PARTIAL` when retail history starts after the period start or the period is not closed), unresolved anomalies (unissued documents, numbering gaps, integrity mismatches, other-currency documents, duplicates) and reconciliation status. Outputs: CSV set (configurable delimiter, formula-injection safe, UTF-8 BOM), PDF summary, JSON. **XLSX is not built** (CSV opens in Excel); retail **VAT by rate is unavailable** (Retail Core stores VAT per line, not the rate).

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

Default provider is `manual`. The Belgian mod-97 checksum is validated offline, and an invalid number is never sent to VIES.

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
