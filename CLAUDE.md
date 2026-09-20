# Retail AI Core — Project Rules

Internal codename: **retail-ai-core**. No commercial brand name has been finalized — never hardcode a retailer's name (HABB or otherwise) into the application, package name, or generic architecture.

This project is **completely separate** from the HABB Shopify theme project (`website habb/theme-repaired-exact/`). Nothing here modifies, depends on, or is built specifically for HABB. HABB is client zero / the pilot merchant, exercised entirely through configuration (see [Merchant configuration](#7-merchant-configuration-habb-is-config-not-architecture) below) — never through code changes to the generic core.

The system must work for any retailer: clothing, shoes, cosmetics, books, specialty food, electronics, pure ecommerce, hybrid physical+online, with or without internal production/customization.

## Architecture principle

**Generic Retail Core + optional vertical modules + merchant-specific configuration.**

Business logic that is true for one merchant or one vertical (e.g. UV-printing production costs) must never leak into code that is supposed to be generic. When in doubt, ask: *"Would this line of code make sense for a bookstore with no in-house production?"* If not, it belongs in a vertical module or merchant config, not the core.

## 1. Product principles

- **Deterministic calculations.** All metrics, margins, and financial figures are computed by versioned SQL/code — never estimated or "vibe-computed" by the LLM.
- **LLM explains; code calculates.** The LLM's job is to interpret and narrate numbers that the deterministic engine already produced, and to help a human decide. It never invents a number that isn't traceable to a calculation.
- **Never fabricate missing data.** If a cost, price, or quantity is missing, the system does not guess or default to zero/average.
- **Explicit unavailable/unclassified states.** Missing or unusable data must surface as `UNCLASSIFIED` / `UNAVAILABLE`, not as a silently substituted estimate. A missing COGS becomes `UNCLASSIFIED`, never an invented profit.
- **Human approval before consequential actions.** Anything that changes real-world state (pricing, inventory, orders, spend, publishing) requires an explicit human decision, recorded in the decision ledger — the system recommends, it does not act unilaterally.

## 2. Architecture pipeline

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

Each stage is a distinct, inspectable layer. Data does not skip straight to LLM explanation — it must pass through data-quality checks and deterministic metric/rule computation first. Every human decision is logged with the evidence that informed it, and later compared against the outcome it produced.

## 3. Generic vs. vertical vs. merchant-specific

Three strictly separated layers:

1. **Generic retail core** — logic true for any retailer (orders, products, inventory, refunds, core metrics).
2. **Vertical-specific logic** — logic true for a category of retailer (e.g. "has in-house production/customization" vs. "buys and resells finished goods"). Lives in its own module, loaded only for merchants that opt into that vertical.
3. **Merchant-specific configuration** — data, not code (e.g. HABB's UV production costs). Lives under `config/merchants/<merchant>/`.

Never hardcode a merchant's business rules into the generic core or into a vertical module. See [`config/merchants/habb/README.md`](config/merchants/habb/README.md).

## 4. Security

- Never expose secrets. No production credentials in the repository, ever.
- No raw customer PII sent to an LLM.
- Shopify access is **read-only** in V1.
- No destructive database operation without explicit human approval.
- No production deployment without explicit human approval.
- Test before merge.
- Migrations are versioned and reviewed before being applied.
- If/when Shopify webhooks are added: HMAC verification is mandatory, no exceptions.
- API rate limiting and CORS hardening: deferred to a later phase, tracked as tech debt, not skipped silently.

See [`docs/security/baseline.md`](docs/security/baseline.md).

## 5. Development workflow

`branch → test → review (PR) → merge → rollback path known`

- No direct pushes to `main`. `main` is protected.
- No force push.
- Every significant change is committed; small, atomic commits.
- Every change has a known rollback path before it merges.
- One feature branch per feature (`feature/<name>`) — never bundle unrelated concerns in one branch or commit.

## 6. Development stack (V1, minimal)

Core: Claude Code, GitHub, Supabase (dev only).
Claude helpers: Context7 (docs), Security review, Playwright/browser tooling.
Shopify: official Shopify MCP connector, **for development inspection/testing only**. The future SaaS product must use its own Shopify App / OAuth / Admin GraphQL integration — the runtime product is never architected around a Claude-side dev connector.
Email: Resend is the intended provider; not implemented yet.

Do not add tooling (Notion, Linear, Figma, Twilio, Klaviyo, Google Ads, Meta, agent-orchestration frameworks, etc.) without a concrete V1 requirement and a written reason. See [`docs/decisions/`](docs/decisions/) for the record of what was considered and why.

## 7. Merchant configuration: HABB is config, not architecture

HABB-specific concepts (UV production costs, blank product costs, ink, consumables, operator time, machine cost, remake/waste assumptions) live under `config/merchants/habb/` as data. None of these concepts are mandatory for the generic core — a retailer that simply buys and resells finished goods must work with zero merchant-specific production config.

## 8. Non-negotiable (current phase)

- Do not build the contribution margin engine, recommendation engine, reorder engine, cash engine, dashboard, email digest, or outcome engine until explicitly approved.
- Do not broaden scope because something "sounds useful."
- Do not create additional agents.
- Do not touch HABB production (Shopify theme/store) from this project.
- Build only what has been explicitly approved for the current phase.
