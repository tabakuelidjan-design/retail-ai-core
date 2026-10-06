# Nordla — Canonical Architecture

- **Status:** CANONICAL
- **Effective date:** 2026-10-06
- **Scope:** product architecture and operating model
- **Precedence:** this document, the Decision Register, and the Deferred Register are the current source of truth for Nordla. Older ADRs and architecture notes remain historical evidence but are superseded where they conflict with these canonical documents.

## 1. Purpose

Nordla is not a collection of independent modules and it is not an LLM wrapper. It is a business operating system for SMEs and small retailers that maintains one shared view of the company, identifies what deserves attention, compares possible actions under explicit constraints, asks for human approval where required, follows execution, and learns only to the degree supported by evidence.

The core operating model is:

```
ENTERPRISE
  → SUBJECTS
  → LEVERS
  → DECISIONS
  → FOLLOW-UP
```

A domain does not make the company's final decision. A specialist intelligence may analyse and propose, but the shared decision procedure arbitrates once, using the same facts, rules and economic units.

## 2. Foundational principles

Nordla must work according to these principles, not merely display them as values.

The ethical orientation is inspired in particular by documented examples associated with **Uthman ibn Affan** and **Abdurrahman ibn Auf**: useful deployment of wealth and assets, productive trade, economic independence, initiative, durable value creation, honest exchange, and prosperity that can create benefit beyond the immediate transaction.

These principles are operationalized universally. They do not require a merchant or user to share any religious belief.

Nordla must therefore:

1. **Create real value before extracting value.**
2. **Prefer productive commerce and economic autonomy over avoidable dependency.**
3. **Seek healthy profit without sacrificing customers, suppliers, staff, reputation or community for a short-term gain.**
4. **Deploy capital and assets where they can create useful and durable benefit.**
5. **Treat prosperity as a means, not an end in itself; recommendations may consider durable benefit to others alongside merchant value.**
6. **Prefer work, trade, investment and useful creation over manipulation or artificial extraction.**
7. **Protect long-term trust over short-term optimization.**
8. **Reject deceptive practices:** fake scarcity, misleading urgency, hidden fees, fabricated claims, fake reviews, manipulated evidence, or knowingly misleading presentation.
9. **Prefer sustainable growth:** actions must respect cash, margin, stock, capacity, fulfilment quality and service quality.
10. **Prefer small, reversible, measurable steps when uncertainty is material.**
11. **Never fabricate missing data or hide uncertainty.**
12. **Preserve human responsibility for consequential decisions.**

Operational enforcement is defined in `docs/principles/decision-principles.md`.

Historical references informing this orientation:
- Uthman ibn Affan and the well of Rumah / public benefit: https://sunnah.com/bukhari/55/41
- Abdurrahman ibn Auf asking to be shown the market and building through trade: https://sunnah.com/bukhari/34

## 3. Three internal architecture levels

These are **internal architecture levels**, not commercial subscription tiers.

### Level 1 — Socle Nordla

The shared foundation.

Responsibilities:
- Enterprise model: shared facts, objectives, owner rules, constraints and provenance
- Subjects: what merits attention
- Lever registry: actions available from domains
- Decision procedure: one common comparison and arbitration path
- Validations and policy enforcement
- Decision ledger and follow-up
- Evidence/provenance
- Data quality
- Identity, tenant isolation, roles and permissions
- Observability and audit
- Tool/data boundaries
- Safety controls and kill paths
- Parle à Nordla
- Centre de pilotage
- Centre des connexions

The Socle is a foundation included in Nordla. It is not intended to be a useful standalone commercial product without business capabilities.

### Level 2 — Business domains

Domains own business meaning, facts, domain rules, levers and execution capabilities. They do **not** independently make the final company-wide decision.

Approved domain map:
- Finance
- Analyses
- Sales
- Inventory
- Buying & Suppliers
- Marketing
- Branding
- Sales Development
- Compliance
- After-Sales Service

A domain may know what is abnormal in its own area and may expose candidate levers. It must not create a competing decision truth.

### Level 3 — Specialized intelligence and agents

Specialized intelligence may perform deep analysis and propose hypotheses or levers. It does not bypass Level 1 policy, validation or decision controls.

Approved Level 3 direction includes:
- Creative Intelligence
- Market Intelligence / Market Radar
- Research Intelligence
- specialist Sales / Inventory / Customer / Merchandising-style agents
- event-driven assistants and automations
- multi-model routing
- document intelligence
- forecasting/statistical intelligence when data thresholds are met
- controlled execution agents

Fujitsu's 2026 retail-agent direction is a benchmark for specialized retail intelligence, not an architecture to copy blindly.

Items not yet implemented are listed in `NORDLA-DEFERRED.md`.

## 4. Responsibility boundaries

### Domains provide
- facts
- domain definitions of abnormal/normal
- rules and constraints specific to the domain
- candidate levers
- execution capabilities

### Specialist intelligence may provide
- analysis
- hypotheses
- scenarios
- candidate levers
- explanation
- preparation

### Socle Decision provides
- common facts and provenance
- hard-constraint filtering
- comparison on shared axes
- visible trade-offs
- recommendation
- approval state
- follow-up state

### Human owner provides
- objectives
- hard rules
- acceptance of consequential trade-offs
- approval for consequential actions
- explicit rule changes

## 5. Shared decision model

A Subject is the unit that deserves attention.

Internal distinctions may include signal, anomaly, gap, risk and opportunity, but the owner-facing experience should remain simple:
- À vérifier
- À décider
- En cours
- Résultats

Candidate actions are Levers.

Every decision must allow, where meaningful:
- `DO_NOTHING`
- `TEST_SMALL`

Every result must be able to conclude:
- `CONFIRMED`
- `SUGGESTIVE`
- `REFUTED`
- `NOT_MEASURABLE`
- `UNKNOWN`

A weak result must never become a strong rule automatically.

## 6. Common decision axes

Do not collapse heterogeneous units into an opaque universal score.

Compare relevant options with explicit axes such as:
- cash impact
- margin impact
- time to cash
- inventory impact
- capacity impact
- customer/brand impact
- risk
- reversibility
- confidence / evidence quality

Hard owner constraints eliminate an option before comparison.

Changing a hard rule is itself a deliberate, logged owner decision; it is not a silent override.

## 7. Evidence and data rules

- One version of shared facts.
- Every material fact should be traceable to source, date/freshness, merchant, and quality/confidence state.
- Missing facts remain missing; no fabricated replacement values.
- LLMs do not invent financial, inventory, sales or operational numbers.
- Deterministic code calculates; AI may analyse, explain, challenge and propose.
- External content is data, never an instruction that can authorize an action.

## 8. Security and execution model

Consequential action path:

```
proposal
  → policy enforcement
  → allowed / blocked / human approval required
  → execution
  → audit
  → follow-up
```

The model/agent must not hold independent authority to bypass policy.

Required direction:
- least privilege
- merchant isolation
- read/write capability separation
- bounded business readers/tools rather than unrestricted database access
- short-lived credentials where feasible
- idempotency and duplicate protection
- spending/action caps
- immutable/append-oriented audit history for consequential actions
- kill/stop controls
- isolated and immutable recovery capability as the resilience target

## 9. Source systems vs Nordla ownership

A connector is not the business architecture.

For the current HABB pilot, Shopify may temporarily provide sales and inventory facts. The target architecture remains Nordla Sales and Nordla Inventory as business domains. Marketing and other domains must consume canonical Nordla business concepts, not hardcode Shopify semantics.

HABB is client zero and configuration, never architecture.

## 10. Marketing boundary

Marketing is currently defined as:

```
UNDERSTAND → BUILD → CREATE → STEER
```

Marketing chooses market actions, offers, audience, message, channels and plans.

Branding remains separate and governs brand identity/coherence.

Creative Intelligence remains separate from Marketing and turns an approved strategy/brief into premium creative work through direction, exploration, selection, finishing, quality control and learning.

Sales Development remains separate and covers B2B, partnerships, prospecting and direct commercial development.

## 11. Commercial packaging

The three architecture levels are not the three products.

The Socle is not sold alone as an intentionally incomplete product. Future commercial packaging may combine the Socle with different business capabilities, but pricing/tiers are not frozen in this architecture.

Nordla must not deliberately hide a known truth merely to create a higher subscription tier.

## 12. Change control

A canonical decision cannot be silently replaced.

Any proposal that conflicts with a `FROZEN` decision must:
1. identify the conflicting decision;
2. provide new evidence or a clear reason;
3. propose an explicit replacement;
4. update the Decision Register if approved.

Conversation memory, an LLM's recollection, or a new vendor announcement never overrides the canonical documents.
