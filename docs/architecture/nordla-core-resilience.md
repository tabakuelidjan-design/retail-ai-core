# Nordla Core resilience

Status: implemented on `feature/nordla-core-resilience-v1`, offline only (fake providers, no network, no credential, no paid call). The Creative Brain is the first pilot consumer.

## Why

Five live attempts of the Creative Brain benchmark each stopped on one local defect: a misspelled key, a forbidden word, a contradiction between two fields, a broken JSON array, an answer wrapped in an `answer` key. None was a Creative problem. They were one problem: **a local, recoverable failure collapsed a whole workflow**, and the mechanics for classifying, recovering from and bounding such failures lived inside one module. Resilience mechanics belong to Nordla Core (NDR-010: evidence, observability, tenant isolation are Socle responsibilities); modules keep their domain reasoning. Everything here is deterministic code outside any model (NDR-009).

Location: `src/core-resilience/` (the layer), `src/core-resilience/adapters/` (the seams to modules), `benchmarks/core-resilience/` (the chaos benchmark), `scripts/run-core-chaos.mjs`, `docs/architecture/nordla-core-resilience-matrix.json` (generated).

## Audit of what existed (before any code)

Verified by reading the code (read-only audit):

- **No shared error/result/retry code existed.** `src/shared` holds only UI chart assets. Each module defined its own errors (ActivationError, ProvisioningError, CreativeIntelligenceError, BrainError, FinanceError, TenantResolutionError, ConnectorError, TenantWriteViolation, LedgerError, ...), its own `fail`/`deepFreeze`/`isPlain` trio, and its own result enums.
- **Worth preserving**: activation's provider boundary (`ProviderRejection`, `callProvider`, `decideRetry`, ambiguous submission is never retried blindly); `supabase/client.js` retry (non-idempotent writes opt out); `sync/write-guard.js` (the strongest tenant guard); `finance/stock.js` (status machine, CAS claim, idempotency key); `SpendGuard` and the live-call lock; the credential store `failWith` fault injector.
- **Duplicated**: `safeCause`/`safeError` (3 copies), the provider-error normalization line (3 copies in the Alibaba adapter) and two parallel provider-error models (`ProviderRejection.retryable` vs `AlibabaProviderError.transient`), secret redaction (3 implementations), timeout wrappers (5), result-state enums (several), the sync summary `{errors: []}` shape.
- **Stays module-specific**: Finance accounting invariants and numbering, Creative gates (guardian, fidelity), the decision-ledger vocabulary, the Alibaba price table and scoped media authorization.
- **Provider detail exposed**: `supabase/client.js` and `shopify/client.js` put response bodies (up to 500 characters, possibly row data) in error messages, which flow into sync summaries and `sync_runs.error`. Core now offers `safeProviderMessage` for this; the modules were NOT changed (see known weaknesses).
- **One local failure aborts a workflow**: `sync/orders.js` (one bad order or upsert aborts the page and the run), `sync/catalog.js`, `activation/executor.js runDueJobs` (a repository throw on one job stops all remaining jobs and, in the worker, all other tenants), `finance/stock.js applyPending` (a store failure after the adjust leaves the movement in APPLYING), several `Promise.all` in `finance/server/app.js` and `metrics/load.js`.
- **State integrity**: `sync/orders.js` writes orders, lines and refunds as separate non-transactional upserts; the token manager can lose a rotated refresh token if the credential update fails after the provider rotated it; `SpendGuard` is in memory only.
- **Tenant isolation**: `analytics-premium/server/tenant.js` fails open (an unbound directory serves foreign reports); only the sync has a central write guard; isolation elsewhere relies on a `merchantId` argument; journals carry no tenant.

These are reported, not fixed (the task forbids rewriting modules; each is a candidate for a separate approved task).

## Taxonomy

Eleven Core categories; every error maps to exactly one. A module keeps its own detailed code (`code`, `domain_code`); nothing useful is replaced.

`PROTOCOL_ERROR`, `INPUT_INVALID`, `MISSING_INFORMATION`, `USER_CONTRADICTION`, `RECOVERABLE_EXECUTION_ERROR`, `TOOL_CAPABILITY_LIMIT`, `PROVIDER_FAILURE`, `DOMAIN_RULE_VIOLATION`, `SAFETY_OR_FIDELITY_BLOCK`, `STATE_INTEGRITY_ERROR`, `FATAL_SYSTEM_ERROR`.

A `CoreError` is frozen and carries: stable machine `code`, optional `domain_code`, a human-safe message, `recoverable` (YES / NO / CONDITIONAL), originating `module` and `stage`, an `evidence_ref`, a state `checkpoint`, scalar-only sanitized `diagnostics`, and the `tenant`. Credentials, tokens, long hex strings and e-mail addresses are redacted from every field. An unregistered error is `FATAL_SYSTEM_ERROR` flagged `unmapped`, never silently recovered. Registries are instances, never process-wide singletons.

## Recovery policy

Actions: `NORMALIZE`, `REASK_PROVIDER`, `RETRY_SAFE_OPERATION`, `REPLAN`, `SWITCH_CAPABILITY`, `ASK_USER`, `GRACEFUL_BLOCK`, `ROLLBACK`, `FATAL_STOP`. A module never chooses an action by itself: the Core policy lists, per category, the authorized actions in order and a precondition for each (`docs/architecture/nordla-core-resilience-matrix.json` is the exact table, generated from the code).

| Category | Authorized, in order |
|---|---|
| PROTOCOL_ERROR | NORMALIZE (a meaning-preserving repair exists) → REASK_PROVIDER (once, where the stage and the subcode allow) → GRACEFUL_BLOCK |
| INPUT_INVALID | NORMALIZE → ASK_USER → GRACEFUL_BLOCK |
| MISSING_INFORMATION | NORMALIZE (a DECLARED safe default) → ASK_USER → GRACEFUL_BLOCK |
| USER_CONTRADICTION | NORMALIZE (an explicit user-priority rule) → ASK_USER → GRACEFUL_BLOCK |
| RECOVERABLE_EXECUTION_ERROR | RETRY_SAFE_OPERATION (idempotent) → REPLAN → ROLLBACK → GRACEFUL_BLOCK |
| TOOL_CAPABILITY_LIMIT | REPLAN → SWITCH_CAPABILITY → ASK_USER → GRACEFUL_BLOCK |
| PROVIDER_FAILURE | RETRY_SAFE_OPERATION (declared transient + idempotent) → SWITCH_CAPABILITY → ASK_USER (only when the sole alternative would degrade the outcome) → GRACEFUL_BLOCK |
| DOMAIN_RULE_VIOLATION | module policy (default ASK_USER → GRACEFUL_BLOCK) |
| SAFETY_OR_FIDELITY_BLOCK | GRACEFUL_BLOCK → ASK_USER → FATAL_STOP; never normalized, retried, re-asked, switched around or rolled back |
| STATE_INTEGRITY_ERROR | ROLLBACK → FATAL_STOP |
| FATAL_SYSTEM_ERROR | FATAL_STOP |

A module policy (`allow`, `extend`, `forbid`, `prefer`) can only be stricter or choose inside Core; the actions in the `FORBIDDEN` table can never be added to a safety, integrity or fatal category. A recovery handler that fails with an unclassified fault does not turn a recoverable error into a fatal one: the original error stands and the next authorized action is tried.

**Budgets.** Every recovery is bounded: provider repairs (default 1), safe retries (2), replans (1), capability switches (1), recovery depth (4), cost and elapsed time (unbounded unless set). A bounded failure ends in `RECOVERY_EXHAUSTED` or another classified terminal state: `COMPLETED`, `NEEDS_USER`, `BLOCKED_GRACEFULLY`, `ROLLED_BACK`, `FATAL`.

**Domain actions keep their meaning** and map onto Core semantics (`createDomainActionMap`): creative `RECONCEPT` → REPLAN at IDEATE, `RECOMPOSE` → REPLAN at COMPOSE, `REFINE` → REPLAN at PRODUCTION.

**SWITCH_CAPABILITY is not dynamic routing** (NDR-D01) and not a silent cross-region fallback (NDR-P16): it uses only an alternate that was declared, is authorized, is declared to give the SAME outcome, stays in the same region (unless the alternate declares cross-region) and does not widen the data class. An alternate that would degrade the outcome is reported and the user is asked.

## State model

`createStateHub()` partitions everything by tenant first. A run has COMMITTED checkpoints (frozen, never overwritten: a second commit of a stage is `STATE_INTEGRITY_ERROR`), PARTIAL evidence of a failed stage (kept, never mistaken for committed state), a JOURNAL and a METER (provider calls and cost) that live outside the checkpoints, so a rollback or a failure never erases evidence or accounting. Rollback is explicit (`rollbackTo`), a resumed run skips committed stages, and `once(key)` makes side effects exactly-once (concurrent attempts share one; an irreversible effect whose outcome is unknown is never repeated automatically). Handing a tenant another tenant's run id is `CORE_TENANT_MISMATCH`.

## User input

`readTextField`, `readAmount`, `readInput`: Unicode NFC, zero-width spaces/BOM/soft hyphen removed, blank runs collapsed (all journaled); the zero-width joiner and non-joiner and bidirectional marks are kept because they carry meaning in emoji, Persian, Indic and mixed-direction text. Nothing is truncated or translated; a text over its limit is `INPUT_TOO_LONG`; null-like words are MISSING unless the field accepts them; an amount with a group separator (`1.250`) is AMBIGUOUS and never guessed. A missing price, legal, financial, claim, supplier or compliance fact is `MISSING_INFORMATION` unless a safe default was declared. Contradictions are detected, never silently resolved (`reconcileStatements`); a deliberate reversal is resolved only by an explicit user-priority rule.

## Change of mind

`createDependencyGraph` / `invalidate` / `applyChange`: a module declares facts and the stages that read them; a change invalidates exactly the closure of its readers, the rest is preserved (`uncommit`), and the next run recomputes only what was invalidated. `CREATIVE_DEPENDENCIES` is the Creative Brain's graph (changing the headline invalidates COMPOSE and everything after it, not FRAME, IDEATE, SELECT_CONCEPT or ART_DIRECT).

## Provider boundary

`readStructuredReply` (fences, prose, empty body, no object, malformed JSON, duplicate keys, a lone wrapper) and `classifyProviderFailure` (timeout, rate limit, network, auth, refusal, capability unavailable, outage, rejection; `transient` is the one flag that matters to recovery; no body, URL or request id is kept). The JSON scanner now lives in Core (`structured-output.js`); the Creative Brain's `model-port.js` consumes it. Generation-time `response_format: json_object` (Creative Brain port) is a separate, already shipped layer; Core still assumes no provider compliance: constrained output + safe normalization + canonical validation + semantic validation.

## Module seams (`adapters/`)

- **creative** (pilot, integrated): every `BRAIN_ERROR` code, `BRAIN_FAILURE` cause, runtime `ROOT_CAUSE` and creative recovery action mapped; the runner's `describeFailure` now also records `core_resilience: {category, recoverable, code}`; `model-port.js` uses Core's JSON scanner. The Brain itself is not redesigned.
- **finance**: every `FinanceError` code in the source is classified (a test reads the source, so a new code cannot escape). Finance policy: never NORMALIZE, REPLAN, SWITCH or RE-ASK; a broken invariant goes to the person or stops; the segregation controls (`*_REQUIRES_A_MERCHANT_ACTOR`) are `SAFETY_OR_FIDELITY_BLOCK`; `CONCURRENT_MODIFICATION` is `STATE_INTEGRITY_ERROR` (stop at the last checkpoint, a person re-reads). Finance semantics were not touched.
- **activation, tenant/connectors, buying, Alibaba**: codes mapped; an ambiguous publish (`PUBLISH_RESULT_UNKNOWN`) is `STATE_INTEGRITY_ERROR`, never retried blindly.
- **Only audited, no adapter**: demand, customers, analytics (metrics), signals, sync, provider-connections, shopify, marketing (M1-M4), branding, onboarding, quality. The chaos benchmark exercises the real entry points of demand, customers, analytics, buying, sync (batch writes, write guard) and tenant, with Core classifying what they throw.

## The chaos benchmark

143 deterministic scenarios in 18 groups (A clean input ... R domain rule violation), run by `node scripts/run-core-chaos.mjs` (fake providers only). Each scenario is isolated: an exception is recorded and the suite continues. Each records: scenario_id, group, module, input_class, expected and actual classification and action, recovered, clarification_required, terminal_state, state_integrity, evidence_integrity, tenant_isolation, provider_calls, recovery_depth. The harness checks the invariants (state, evidence, tenant isolation across ALL tenants of the suite, authorization of every executed action, no fatal error silently recovered, boundedness, no duplicate irreversible side effect) and reports completion, automatic-recovery, clarification, graceful-block, provider-recovery and protocol-repair rates and depth, as measured, with no invented target.

## Readiness

`NORDLA_CORE_RESILIENCE_READY = YES` only if: 0 process crashes, 0 uncaught exceptions, 0 state corruption, 0 cross-tenant leakage, 0 evidence loss, 100% terminal states classified, 100% executed recoveries authorized, 0 recoverable errors treated as fatal, 0 fatal errors silently recovered, 0 unbounded recovery, 0 duplicate irreversible side effects, 0 failed expectations, at least 120 scenarios. `CREATIVE_BRAIN_MIGRATED_TO_CORE_RESILIENCE` is reported separately (`creativeMigrationReport`). No other module is claimed to be migrated.

## Known limits

- Modules were not changed: the raw-error exposure, the non-isolated sync loops, the non-transactional order write, the fail-open analytics tenant binding and the lost-rotated-token window remain, and are listed as candidates for separate tasks.
- Several modules throw a raw `TypeError` on a null input collection (`buildDemandFacts`, `buildCustomerFacts`, `computeSalesMetrics`; `evaluateCandidate` with null facts or no `now`). Core classifies this as an unmapped `FATAL_SYSTEM_ERROR` (bugs are not hidden) and offers `requireCollections` to ask for the data instead; the modules do not call it yet.
- `compliance` is not implemented as a module: its scenarios test only the Core input boundary.
- In-process state only: the hub is a model for Nordla's in-process stores; durable checkpoints in a database are not designed here.
- Elapsed-time budgets use an injectable clock; real wall-clock behavior under load is not benchmarked.
- `json_schema` strict mode for the Creative Brain provider remains a separate follow-up (verify qwen3.8-max on the Frankfurt endpoint first).
