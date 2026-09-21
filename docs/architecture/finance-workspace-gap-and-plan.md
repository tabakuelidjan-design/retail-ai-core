# Finance Operations Workspace — Gap & Implementation Plan

Status: proposal for owner review (2026-09-22). Nothing in this document is built yet unless marked DONE. Branch `feature/finance-operations`, not merged.

## 1. Benchmark (official product documentation, September 2026)

| Feature | Competitors | HABB now | HABB planned | Priority |
|---|---|---|---|---|
| Invoices + quotes + credit notes, PDF, UBL | all six | DONE (engine, lifecycle, immutability, audit) | keep | — |
| Peppol send **and receive** (free/included) | [Accountable](https://www.accountable.eu/en-be/peppol/) (free, both), [Odoo](https://www.odoo.com/documentation/19.0/applications/finance/accounting/customer_invoices/electronic_invoicing.html) (both) | UBL prepared/validated, transmission adapter NOT CONFIGURED | topology decision, then sender adapter; receive through the existing provider | **P0** (topology) / P1 (send) |
| Purchases / supplier invoices with OCR | [Odoo](https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills/invoice_digitization.html) (OCR+AI), Xero (Hubdoc + bills), QuickBooks (receipt capture, bills), Accountable | supplier-invoice model only, no UI | "Achats" + Finance Inbox, manual/upload first, extraction with confidence + human review later | **P0** (foundation) / P2 (OCR) |
| Automatic payment reminders | [Xero](https://central.xero.com/0/article/Set-up-invoice-reminders), [Zoho](https://www.zoho.com/us/books/kb/payments/invoice-reminders.html) (up to 30), [QuickBooks](https://quickbooks.intuit.com/learn-support/en-us/help-article/invoicing/send-invoice-reminders-automatically-manually/L84cQjpxo_US_en_US), [FreshBooks](https://support.freshbooks.com/hc/en-us/articles/227559727-What-are-payment-reminders-and-late-fees) (3 + late fees), Odoo | overdue facts only | configurable steps, agent PREPARES, merchant approves; no automatic late fees | **P1** |
| Recurring invoices | all | none | templates that create DRAFTS; merchant approves | **P1** |
| Customer statements | Zoho (statement of accounts, PDF) | none | per-customer totals + PDF statement for a period | **P1** |
| Customer portal (view, accept quote, pay) | Zoho, FreshBooks, Odoo | none | extension point only | P2 |
| Bank feeds + reconciliation | Xero, QuickBooks, Odoo, Accountable | manual payments | `BankReconciliationAdapter` interface only | P2 |
| Accountant collaboration | QuickBooks Accountant, FreshBooks (free access), Accountable (with consent) | basic pack (CSV/PDF/XLSX) | accountant profile, ZIP period file, approval-gated send | **P0** |
| Accounting-software export | Accountable Connect, Odoo native | none | provider-neutral `AccountingExportAdapter`, exports first | P1 |
| Multilingual UI | Belgian tools: FR/NL/EN | English only | FR default, NL, EN, separate from document language | **P0** |
| Proactive "what to do next" | Xero/Odoo dashboards (reactive) | overview counters | Action Center (money to collect, overdue, to validate, period closing) | **P0** |
| Stock kept in sync with B2B sales | Odoo (integrated inventory), Xero (inventory) | none | idempotent decrement of standalone B2B catalogue lines | **P0** (gated, see §5) |
| Belgian specifics: HTVA/TVAC, Peppol, VAT by rate, BCE/KBO lookup, structured reference | Accountable | DONE for VAT, BCE lookup (CBEAPI), UBL | keep, add structured payment reference | P1 |

Not copied on purpose: card payments / online payment links (not needed for B2B bank-transfer culture), full bookkeeping / VAT return filing (Accountable Taxes plan; out of scope, the accountant does it), multi-currency, time tracking.

## 2. Roadmap

**P0 — before Finance V1 merge**
1. Finish and browser-verify the dynamic premium UI (in progress: shell, overview, lists, form, product picker, gross-price policy).
2. i18n layer: FR (default), NL, EN; persisted; UI language separate from document language; every string through `t()`.
3. Accountant profile in merchant-local settings + one-click period pack (ZIP with the agreed folder structure) + "Envoyer au comptable" with an explicit APPROVE step.
4. Finance Inbox + Achats foundation: private attachment storage, statuses RECEIVED → TO_REVIEW → VALIDATED → TO_PAY → PAID, sources Manual / Upload now; Email and Peppol as `InboxSourceAdapter` implementations NOT CONFIGURED.
5. Peppol topology decision (see §3), then the send/receive UX states (SENT → DELIVERED / REJECTED) behind the existing adapter boundary.
6. Action Center on the Overview.
7. Stock synchronization design + implementation **once the write scope is approved** (see §5).

**P1 — before selling externally**: reminder engine (prepare-only), recurring invoice templates (draft generation), customer statements, `AccountingExportAdapter` with generic CSV profiles, structured payment reference, roles (owner / accountant read-only), outgoing Peppol via the chosen access point.

**P2 — later**: OCR/AI extraction engine, client portal, bank reconciliation with a real bank feed, direct accounting connectors (Exact Online, Odoo, Yuki, WinBooks, Octopus, Sage), automatic reminders (opt-in), online payments.

## 3. Peppol topology — findings

Verified facts:
- The public Peppol Directory lists **the merchant (enterprise number kept in merchant-local settings) as registered since 2026-03-09** under both Belgian schemes (`0208` and `9925`), with Invoice, CreditNote and their self-billing document types. HABB is therefore already a Peppol participant.
- A participant has **one receiving Access Point at a time**. Codabox's own guidance says to ask whoever registered the company; deregistration takes up to 48 hours before re-registering elsewhere ([Peppol in Belgium – Codabox AP](https://peppolinbelgium.freshdesk.com/en/support/solutions/articles/75000128859-info-about-the-peppol-access-point-codabox-)).
- Codabox VOILA registers a client on Peppol/Zoomit when the accountant activates it, retrieves purchase invoices and **emails them to the client and to the accounting office** ([Codabox VOILA channels](https://faq.codabox.com/en/support/solutions/articles/75000057494-the-channels-peppol-and-zoomit)). The Codabox invoice notifications the merchant already receives match this flow (sender kept in merchant-local settings).
- I found **no public Codabox developer API**; the documented paths are email delivery and UBL import into accounting software.
- Which Access Point holds HABB's registration could **not** be determined from public data (SML DNS lookup inconclusive). It must be confirmed with the accountant (address in merchant-local settings) or Codabox.

Recommendation:
1. Do **not** register HABB with a second receiving Access Point. It would silently replace the current one and could break the accountant's incoming flow.
2. Ask the accountant / Codabox: who owns the registration, and can HABB use a **send-only** Access Point while Codabox stays the receiver.
3. **Receive**: keep Codabox. Route Codabox's invoice emails for HABB to the dedicated finance address (Codabox VOILA recipient setting, or a sender-only forwarding rule) so they reach the Finance Inbox without exposing the personal mailbox.
4. **Send**: choose a sender-capable Access Point only after owner approval; cost and terms to be presented first. Until then outgoing stays "UBL prepared, download".

## 4. Finance Inbox — recommendation

- A dedicated finance mailbox only (address in merchant-local settings). Ingest **only messages addressed to it**; never connect a personal or historical mailbox. Codabox should deliver to the finance address at the source, with a sender-restricted forward as a fallback.
- Boundary `InboxSourceAdapter` (`upload`, `email`, `peppol`, `manual`): each returns `{source, receivedAt, attachment, rawMetadata}`; the Inbox never reads anything else.
- Attachments in a **private** Supabase storage bucket (no public URL), tenant-scoped, short-lived signed URLs, audit event per access.
- Extraction boundary (`DocumentExtractor`): returns fields with a confidence and a pointer to the source document; nothing is accepted without merchant review; the deterministic engine and the existing `supplier-invoice.js` validation (net + VAT = gross) stay the authority.
- Statuses RECEIVED → TO_REVIEW → VALIDATED → TO_PAY → PAID; payment status is manual until the reconciliation adapter exists. No bookkeeping classification.

## 5. Stock synchronization — blocking constraint

Requirement: standalone B2B catalogue lines must decrement stock exactly once, idempotently, with an immutable link finance document → line → variant → quantity → inventory adjustment; Shopify stays the inventory source of truth.

**This needs a Shopify write scope (`write_inventory`)**, but the project rule is that Shopify access stays read-only with minimum scope. Proposed design, pending your explicit approval to add that one scope:
- an append-only `fin_stock_movements` ledger (unique key: document id + line position + kind) written in the same transaction as issuance, so retry is idempotent;
- an applier that calls `inventoryAdjustQuantities` with the movement id as the idempotency key, marks the movement APPLIED/FAILED, and never touches prices or product data;
- draft, quote and custom lines: no movement; Shopify/POS-linked invoices: no movement; credit note: explicit "restock?" choice creating a reverse movement.

## 6. Other decisions needed from the owner

1. Approve the additional `write_inventory` scope (or keep stock manual in V1).
2. Sending email to the accountant needs a channel: choose one of (a) generate the package plus a ready `.eml` you send yourself (no new access), (b) a transactional email service (new secret, approval per send), (c) the Gmail connector limited to creating a draft. Recommendation: (a) for V1.
3. Confirm the Codabox/Peppol steps in §3 with the accountant before any Access Point work.

## 7. Suggested build order after approval

i18n layer → accountant profile + ZIP pack + approval flow → Achats/Inbox foundation → Action Center → Peppol UX states → stock sync (if approved) → P1 items.
