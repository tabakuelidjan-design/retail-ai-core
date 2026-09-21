# Finance dashboard — operating guide

A local, merchant-facing web page for Finance Operations. No terminal commands or JSON files are needed for normal use.

## Start it

```
npm run finance:dashboard
```

Open `http://127.0.0.1:4310` (loopback only: it is not reachable from other computers). Log in with the token in your `.env` file (`FINANCE_DASHBOARD_TOKEN`, generated on the first run and never displayed). To look around safely with made-up data first: `npm run finance:demo` (`http://127.0.0.1:4311`, token `demo-token-demo-token-demo-token`, nothing real, resets when stopped).

## The normal workflow

New invoice -> choose or search the company -> add lines -> check the totals -> **Save and review** -> **Approve** -> the invoice is issued and numbered -> download the PDF (and the Peppol/UBL file) -> later **Mark sent** and **Add payment**.

| Section | What it does |
|---|---|
| Overview | Unpaid, overdue, outstanding, paid this month, awaiting approval, quotes awaiting response / to convert, ageing, and the accountant-pack status of the last closed quarter |
| Invoices | List with filters (Draft, Ready for approval, Issued, Sent, Partially paid, Paid, Overdue, Credited); open, edit drafts, preview PDF, submit, approve / modify / reject, mark sent, add payment, create credit note |
| New invoice | Company search or lookup, dates and terms, revenue basis, VAT treatment, line editor with live server-side totals |
| Quotes | Draft -> Sent (numbered) -> Accepted / Rejected -> Convert to invoice (reuses all quote data) |
| Companies | Directory with document history, outstanding amount, payment summary. No credit scoring |
| Payments | Unpaid / due soon / overdue, ageing 0-7, 8-30, 31-60, 60+, register manual payments |
| Accountant pack | Choose from / to, see completeness, retail vs standalone B2B, VAT by rate, anomalies; download CSV, PDF, XLSX |
| Settings | Seller details, IBAN, VAT rates, numbering, language, branding, lookup provider, Peppol status (NOT CONFIGURED) |

## Shopify / POS orders

Choose **Invoice for an existing shop / POS order** and pick the order (reference, date, channel, items, total: no customer details are shown). The invoice then **creates no additional revenue**, and each order can have only one active invoice. Choose **New B2B sale** for a sale outside the shop: that is added on top of the shop and POS sales.

## What the browser does and does not do

The page shows and collects; it never calculates. Every total, VAT amount, status and number comes from the server's finance engine, and everything is validated again on save. Issued documents cannot be edited: correct them with a credit note.

## Security

Loopback only; token login with a lockout after repeated failures; HttpOnly + SameSite=Strict session cookie; CSRF token on every change; Host and Origin checks; strict Content-Security-Policy with no inline scripts; the UI builds no HTML from text (so free text cannot become markup); every request is scoped to your merchant (another merchant's ids return "not found"); every lifecycle action is audited; issued documents and the audit trail are protected by the database itself.

## Numbering is crash-safe

Approving a document allocates its number, freezes it, fingerprints it and writes the audit event in **one database transaction** (`fin_issue_document`). If anything fails at any point, the number counter is rolled back too: a crash cannot burn a number or leave a half-issued document. Verified on the real database: 20 truly parallel approvals produced 20 unique, consecutive numbers with 20 audit events; a failure after allocation left the counter unchanged; the next issue took the very next number.

## Full accounting history (`read_all_orders`)

Today Shopify only exposes the last 60 days of orders to the app, so closed periods older than that are `PARTIAL`.

**Action needed from you (once):** in the Shopify Dev Dashboard, add the `read_all_orders` access scope to the app, release the new version, and approve the updated permissions on the store. Then tell the assistant, or run:

```
npm run sync:backfill
```

What happens: the command first checks the LIVE token for the scope and stops with a clear message if it is missing (nothing is fetched). With the scope, it imports every order since the day the store was created, using the **same** order fields as today (no customer name, email, phone or address is added; the optional pseudonymous customer key follows its existing setting). It is a one-time backfill and safe to repeat (upserts). Afterwards a coverage marker (`data/local/sync-coverage.json`) records how far back the history is verified, and the normal daily sync keeps it current.

What becomes available: complete order, refund and line history (including the VAT rate captured per line) for any past period, so the accountant pack can cover closed quarters fully.

**How a closed quarter becomes COMPLETE instead of PARTIAL** (all must hold): the history reaches the start of the period (backfill marker, or the store did not exist earlier), the period has ended, the last successful sync is after the period end, every retail line has a captured VAT rate (the backfill re-syncs lines and populates it), and there is no critical anomaly.

## Peppol

The dashboard prepares and validates the structured invoice (UBL, Peppol BIS Billing 3.0) and lets you download it. **Nothing is transmitted.** Sending needs a Peppol Access Point provider, which is not selected. Belgian B2B invoices between VAT-registered businesses must be sent as structured e-invoices (since 1 January 2026), so a PDF alone is not enough for those customers until a provider is connected.

## Company search (one search field)

Everywhere you pick a customer (**Companies -> Add a company**, **New invoice**, **New quote**) there is one field: *Search company name or VAT / enterprise number*, with a **Search** button. Results appear under it, selecting one fills the form, every field stays editable, the **source is always shown**, and typing by hand always works.

Source priority: **Belgian company register (CBEAPI) -> VIES -> OpenPeppol -> manual entry.**

- **Number** (`BE 0123.456.789`, `0123456789`...): normalised and checked offline, then looked up in the register. It fills legal name, enterprise number, street and number, postal code, city, country and status. **VIES only confirms that the VAT number is active**; the VAT number is filled in only when VIES confirms it. An inactive company is shown with its status and a warning.
- **Name**: your saved companies first, then the register (legal entities only, with their address). Selecting a result runs the VIES VAT check. If the register has nothing or is unavailable, OpenPeppol (Peppol-registered companies) is tried, then manual entry.
- **Sole traders (natural persons)** are **never listed by name**. They are returned only for an exact enterprise / VAT number, labelled **SOLE TRADER / PERSONAL DATA**, and are **not saved** unless you save that customer yourself (the "save to my directory" box is unchecked for them). Their details are never logged.
- **Setup**: put `CBEAPI_KEY=...` in `.env` (free key from cbeapi.be: 2,500 requests/day, monthly data snapshot; the paid daily plan needs no code change). Without the key the register is skipped and VIES / OpenPeppol / manual still work. Settings has switches for the register, the secondary name search and the VAT lookup.
- BCE/KBO Public Search is **not** scraped. The register is a replaceable provider (`createCbeApiProvider` in `src/finance/company-search.js`): a paid or local KBO Open Data source can replace it without touching the form.
