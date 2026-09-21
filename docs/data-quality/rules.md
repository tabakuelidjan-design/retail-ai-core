# Data Quality — Living Catalogue

Canonical source of truth for the *definitions* is the `data-quality-rules` Skill (`.claude/skills/data-quality-rules/SKILL.md`). This document tracks implementation status; keep it in sync as checks are actually built.

| Check                              | Defined | Implemented | Notes |
|-------------------------------------|:-------:|:-----------:|-------|
| Missing COGS                        | ✅      | ✅ `MISSING_COST` | Only variants that sold or hold stock. Metrics resolve to `UNCLASSIFIED`, never estimated. |
| Duplicate SKU                       | ✅      | ✅ `DUPLICATE_SKU_OBSERVATION` | One flag per shared SKU. |
| Negative stock                      | ✅      | ❌          | |
| Suspicious price                    | ✅      | ◐ `SUSPICIOUS_FINANCIAL_VALUE` | Structural checks only (negative/zero price, discount > gross, non-positive cost). Statistical outlier thresholds still to do (merchant config). |
| Suspicious cost                     | ✅      | ❌          | Threshold is merchant/vertical config, not hardcoded. |
| Refund without corresponding order  | ✅      | ✅ `REFUND_WITHOUT_EXPECTED_MAPPING` | FK already forbids orphan refunds; the rule catches refunds with money but no product line. |
| Unavailable product                 | ✅      | ❌          | |
| Missing inventory                   | ✅      | ❌          | |
| Stale synchronization               | ✅      | ◐ `STALE_INVENTORY_SNAPSHOT` | Inventory only, 36h default (config). Other sources still to do. |
| Unmatched historical variant        | ✅      | ✅ `UNMATCHED_HISTORICAL_VARIANT` | Sold line with no catalog variant. |

Implemented in Phase 2A (`src/quality/`), persisted idempotently to `data_quality_flags` by `npm run quality:flags`. ❌ = not implemented, ◐ = partly. Do not add rows without first updating the Skill definition.
