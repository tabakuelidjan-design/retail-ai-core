# Supabase Schema Proposal (Phase 0 — NOT APPLIED)

This is a design proposal only. No migration has been written or applied. Per the safe-deployment discipline, this must be reviewed and explicitly approved before any `supabase/migrations/*.sql` is created from it.

## Design goals

- IDs and relationships are **not** intrinsically limited to a single merchant (HABB) — every business entity is scoped by `merchant_id` from day one.
- No multi-tenant billing/subscription architecture yet (explicitly out of scope for Phase 0).
- No over-engineering: this is the minimal entity set needed to eventually support data → data quality → metrics → decisions → outcomes, not a full ERP model.
- RLS-ready: every table scoped by `merchant_id` so a future RLS policy can restrict rows per merchant/tenant.

## Proposed entities

### `merchants`
Root tenant entity. `id`, `name`, `vertical` (e.g. `general_retail`, `production_customization`), `created_at`.

### `locations`
Physical or logical location per merchant (store, warehouse, "online"). `id`, `merchant_id`, `name`, `type`.

### `products`
`id`, `merchant_id`, `title`, `handle`/external reference, `source_system` (e.g. `shopify`), `source_id`.

### `variants`
`id`, `product_id`, `sku`, `title`, attributes (JSON), `source_id`.

### `inventory_snapshots`
Point-in-time stock reads. `id`, `variant_id`, `location_id`, `quantity`, `synced_at`. Append-only — never overwritten, so stock-coverage/dead-stock metrics can look at history, and "stale synchronization" data-quality checks can compare `synced_at` against now.

### `orders`
`id`, `merchant_id`, `location_id` (nullable — online orders may have none), `source_id`, `ordered_at`, `currency`, `status`.

### `order_lines`
`id`, `order_id`, `variant_id`, `quantity`, `unit_price`, `discount_amount`.

### `refunds`
`id`, `order_id` (must reference an existing order — a refund without one is a data-quality violation, not a valid row), `amount`, `refunded_at`, `reason` (nullable).

### `product_costs`
`id`, `variant_id`, `merchant_id`, `unit_cost`, `currency`, `effective_from`, `source` (`manual` | `import` | vertical-module-computed). Absence of a row for a variant is what produces `UNCLASSIFIED` COGS — this table is intentionally allowed to be incomplete; the system must handle that gracefully rather than assuming completeness.

### `metric_definitions`
`id`, `key` (e.g. `contribution_margin_v0`), `version`, `description`, `formula_reference` (pointer to the versioned SQL/code that computes it, not the formula duplicated as a string). Mirrors the `retail-metrics` Skill — the Skill is the human-readable definition, this table is what the app looks up to know which version is currently in use.

### `metric_values`
`id`, `merchant_id`, `metric_definition_id`, `period_start`, `period_end`, `value` (nullable), `status` (`ok` | `unclassified`), `computed_at`. `value` is null and `status = 'unclassified'` when inputs were incomplete — never a substituted number.

### `decisions`
`id`, `merchant_id`, `type`, `proposed_at`, `decided_at` (nullable until a human acts), `decided_by`, `outcome` (`approved` | `rejected` | `modified`), `notes`.

### `decision_evidence`
`id`, `decision_id`, `metric_value_id` (nullable), `data_quality_flag_id` (nullable), `note` — links a decision to the specific metrics/data-quality state that informed it, so it's auditable later.

### `future_outcomes`
`id`, `decision_id`, `observed_at`, `outcome_metric_value_id` (nullable), `summary` — closes the loop by recording what actually happened after a decision, for later comparison against what was predicted/expected.

### (implicit) data-quality flags
Not fully modeled yet — needs a `data_quality_flags` table (`id`, `merchant_id`, `check_key`, `entity_type`, `entity_id`, `detected_at`, `resolved_at` nullable) referenced by `decision_evidence`. Flagged here as a gap to resolve in the next schema revision rather than silently added without review.

## Explicitly deferred

- Multi-tenant billing/subscription tables.
- Anything vertical-specific (e.g. UV-printing cost breakdown) — that lives in merchant config (`config/merchants/<merchant>/`) and/or a vertical module's own tables, added later behind its own review, not bolted onto the generic schema now.
- RLS policies themselves (the schema is designed to make them possible; writing and applying them is a separate, reviewed step once the connector is live and a dev project exists).

## Next step (needs explicit approval before proceeding)

1. Review this proposal (add/cut entities as needed — the `data_quality_flags` gap above should be resolved first).
2. Once approved, write versioned migrations under `supabase/migrations/`.
3. Apply migrations only to the **development** Supabase project, never directly to a future production project.
