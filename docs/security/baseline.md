# Security Baseline

## Access scopes

- **Shopify:** read-only for all development/inspection access in this project. No write scopes are requested. The future production SaaS integrates via its own Shopify App with least-privilege OAuth scopes chosen per feature — never a blanket admin scope.
- **Supabase:** least-privilege service roles. The **development** project only exists for schema design/testing in Phase 0+1. Claude is never given direct access to a production database. Row Level Security (RLS) is enabled by default on every table from the first migration onward; a strategy per table is documented in `docs/architecture/` once the schema is implemented (not just proposed).

## Secrets

- No `.env` file (or any file containing a real secret) is ever committed. `.gitignore` excludes `.env*` (except `.env.example`), and any local credential file.
- Secret scanning should be enabled on the GitHub repository once created (GitHub's built-in secret scanning / push protection, or an equivalent).
- No production credentials exist in this repository at any point in its history.

## PII

- No raw customer PII (name, email, phone, address, payment details) is sent to an LLM. Where an explanation needs to reference a customer, use an internal identifier, not personal data, unless a specific, reviewed feature requires otherwise.

## Destructive operations

- No destructive database operation (drop, truncate, bulk delete, irreversible migration) without explicit human approval, requested and given per-operation.
- No production deployment without explicit human approval, requested and given per-deployment.
- Every migration is versioned and reviewed before being applied to any shared environment.

## Webhooks (future)

- If/when Shopify webhooks are implemented, HMAC signature verification is mandatory on every webhook endpoint before any payload is trusted.

## API hardening (future)

- Rate limiting and CORS configuration are deferred past Phase 0. They are tracked here as required before any public-facing API surface ships — not silently skipped.

## Branch protection & repo controls

- **Status as of Phase 0: not yet configured.** This environment has no `gh` CLI installed and no GitHub MCP connector, so branch protection cannot be applied programmatically from here. Once the private GitHub repository exists (created manually per the Phase 0 report), apply, in the repo's Settings → Branches:
  - Require a pull request before merging into `main`.
  - Require at least 1 review before merging.
  - Disallow force pushes to `main`.
  - Disallow direct pushes to `main` (including for admins, if the plan allows it).
  - Enable secret scanning + push protection (Settings → Code security).

## Environment variable strategy

- Local development secrets live in a git-ignored `.env.local` (or equivalent), never in `.env.example`, which contains only variable names and placeholder values.
- Any secret used in CI is stored as a GitHub Actions encrypted secret, never inlined in workflow YAML.
