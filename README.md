# retail-ai-core

Internal codename for a generic retail AI system. HABB is the pilot merchant, exercised entirely through configuration — see [`CLAUDE.md`](CLAUDE.md) for the architecture principles and rules governing this project.

**Status: Phase 2C — Buying Intelligence Lite (under review), on top of Phase 2B demand/inventory facts and the Phase 2A Sales & Profit engine.** Read-only Shopify → Supabase sync (Phase 1) plus a deterministic sales/profit metric layer, product signals and data-quality flags (Phase 2A). No decision engine, LLM recommendations, or dashboard yet. See [`docs/architecture/sales-profit-engine.md`](docs/architecture/sales-profit-engine.md) and [`docs/architecture/demand-inventory-signals.md`](docs/architecture/demand-inventory-signals.md) and [`docs/architecture/buying-intelligence-lite.md`](docs/architecture/buying-intelligence-lite.md).

- [`CLAUDE.md`](CLAUDE.md) — product principles, architecture, security, workflow rules.
- [`docs/architecture/`](docs/architecture/) — pipeline and layering overview.
- [`docs/decisions/`](docs/decisions/) — architecture decision records.
- [`docs/security/`](docs/security/) — security baseline and current status.
- [`docs/data-quality/`](docs/data-quality/) — data quality check catalogue.
- [`docs/metrics/definitions.md`](docs/metrics/definitions.md) — versioned metric definitions (formula, sources, refund/discount/tax/missing-cost treatment).
- [`docs/principles/`](docs/principles/) — generic decision principles (governance for future recommendations; never alter calculations).
- [`.claude/skills/`](.claude/skills/) — `retail-metrics`, `data-quality-rules`, `safe-deployment`.
- [`config/merchants/`](config/merchants/) — merchant-specific configuration (data, not code).
- [`supabase/proposal/schema.md`](supabase/proposal/schema.md) — proposed database schema, not yet applied.
