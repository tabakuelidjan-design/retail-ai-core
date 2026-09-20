# ADR 0001: Project Foundation (Phase 0)

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

We are starting a new product ("Retail AI", internal codename `retail-ai-core`) with HABB as the pilot merchant. The product must generalize to other retail verticals from day one — it must not become "the HABB app" architecturally, even though HABB is the only real merchant in V1.

## Decision

- Build a **generic retail core**, with **optional vertical modules**, with **merchant-specific configuration** as the only place merchant business rules live. See `docs/architecture/overview.md`.
- Keep this project in a completely separate repository/directory from the HABB Shopify theme project. No shared code, no shared deployment.
- Phase 0 delivers only: environment setup, `CLAUDE.md`, docs structure, three V1 Skills (`retail-metrics`, `data-quality-rules`, `safe-deployment`), and a Supabase schema *proposal*. No business-logic engines are built yet.
- Minimal V1 stack only: Claude Code, GitHub, Supabase (dev), Context7, a security-review capability, and browser/Playwright-style testing tooling. Everything else (Notion, Linear, Figma, Twilio, Klaviyo, ad platforms, agent-orchestration frameworks) requires a concrete V1 requirement and a written justification before being added.
- Shopify access for this project is read-only and is a development convenience; the eventual product will use its own Shopify App / OAuth / Admin GraphQL integration, not the Claude-side connector.

## Consequences

- Any future feature must be checked against "does this belong in the generic core, a vertical module, or merchant config?" before being written.
- HABB-specific numbers (UV printing costs, blank costs, etc.) must never appear in code — only in `config/merchants/habb/`.
- Because branch protection and GitHub-hosted CI require an actual GitHub repository and either `gh` CLI auth or a GitHub connector (neither is available in this environment as of this ADR), those specific controls are pending manual setup — see `docs/security/baseline.md` for current status.

## Alternatives considered

- Building directly inside the existing HABB Shopify project repository — rejected: would couple a multi-merchant SaaS product to a single merchant's theme repo and make architectural contamination almost inevitable.
- Starting directly with the metrics/decision engine — rejected per explicit instruction: Phase 0 is foundation only.
