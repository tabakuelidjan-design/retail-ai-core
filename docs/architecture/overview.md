# Architecture Overview

## Pipeline

```
DATA
  → DATA QUALITY
  → METRICS
  → RULES / DECISION ENGINE
  → LLM EXPLANATION
  → HUMAN DECISION
  → DECISION LEDGER
  → FUTURE OUTCOME TRACKING
```

- **DATA** — raw ingestion from source systems (Shopify Admin API in V1, read-only). Stored close to source shape.
- **DATA QUALITY** — every ingested record passes the checks defined in the `data-quality-rules` Skill before it is trusted by anything downstream. Failures are recorded, not silently fixed.
- **METRICS** — deterministic SQL/code computes the metrics defined in the `retail-metrics` Skill. The LLM never computes a metric value itself.
- **RULES / DECISION ENGINE** — deterministic business rules evaluate metrics and data-quality state to produce candidate findings/recommendations. Not built yet (explicitly deferred past Phase 0).
- **LLM EXPLANATION** — the LLM narrates and contextualizes what the deterministic layers produced. It explains; it does not calculate or invent figures.
- **HUMAN DECISION** — a person reviews the explanation and evidence, then approves, rejects, or modifies the proposed action. No consequential action happens without this step.
- **DECISION LEDGER** — every human decision is recorded with the evidence that informed it (which metrics, which data-quality state, which explanation).
- **FUTURE OUTCOME TRACKING** — decisions are later compared against what actually happened, closing the loop for future recommendations.

## Layering: generic core vs. vertical vs. merchant

```
retail-ai-core/
  (generic core — orders, products, inventory, refunds, core metrics, data quality, decision ledger)
  + vertical modules (opt-in per merchant: e.g. "has in-house production/customization")
  + config/merchants/<merchant>/ (data only — no code)
```

A merchant like HABB (in-house UV printing/personalization) opts into a "has production" vertical module and supplies its cost data via `config/merchants/habb/`. A merchant that simply buys and resells finished goods (e.g. a pure resale clothing store) never touches that vertical module and needs no production-cost config at all. The generic core must function correctly for both.

## Current phase (Phase 0)

Only this document, the Supabase schema *proposal* (not yet applied), the three V1 Skills, and the security/data-quality docs exist. No sync code, no metrics engine, no decision engine, no dashboard, and no LLM-facing product surface have been built yet — those are explicitly out of scope until approved in a later phase.
