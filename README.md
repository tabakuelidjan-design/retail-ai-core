# retail-ai-core

Internal codename for a generic retail AI system. HABB is the pilot merchant, exercised entirely through configuration — see [`CLAUDE.md`](CLAUDE.md) for the architecture principles and rules governing this project.

**Status: Phase 0 — foundation only.** No sync, metrics engine, decision engine, or dashboard has been built yet.

- [`CLAUDE.md`](CLAUDE.md) — product principles, architecture, security, workflow rules.
- [`docs/architecture/`](docs/architecture/) — pipeline and layering overview.
- [`docs/decisions/`](docs/decisions/) — architecture decision records.
- [`docs/security/`](docs/security/) — security baseline and current status.
- [`docs/data-quality/`](docs/data-quality/) — data quality check catalogue.
- [`docs/metrics/`](docs/metrics/) — pointer to the canonical metric definitions Skill.
- [`.claude/skills/`](.claude/skills/) — `retail-metrics`, `data-quality-rules`, `safe-deployment`.
- [`config/merchants/`](config/merchants/) — merchant-specific configuration (data, not code).
- [`supabase/proposal/schema.md`](supabase/proposal/schema.md) — proposed database schema, not yet applied.
