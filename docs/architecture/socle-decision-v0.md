# Socle Decision V0

Branch `feature/socle-decision-v0`, based on `integration/nordla-platform-baseline` (08619d7).
Code: `src/socle-decision/`. Tests: `test/socle-decision.test.js`. Fixtures (synthetic only): `test/fixtures/socle-decision-synthetic.js`.

Model: **Entreprise -> Sujets -> Leviers -> Décisions -> Suivi**. Deterministic, in-memory, no I/O, no LLM, no agent, no Shopify, no clock (time is injected as `now`).

## Rule of the architecture

Business domains are not small autonomous brains. A domain supplies only **facts**, **levers** (and later, execution capabilities). Rules and comparison live **once**, in the common procedure.

| Layer | Files | May do | Must not do |
|---|---|---|---|
| Domains | `domains/*.js` | build a Subject (facts, missing data), list possible Levers | rank, choose, recommend, evaluate rules |
| Rules | `rules.js` | PASS / FAIL / NEEDS_HUMAN with an explicit reason | score |
| Comparison | `compare.js`, `decision.js` | the only place where options are compared | multiply units, call an LLM |
| Gates | `gates.js` | materiality, attention budget, cooldown (all from config) | hardcode a threshold |
| Follow-up | `ledger.js`, `store.js` | log, human decision, result | turn a result into a rule |

## Objects

- **Subject**: `id, merchant_id, type, key, kind (anomaly|gap|risk|opportunity), title, summary, status, materiality, currency, confidence, detected_at, review_at, facts[], missing_data[], source_refs[]`. Status: `TO_VERIFY | TO_DECIDE | IN_PROGRESS | RESULT | DISMISSED`. A suspect fact or a blocking gap gives `TO_VERIFY` (Data Quality First).
- **Lever**: `id, domain, type, label, description, eligibility, estimated_effects, estimated_cost, time_to_effect, reversibility, risk, required_approval, required_data` (+ `parameters, touches_price, combinable_with, assumptions`). Unknown effects stay `null`; nothing is guessed. `DO_NOTHING` is injected in every decision and is never eliminated. `TEST_SMALL` is injected from `config.testSmall`.
- **Rule**: `MIN_CASH, MIN_MARGIN, MAX_DISCOUNT, MAX_BUDGET, MAX_CAPACITY, MAX_RISK`, merchant-scoped rule sets. `FAIL` eliminates a lever before comparison. `NEEDS_HUMAN` keeps it, flagged, and moves the approval status to `NEEDS_HUMAN_INPUT`.
- **Decision**: subject, levers examined, eliminated (stage + reasons), remaining, recommended (`ACTION | COMBINED | TEST_SMALL | DO_NOTHING`), alternatives (why not), trade-offs, missing data, unresolved constraints, approval status. A `TO_VERIFY` subject yields a `TO_VERIFY` decision with no recommendation.
- **Log entry**: subject, facts used, rules applied, options, recommendation, human decision (approver, reason, date, chosen levers), planned actions, result (`CONFIRMED | SUGGESTIVE | REFUTED | NOT_MEASURABLE | UNKNOWN` + evidence level), next review.

## Comparison method (explainable, no combined score)

1. Eligibility (type, required facts, conditions) then owner rules.
2. If the baseline (`DO_NOTHING`) breaches a hard constraint, only options that resolve it are compared (stage 0).
3. Pareto dominance on the 8 axes: cash, margin, time to cash, capacity, inventory, risk, reversibility, confidence. Units are never merged.
4. Lexicographic choice along a declared axis priority per subject type (`compare.js`, overridable by `config.profiles`), with per-axis tolerance. Unknown values never win an axis.
5. If the best option has LOW confidence and `TEST_SMALL` is admissible, the recommendation is `TEST_SMALL` targeting it.
6. Combination only between levers that **mutually declare** `combinable_with` (effects assumed additive), with all rules still passing.

The trace of every stage is in `recommended.rationale`; trade-offs are given axis by axis in raw units.

## Guarantees tested

Merchant isolation (store, rule sets, decide, priorities), no network, no I/O primitive, no import outside the module (no Finance / Analytics / Identity / Security / Tenant / China Sourcing / Brain), no arbitration code in domains, no automatic learning from a result.

## Deliberate interpretations of V0

- `TEST_SMALL` is subject to the same hard rules as any lever (only `DO_NOTHING` is exempt). With cash below the floor, a test that costs cash worsens the constraint and is eliminated, visibly.
- `MIN_CASH` is evaluated worst-case: an inflow counts only if known and within `horizon_days`.
- A human cannot approve a lever that a rule eliminated (V0 has no override path).

## Documented, NOT applied: persistence

V0 is in-memory (`SocleStore`). A DB version would need, per `merchant_id` (RLS), tables for `socle_subjects`, `socle_decisions`, `socle_decision_log` and `socle_rule_sets`, with the log append-only. **No migration is written or applied in this branch.** It belongs to a separate, reviewed step.

## Not in V0

No LLM, no agents, no Shopify/connector, no UI, no external automation, no learning, no multi-currency comparison, no sequencing/scheduling of actions, no probability model, no domains beyond the three validation types (Marketing and Stock are out of scope).
