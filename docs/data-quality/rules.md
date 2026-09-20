# Data Quality — Living Catalogue

Canonical source of truth for the *definitions* is the `data-quality-rules` Skill (`.claude/skills/data-quality-rules/SKILL.md`). This document tracks implementation status; keep it in sync as checks are actually built.

| Check                              | Defined | Implemented | Notes |
|-------------------------------------|:-------:|:-----------:|-------|
| Missing COGS                        | ✅      | ❌          | Must resolve to `UNCLASSIFIED`, never estimated. |
| Duplicate SKU                       | ✅      | ❌          | |
| Negative stock                      | ✅      | ❌          | |
| Suspicious price                    | ✅      | ❌          | Threshold is merchant/vertical config, not hardcoded. |
| Suspicious cost                     | ✅      | ❌          | Threshold is merchant/vertical config, not hardcoded. |
| Refund without corresponding order  | ✅      | ❌          | |
| Unavailable product                 | ✅      | ❌          | |
| Missing inventory                   | ✅      | ❌          | |
| Stale synchronization               | ✅      | ❌          | Freshness window is per data source. |

No check is implemented yet — Phase 0 is architecture/foundation only. Do not add rows without first updating the Skill definition.
