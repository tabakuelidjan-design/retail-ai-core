---
name: data-quality-rules
description: Defines what makes retail-ai-core's business data trustworthy, and the checks that must run before data feeds metrics or decisions. Use whenever ingesting, validating, or reasoning about data quality.
---

# Data Quality Rules

Purpose: define what makes business data trustworthy enough to feed the metrics and decision engine.

## The one rule that overrides everything else

**Never replace missing data with an invented default.** Missing COGS becomes `UNCLASSIFIED` — never an estimated profit, never a zero, never an average pulled from other products. The same applies to any other missing value that would otherwise silently distort a calculation. When a check below fires, the affected record is flagged; it is not auto-corrected, auto-estimated, or silently dropped from aggregates without being counted as `UNCLASSIFIED`.

## Initial checks (V1)

- **Missing COGS** — a product/variant sold with no corresponding `product_costs` entry.
- **Duplicate SKU** — the same SKU string mapped to more than one distinct product/variant.
- **Negative stock** — an inventory snapshot with quantity below zero (sync bug or unaccounted sale/return).
- **Suspicious price** — a price that is a statistical outlier versus the product's own price history or its category (exact thresholds are a merchant/vertical config parameter, not hardcoded).
- **Suspicious cost** — same idea, applied to `product_costs`: a cost entry wildly inconsistent with the product's price or its own cost history.
- **Refund without corresponding order** — a refund record that cannot be matched to an existing order.
- **Unavailable product** — a product referenced by an order or metric that no longer exists / is not returned by the source system.
- **Missing inventory** — a product/variant with no inventory snapshot at all (never synced, or sync failed silently).
- **Stale synchronization** — the last successful sync for a data source is older than its expected freshness window.

Do not add checks beyond this list without updating this document first — the point is a reviewable, versioned set of rules, not an ad hoc pile of validations scattered through code.

## How checks are used

A data-quality failure does not block ingestion of the rest of the dataset, but it must:
1. Be recorded (so it's auditable — which record, which check, when).
2. Propagate as `UNCLASSIFIED` into any metric that would otherwise use the bad/missing value.
3. Never be silently "fixed" by substituting a guessed value.

See [`docs/data-quality/`](../../../docs/data-quality/) for the living catalogue of checks and their current implementation status, and [`retail-metrics`](../retail-metrics/SKILL.md) for how `UNCLASSIFIED` propagates into metric output.
