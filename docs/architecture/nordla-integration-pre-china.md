# Nordla - pre-China system integration

Branch `integration/nordla-pre-china` (worktree `retail-ai-core-integration-wt`). Not merged to `main`. 2026-10-14.

This document is the module inventory, the module map, the ownership table and the findings of the integration. The code is in `src/integration/` (contracts and orchestration) and `src/finance/purchase-analysis.js` (Finance's answer for a planned purchase). No existing module was physically moved or rewritten.

## 1. Inventory: what was merged, from which tip

| Module | Branch / tip | How it reached the integration |
|---|---|---|
| BMC base: CREATIVE, BRANDING, MARKETING, ACTIVATION, provider connections | `feature/creative-system-closure` `7c76edb` | integration branch started here (it already contains branding `e0b86c9`, marketing M4 `ceec15c`, activation `9abfc92`, provider-connections `a0162e9`, creative-alibaba `259467d`, finance-integration `21dc924`) |
| CHINA_SOURCING (+ ANALYTICS "Analyses", Ask voice UI) | `feature/china-sourcing-mobile-ux-v2` `950ebe4` | merged (live tip is now `933168c`: one later sourcing commit is NOT included) |
| CORE (tenant, identity, security, merchant ids), FINANCE (C-line changes) | `feature/core-merchant-cleanup-m2` `cb3976a` | merged |
| GROWTH | `feature/growth-priorities-v1` `f56bcc7` | merged (clean) |
| SOCLE_DECISION | `feature/socle-decision-v0` `3f10482` | merged (clean) |
| PARLE_A_NORDLA (design doc only) | `origin/docs/parle-a-nordla-master-tree` `50e03ec` | merged (docs) |
| BUYING, STOCK_SALES, FINANCE base | `integration/nordla-platform-baseline` `08619d7` (ancestor of all lines) | via the above |
| Core resilience layer | `feature/nordla-core-resilience-v1` `4e82918` | **NOT merged**: conflict in `src/creative-brain/model-port.js` and it would stale the Creative readiness attestation (code hash) |

Answers to the requested inventory block:

```
CORE            = integration/nordla-platform-baseline 08619d7 + feature/core-merchant-cleanup-m2 cb3976a
BRANDING        = feature/branding-guardian-v1-on-brand e0b86c9 (ancestor of 7c76edb)
MARKETING       = feature/marketing-m4-steer-v1 ceec15c (ancestor of 7c76edb)
CREATIVE        = feature/creative-system-closure 7c76edb
CHINA_SOURCING  = feature/china-sourcing-mobile-ux-v2 950ebe4 (live tip 933168c not included)
FINANCE         = feature/finance-integration 21dc924 + payables cc86c0f + docintel 60dd60c (ancestors) + purchase-analysis.js (this branch)
BUYING          = src/buying @ 08619d7 (evaluator only). PurchasePlan is new, in src/integration
STOCK_SALES     = src/metrics + src/sync + src/demand @ 08619d7. No inbound / ETA / receipt existed. IncomingExpectation is new, in src/integration
ANALYTICS       = src/analytics-premium @ 3b44f19 (analyses-v1) over baseline
PARLE_A_NORDLA  = NOT_IMPLEMENTED as a router. Design: 50e03ec. This branch adds a deterministic TEXT router. No voice.
OTHER           = GROWTH f56bcc7, SOCLE_DECISION 3f10482, ACTIVATION 9abfc92, IDENTITY cb3976a
NOT_IMPLEMENTED = universal voice / ASR router; purchase orders; incoming stock; supplier exposure (before this branch)
```

## 2. Module map

Machine-readable in `src/integration/module-map.js` (checked by test). Summary of dependencies (H hard, S soft, O optional):

- MARKETING -> BRANDING (H), SOCLE_DECISION (H), STOCK_SALES (S)
- CREATIVE -> BRANDING (H), MARKETING (S)
- ACTIVATION -> MARKETING (H)
- CHINA_SOURCING -> FINANCE (O) (today: only `finance/pdf-text.js`; nothing else imports Sourcing)
- BUYING -> STOCK_SALES (H)
- FINANCE -> CORE (H), STOCK_SALES (S)
- GROWTH -> STOCK_SALES (H)
- ANALYTICS -> CORE (H), read-only
- HISTORICAL_ONLY: none declared.

## 3. Single source of truth (ownership)

Machine-readable in `src/integration/ownership.js`.

| Entity | Owner | Note |
|---|---|---|
| PRODUCT | STOCK_SALES | catalogue; Shopify is a temporary source (NDR-012) |
| SUPPLIER | FINANCE | `fin_companies`; Sourcing keeps per-case claims only |
| CUSTOMER, ORDER | STOCK_SALES | |
| PURCHASE | BUYING | plan lifecycle; order placement and payment are separate approved actions |
| INVOICE, PAYMENT, FINANCIAL_FACT | FINANCE | every landed cost / margin / cash figure shown to the owner |
| STOCK | STOCK_SALES | on-hand; incoming is a separate bucket that never counts as available |
| CAMPAIGN | MARKETING | Creative keeps no campaign state of its own |
| CREATIVE_ASSET | CREATIVE | |
| BRAND_PROFILE, CLAIM_EVIDENCE | BRANDING | Marketing proposes claims, Branding approves, Creative consumes |
| SOURCING_CASE | CHINA_SOURCING | |

## 4. Shared identities, provenance, approvals

- **Ids** (`ids.js`): `nordla:<kind>:<id>`; kinds tenant, merchant, product, variant, supplier, customer, order, sourcing_case, purchase, invoice, campaign, asset, run. `tenant_id` IS `merchant_id` (there is no separate tenant id in `src/tenant`). A registry maps module-local ids to one canonical id; same normalised name or VAT with a second canonical id, or one local id bound twice, is `IDENTITY_CONFLICT`. Ambiguous mentions are never guessed.
- **Provenance** (`provenance.js`): USER_PROVIDED, SUPPLIER_CLAIM, DOCUMENT_OBSERVED, IMAGE_OBSERVED, SYSTEM_DERIVED, VERIFIED, ESTIMATED, UNKNOWN, CONFLICT. Seven module enums are mapped (tables in `MAPPINGS`). A quoted price is a SUPPLIER_CLAIM. The only promotion is to VERIFIED, by a named HUMAN or OFFICIAL_SOURCE with an evidence ref; a CONFLICT is left only by an explicit resolution.
- **Approvals** (`approval.js`): READ_ONLY, AUTO_SAFE, OWNER_REVIEW, OWNER_APPROVAL_REQUIRED, BLOCKED; one table of `<MODULE>.<action>`; default deny; an approval is a record by a named human for that action and that subject; machine approvers are refused.

## 5. Connections built

| Connection | Where | Result |
|---|---|---|
| Sourcing -> BUY_CANDIDATE | `handoffs.markBuyCandidate` | Sourcing has no BUY_CANDIDATE state and no approval workflow (its verdict is advisory). A BUY_CANDIDATE here = verdict GO/CONDITIONAL_GO with no hard blocker AND a named-human approval of that case. |
| Sourcing -> Buying | `handoffs.buildBuyingHandoff` | supplier, product, quote (price, currency, MOQ, incoterm, lead time, tiers, payment terms), evidence, risks, documents, negotiation history, owner approval. `purchase_created: false`. |
| Buying -> Finance | `financeRequestFromHandoff` -> `finance/purchase-analysis.js` | landed cost, cash requirement (import VAT advanced), payment schedule, margin, scenarios, risks. Integer cents. Foreign currency refused (`CURRENCY_CONFLICT`) unless a human states the rate; then flagged ESTIMATED. |
| Buying -> Stock | `buildPurchasePlan`, `approvePurchasePlan`, `buildIncomingExpectation` | incoming product, quantity, ETA, supplier, purchase cost, destination location. State EXPECTED, `counted_in_available: false`. No stock mutation. |
| Stock -> Marketing | `checkClaimsAgainstStock` | "in stock" needs on-hand > 0; "coming soon" needs an expectation with an ETA; unknown stock is UNVERIFIABLE. |
| Branding -> Marketing -> Creative | `buildCampaignContract`, `creativeInputsFrom` | one campaign contract owned by Marketing; Creative receives a projection (product ref, request ref, approved claims only). An unapproved claim or one Stock does not support never reaches Creative. |
| -> Analytics | `buildTrackingDefinition` | read-only definition (`authoritative_for_operations: false`). |
| Parle a Nordla | `router.js` | deterministic FR/EN text router: intent + entities + context + permissions; ambiguity => ASK. |

## 6. Findings that need an owner decision or a separate task (not fixed here)

1. **Three landed-cost engines** (Sourcing `landed.js`/`economics.js`, Buying `economics.js`, now Finance `purchase-analysis.js`). Finance is the authority for the handoff; the other two remain and can disagree (DUP-LANDED-COST). Decision: retire Sourcing's engine behind a Finance call, or keep it as an advisory field estimate?
2. **No persistence** for BUY_CANDIDATE, PurchasePlan, IncomingExpectation, CampaignContract, TrackingDefinition and the trace ledger (in memory). Needs tables and a separate approved task.
3. **No purchase order / commitment / incoming-stock object existed.** The ones here are minimal and in memory.
4. **Marketing M3 brief and Creative's runtime brief are two unconnected shapes** (`creative-brief.js` vs `buildBrief`). The integration campaign contract bridges them at the contract level only; mapping the real Push -> M3 brief -> Creative brief is not done.
5. **Sourcing is single-tenant and file-based** (no merchantId, no Supabase). Cases are linked to a tenant only through the integration registry.
6. **Core resilience (`4e82918`) is not merged**: owner decision (it re-attests Creative).
7. **Growth defaults to UTC** (KNOWN_DEBT, exempted in the C8 guard) - contradicts the "refuse to assume UTC" rule.
8. **Sourcing live tip `933168c`** has one commit after the merged `950ebe4`.
9. **Windows-only test failures** in 7 `sourcing-*` test files (`C:\C:\...` path from `new URL().pathname`) also fail on the untouched Sourcing branch on this machine; they are environmental, not caused by the merge.
10. Creative quality limits (no live provider, no vision critic, placeholder plates) are unchanged by this work.

### 6.1 Status after the Core P0 (branch `claude/nordla-core-p0`)

| §6 item | Status |
|---|---|
| 1. Three landed-cost engines | Unchanged: owner decision (Finance as the only authority). |
| 2. No persistence | Tables PREPARED, not applied: `supabase/migrations-pending/20261015090000_*` (+ RLS policies, fin_* search_path). Owner authorization required. |
| 3. No PO / real incoming stock | Unchanged (out of P0 scope). |
| 4. Two brief shapes | Unchanged. |
| 5. Sourcing single-tenant, file based | `sourcing_cases` table with `merchant_id` prepared; hosted mode requires a named merchant. The server still uses files until the database is chosen. |
| 6. Core resilience not merged | MERGED (`model-port.js` conflict resolved keeping both behaviours). Creative re-attestation PREPARED, not done: `docs/architecture/creative-readiness-reattestation-pending.md`. |
| 7. Growth defaults to UTC | FIXED: the merchant zone is required (TIMEZONE_NOT_CONFIGURED / TIMEZONE_INVALID); the C8 guard exemption is removed. |
| 8. Sourcing tip 933168c | MERGED (`feature/china-sourcing-mobile-ux-v2`, with 183267d and 90e1ecf). |
| 9. Windows test failures | FIXED in the tests (`fileURLToPath`; guard test). Not re-run on Windows itself from here. |

## 7. Cross-line conflicts found and aligned (merge fixes)

- Config unions (`package.json`, `.gitignore`, `.gitattributes`, finance-privacy filter) and a regenerated lockfile.
- `finance/runtime.js` imports, `finance/ui/lang-fr.js` (fr-BE nomenclature side), three tenant-decoupling tests (C6-F supersedes the transitional legacy fallback).
- Creative dependency-pin test now accepts Finance's e-invoicing validators.
- `provider-connections/validation.js`: removed the `legacy_shopify` tenant source (C6-F removed it everywhere else).
- `analytics-premium/ui/ask.js`: no hardcoded English percent fallback (locale rule).
- `c6f` test sets `MERCHANT_TIMEZONE`; `finance/ui/lang-nl.js` gets the Dutch string for a new credit-note key.
- M2 migration test allows later migrations; Growth baseline-scope guard skipped on this branch (the merged lines legitimately changed Finance/Analytics).

## 8. Tests

`test/integration-contracts.test.js` (identity, provenance, approval, ownership, module map, ledger, hub, Finance purchase analysis, router, readiness) and `test/integration-workflows.test.js` (the three workflows over the real Sourcing, Finance and Creative modules with scripted fakes for the provider ports; failure tests A-G). `tools/integration-mutation.mjs` is the targeted mutation sweep.
