# Finance — Belgium & Peppol

Scope V1: Belgian invoice compliance (route decision, structured payment reference), legal artifacts (exact PDF and structured originals), Peppol outbound and inbound behind a provider contract. **Not** in scope: e-reporting, Intervat, VAT return, general ledger, accounting entries, a concrete Peppol provider.

Nordla is not a tax adviser. Every fact comes from explicit data; what cannot be decided from facts becomes `MANUAL_REVIEW_REQUIRED` or `COMPLIANCE_BLOCKED`, never a guess. No tax rule was coded from memory: each LEGAL / PEPPOL rule below was read on its official source on **2026-10-03** (SPF Finances / BOSA e-invoice portal, OpenPeppol, Febelfin/EPC). Where the source was not specific (public-procurement thresholds, intra-EU delivery facts, the exact UBL placement of the Belgian structured communication) the case is explicitly manual review / not supported.

## Supported Peppol release

Peppol BIS Billing 3.0, **May 2026 release, version 3.0.21** (docs.peppol.eu; the official `.sch` files state "Last update: 2026 May release 3.0.21"). CustomizationID `urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0` (rule PEPPOL-EN16931-R004), ProfileID `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`. Declared in ONE place (`PEPPOL_RULESETS` in `src/finance/peppol-validation.js`); every validated or archived structured document records the BIS version, release, identifiers and the SHA-256 of the exact compiled validators and Schematron sources, so a historical invoice stays linked to the ruleset that validated it. A future release is added next to 3.0.21 (coexistence), never replacing it.

## Official validation pipeline

`secure XML checks → official UBL 2.1 XSD → official EN 16931 Schematron → official Peppol Schematron → Nordla invariants → provider`.
- **XSD**: the official OASIS UBL 2.1 `UBL-Invoice-2.1.xsd` / `UBL-CreditNote-2.1.xsd` (with the whole `common/` set, unchanged from `UBL-2.1.zip`), executed by libxml2 compiled to WebAssembly (`xmllint-wasm`, MIT, no native build). The root element selects the schema; an XSD failure yields structured `UBL-XSD` findings (line, message), skips the Schematron layers (they would judge a document that is not valid UBL) and the document is never archived as valid, never queued, never sent.
- **Schematron**: the OFFICIAL `CEN-EN16931-UBL.sch` and `PEPPOL-EN16931-UBL.sch` from docs.peppol.eu, compiled by `scripts/build-peppol-validators.mjs` (ISO Schematron reference implementation → XSLT → Saxon-JS SEF) and executed with Saxon-JS 2.7.0.
- Nothing is re-implemented. Findings are structured (layer, ruleset + version + artifact hash, rule id, severity, message, location, timestamp, document hash).
- **Integrity (fail closed)**: `vendor/MANIFEST.json` is the single immutable record of every artifact (source URL, version, retrieval date, SHA-256, size); its own hash is pinned in `src/finance/validation-artifacts.js`. Before any official layer runs, the bytes that will be used are hashed against it; a missing, modified, truncated, wrong-version or replaced-manifest artifact gives `VALIDATION-ARTIFACTS-UNVERIFIED` and no official layer starts (the build script refuses the same way). `.gitattributes` marks `vendor/**` as `-text -diff`: Git never converts line endings of the vendored files. Adopting a release is a deliberate act: re-run `scripts/pin-validation-artifacts.mjs` and update the pinned manifest hash in the same commit. The compiled SEF files are not byte-reproducible (Saxon embeds build-specific data): the committed bytes are what is pinned.
- Cost: about 0.7 s for the XSD plus 0.35 s for the Schematron per document; archiving at issuance is synchronous (asynchronous archiving is backlog).

## Route decision (`determineInvoiceRoute`)

From facts only; returns the route, the reasons, the rule ids, the missing facts and notes. Routes: `PEPPOL_REQUIRED`, `PEPPOL_PREFERRED`, `B2G_STRUCTURED`, `NON_STRUCTURED_ALLOWED`, `ALTERNATIVE_EN16931_AGREED`, `MANUAL_REVIEW_REQUIRED`, `COMPLIANCE_BLOCKED`.

| situation | route |
|---|---|
| buyer is a private individual | `NON_STRUCTURED_ALLOWED` (B2C out of scope) |
| buyer is a public authority | `B2G_STRUCTURED` (own route; procurement thresholds/exceptions not evaluated → note) |
| seller not established in Belgium and no establishment fact | `MANUAL_REVIEW_REQUIRED` |
| buyer exempt-only under art. 44 (explicit fact) | `NON_STRUCTURED_ALLOWED` |
| foreign buyer | `NON_STRUCTURED_ALLOWED`, or `PEPPOL_PREFERRED` when the buyer has a Peppol id (voluntary) — never an automatic Belgian B2B |
| foreign address with a Belgian VAT number / Belgian business without VAT number and without exemption fact | `MANUAL_REVIEW_REQUIRED` |
| Belgian VAT-liable buyer, regime domestic or small-business exemption | `PEPPOL_REQUIRED` (`COMPLIANCE_BLOCKED` if the seller's VAT number or IBAN is missing) |
| other VAT regimes with a Belgian buyer | `MANUAL_REVIEW_REQUIRED` |
| explicit agreement (format, reason, evidence, timestamp, recorded by, EN 16931 compliant) | `ALTERNATIVE_EN16931_AGREED`; an incomplete or non-EN16931 agreement is `COMPLIANCE_BLOCKED` — never a silent fallback |
| credit note | the route of the invoice it corrects (unknown original → manual review) |

## Rules (classified)

### LEGAL MUST
| id | rule | official source | URL / legal reference | verified on | Nordla component |
|---|---|---|---|---|---|
| `BE-B2B-STRUCTURED-2026` | From 2026-01-01, invoices between Belgian enterprises liable to VAT (B2B) must be structured electronic invoices; a PDF sent by e-mail is no longer enough. | FPS Finance / BOSA e-invoice portal | <https://einvoice.belgium.be/en/article/structured-electronic-invoices-between-companies-are-compulsory-2026> (VAT Code art. 53 §2bis) | 2026-10-03 | belgium-compliance.js determineInvoiceRoute |
| `BE-B2C-OUT-OF-SCOPE` | The obligation does not apply to invoices issued to private individuals. | FPS Finance / BOSA e-invoice portal | <https://einvoice.belgium.be/en/article/structured-electronic-invoices-between-companies-are-compulsory-2026> | 2026-10-03 | determineInvoiceRoute (buyer.kind = individual) |
| `BE-NON-ESTABLISHED-OUT` | VAT-registered persons not established in Belgium (no permanent establishment) are not subject to the obligation; small-business exemption scheme and agricultural scheme users ARE subject. | FPS Finance / BOSA e-invoice FAQ | <https://einvoice.belgium.be/en/FAQ/general-questions-b2b> (VAT Code art. 53 §2bis) | 2026-10-03 | determineInvoiceRoute (seller establishment, vat_exempt_small_business stays in scope) |
| `BE-ART44-OUT` | Taxpayers whose only activities are exempt under VAT Code art. 44 are not required to register for VAT (and therefore have no VAT number): an explicit fact "exempt art. 44 only" takes the buyer out of scope. | FPS Finance / BOSA e-invoice portal | <https://einvoice.belgium.be/en/FAQ/general-questions-b2b> (VAT Code art. 44) | 2026-10-03 | determineInvoiceRoute (buyer.exemptArt44Only) |
| `BE-ALT-FORMAT-AGREEMENT` | Structured invoices are in principle Peppol BIS; a deviation is only possible if BOTH parties agree and the alternative format complies with EN 16931; the agreement should be explicit and in writing. | FPS Finance / BOSA e-invoice portal | <https://einvoice.belgium.be/en/FAQ/specific-questions-about-e-invoicing> | 2026-10-03 | determineInvoiceRoute (agreement fact: reason, evidence, format, timestamp, provenance) |
| `BE-CREDIT-NOTE-SAME-FORMAT` | A document that modifies the original structured invoice and refers to it unambiguously is itself a structured invoice and is issued in the same format; credit and debit notes are therefore also sent via Peppol. | FPS Finance / BOSA e-invoice FAQ | <https://einvoice.belgium.be/en/FAQ/specific-questions-about-e-invoicing> (VAT Code art. 56 §2 (4)) | 2026-10-03 | determineInvoiceRoute (credit note inherits the route of the invoice it corrects) |
| `BE-B2G-SEPARATE` | E-invoicing to public authorities is governed by separate rules (mandatory for public contracts published after 2024-03-01; Royal Decree of 2022-03-09). B2G is its own route; thresholds and exceptions of public procurement are not evaluated by Nordla V1. | FPS Finance / BOSA e-invoice portal | <https://einvoice.belgium.be/en/article/structured-electronic-invoices-between-companies-are-compulsory-2026> (Royal Decree 2022-03-09) | 2026-10-03 | determineInvoiceRoute (B2G_STRUCTURED + manual-review note) |
| `BE-TOLERANCE-2026Q1` | FPS Finance showed tolerance (no penalty) during 2026-01-01..2026-03-31 for enterprises that acted in a timely and reasonable manner; penalties apply after. | FPS Finance / BOSA e-invoice portal | <https://einvoice.belgium.be/en/news/period-tolerance-during-first-three-months-2026> | 2026-10-03 | documentation only (no code path depends on it) |
| `BE-ATTACHMENT-FORMATS` | Attachments follow the EN 16931 list (pdf, png, jpg, csv, xlsx, ods); XML is not in that list unless the parties agree. | FPS Finance / BOSA e-invoice FAQ | <https://einvoice.belgium.be/en/FAQ/specific-questions-about-e-invoicing> | 2026-10-03 | peppol-validation.js PEPPOL_RULESETS[*].attachmentMediaTypes |
| `FEBELFIN-OGM-VCS` | Structured communication OGM/VCS: 12 digits, the last two are the check digits = (first 10 digits) mod 97, 97 when the remainder is 0; printed +++xxx/xxxx/xxxxx+++. (Commercial invoice reference, not other administrations' structured communications.) | Febelfin - Additional Optional Service OGM-VCS (EPC AOS1) | <https://www.europeanpaymentscouncil.eu/sites/default/files/inline-files/Febelfin%20-%20AOS-OGMVCS_0.pdf> | 2026-10-03 | belgium-compliance.js vcs* |

### PEPPOL MUST
| id | rule | official source | URL / legal reference | verified on | Nordla component |
|---|---|---|---|---|---|
| `PEPPOL-BIS-3.0.21` | Peppol BIS Billing 3.0, May 2026 release, version 3.0.21; CustomizationID urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0 (rule PEPPOL-EN16931-R004). | OpenPeppol | <https://docs.peppol.eu/poacc/billing/3.0/> | 2026-10-03 | peppol-validation.js PEPPOL_RULESETS |
| `PEPPOL-ATTACHMENT-MEDIA-TYPES` | A receiver accepts attachments with media types application/pdf, image/png, image/jpeg, text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.oasis.opendocument.spreadsheet. | OpenPeppol BIS Billing 3.0 specification (binary objects) | <https://docs.peppol.eu/poacc/billing/3.0/bis/> | 2026-10-03 | peppol-validation.js PEPPOL_RULESETS[*].attachmentMediaTypes |
| `PEPPOL-OFFICIAL-SCHEMATRON` | Invoices are validated with the official EN 16931 (CEN-EN16931-UBL.sch) and Peppol (PEPPOL-EN16931-UBL.sch) Schematron, executed from the official files (not re-implemented). | OpenPeppol | <https://docs.peppol.eu/poacc/billing/3.0/files/> | 2026-10-03 | peppol-validation.js + scripts/build-peppol-validators.mjs |

### NORDLA INVARIANT
| id | rule | official source | URL / legal reference | verified on | Nordla component |
|---|---|---|---|---|---|
| `NORDLA-UBL-XSD` | A structured document is validated against the official OASIS UBL 2.1 XSD (Invoice and CreditNote) before the Schematron layers; an XSD failure is never archived as valid, queued or sent. | OASIS UBL 2.1 (os-UBL-2.1) schemas | <https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip> | 2026-10-03 | peppol-validation.js (xmllint-wasm) |
| `NORDLA-ARTIFACT-INTEGRITY` | Every official validation artifact is pinned by SHA-256 in vendor/MANIFEST.json (whose own hash is pinned in code) and verified before validators are built or run; a missing, modified or wrong-version artifact fails closed. | Nordla architecture | — | — | validation-artifacts.js, scripts/pin-validation-artifacts.mjs |
| `NORDLA-IMMUTABLE-ISSUE` | An issued document, its seller/buyer snapshot, its archived PDF and structured original never change; corrections are credit notes. | Nordla architecture | — | — | fin_documents guard, fin_artifacts immutability |
| `NORDLA-ONE-SNAPSHOT` | PDF and UBL are produced from the SAME immutable issue snapshot; there is one financial calculator. | Nordla architecture | — | — | legal-artifacts.js |
| `NORDLA-NO-SILENT-FALLBACK` | A structured document that fails validation is never SENT/DELIVERED, and Nordla never falls back silently to a PDF by e-mail. | Nordla architecture | — | — | peppol-service.js |
| `NORDLA-RECEIVE-NOT-VALIDATE` | Receiving a structured invoice never validates it accounting-wise: it lands TO_REVIEW with its exact original archived first. | Nordla architecture | — | — | peppol-service.js inbound |

### BACKLOG
| id | rule | official source | URL / legal reference | verified on | Nordla component |
|---|---|---|---|---|---|
| `BACKLOG-E-REPORTING` | Belgian e-reporting (2028) and Intervat are not part of Finance V1. | — | — | — | — |
| `BACKLOG-SELF-BILLING` | Self-billing workflow (the model can recognise the case; no workflow). | — | — | — | — |
| `BACKLOG-RETENTION-DURATIONS` | Retention durations per document type: only a classification is stored; no duration is hard-coded and nothing is deleted automatically. | — | — | — | legal-artifacts.js RETENTION_CLASSES |

## Structured payment reference (VCS/OGM)

12 digits, the last two are `(first 10 digits) mod 97`, **97 when the remainder is 0**; printed `+++xxx/xxxx/xxxxx+++`. Integer arithmetic only. Derived once from the legal invoice number (last 10 digits), stored on the PDF original (`fin_artifacts.payment_reference`: CHECK mod 97, unique per merchant, immutable) and read back by the UBL (`cbc:PaymentID`, printed form), the PDF and the accountant export; it is never regenerated. It is the commercial invoice reference, not a structured communication of another administration. Open point (BACKLOG): confirm with BOSA/Febelfin whether the Belgian practice expects the printed or the 12-digit form in BT-83.

## Numbering

The existing concurrency-safe numbering (`fin_next_number` + `fin_issue_document`, one transaction, unique per merchant/type/year) was re-checked and kept: PostgreSQL tests show eight simultaneous issuances getting distinct consecutive numbers and eight distinct valid references. Numbers are immutable after issue (document guard); a cancelled draft never consumes a number.

## Issue snapshot, immutability, archive

At issuance the document is hash-locked (`snapshot_hash`) with its seller and buyer snapshot. Right after issuance (hook `onIssued`) Nordla archives, from that same snapshot: the **PDF original** (exact bytes, SHA-256, renderer version, snapshot hash, route, seller profile version), then — when the route requires it — the **structured original** (UBL built from the snapshot, validated, archived only if valid, with the exact ruleset and validation result). A failure never undoes an issuance: it is audited (`ARTIFACT_STORAGE_FAILED`, `ARCHIVE_HOOK_FAILED`) and the repair path archives a **REGENERATED_COPY**, never an "original". `fin_seller_profile_versions` keeps the lineage of the seller profile (same content = same version); changing the profile or the customer never changes an issued invoice, its PDF or its structured original (tests E/F).

## Provider abstraction and state machines

`PeppolProvider` (`src/finance/peppol-provider.js`): participant lookup, submit, find-by-idempotency-key, status, inbound fetch, webhook authentication, health. Credentials stay in the adapter. A deterministic fake provider and a null provider exist; **no real provider is selected**.
Outbound (database-enforced in `fin_peppol_messages`): `QUEUED → SUBMITTING → SUBMITTED → DELIVERED | DELIVERY_FAILED`, `SUBMITTING → SUBMISSION_FAILED → QUEUED` (explicit retry), `VALIDATION_FAILED` terminal. Provider acceptance is **SUBMITTED**, never DELIVERED. One message per logical document; the QUEUED→SUBMITTING claim is a compare-and-set (eight concurrent senders give one submit). A timeout is an unknown outcome: the provider is asked by our idempotency key before anything is re-sent. Participant discovery is cached with checked_at/source and a negative result expires.
Inbound: exact bytes archived first → hash → deduplicate (provider message id, document hash, business key = sender endpoint + document id + issue date; conflicting bytes for the same business document are kept as evidence, never turned into a second supplier invoice) → official validation → supplier-invoice **candidate** → `TO_REVIEW` → a person accepts (through the existing supplier-invoice validation) or rejects with a reason. Attachments: only the media types of the verified ruleset, size-bounded, plain file names, archived under the message with hash and parent. Security: DOCTYPE/entities refused, depth and size limits, authenticated webhook, recipient check.

## Artifacts, retention, resilience

`fin_artifacts` stores durable metadata (hash, size, media type, provenance, classification original/regenerated, retention class, legal hold); the bytes live in the artifact storage behind `storage_ref` (never only in memory or in PostgreSQL rows); read-back verifies the SHA-256. Immutable: no update except `legal_hold`, no delete. Retention is a **classification** per artifact type (no duration hard-coded, nothing deleted automatically). No dependency on the provider: originals, hashes and states are exportable and restorable (compatible with the future Resilience Core).

## Tax model

EN 16931 categories used: `S` standard (21 %, 12 %, 6 % when allowed by the merchant), `Z` zero, `E` exempt (small-business scheme), `AE` reverse charge, plus `K`/`G` known but blocked for structured invoices until their facts exist (intra-EU delivery facts → `INTRA_EU_DELIVERY_FACTS_REQUIRED`). The rate and the regime are explicit merchant choices validated by `validateVat`; the exemption reason is merchant-confirmed text; Nordla selects nothing. Rounding follows the existing integer-cent rules and the explicit payable rounding amount (BT-114); the structured totals are checked against the snapshot (`NORDLA-SNAPSHOT-*` invariants).

## Known unsupported cases

Intra-EU / export structured invoices (delivery facts), VAT categories O/L/M, self-billing, e-reporting, attachments as XML (only by agreement), B2G thresholds, a real network sandbox (**blocked by provider selection**).
