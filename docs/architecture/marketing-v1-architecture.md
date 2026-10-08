# Nordla — Marketing V1 Architecture

- **Status:** APPROVED WORKING ARCHITECTURE — M1 COMPLETE · M1.5 COMPLETE
- **Date:** 2026-10-08
- **Canonical sequence:** `UNDERSTAND → BUILD → CREATE → STEER`
- **Scope:** Marketing core + reserved specialized intelligences
- **Build status:** M1 = **COMPLETE**. M1.5 = **COMPLETE**. Current build target = **M2 — BUILD** (not started; waits for the next architect mandate).

## 0. Architectural rules

Marketing must respect the frozen Nordla decisions:

- Marketing proposes; Socle arbitrates final company decisions.
- `DO_NOTHING`, `TEST_SMALL` and `NOT_MEASURABLE` are first-class outcomes.
- Material business numbers are calculated by deterministic code.
- Attribution is not causality.
- Branding, Creative Intelligence, Sales Development, Customers, Finance, Inventory and Operations remain separate domains.
- Marketing references external truths; it does not duplicate their ownership.
- HABB is client zero / configuration, never generic architecture.

## 1. Existing capability — reuse, do not rebuild

The existing `src/marketing/*` measurement layer remains the factual measurement substrate for UNDERSTAND.

It already provides:

- last-recorded-visit attribution;
- channel facts;
- landing facts;
- product/category/collection facts;
- campaign concentration;
- traffic facts;
- conversion gates;
- paid readiness;
- CPC / CTR;
- ROAS / CAC gates;
- profit-after-ad-spend gate;
- search visibility;
- query/page facts;
- data-quality issues;
- provenance;
- `COMPLETE / PARTIAL / UNAVAILABLE`;
- `causal_claims: false`;
- Phase 3 gating of consumable measurement facts.

Invariant:

> **ATTRIBUTED ≠ INCREMENTAL ≠ CAUSAL.**

---

# 2. Consolidated Marketing tree

```text
NORDLA MARKETING
│
├── SIGNAL INPUT LAYER
│   │
│   ├── Existing Marketing Measurement
│   ├── Sales facts
│   ├── Inventory / Fulfillment facts or verdicts
│   ├── Finance facts or verdicts
│   ├── Operational Capacity facts or verdicts
│   ├── Customer segment refs
│   ├── Product / Offer refs
│   ├── Calendar / seasonality
│   │
│   └── MarketSignal[]
│       ├── INTERNAL_MEASUREMENT
│       ├── EXTERNAL_SIGNAL
│       └── MANUAL_OBSERVATION
│
│       Signal producers:
│       ├── Social Trend Radar                  [RESERVED]
│       ├── Search Demand Radar                 [RESERVED]
│       ├── Store Experience Intelligence       [RESERVED]
│       ├── Reputation & Review Intelligence    [RESERVED]
│       ├── Local Event / Occasion Radar
│       ├── Lost Demand
│       └── future signal producers
│
├── 1. UNDERSTAND
│   │
│   ├── Fact / Signal Aggregation
│   ├── Freshness & expiry
│   ├── Materiality Assessment
│   ├── Domain Fit
│   │   ├── MARKETING_RELEVANT
│   │   ├── REFER_TO_DOMAIN
│   │   ├── NO_MATERIAL_SIGNAL
│   │   └── NOT_MEASURABLE
│   │
│   └── MarketingFinding
│       ├── PROBLEM / OPPORTUNITY
│       ├── what / where / when / how much
│       ├── IS / IS NOT
│       ├── evidence
│       ├── contradictory evidence
│       ├── limitations
│       ├── data gaps
│       ├── expires_at
│       └── CandidateHypothesis[]
│
├── 2. BUILD
│   │
│   ├── Lever Fitness
│   │   ├── why this lever
│   │   ├── why not alternatives
│   │   ├── lead-time fit
│   │   └── hard constraints
│   │
│   ├── Lever Candidates
│   │   ├── DO_NOTHING
│   │   ├── TEST_SMALL
│   │   ├── VISIBILITY
│   │   ├── OFFER
│   │   ├── CRM_LIFECYCLE
│   │   ├── SEARCH_LOCAL
│   │   └── PAID_ACQUISITION
│   │
│   ├── MarketingPushProposal
│   │   ├── objective
│   │   ├── finding_ref
│   │   ├── hypothesis_ref?
│   │   ├── audience_ref / non-executable audience_definition
│   │   ├── lever
│   │   ├── channels
│   │   ├── lead_time
│   │   ├── valid_execution_window
│   │   ├── ResourceRequirements
│   │   ├── claim_refs
│   │   ├── policy_requirements
│   │   ├── risks
│   │   ├── unknowns
│   │   ├── reversibility
│   │   └── MeasurementPlan
│   │
│   └── Socle Decision Package
│       ├── Option A
│       ├── Option B
│       ├── TEST_SMALL
│       └── DO_NOTHING
│
├── SOCLE
│   ├── company decision
│   ├── contact-pressure policy
│   ├── capacity / queue arbitration
│   ├── policy / compliance
│   └── execution authorization
│
├── 3. CREATE
│   │
│   └── CreativeBrief
│       ↓
│     Creative Intelligence
│       ↓
│     Creative Fidelity
│       ↓
│     Brand Guardian
│       ↓
│     Activation Manifest
│
└── 4. STEER
    ├── MarketingRun
    ├── online attributed result
    ├── offline attributed result
    ├── incremental result only when eligible
    ├── INCREMENTALITY_UNTESTABLE
    ├── MarketingLearning
    └── Follow-up Proposal
        ├── PROPOSE_CONTINUE
        ├── PROPOSE_STOP
        ├── PROPOSE_ADJUST
        ├── PROPOSE_SCALE
        ├── PROPOSE_TEST_AGAIN
        └── DO_NOTHING
            ↓
          Socle
```

---

# 3. MarketSignal — common signal envelope

Do not create a separate top-level contract for every radar.

All specialized signal producers feed UNDERSTAND through one common envelope.

Conceptual V1 shape:

```text
MarketSignal
├── signal_id
├── merchant_id
├── brand_id?
├── signal_class
│   ├── INTERNAL_MEASUREMENT
│   ├── EXTERNAL_SIGNAL
│   └── MANUAL_OBSERVATION
├── signal_type
├── subject_refs[]
├── source_ref
├── detected_at
├── observed_at?
├── expires_at
├── locale?
├── market?
├── evidence_refs[]
├── limitations[]
└── provenance
```

Important:

- `INTERNAL_MEASUREMENT` is not automatically causal truth.
- `EXTERNAL_SIGNAL` is never treated as a fact about the merchant.
- `MANUAL_OBSERVATION` is traceable but not automatically statistical proof.
- Every signal has freshness / expiry.
- Specialized producers may have typed payloads, but they do not invent new top-level signal semantics.

---

# 4. Specialized intelligences — reserved architecture

These capabilities are reserved now so they cannot be forgotten, but they do not block M1.

## 4.1 Social Trend Radar — RESERVED

Purpose:

- detect emerging social topics;
- formats;
- sounds;
- products/categories;
- vocabulary;
- velocity;
- persistence;
- locale/market relevance.

Output:

```text
MarketSignal
signal_class = EXTERNAL_SIGNAL
signal_type = SOCIAL_TREND
```

A social trend never directly authorizes spend, stock purchase or execution.

## 4.2 Search Demand Radar — RESERVED

Purpose:

- detect query acceleration;
- local search demand;
- seasonal changes;
- emerging product/category interest.

Output:

```text
MarketSignal
signal_class = EXTERNAL_SIGNAL
signal_type = SEARCH_DEMAND
```

Existing Search Console measurement remains part of the current factual measurement layer.

## 4.3 Store Experience Intelligence — RESERVED

Purpose:

- storefront / window visibility;
- in-store visual hierarchy;
- merchandising;
- hot/cold zones;
- signage / PLV;
- product placement;
- physical customer flow;
- planogram-lite observations.

Output:

```text
MarketSignal
signal_type = STORE_OBSERVATION
```

or a later specialized `StoreProposal` consumed by BUILD.

Store Experience does not make final execution decisions.

## 4.4 Reputation & Review Intelligence — RESERVED

Purpose:

- repeated complaints;
- repeated praise;
- reputation changes;
- review themes.

It routes issues either to Marketing or to the real owning domain through `REFER_TO_DOMAIN`.

## 4.5 Local Event / Occasion signals

Calendar / occasion context can be lightweight in V1.

Examples:

- public holidays;
- local events;
- school calendar;
- commercial occasions;
- seasonal windows.

## 4.6 Lost Demand

Examples:

- zero-result site search;
- repeated request for unavailable product;
- product interest while unavailable;
- repeated manual customer request.

Output:

```text
MarketSignal
signal_type = LOST_DEMAND
```

---

# 5. UNDERSTAND — M1 target

## 5.1 Marketing Context

Marketing consumes read-only facts / refs from owning domains.

It may consume typed values when owners expose them, for example:

- `available_units`;
- `unit_margin`;
- `coverage_days`;
- `capacity_window`.

It must not recalculate or become the source of truth for those domains.

## 5.2 Materiality Assessment

Do not use one universal score.

Visible axes:

```text
economic_materiality
customer_materiality
strategic_materiality
risk_materiality
operational_materiality
```

Possible synthesis:

```text
MATERIAL
NOT_MATERIAL
UNKNOWN
```

with explicit reasons.

No hard-coded universal € threshold.

## 5.3 Domain Fit

Marketing must be able to conclude:

```text
MARKETING_RELEVANT
REFER_TO_DOMAIN
NO_MATERIAL_SIGNAL
NOT_MEASURABLE
```

Examples of target domains:

- Inventory;
- Finance;
- Customers;
- Sales / Product;
- Site / Commerce;
- Operations;
- Sales Development;
- Branding.

## 5.4 MarketingFinding

A Finding describes an observable problem or opportunity.

It never contains a final causal claim, campaign, budget or creative execution.

Conceptual shape:

```text
MarketingFinding
├── finding_id
├── merchant_id
├── brand_id?
├── finding_type
│   ├── PROBLEM
│   ├── OPPORTUNITY
│   ├── NO_MATERIAL_SIGNAL
│   └── NOT_MEASURABLE
├── subject_refs[]
├── statement
├── scope
├── window
├── baseline_ref?
├── observed_change?
├── evidence_refs[]
├── contradictory_evidence_refs[]
├── limitations[]
├── data_gaps[]
├── is[]
├── is_not[]
├── materiality
├── domain_fit
├── expires_at
└── hypotheses: CandidateHypothesis[]
```

## 5.5 CandidateHypothesis

A separate typed contract embedded in Finding V1.

```text
CandidateHypothesis
├── hypothesis_id
├── statement
├── mechanism
├── supporting_evidence_refs[]
├── contradicting_evidence_refs[]
├── unknowns[]
├── testability
└── status
```

It is never a FACT merely because a model produced it.

---

# 6. BUILD — reserved contract direction

## 6.1 Lever Fitness

A lever is not selected only because it is available.

Evaluate:

- why this lever;
- why alternatives were rejected;
- operational compatibility;
- financial compatibility;
- lead-time compatibility;
- audience compatibility;
- risk;
- reversibility.

## 6.2 ResourceRequirements

This must be designed into the Push contract from the start.

```text
ResourceRequirements
├── cash?
├── human_time?
├── operational_capacity_refs[]
├── inventory_requirements[]
├── creative_capacity?
├── contact_capacity?
└── other_requirements[]
```

Marketing declares requirements. Owning domains / Socle determine availability.

## 6.3 Lead time

Every actionable lever must eventually expose:

```text
estimated_lead_time
valid_execution_window
```

An opportunity can be valid but no longer executable in time.

## 6.4 Policy / compliance requirements

A Push may include:

```text
claim_refs[]
policy_requirements[]
consent_requirements[]
promotion_rule_refs[]
```

Marketing does not decide legal/compliance validity.

---

# 7. CREATE boundaries

Marketing owns the brief, not artistic execution.

```text
Marketing
→ CreativeBrief
→ Creative Intelligence
→ Creative Fidelity
→ Brand Guardian
→ Activation Manifest
```

Important:

Brand Guardian outcomes are not binary only.

```text
PASS
FAIL
REVIEW_REQUIRED
NOT_MEASURABLE
```

Creative Fidelity remains a separate owner of product-fidelity truth and feeds Brand Guardian through the established external-gate architecture.

---

# 8. STEER direction

STEER is not just analytics.

It must preserve the distinctions:

```text
OBSERVED_CHANGE
ATTRIBUTED_RESULT
OFFLINE_ATTRIBUTED_RESULT
INCREMENTAL_RESULT
INCREMENTALITY_UNTESTABLE
```

No incremental claim is allowed without an eligible measurement design.

Low-volume businesses must receive honest outputs rather than false statistical certainty.

## 8.1 MarketingLearning

STEER can produce an expiring learning record:

```text
MarketingLearning
├── finding_ref
├── hypothesis_ref?
├── push_ref
├── run_ref
├── outcome
├── evidence_refs[]
├── learned_at
├── valid_until / expires_at
└── limitations[]
```

Purpose:

- avoid immediately retesting a recently refuted hypothesis;
- preserve what was learned;
- allow learning to expire when context changes.

---

# 9. Offline attribution — reserved

Physical retail must not be invisible.

Reserve support for:

- campaign QR;
- promo code;
- short URL;
- POS campaign marker;
- coupon/reference;
- "how did you hear about us?" observation.

These may produce:

```text
OFFLINE_ATTRIBUTED_RESULT
```

They are still attribution, not causal proof.

---

# 10. Shared Socle responsibilities

The following are not owned by Marketing:

## Contact pressure

Cross-channel/customer pressure is a Socle / policy concern because contacts may come from Marketing, Sales Development and automations.

Marketing declares intended contact:

```text
audience_ref
channel
timing
priority
```

Socle checks pressure, consent and competing contacts.

## Capacity / queue

Marketing declares `ResourceRequirements`.

Operations and other domains expose availability.

Socle arbitrates competing work.

## Activation

Marketing eventually emits an `ActivationManifest`.

Execution belongs to a shared governed execution layer.

---

# 11. Capabilities intentionally deferred

Do not build now:

- competitor radar;
- creative fatigue engine;
- creator discovery;
- next-best-product engine;
- complex journey orchestration;
- large-scale competitor ad surveillance;
- advanced geo-lift;
- heavy multi-touch attribution;
- autonomous media buying.

Journey orchestration is **DEFERRED**, not permanently rejected.

---

# 12. M1 build scope

The first Marketing construction phase is intentionally small:

```text
M1 — UNDERSTAND FOUNDATION

MarketSignal contract
+
MarketingContext contract
+
Materiality Assessment
+
Domain Fit
+
MarketingFinding
+
CandidateHypothesis
+
Freshness / expiry
+
REFER_TO_DOMAIN
```

Not in M1:

- Push Proposal;
- Creative Brief;
- Activation;
- full Experiment engine;
- STEER;
- Social Trend Radar implementation;
- Store Experience implementation;
- Reputation implementation.

---

# 13. M1.5 follow-up

**Status: COMPLETE** — see [`marketing-m1-5-signal-producers.md`](./marketing-m1-5-signal-producers.md). M1 is COMPLETE and was not changed by M1.5.

After M1:

```text
Lost Demand signal producer
+
Calendar / seasonality producer
+
Manual Observation input
```

These validate that the `MarketSignal` envelope works across different signal sources before larger specialized intelligences are implemented.

---

# 14. M2 and later

## M2 — BUILD

```text
Lever Fitness
MarketingPushProposal
ResourceRequirements
Lead-time fit
MeasurementPlan
Socle Decision Package
```

## M3 — CREATE

```text
CreativeBrief
Creative Intelligence handoff
Creative Fidelity handoff
Brand Guardian handoff
ActivationManifest contract
```

## M4 — STEER

```text
MarketingRun
Attribution / incremental eligibility
Offline attribution
MarketingLearning
Follow-up proposals
```

---

# 15. Architectural goal

The architecture must remain open to future specialized intelligence without rebuilding the Marketing core.

A future radar should be able to do:

```text
new specialized intelligence
→ MarketSignal
→ UNDERSTAND
```

without introducing a new top-level Marketing architecture.

That is the primary extensibility rule for Marketing V1.
