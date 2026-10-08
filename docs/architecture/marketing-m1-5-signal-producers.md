# Nordla — Marketing M1.5 · Signal Producers

- **Status:** IMPLEMENTED LOCALLY / UNDER AUDIT — not pushed, not COMPLETE until audited
- **Builds on:** [`marketing-m1-understand-contract.md`](./marketing-m1-understand-contract.md) (M1 = COMPLETE, unchanged)
- **Parent architecture:** [`marketing-v1-architecture.md`](./marketing-v1-architecture.md) §13
- **Code:** `src/marketing/{signal-producer,lost-demand,calendar-signals,manual-observation}.js`
- **Tests:** `test/marketing-m1-5.test.js`
- **CI:** `.github/workflows/marketing-v1.yml`

M1.5 proves that the M1 `MarketSignal` envelope can receive sources of very different nature **without changing the UNDERSTAND core**:

| Producer | Nature | Class | Signal types |
|---|---|---|---|
| Lost Demand | deterministic internal demand that could not be served | `INTERNAL_MEASUREMENT` | `LOST_DEMAND_ZERO_RESULT_SEARCH`, `LOST_DEMAND_UNAVAILABLE_PRODUCT_INTEREST`, `LOST_DEMAND_OUT_OF_STOCK_INTEREST` |
| Calendar / Seasonality | time-bounded phenomenon from the outside world | `EXTERNAL_SIGNAL` | `CALENDAR_LOCAL_EVENT`, `CALENDAR_SEASONAL_WINDOW`, `CALENDAR_COMMERCIAL_OCCASION` |
| Manual Observation | traced human observation | `MANUAL_OBSERVATION` | `MANUAL_<OBSERVATION_TYPE>` |

```text
producer-specific trusted input
        ↓  producer (pure adapter, validates its own requirements)
   buildMarketSignal            ← the one canonical constructor (M1)
        ↓
     MarketSignal
        ↓
   MarketingContext → Materiality → Domain Fit → MarketingFinding → readiness   (unchanged M1)
```

## 1. What a producer is — and is not

A producer **receives** a resolved tenant (and optionally a resolved Brand Identity) plus a **closed, structured input**; **validates** it; **maps** its kind to a fixed `signal_class` / `signal_type`; and **calls `buildMarketSignal`**. It returns an ordinary `MarketSignal`.

It never: writes to a database; takes a decision; builds a Finding; evaluates readiness; recommends, budgets, publishes, sends or buys; calls a network, LLM or model; reads the clock. There is **no producer-specific id** (`lost_demand_id`, `calendar_signal_id`, `manual_obs_id` do not exist): the deterministic `signal_id` of the canonical signal is the only identity passed to UNDERSTAND. No `MarketSignalV2`, no `LostDemandFinding`, no new materiality / domain-fit / provenance model.

Because every output goes through `buildMarketSignal`, it inherits — and nothing is rebuilt locally — deep freeze, deterministic id, tenant/brand isolation, timestamp normalization, provenance (`causal_claim: false`), class limitation, freshness semantics.

### Trust boundary

Producer input must come from a **trusted server-side adapter or a validated operator workflow**. M1.5 performs no authentication, no identity proof, no connector authorization and no cryptographic evidence verification. A raw client payload must never be handed to a producer on a real execution path. (Open dependency: Nordla Identity, Socle Evidence Registry.)

### Common input (closed schema — unknown keys are refused, `MKT_UNKNOWN_KEY`)

```text
subject_refs[]  source_ref  evidence_refs[]
detected_at  observed_at?  expires_at  effective_window?  locale?  market?
limitations[]  provenance
+ one producer-specific key: kind (Lost Demand, Calendar) | observation_type (Manual)
```

`merchant_id`, `brand_id`, `signal_id`, `signal_class`, `signal_type`, and any `campaign`, `budget`, `recommendation`, `stock_to_buy`, `expected_revenue`, `score`, `action`, `text`, `notes`… are **not accepted**. Tenant and brand come from the resolved tenant / Brand Identity passed as arguments; `brand_id` is never inferred (merchant-wide stays merchant-wide, brand-scoped stays brand-scoped).

### The four times (M1 contract, restated)

| Field | Meaning |
|---|---|
| `observed_at` | when the thing was observed (`≤ detected_at`) |
| `detected_at` | when Nordla received / detected it |
| `expires_at` | until when **the evidence** stays valid — the only field freshness uses |
| `effective_window` | when **the phenomenon** takes place; may lie in the future; never affects freshness |

Every timestamp is an explicit input (ISO-8601 with offset, real calendar date). No function in M1.5 uses `Date.now()` or `new Date()`.

## 2. Lost Demand — `produceLostDemandSignal`

Purpose: a demand that was observed but could not be satisfied or found. **It produces a signal only.** It never says "stock this", "buy N units" or "launch a campaign", counts nothing, aggregates nothing and invents no number: a trusted adapter supplies an already-aggregated record whose magnitude stays in the cited evidence until a Socle Evidence Registry exists.

- **Kinds (exactly three):** `ZERO_RESULT_SEARCH`, `UNAVAILABLE_PRODUCT_INTEREST`, `OUT_OF_STOCK_INTEREST`. Human requests are **not** a Lost Demand kind: they go through Manual Observation.
- **Mapping:** `kind` → `signal_type` `LOST_DEMAND_<KIND>` (constant `LOST_DEMAND_SIGNAL_TYPE`), so no consumer parses `source_ref` to learn the type. Class is always `INTERNAL_MEASUREMENT`.
- **Required:** ≥ 1 `subject_ref` (`MKT_LOST_DEMAND_SUBJECT_REQUIRED`, e.g. `query://…`, `product://…`, `category://…`; not resolved here) and ≥ 1 `evidence_ref` (`MKT_LOST_DEMAND_EVIDENCE_REQUIRED`: a demand signal without an auditable source never enters UNDERSTAND). Unknown kind → `MKT_LOST_DEMAND_INVALID_KIND`.
- **No inventory inference:** the producer neither reads nor computes stock. `OUT_OF_STOCK_INTEREST` means *the owning source states that the observed interest concerned an unavailable object*.
- `effective_window` optional.

## 3. Calendar / Seasonality — `produceCalendarSignal`

Purpose: represent a time-bounded phenomenon relevant to Marketing from a record already supplied by a future adapter. No calendar is downloaded, no holiday hardcoded, no Google Calendar / weather / event API called, no marketing text or recommendation generated.

- **Kinds:** `LOCAL_EVENT`, `SEASONAL_WINDOW`, `COMMERCIAL_OCCASION`.
- **Mapping:** `CALENDAR_<KIND>`; class always `EXTERNAL_SIGNAL` (context from the outside world, never a fact about the merchant; a planned event is **not** bent into `MANUAL_OBSERVATION`). A future internal merchant calendar would get its own producer.
- **`effective_window {start,end}` is required** (`MKT_CALENDAR_EFFECTIVE_WINDOW_REQUIRED`), strict timestamps, `end > start` (`MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW` from the M1 constructor). It may be in the future. `expires_at` is independent: an event in December can have evidence that expires in October.
- **Required:** ≥ 1 `subject_ref`, ≥ 1 `evidence_ref` (`MKT_CALENDAR_SUBJECT_REQUIRED`, `MKT_CALENDAR_EVIDENCE_REQUIRED`). `locale` / `market` propagate to the signal.

## 4. Manual Observation — `produceManualObservationSignal`

Purpose: let a small shop or workshop feed UNDERSTAND with a **traced human observation**. It stores no profile and no prose.

- **Class:** always `MANUAL_OBSERVATION`, so the M1 envelope attaches `MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF` automatically — qualitative evidence, never statistical proof.
- **`observation_type`:** an extensible UPPER_SNAKE token (not a closed business list); the signal type is `MANUAL_<OBSERVATION_TYPE>` (≤ 64 characters in all). Missing → `MKT_MANUAL_OBSERVATION_TYPE_REQUIRED`; invalid (lower case, spaces, > 57 characters, repeating the `MANUAL_` prefix) → `MKT_MANUAL_OBSERVATION_INVALID_TYPE`. The tests' `PRODUCT_REQUEST`, `STORE_HESITATION`, `SERVICE_QUESTION` are examples, not an HABB taxonomy.
- **Required:** `observed_at` (`MKT_MANUAL_OBSERVATION_OBSERVED_AT_REQUIRED`; `observed_at ≤ detected_at` is enforced by the M1 constructor), ≥ 1 `subject_ref`, ≥ 1 `evidence_ref` (a server-side reference to a manual-observation record, store log or operator note record — **its persistence is not built here**).
- **Privacy by construction** (no PII detector — the schema is closed and there is no free-text field):
  - `customer_name`, `email`, `phone`, `address`, `note`, `comment`, `transcript`, `conversation`… do not exist: such keys are refused;
  - refs are opaque tokens (no space, `@`, `?`, `&`);
  - `limitations` and `provenance.limitations` are **stable UPPER_SNAKE codes, not sentences**;
  - `provenance.source_system` is an opaque reference and `provenance` accepts only `source_system`, `completeness`, `evidence_kind`, `limitations` (no `filters`, `attribution_model`, `source_fields`, `window`), so nothing free-form can ride along.
  The detailed human description belongs to a future server-side record that `evidence_refs` points to — never to the `MarketSignal`.

## 5. Composition with M1

- The three outputs enter `buildMarketingContext({ marketSignals })` alone or mixed; the unchanged M1 context enforces tenant/brand scope (a brand signal only in its own brand's context; a merchant-wide signal in any brand of the same merchant) and labels a signal `STALE` when `expires_at ≤ as_of`.
- A `MarketingFinding` may cite a producer signal by its `signal_id` in `evidence_refs`. The M1 **evidence freshness bound** applies unchanged: `finding.expires_at ≤ min(supporting signal.expires_at)` (`MKT_FINDING_OUTLIVES_EVIDENCE`); a signal expired at `created_at` is refused as active proof (`MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED`) but may be cited as contradictory evidence (flagged `CITED_SIGNAL_EXPIRED`). The caveats of the producer's class travel to the Finding.
- **No producer ever creates a Finding or reaches `READY_FOR_BUILD`.** A Finding is built explicitly, with its own materiality and domain fit; readiness remains a gate over that Finding. A signal alone proves nothing (`MarketSignal ≠ company truth by default`, `External signal ≠ authorization`, `Manual observation ≠ statistical proof`).

## 6. Causal boundary & authority

`ATTRIBUTION ≠ CAUSALITY` is untouched: provenance `causal_claim` is always `false` (supplying `true` is refused), attributed/inferred evidence keeps `ATTRIBUTION_IS_NOT_CAUSAL_PROOF`. The producers expose no function to publish, send, buy ads, change a price or a stock level, approve spend or execute anything.

## 7. Error codes

Producer-specific (`PRODUCER_ERROR` in `signal-producer.js`, thrown as `MarketingUnderstandError`): `MKT_LOST_DEMAND_{INVALID_KIND,SUBJECT_REQUIRED,EVIDENCE_REQUIRED}`, `MKT_CALENDAR_{INVALID_KIND,EFFECTIVE_WINDOW_REQUIRED,SUBJECT_REQUIRED,EVIDENCE_REQUIRED}`, `MKT_MANUAL_OBSERVATION_{TYPE_REQUIRED,INVALID_TYPE,OBSERVED_AT_REQUIRED,SUBJECT_REQUIRED,EVIDENCE_REQUIRED}`. Every other condition keeps its existing M1 code (`MKT_UNKNOWN_KEY`, `MKT_INVALID_FIELD`, `MKT_INVALID_TIMESTAMP`, `MKT_SIGNAL_*`, `MKT_TENANT_INVALID`, `MKT_CAUSAL_CLAIM_FORBIDDEN`…) — no code is duplicated and no M1 file was modified for them.

## 8. Non-goals (not built)

`MarketingPushProposal`, Lever Fitness, `ResourceRequirements`, experiment engine, `CreativeBrief`, `ActivationManifest`, `MarketingRun`, `MarketingLearning`, offline attribution, Social Trend / external Search Demand / Store Experience / Reputation / Competitor radars, Creative Fatigue, Creator Discovery, Next Best Product, journey orchestration, publication, ad buying, migrations, persistent signal tables, UI, scheduler, automation, LLM/VLM calls, web scraping, social APIs, Google Calendar / weather / holiday connectors.

## 9. Open dependencies (not resolved here)

Socle Evidence Registry · signal persistence · Manual Observation persistence / UI · site-search adapter · inventory availability adapter · calendar connector · holiday provider · local-event provider · Social Trend Radar · external Search Demand Radar · Store Experience Intelligence · Reputation Intelligence · Identity / authentication · Decision Ledger · M2 BUILD.

## 10. Deviations & choices (documented)

1. **Manual Observation is stricter than the bare M1 envelope**: `limitations` and `provenance.limitations` are UPPER_SNAKE codes, and `provenance` is restricted to four keys with an opaque `source_system`. M1 allows free-text limitations (≤ 300 characters) and a free-text `source_system`; for a *human* observation that would be a place to smuggle a name or a remark, so this producer closes it. M1 itself is unchanged.
2. **Producer-specific error codes live in `signal-producer.js`**, not in `MKT_ERROR`, so that no M1 file is modified.
3. **No barrel file**: each producer is imported from its own module; `understand.js` (M1 public surface) is not changed.
4. **`observation_type` and `kind` are matched case-sensitively** against the closed list / token pattern; `Object.hasOwn` prevents inherited property names from passing as a kind.
