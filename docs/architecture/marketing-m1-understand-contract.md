# Nordla — Marketing M1 · UNDERSTAND Foundation V1 (contract)

- **Status:** IMPLEMENTED (M1) + audit corrections (freshness bound, `effective_window`, canonical registry, coverage matrix) — local commits, not pushed
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
├── effective_window?  { start, end } — the period of the phenomenon (may be in the future)
├── locale?, market?   BCP 47 (fr-be → fr-BE); ISO region / M.49
├── evidence_refs[]    opaque refs, de-duplicated
├── limitations[]      de-duplicated; the class limitation is always first
└── provenance         the existing src/marketing/provenance.js contract
```

- **Classes** — `INTERNAL_MEASUREMENT` is not causal truth; `EXTERNAL_SIGNAL` is never a fact about the merchant; `MANUAL_OBSERVATION` is traced qualitative evidence, never statistical proof. Each class **always** carries its limitation (`INTERNAL_MEASUREMENT_IS_NOT_CAUSAL_PROOF`, `EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT`, `MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF`), which travels to any Finding that cites the signal.
- **Provenance** is the existing Marketing vocabulary, unchanged (`observed | attributed | inferred | derived | unavailable`; `COMPLETE | PARTIAL | UNAVAILABLE`). `attributed`/`inferred` keep `ATTRIBUTION_IS_NOT_CAUSAL_PROOF`. `causal_claim` is always `false`; supplying `true` is refused (`MKT_CAUSAL_CLAIM_FORBIDDEN`). `filters` are flat JSON primitives only.
- **Reserved `signal_type` examples (documentation only):** `MARKETING_MEASUREMENT`, `SOCIAL_TREND`, `SEARCH_DEMAND`, `STORE_OBSERVATION`, `REPUTATION`, `LOCAL_EVENT`, `LOST_DEMAND`.
- **Three different times — never interchangeable:**

  | Field | Answers | Rule |
  |---|---|---|
  | `observed_at` | when the thing was actually seen | optional; `≤ detected_at` |
  | `expires_at` | how long **the evidence** stays valid (freshness) | required; `> detected_at`; the only field freshness looks at |
  | `effective_window` | the period of **the phenomenon** the signal is about (an event, a season, a trend, a commercial window) | optional `{ start, end }`, strict timestamps, `end > start`; may lie in the future; never affects freshness |

  `effective_window` lets a future producer describe "a local event on 20–27 December" without bending `observed_at` (which must not be in the future) or `expires_at` (which is about the evidence, not the event). Refused with `MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW`. No producer is built.
- **Freshness:** `expires_at > detected_at`. `isMarketSignalExpired(signal, asOf)` is true when `expires_at ≤ asOf`; `marketSignalFreshness` returns `FRESH | STALE`. An expired signal stays auditable and in the context (labelled `STALE`); it is never silently fresh evidence.

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

`REFER_TO_DOMAIN` requires `target_domains` + `reason_codes` + `evidence_refs`; targets are forbidden otherwise. The target registry is closed and is **exactly the approved Level-2 domain map** of `NORDLA-CANONICAL-ARCHITECTURE.md` (no code-level registry exists, so none was duplicated), minus Marketing itself: `FINANCE, ANALYSES, SALES, INVENTORY, BUYING_SUPPLIERS, BRANDING, SALES_DEVELOPMENT, COMPLIANCE, AFTER_SALES_SERVICE`. `MARKETING` is not a destination (a problem is never referred back to the referring domain). `CUSTOMERS`, `SITE_COMMERCE`, `OPERATIONS`, `SALES_PRODUCT`, `AFTER_SALES` and `SERVICE_SUPPORT` are refused; a future need for another owner is a separate architecture decision, the canonical map is not changed here. The same registry types `data_gaps[].owner_domain`. A test checks that every entry appears in the canonical document's domain map. Domain Fit carries a diagnosis only — no lever, budget, campaign or action.

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
- Built from a `MarketingContext` (`buildMarketingFinding({ tenant, context, …fields })`): scope is taken from the context, never inferred. **Cited signal limitations travel to the Finding.**
- **Evidence freshness bound (transitive freshness).** A Finding cannot stay valid longer than the signals that support it. The *active support* is every ref that can make the Finding material or relevant — `evidence_refs`, the evidence of each materiality axis, and the evidence of the domain fit — restricted to the signals known to the context. Then:
  - `finding.expires_at ≤ min(signal.expires_at)` over those signals, else `MKT_FINDING_OUTLIVES_EVIDENCE` (equal is allowed; refs that are not context signals, such as measurement facts, impose no bound);
  - a supporting signal already expired at `created_at` (`expires_at ≤ created_at`) is refused as active proof, `MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED`. It stays visible in the context (`STALE`) and can still be cited in `contradictory_evidence_refs` — kept for audit and flagged `CITED_SIGNAL_EXPIRED` — but it can never be what makes a Finding `READY_FOR_BUILD`.
  - `contradictory_evidence_refs` never bound the Finding.
  - The check needs the context's signals, so it applies in `buildMarketingFinding`; `normalizeMarketingFinding` re-validates stored data without a context and cannot re-check it (the persistence layer must call the builder).
- **Evidence-resolution limitation (explicit).** M1 resolves only what it can see:

  | Reference | M1 behaviour |
  |---|---|
  | `MarketSignal` whose id is present in the `MarketingContext` | freshness and transitive expiry **enforced** (rules above) |
  | any other opaque evidence ref (measurement facts, domain facts, documents…) | a **trusted server-side reference**: M1 checks only its shape; its resolution and freshness are **delegated to a future Socle Evidence Registry / evidence resolver**, which does not exist yet and is not built here |

  So a Finding that cites only non-signal refs is not bounded by any expiry other than its own `expires_at`, and an unknown or stale non-signal ref is not detected by M1.
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

Lost Demand producer · Calendar/seasonality producer · Manual Observation input workflow · Social Trend / Search Demand / Store Experience / Reputation radars · Operations / Workshop data source · Customers segment source · richer Finance / Inventory contracts · persistence · Decision Ledger · Activation · Creative · STEER · Nordla Identity (trust of server-built inputs) · **Socle Evidence Registry / evidence resolver** (resolution and freshness of non-signal evidence refs).

## 15. Test coverage — mandate cases 1–131

One row per numbered case of the M1 mandate (§51–§64). Several cases share a test function when that function asserts them together; `test/marketing-understand.test.js` enforces that this table has exactly 131 rows and that every named test exists.

<!-- coverage-matrix:start -->
| Mandate case | Behaviour | Test (`test/marketing-understand.test.js` unless noted) |
|---:|---|---|
| 1 | valid signal accepted | MarketSignal: a valid signal is accepted, normalized and given a deterministic id |
| 2 | unknown key refused | MarketSignal: closed schema - unknown key, unknown class, empty/invalid type, missing source are all refused |
| 3 | unknown signal_class refused | MarketSignal: closed schema - unknown key, unknown class, empty/invalid type, missing source are all refused |
| 4 | empty signal_type refused | MarketSignal: closed schema - unknown key, unknown class, empty/invalid type, missing source are all refused |
| 5 | invalid signal_type format refused | MarketSignal: closed schema - unknown key, unknown class, empty/invalid type, missing source are all refused |
| 6 | merchant mismatch refused | MarketSignal: tenant and brand scope - merchant_id/brand_id are derived, never trusted from the caller |
| 7 | brand of another merchant refused (when resolved) | MarketSignal: tenant and brand scope - merchant_id/brand_id are derived, never trusted from the caller |
| 8 | invalid subject_refs refused | MarketSignal: subject/evidence refs are opaque tokens; duplicates collapse; limitations are kept and deduplicated |
| 9 | missing source_ref refused | MarketSignal: closed schema - unknown key, unknown class, empty/invalid type, missing source are all refused |
| 10 | evidence_refs de-duplicated | MarketSignal: subject/evidence refs are opaque tokens; duplicates collapse; limitations are kept and deduplicated |
| 11 | limitations de-duplicated | MarketSignal: subject/evidence refs are opaque tokens; duplicates collapse; limitations are kept and deduplicated |
| 12 | invalid timestamp refused | MarketSignal: timestamps need an explicit offset and a real date; expiry and observation order are enforced |
| 13 | expires_at <= detected_at refused | MarketSignal: timestamps need an explicit offset and a real date; expiry and observation order are enforced |
| 14 | fresh signal detected | MarketSignal freshness: pure helpers with an explicit clock - expired signals stay auditable and are never fresh |
| 15 | expired signal detected | MarketSignal freshness: pure helpers with an explicit clock - expired signals stay auditable and are never fresh |
| 16 | INTERNAL_MEASUREMENT never causal | MarketSignal never becomes causal, whatever its class or evidence kind |
| 17 | EXTERNAL_SIGNAL never causal | MarketSignal never becomes causal, whatever its class or evidence kind |
| 18 | MANUAL_OBSERVATION never causal | MarketSignal never becomes causal, whatever its class or evidence kind |
| 19 | signal deep-frozen | MarketSignal: deep-frozen output, caller input never mutated or frozen |
| 20 | input not mutated | MarketSignal: deep-frozen output, caller input never mutated or frozen |
| 21 | manual observation with PII field refused | MarketSignal privacy: closed schema, no customer profile or contact field can be stored |
| 22 | no email / phone / customer_name accepted | MarketSignal privacy: closed schema, no customer profile or contact field can be stored |
| 23 | no customer profile in a signal | MarketSignal privacy: closed schema, no customer profile or contact field can be stored |
| 24 | opaque refs accepted without expansion | MarketSignal: subject/evidence refs are opaque tokens; duplicates collapse; limitations are kept and deduplicated |
| 25 | canonical tenant required | MarketingContext: needs the canonical tenant and an explicit clock |
| 26 | merchant mismatch refused | MarketingContext: a brand-scoped context needs a READY Brand Context of that exact brand and merchant |
| 27 | READY Brand Context accepted | MarketingContext: a brand-scoped context needs a READY Brand Context of that exact brand and merchant |
| 28 | non-READY Brand Context refused (brand-scoped) | MarketingContext: a brand-scoped context needs a READY Brand Context of that exact brand and merchant |
| 29 | brand mismatch refused | MarketingContext: a brand-scoped context needs a READY Brand Context of that exact brand and merchant |
| 30 | merchant-wide context without brand | MarketingContext: needs the canonical tenant and an explicit clock |
| 31 | signals of another merchant refused | MarketingContext: signals of another merchant, or scoped to another brand, are refused; merchant-wide signals pass |
| 32 | context deep-frozen | MarketingContext: deep-frozen output; caller inputs never mutated |
| 33 | no input mutated | MarketingContext: deep-frozen output; caller inputs never mutated |
| 34 | phase3Inputs GATED stays gated | MarketingContext reuses phase3Inputs unchanged: a GATED conversion stays GATED, an OPEN one is consumed without recomputation |
| 35 | phase3Inputs OPEN consumed without recomputation | MarketingContext reuses phase3Inputs unchanged: a GATED conversion stays GATED, an OPEN one is consumed without recomputation |
| 36 | unknown axis refused | Materiality: closed axes and statuses |
| 37 | unknown status refused | Materiality: closed axes and statuses |
| 38 | one MATERIAL axis -> MATERIAL | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 39 | two MATERIAL axes -> MATERIAL, no score | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 40 | no MATERIAL + one UNKNOWN -> UNKNOWN | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 41 | all applicable NOT_MATERIAL -> NOT_MATERIAL | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 42 | NOT_APPLICABLE ignored | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 43 | all NOT_APPLICABLE -> UNKNOWN | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 44 | reasons / evidence preserved | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 45 | no global numeric score exposed | Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold |
| 46 | no hard-coded EUR threshold | Materiality has no hard-coded business threshold: no currency, no numeric comparison in its source |
| 47 | MARKETING_RELEVANT valid | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 48 | REFER_TO_DOMAIN requires target_domains | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 49 | REFER_TO_DOMAIN without target refused | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 50 | unknown target domain refused (closed registry) | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 51 | NO_MATERIAL_SIGNAL valid | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 52 | NOT_MEASURABLE valid | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 53 | reasons / evidence preserved | Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence |
| 54 | no execution decision included | Domain Fit carries a diagnosis only - no execution decision can be attached |
| 55 | PROBLEM valid | Finding: PROBLEM, OPPORTUNITY, NO_MATERIAL_SIGNAL and NOT_MEASURABLE are all valid and derive a deterministic id |
| 56 | OPPORTUNITY valid | Finding: PROBLEM, OPPORTUNITY, NO_MATERIAL_SIGNAL and NOT_MEASURABLE are all valid and derive a deterministic id |
| 57 | NO_MATERIAL_SIGNAL valid | Finding: PROBLEM, OPPORTUNITY, NO_MATERIAL_SIGNAL and NOT_MEASURABLE are all valid and derive a deterministic id |
| 58 | NOT_MEASURABLE valid | Finding: PROBLEM, OPPORTUNITY, NO_MATERIAL_SIGNAL and NOT_MEASURABLE are all valid and derive a deterministic id |
| 59 | unknown finding_type refused | Finding: PROBLEM, OPPORTUNITY, NO_MATERIAL_SIGNAL and NOT_MEASURABLE are all valid and derive a deterministic id |
| 60 | key `campaign` refused | Finding: closed schema - no campaign, budget, creative, final cause, score or spend can be stored |
| 61 | key `budget` refused | Finding: closed schema - no campaign, budget, creative, final cause, score or spend can be stored |
| 62 | key `creative` refused | Finding: closed schema - no campaign, budget, creative, final cause, score or spend can be stored |
| 63 | key `final_cause` refused | Finding: closed schema - no campaign, budget, creative, final cause, score or spend can be stored |
| 64 | empty statement refused | Finding: statement is required and bounded; subjects and evidence are required for PROBLEM/OPPORTUNITY |
| 65 | subject_refs rule explicit | Finding: statement is required and bounded; subjects and evidence are required for PROBLEM/OPPORTUNITY |
| 66 | evidence_refs required for PROBLEM / OPPORTUNITY | Finding: statement is required and bounded; subjects and evidence are required for PROBLEM/OPPORTUNITY |
| 67 | contradictory evidence kept | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 68 | limitations kept | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 69 | data gaps kept | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 70 | invalid created_at refused | Finding: window and expiry are validated |
| 71 | expires_at <= created_at refused | Finding: window and expiry are validated |
| 72 | Finding deep-frozen | Finding: deep-frozen output, caller input never mutated, JSON round-trip is stable |
| 73 | input not mutated | Finding: deep-frozen output, caller input never mutated, JSON round-trip is stable |
| 74 | statement never parsed as business data | Finding: the statement is free text for humans - the engine never reads it to decide anything |
| 75 | valid IS entry | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 76 | valid IS NOT entry | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 77 | empty dimension refused | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 78 | empty value refused | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 79 | evidence refs attachable to an entry | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 80 | IS / IS NOT never becomes a hypothesis | Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved |
| 81 | valid embedded hypothesis | CandidateHypothesis exists only inside a Finding and keeps refs, unknowns and testability |
| 82 | standalone hypothesis impossible publicly | CandidateHypothesis exists only inside a Finding and keeps refs, unknowns and testability |
| 83 | empty statement refused | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 84 | empty mechanism refused | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 85 | supporting refs kept | CandidateHypothesis exists only inside a Finding and keeps refs, unknowns and testability |
| 86 | contradicting refs kept | CandidateHypothesis exists only inside a Finding and keeps refs, unknowns and testability |
| 87 | unknowns kept | CandidateHypothesis exists only inside a Finding and keeps refs, unknowns and testability |
| 88 | invalid testability refused | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 89 | TESTABLE_NOW accepted | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 90 | TESTABLE_LATER accepted | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 91 | NOT_TESTABLE accepted | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 92 | UNKNOWN accepted | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 93 | CONFIRMED refused | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 94 | PROVEN / FACT refused | CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation |
| 95 | no machine causal claim | A mechanism stays a candidate: no output of any M1 function ever contains causal_claim=true |
| 96 | before expiry = FRESH | Finding freshness uses an explicit clock only: FRESH before expiry, STALE at and after |
| 97 | at expiry = STALE | Finding freshness uses an explicit clock only: FRESH before expiry, STALE at and after |
| 98 | after expiry = STALE | Finding freshness uses an explicit clock only: FRESH before expiry, STALE at and after |
| 99 | explicit clock only | Finding freshness uses an explicit clock only: FRESH before expiry, STALE at and after |
| 100 | no implicit Date.now | No implicit clock or randomness anywhere in the M1 engine |
| 101 | PROBLEM + MATERIAL + RELEVANT + FRESH -> READY | Readiness: READY_FOR_BUILD only for a fresh, material, marketing-relevant PROBLEM/OPPORTUNITY |
| 102 | OPPORTUNITY, same conditions -> READY | Readiness: READY_FOR_BUILD only for a fresh, material, marketing-relevant PROBLEM/OPPORTUNITY |
| 103 | REFER_TO_DOMAIN -> REFER_TO_DOMAIN | Readiness: every other route, with the documented precedence STALE > REFER > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY |
| 104 | NOT_MEASURABLE -> NOT_MEASURABLE | Readiness: every other route, with the documented precedence STALE > REFER > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY |
| 105 | NOT_MATERIAL -> NO_MATERIAL_SIGNAL | Readiness: every other route, with the documented precedence STALE > REFER > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY |
| 106 | expired -> STALE | Readiness: every other route, with the documented precedence STALE > REFER > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY |
| 107 | STALE has priority over READY | Readiness: every other route, with the documented precedence STALE > REFER > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY |
| 108 | no READY route if Marketing is not relevant | Readiness: a Finding is never READY when Marketing is not the relevant domain, whatever else it says |
| 109 | no API returns causal_claim true | A mechanism stays a candidate: no output of any M1 function ever contains causal_claim=true |
| 110 | attributed evidence keeps ATTRIBUTION_IS_NOT_CAUSAL_PROOF | MarketSignal never becomes causal, whatever its class or evidence kind |
| 111 | inferred evidence keeps its causal limitation | MarketSignal never becomes causal, whatever its class or evidence kind |
| 112 | external signal never promoted to causal fact | MarketSignal never becomes causal, whatever its class or evidence kind |
| 113 | hypothesis with mechanism stays candidate | A mechanism stays a candidate: no output of any M1 function ever contains causal_claim=true |
| 114 | no margin computation | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 115 | no stock computation | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 116 | no customer-profile logic | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 117 | no Creative call | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 118 | no Brand Guardian call | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 119 | no publish function | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 120 | no spend function | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 121 | no price-change function | Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic |
| 122 | phase3Inputs OPEN still works | MarketingContext reuses phase3Inputs unchanged: a GATED conversion stays GATED, an OPEN one is consumed without recomputation |
| 123 | phase3Inputs GATED returns no traffic number | MarketingContext reuses phase3Inputs unchanged: a GATED conversion stays GATED, an OPEN one is consumed without recomputation |
| 124 | search observations stay not_a_conversion_input | MarketingContext: measurement of another merchant is refused; search facts stay observations |
| 125 | causal_claims:false invariant | Existing Marketing Measurement is untouched: report document, gates, provenance, search observations |
| 126 | existing marketing report test stays green | test/marketing.test.js (existing suite, unchanged) |
| 127 | two merchants cannot mix signals | MarketingContext: signals of another merchant, or scoped to another brand, are refused; merchant-wide signals pass |
| 128 | two brands of one merchant keep distinct signals | MarketingContext: signals of another merchant, or scoped to another brand, are refused; merchant-wide signals pass |
| 129 | brand Finding cannot use another brand's signal | Finding scope comes from the MarketingContext: tenant and brand are explicit, never inferred |
| 130 | merchant-wide signal usable in the same merchant's context | MarketingContext: signals of another merchant, or scoped to another brand, are refused; merchant-wide signals pass |
| 131 | no brand_id is invented | MarketSignal: tenant and brand scope - merchant_id/brand_id are derived, never trusted from the caller |
<!-- coverage-matrix:end -->
