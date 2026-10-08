# Nordla — Marketing M1 · UNDERSTAND Foundation V1 (contract)

- **Status:** IMPLEMENTED (M1) — local commit, not pushed, awaiting architect audit
- **Parent architecture:** [`marketing-v1-architecture.md`](./marketing-v1-architecture.md)
- **Decisions respected:** NDR-001/002/003/007/008/010/013/014/015/016/020 (see §12)
- **Code:** `src/marketing/{understand-constants,understand-validation,market-signal,marketing-context,materiality,domain-fit,finding,understand}.js`
- **Public surface:** `src/marketing/understand.js` (the CLI `src/marketing/index.js` is not touched and not re-exported)
- **Tests:** `test/marketing-understand.test.js`

M1 teaches Nordla to say, with proof, **what is observed, whether it matters, whether it is a Marketing problem at all, what evidence is missing, and which explanations remain only hypotheses.** It never proposes an action.

```text
existing facts / domain-owned facts / MarketSignal[]
              ↓
        MarketingContext
              ↓
     Materiality Assessment
              ↓
          Domain Fit
              ↓
       MarketingFinding ── CandidateHypothesis[] (embedded)
              ↓
   findingFreshness / evaluateFindingReadiness
```

## 1. General rules (every M1 contract)

| Rule | How |
|---|---|
| Pure & deterministic | No network, filesystem, database, LLM, VLM, `Date.now()`, random id or environment. The clock (`asOf`, `created_at`…) is always an argument. |
| Closed schemas | An unknown key is refused (`MKT_UNKNOWN_KEY`): no `budget`, `campaign`, `creative`, `final_cause`, `score`, `confidence`, `causal_claim: true`, `email`, `phone`… can be stored. |
| Immutable | Every returned object is deep-frozen. Caller inputs are copied, never mutated and never frozen. |
| Stable errors | `MarketingUnderstandError` with a `code` from `MKT_ERROR` (one code per condition). Messages never echo submitted values. |
| Deterministic ids | `msig_…`, `mfd_…`, `mhy_…` = sha256 of the normalized content (same convention as Branding decision events). |
| Timestamps | ISO-8601 with an **explicit offset** and a real calendar date; normalized to UTC. `2026-10-08`, `…T10:00:00` (no offset) and `2026-02-31…` are refused. |
| Opaque references | Every `*_ref(s)`, `dimension`, `value` is an opaque token (letters, digits, `: _ . / # -`; no space, `@`, `?`, `&`). An e-mail, a name, a phone number or a query string with a click id cannot be stored. Privacy comes from the closed schema, not from a PII detector. |

## 2. Tenant / brand boundary and trust

- `merchant_id` is **derived from the canonical tenant** (`{ merchantId, source }` from `src/tenant`). `buildMarketSignal` / `buildMarketingFinding` refuse a caller-supplied `merchant_id`, `brand_id` or id. Validating a stored payload (`normalizeMarketSignal`, `normalizeMarketingFinding`) requires its `merchant_id` to equal the tenant (`MKT_*_TENANT_MISMATCH`).
- `brand_id` is **optional** (merchant-wide object) and **never inferred**. When a resolved Brand Identity is supplied it must belong to the same merchant, be `ACTIVE`, and equal the declared `brand_id`.
- A **brand-scoped `MarketingContext`** requires `brandId` plus a **`READY` Brand Context** (`buildBrandContext`) of that exact merchant and brand. It stores only `brand_id`, `core_ref`, `memory_ref` and review signals — Branding is referenced, never rebuilt or copied.
- **Signal scope:** a brand-scoped signal enters only its own brand's context; a merchant-wide signal (`brand_id: null`) may enter any brand's context of the same merchant; a brand-scoped signal never enters a merchant-wide context. Two merchants can never mix signals.
- **Trust boundary (same philosophy as Branding):** tenant, Brand Identity/Context, measurement facts, domain facts, manual observations and signals must come from **trusted server-side adapters**. M1 validates shape, scope, freshness and the causal boundary; it performs **no** authentication, cryptographic verification or connector authorization. Until Nordla Identity exists, whoever builds those inputs carries that trust (open dependency).

## 3. MarketSignal

One envelope for every present and future producer (no per-radar contract). **No producer is built in M1.**

```text
MarketSignal
├── signal_id          derived (msig_…) unless supplied
├── merchant_id        from the tenant
├── brand_id?          null = merchant-wide
├── signal_class       INTERNAL_MEASUREMENT | EXTERNAL_SIGNAL | MANUAL_OBSERVATION
├── signal_type        UPPER_SNAKE_CASE, ≤ 64 (extensible; the core never branches on it)
├── subject_refs[]     opaque refs
├── source_ref         required
├── detected_at, observed_at?, expires_at
├── locale?, market?   BCP 47 (fr-be → fr-BE); ISO region / M.49
├── evidence_refs[]    opaque refs, de-duplicated
├── limitations[]      de-duplicated; the class limitation is always first
└── provenance         the existing src/marketing/provenance.js contract
```

- **Classes** — `INTERNAL_MEASUREMENT` is not causal truth; `EXTERNAL_SIGNAL` is never a fact about the merchant; `MANUAL_OBSERVATION` is traced qualitative evidence, never statistical proof. Each class **always** carries its limitation (`INTERNAL_MEASUREMENT_IS_NOT_CAUSAL_PROOF`, `EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT`, `MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF`), which travels to any Finding that cites the signal.
- **Provenance** is the existing Marketing vocabulary, unchanged (`observed | attributed | inferred | derived | unavailable`; `COMPLETE | PARTIAL | UNAVAILABLE`). `attributed`/`inferred` keep `ATTRIBUTION_IS_NOT_CAUSAL_PROOF`. `causal_claim` is always `false`; supplying `true` is refused (`MKT_CAUSAL_CLAIM_FORBIDDEN`). `filters` are flat JSON primitives only.
- **Reserved `signal_type` examples (documentation only):** `MARKETING_MEASUREMENT`, `SOCIAL_TREND`, `SEARCH_DEMAND`, `STORE_OBSERVATION`, `REPUTATION`, `LOCAL_EVENT`, `LOST_DEMAND`.
- **Freshness:** `expires_at > detected_at`; `observed_at ≤ detected_at` when present. `isMarketSignalExpired(signal, asOf)` is true when `expires_at ≤ asOf`; `marketSignalFreshness` returns `FRESH | STALE`. An expired signal stays auditable and in the context (labelled `STALE`); it is never silently fresh evidence.

## 4. MarketingContext

`buildMarketingContext({ tenant, asOf, brandId?, brandContext?, measurementFacts?, domainInputs?, customerSegmentRefs?, productRefs?, offerRefs?, calendarRefs?, marketSignals? })` — read-only inputs for UNDERSTAND, not a warehouse.

- **Existing Marketing Measurement** is consumed through **`phase3Inputs(facts)` unchanged** (cloned, never aliased): a `GATED` conversion stays `GATED` with `traffic: null`; an `OPEN` one is consumed without recomputation; search facts stay `not_a_conversion_input`; `causal_claims` stays `false`. Facts of another merchant are refused.
- **Domain facts** (`SALES_PRODUCT`, `INVENTORY`, `FINANCE`, `OPERATIONS`): each fact is typed (`fact_key`, `value` = finite number | boolean | short string, `unit?`, **`source_ref` required**, `observed_at`). Marketing reads what the owner exposes (`available_units`, `unit_margin`, `coverage_days`, `capacity_window`…) and **never recomputes it**. Customers appear as **segment refs only** — no profile data.
- Output carries `signal_freshness[]` relative to `as_of`.

## 5. Materiality Assessment

Exactly five axes — `ECONOMIC`, `CUSTOMER`, `STRATEGIC`, `RISK`, `OPERATIONAL` — each `{ status, reason_codes[], evidence_refs[] }` with status `MATERIAL | NOT_MATERIAL | UNKNOWN | NOT_APPLICABLE`. At least one reason code is required; `MATERIAL` / `NOT_MATERIAL` also require evidence.

```text
≥ 1 axis MATERIAL                                -> MATERIAL
else ≥ 1 axis UNKNOWN                            -> UNKNOWN
else ≥ 1 applicable axis, all NOT_MATERIAL       -> NOT_MATERIAL
else (all NOT_APPLICABLE)                        -> UNKNOWN
```

`NOT_APPLICABLE` does not vote. An axis nobody assessed is `UNKNOWN` with reason `AXIS_NOT_ASSESSED` (never silently `NOT_MATERIAL`). The result also lists `deciding_axes`. **No score, no weights, no € threshold:** statuses come from owning domains or future configurable rules; M1 owns only the contract, validation and aggregation. A Finding re-computes `overall` from the axes and refuses a forged one.

## 6. Domain Fit

`MARKETING_RELEVANT | REFER_TO_DOMAIN | NO_MATERIAL_SIGNAL | NOT_MEASURABLE`, with `reason_codes[]` (≥ 1), `evidence_refs[]`, `target_domains[]`.

`REFER_TO_DOMAIN` requires `target_domains` + `reason_codes` + `evidence_refs`; targets are forbidden otherwise. The target registry is closed: `INVENTORY, FINANCE, CUSTOMERS, SALES_PRODUCT, SITE_COMMERCE, OPERATIONS, SALES_DEVELOPMENT, BRANDING, SERVICE_SUPPORT` (no repository registry existed; this uses the architecture's names — no second taxonomy). Domain Fit carries a diagnosis only — no lever, budget, campaign or action.

## 7. MarketingFinding

```text
MarketingFinding
├── finding_id (mfd_…)  merchant_id  brand_id?
├── finding_type        PROBLEM | OPPORTUNITY | NO_MATERIAL_SIGNAL | NOT_MEASURABLE
├── subject_refs[]      statement (≤ 500, human text)
├── scope[]  is[]  is_not[]     { dimension, value, evidence_refs[] }  (opaque tokens)
├── window {start,end}  baseline_ref?
├── evidence_refs[]  contradictory_evidence_refs[]   (first-class)
├── limitations[]  data_gaps[]  { gap_code, owner_domain?, description }
├── materiality  domain_fit
├── created_at  expires_at
└── hypotheses[]
```

- `REFER_TO_DOMAIN` is a **`domain_fit`**, never a `finding_type`: a real, observable problem can be referred elsewhere and is then never BUILD-eligible.
- `PROBLEM`/`OPPORTUNITY` need ≥ 1 `subject_ref` and ≥ 1 `evidence_ref`; `NOT_MEASURABLE` must name ≥ 1 `data_gap`. The same dimension/value cannot be both IS and IS NOT. IS / IS NOT never become a hypothesis automatically.
- **The engine never parses `statement`** (or any free text) to decide anything; decisions come from structured fields and evidence refs. A future LLM may write the statement; material numbers keep coming from facts.
- Built from a `MarketingContext` (`buildMarketingFinding({ tenant, context, …fields })`): scope is taken from the context, never inferred. **Cited signal limitations travel to the Finding**, and a cited signal that had already expired at `created_at` adds `CITED_SIGNAL_EXPIRED`.
- Only structured gaps — **no estimate is ever substituted for a missing value**; no `observed_change` snapshot field in M1 (a value, if ever needed, is referenced by evidence ref).

## 8. CandidateHypothesis

Embedded in the Finding; it has **no public builder or normalizer** — `Hypothesis cannot exist outside a Finding` is structural (tested on the export surface).

```text
{ hypothesis_id (mhy_…), statement, mechanism,
  supporting_evidence_refs[], contradicting_evidence_refs[], unknowns[],
  testability: TESTABLE_NOW | TESTABLE_LATER | NOT_TESTABLE | UNKNOWN }
```

No `status`, no `confidence`: `CONFIRMED` / `PROVEN` / `FACT` are refused as unknown keys. A hypothesis can only be confirmed later by STEER with its own evidence. `NOT_TESTABLE` / `UNKNOWN` hypotheses are kept with their unknowns. M1 makes no model call and extracts no number from hypothesis text.

## 9. Freshness & readiness

`findingFreshness(finding, asOf)` → `FRESH` until `expires_at`, `STALE` at and after it (consultable, never BUILD-eligible without refresh).

`evaluateFindingReadiness(finding, asOf)` → `{ status, reason_codes[] }`, **first match wins**:

| # | Status | When |
|---|---|---|
| 1 | `STALE` | `expires_at ≤ asOf` |
| 2 | `REFER_TO_DOMAIN` | `domain_fit = REFER_TO_DOMAIN` |
| 3 | `NOT_MEASURABLE` | `finding_type = NOT_MEASURABLE`, or `domain_fit = NOT_MEASURABLE`, or materiality still `UNKNOWN` (`MATERIALITY_UNKNOWN`) |
| 4 | `NO_MATERIAL_SIGNAL` | `finding_type = NO_MATERIAL_SIGNAL`, or `materiality = NOT_MATERIAL`, or `domain_fit = NO_MATERIAL_SIGNAL` |
| 5 | `READY_FOR_BUILD` | `PROBLEM`/`OPPORTUNITY` + `MATERIAL` + `MARKETING_RELEVANT` + fresh |

**Why this precedence:** an expired diagnosis must be refreshed before any other conclusion is trusted; a problem that belongs to another domain is never a Marketing build; an unmeasurable finding cannot be called immaterial; and only a fully qualified finding is ready. It is a gate, not a build: nothing in M1 consumes it.

## 10. Causal boundary & no action authority

- No M1 output contains `causal_claim: true` (or `causal_claims: true`); evidence provenance keeps `ATTRIBUTION_IS_NOT_CAUSAL_PROOF`. **ATTRIBUTED ≠ INCREMENTAL ≠ CAUSAL** is not weakened.
- The M1 export surface has no `publish`, `send`, `buy_ads`, `change_price`, `change_stock`, `execute`, `approve_spend` or `force_campaign`, and imports no Creative, Brand Guardian, Inventory, Finance, Customers, sync or connector module (tested structurally). No margin, stock or customer-profile logic exists in M1.

## 11. Non-goals (not built)

`MarketingPushProposal`, Lever Library / Fitness, `ResourceRequirements`, experiment engine, `CreativeBrief`, `ActivationManifest`, `MarketingRun`, `MarketingLearning`, offline attribution, every signal **producer** (Social Trend, Search Demand, Store Experience, Reputation, Lost Demand, calendar), manual-observation input workflow, contact pressure, creative fatigue, creator discovery, next-best-product, journey orchestration, media buying, publication, connectors, dashboards, LLM/VLM calls, web crawling, database migrations, persistent Marketing tables.

## 12. Decision register check

| NDR | Respected by |
|---|---|
| 001 / 002 / 003 | M1 only diagnoses; no decision, lever or execution; nothing bypasses the Socle. |
| 007 | `NOT_MEASURABLE` and `NO_MATERIAL_SIGNAL` are first-class finding/domain-fit/readiness outcomes. (`DO_NOTHING` / `TEST_SMALL` are BUILD options — M2.) |
| 008 | Pure code; material numbers only come from facts/evidence; no LLM; no number parsed from text. |
| 010 | Provenance reused; closed schemas; tenant/brand isolation; explicit trust boundary. |
| 013 / 014 / 015 / 016 | Understand only; Branding referenced through Brand Context; no Creative / Sales Development logic. |
| 020 | No merchant-specific code or name in the generic M1 modules (tested). |

## 13. Generic example

```js
import {
  buildMarketSignal, buildMarketingContext, assessMateriality, buildMarketingFinding, evaluateFindingReadiness,
} from './src/marketing/understand.js';

const tenant = { merchantId: '<tenant-uuid>', source: 'env' };     // from the canonical resolver

const signal = buildMarketSignal({
  tenant, signal_class: 'MANUAL_OBSERVATION', signal_type: 'LOST_DEMAND',
  subject_refs: ['product://case-x'], source_ref: 'observation/2026-10-08-a',
  detected_at: '2026-10-08T10:00:00Z', expires_at: '2026-10-22T10:00:00Z',
  provenance: { source_system: 'staff_log', completeness: 'PARTIAL', evidence_kind: 'observed' },
});

const context = buildMarketingContext({ tenant, asOf: '2026-10-08T12:00:00Z', marketSignals: [signal] });

const finding = buildMarketingFinding({
  tenant, context, finding_type: 'OPPORTUNITY', subject_refs: ['product://case-x'],
  statement: 'Repeated requests for an item that is not offered.',
  window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' },
  evidence_refs: [signal.signal_id],
  materiality: assessMateriality({ CUSTOMER: { status: 'MATERIAL', reason_codes: ['REPEATED_REQUESTS'], evidence_refs: [signal.signal_id] } }),
  domain_fit: { status: 'MARKETING_RELEVANT', reason_codes: ['DEMAND_NOT_SERVED_BY_VISIBILITY'] },
  created_at: '2026-10-08T12:00:00Z', expires_at: '2026-10-22T12:00:00Z',
});

evaluateFindingReadiness(finding, '2026-10-09T00:00:00Z'); // READY_FOR_BUILD
```

## 14. Open dependencies (intentionally not resolved here)

Lost Demand producer · Calendar/seasonality producer · Manual Observation input workflow · Social Trend / Search Demand / Store Experience / Reputation radars · Operations / Workshop data source · Customers segment source · richer Finance / Inventory contracts · persistence · Decision Ledger · Activation · Creative · STEER · Nordla Identity (trust of server-built inputs).
