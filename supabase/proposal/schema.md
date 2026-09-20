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

### `decision_outcomes`
(renamed from `future_outcomes` — "future" ages badly once a decision's outcome has already been observed; this name stays accurate at any point in time.)
`id`, `decision_id`, `observed_at`, `outcome_metric_value_id` (nullable), `summary` — closes the loop by recording what actually happened after a decision, for later comparison against what was predicted/expected. This table only ever *stores* an observation; no scoring/comparison logic lives here or anywhere yet — that's the Outcome Engine, explicitly out of scope until approved.

### `data_quality_flags`
Stores only the **results** of the deterministic checks defined in the `data-quality-rules` Skill — no business logic lives in this table, it is a record of "check X fired on entity Y at time Z", nothing more.
- `id`
- `merchant_id` — which merchant's data the flag belongs to
- `entity_type` — the kind of record the check ran against (`product`, `variant`, `order`, `refund`, `inventory_snapshot`, …)
- `entity_id` — the specific record's id (loosely typed / not a FK, since `entity_type` varies)
- `rule_code` — which check fired, matching a key from the `data-quality-rules` Skill (e.g. `missing_cogs`, `negative_stock`) — never a free-text description
- `severity` — e.g. `info` | `warning` | `critical`; the mapping from rule to default severity is config, not hardcoded per-row
- `status` — `open` | `resolved` | `ignored`; ignoring a flag is a human decision that should itself be traceable (later, an `decision_evidence` row can point at an ignored flag)
- `detected_at` — when the check first flagged this entity in this state
- `resolved_at` — nullable; when it stopped firing / was resolved
- `details` — JSON blob holding whatever evidence the check produced (e.g. the missing field, the expected vs. actual value) — evidence only, never a computed business number

`decision_evidence.data_quality_flag_id` references this table.

## Explicitly deferred

- Multi-tenant billing/subscription tables.
- Anything vertical-specific (e.g. UV-printing cost breakdown) — that lives in merchant config (`config/merchants/<merchant>/`) and/or a vertical module's own tables, added later behind its own review, not bolted onto the generic schema now.
- RLS policies themselves (the schema is designed to make them possible; writing and applying them is a separate, reviewed step, tracked below).
- The Outcome Engine (any logic that scores/compares `decision_outcomes` against what was predicted) — `decision_outcomes` only stores observations for now.

## Status

- ✅ `data_quality_flags` gap resolved (see above).
- ✅ `future_outcomes` renamed to `decision_outcomes`.
- ✅ Development Supabase project created (`retail-ai-core-dev`, region `eu-west-1`) — no tables yet, no migration applied.
- ⏳ Full SQL migration drafted below, shown for review — **not applied**.

## Final SQL (draft — for review only, NOT applied to any project)

```sql
-- 0001_initial_schema.sql (PROPOSAL — DO NOT APPLY WITHOUT EXPLICIT APPROVAL)

create table merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vertical text not null default 'general_retail',
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null,
  type text not null
);

create table products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  title text not null,
  handle text,
  source_system text not null,
  source_id text not null,
  unique (merchant_id, source_system, source_id)
);

create table variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  sku text,
  title text,
  attributes jsonb not null default '{}'::jsonb,
  source_id text
);

create table inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id),
  location_id uuid not null references locations(id),
  quantity integer not null,
  synced_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  location_id uuid references locations(id),
  source_id text not null,
  ordered_at timestamptz not null,
  currency text not null,
  status text not null,
  unique (merchant_id, source_id)
);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  variant_id uuid not null references variants(id),
  quantity integer not null,
  unit_price numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  amount numeric(12,2) not null,
  refunded_at timestamptz not null,
  reason text
);

create table product_costs (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id),
  merchant_id uuid not null references merchants(id),
  unit_cost numeric(12,2) not null,
  currency text not null,
  effective_from timestamptz not null default now(),
  source text not null check (source in ('manual', 'import', 'vertical_module'))
);

create table metric_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version integer not null,
  description text not null,
  formula_reference text not null,
  unique (key, version)
);

create table metric_values (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  metric_definition_id uuid not null references metric_definitions(id),
  period_start date not null,
  period_end date not null,
  value numeric(14,2),
  status text not null check (status in ('ok', 'unclassified')),
  computed_at timestamptz not null default now()
);

create table data_quality_flags (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  entity_type text not null,
  entity_id uuid not null,
  rule_code text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  type text not null,
  proposed_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  outcome text check (outcome in ('approved', 'rejected', 'modified')),
  notes text
);

create table decision_evidence (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decisions(id),
  metric_value_id uuid references metric_values(id),
  data_quality_flag_id uuid references data_quality_flags(id),
  note text
);

create table decision_outcomes (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decisions(id),
  observed_at timestamptz not null default now(),
  outcome_metric_value_id uuid references metric_values(id),
  summary text
);

-- RLS is enabled on every table now; policies themselves are a separate,
-- reviewed step (tracked in docs/security/baseline.md) — not written yet.
alter table merchants enable row level security;
alter table locations enable row level security;
alter table products enable row level security;
alter table variants enable row level security;
alter table inventory_snapshots enable row level security;
alter table orders enable row level security;
alter table order_lines enable row level security;
alter table refunds enable row level security;
alter table product_costs enable row level security;
alter table metric_definitions enable row level security;
alter table metric_values enable row level security;
alter table data_quality_flags enable row level security;
alter table decisions enable row level security;
alter table decision_evidence enable row level security;
alter table decision_outcomes enable row level security;
```

RLS is turned **on** for every table (so no table is accidentally left open), but no policies are defined yet — with RLS on and zero policies, every table is fully locked down (no row readable/writable) until policies are written and reviewed as its own step.

## Next step (needs explicit approval before proceeding)

1. Review the SQL above (schema shape, naming, anything missing).
2. Once approved, save it as `supabase/migrations/0001_initial_schema.sql` and apply it to the **dev** project (`retail-ai-core-dev`) only, via `apply_migration`.
3. Write and review RLS policies as a separate follow-up step before any application code reads/writes these tables.
