# Nordla — Project Rules

Internal repository codename: **retail-ai-core**.

HABB is client zero / pilot merchant. HABB-specific rules remain configuration, never generic architecture.

## 0. Mandatory source of truth

Before any substantial Nordla work, READ FIRST:

1. `NORDLA-CANONICAL-ARCHITECTURE.md`
2. `NORDLA-DECISION-REGISTER.md`
3. `NORDLA-DEFERRED.md`
4. relevant accepted ADRs under `docs/decisions/`

These files are the current source of truth.

Do not rely on conversation memory, model memory, an old prompt, or an old architecture note when these documents say otherwise.

A decision marked `FROZEN` must never be silently replaced. If new evidence challenges it:
- name the decision ID;
- explain the conflict;
- propose an explicit replacement;
- stop before implementing the conflicting architecture unless the change is approved.

## 1. Canonical operating model

Nordla's shared operating model is:

```
ENTERPRISE
  → SUBJECTS
  → LEVERS
  → DECISIONS
  → FOLLOW-UP
```

Domains do not make independent final company decisions.

Domains provide:
- facts;
- domain rules/constraints;
- candidate levers;
- execution capabilities.

Specialist intelligences/agents may analyse and propose.

Socle Decision performs the common arbitration once.

Human owners remain responsible for consequential decisions according to policy.

## 2. Three internal architecture levels

These are architecture levels, not subscription tiers.

### Level 1 — Socle
Shared enterprise truth, Subjects, Levers, Decision, Follow-up, validation/policy, ledger, provenance, data quality, security, observability, tool boundaries, pilot/connection surfaces.

### Level 2 — Business domains
Finance, Analyses, Sales, Inventory, Buying & Suppliers, Marketing, Branding, Sales Development, Compliance, After-Sales.

### Level 3 — Specialized intelligence
Creative Intelligence, Market Intelligence/Radar, Research Intelligence, specialist retail agents, automations, multi-model routing, forecasting when justified, and controlled execution agents.

Do NOT implement Level 3 capabilities merely because they exist in the architecture. Check `NORDLA-DEFERRED.md` and the current approved scope.

## 3. Foundational decision principles

Nordla must work according to the principles defined in:
- `NORDLA-CANONICAL-ARCHITECTURE.md`
- `docs/principles/decision-principles.md`

Core requirements include:
- real value creation before extraction;
- productive commerce and economic autonomy;
- honest profit;
- useful and durable deployment of capital/assets;
- long-term trust;
- sustainable growth;
- rejection of deception and manipulation;
- explicit uncertainty;
- human responsibility for consequential actions.

These principles are operational constraints, not decorative values.

## 4. Product and calculation principles

- **Deterministic calculations.** Material financial, inventory, sales and operational figures are computed by versioned SQL/code.
- **LLM explains and analyses; code calculates.**
- **Never fabricate missing data.**
- **Explicit unavailable/unclassified states.**
- **One shared fact model with provenance.**
- **Hard owner constraints eliminate before comparison.**
- **No opaque universal score across heterogeneous axes.**
- **DO_NOTHING and TEST_SMALL remain legitimate options where meaningful.**
- **NOT_MEASURABLE is a legitimate result.**
- **Weak evidence never becomes a strong rule automatically.**

## 5. Generic vs vertical vs merchant-specific

Three strictly separated layers:

1. **Generic Nordla core** — logic true for any supported business/retailer.
2. **Vertical-specific logic** — opt-in logic true for a business category.
3. **Merchant-specific configuration** — data/configuration only.

Never hardcode HABB into generic architecture.

## 6. Security and execution

- Never expose secrets.
- No raw customer PII sent to an LLM unless explicitly designed, lawful and approved.
- Least privilege by default.
- Agents/tools receive bounded capabilities, not unrestricted database/system authority.
- Consequential actions pass through policy enforcement outside the LLM/agent.
- No destructive database operation without explicit authorization.
- No production deployment without explicit human approval.
- Migrations are versioned and reviewed.
- Test before merge.
- Maintain auditability, tenant isolation, idempotence and rollback/stop paths for consequential actions.

## 7. Development workflow

`branch → test → review → merge → rollback path known`

- No direct pushes to `main`.
- No force push.
- One feature branch per feature.
- Keep commits small and coherent.
- Do not broaden scope because something sounds useful.
- Do not create new agents/modules/capabilities unless approved in the canonical architecture/register or explicitly approved for the current phase.
- Do not touch HABB production from this repository unless explicitly approved.
- Build only the approved current scope.

## 8. Connectors and temporary sources

Connectors are replaceable sources, not architecture.

Shopify may currently supply pilot facts for HABB, but future Nordla Sales and Inventory remain the target business domains. Do not hardcode Shopify semantics into domain logic.

## 9. Current rule for older documents

Older architecture notes and ADRs remain historical records.

When they conflict with:
- `NORDLA-CANONICAL-ARCHITECTURE.md`
- `NORDLA-DECISION-REGISTER.md`
- `NORDLA-DEFERRED.md`

the canonical documents take precedence unless a later accepted ADR explicitly supersedes a frozen decision.
