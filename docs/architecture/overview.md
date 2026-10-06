# Nordla Architecture Overview

> Current architecture summary. For authoritative detail, read:
> - `NORDLA-CANONICAL-ARCHITECTURE.md`
> - `NORDLA-DECISION-REGISTER.md`
> - `NORDLA-DEFERRED.md`

## Operating model

```
ENTERPRISE
  → SUBJECTS
  → LEVERS
  → DECISIONS
  → FOLLOW-UP
```

Nordla is not a set of independent modules. It maintains one shared view of the company, identifies what deserves attention, compares actions under explicit constraints, requests approval where required, follows execution, and learns only to the extent supported by evidence.

## Three internal levels

### Level 1 — Socle Nordla
Shared enterprise facts, provenance, Subjects, Lever registry, Decision procedure, policy/validation, ledger, follow-up, security, data quality, observability, bounded tools/connectors, Parle à Nordla and Centre de pilotage.

### Level 2 — Business domains
Finance, Analyses, Sales, Inventory, Buying & Suppliers, Marketing, Branding, Sales Development, Compliance, After-Sales.

Domains provide business facts, domain rules/constraints, candidate levers and execution capabilities. They do not independently make the final cross-company decision.

### Level 3 — Specialized intelligence
Creative Intelligence, Market Intelligence/Radar, Research Intelligence, specialist retail agents, automations, multi-model routing, forecasting/statistical intelligence when justified, and controlled execution agents.

Specialized intelligence may analyse and propose. It never bypasses Socle policy, validation or shared decision controls.

## Decision path

```
facts
  → data quality / provenance
  → Subject
  → eligible Levers
  → hard-constraint filtering
  → common comparison with visible trade-offs
  → recommendation
  → human/policy approval
  → execution
  → follow-up
  → evidence-qualified learning
```

Important outcomes include:
- `DO_NOTHING`
- `TEST_SMALL`
- `NOT_MEASURABLE`

## Product principles

- deterministic code calculates material numbers;
- AI analyses/explains/proposes;
- no fabricated missing data;
- no opaque universal score across heterogeneous units;
- one shared version of facts;
- hard owner constraints are explicit;
- consequential actions require policy enforcement and appropriate human validation;
- weak evidence does not become a strong rule automatically.

## Foundational decision principles

Nordla works under the decision principles in `docs/principles/decision-principles.md`, including real value creation, productive commerce, economic autonomy, honest profit, useful deployment of capital, long-term trust, sustainable growth, real customer value and rejection of deception/manipulation.

## Sources vs architecture

HABB is client zero, never architecture.

Shopify may currently provide HABB sales/inventory facts. It is a temporary source, not the target domain model. Nordla Sales and Nordla Inventory remain target domains.

## Current implementation reality

The historical Phase 0 statement that no sync, metrics or decision work existed is obsolete.

The repository now contains material implementation work across the platform. Current status must be determined from the relevant branch/commit and tests, not from the old Phase 0 snapshot.

The canonical Constitution defines the target model. Individual feature branches may implement only part of it.

## Change control

No frozen architecture decision may be silently replaced. See `NORDLA-DECISION-REGISTER.md`.
