# Creative Fidelity V0 — hardening after independent audit

Status: IMPLEMENTED ON FEATURE BRANCH / RE-AUDIT REQUIRED

This checkpoint addresses the four findings from the independent Claude audit before any benchmark result is allowed to count.

## F1 — Fidelity gate is fail-closed

The hard gate now has three outcomes:

- PASS
- FAIL
- NOT_MEASURABLE

A benchmark judgement becomes:

- ACCEPTED only when every required fidelity check is measured and PASS;
- REJECTED when at least one required fidelity check is FAIL;
- UNDETERMINED when evidence is missing or NOT_MEASURABLE.

Unknown observation codes now throw instead of being ignored.

Creative quality is ordinal:

- UNACCEPTABLE
- WEAK
- ACCEPTABLE
- STRONG

No numeric universal score selects a winner.

## F2 — One execution gate

All benchmark execution uses `evaluateModelExecutionGate`.

It checks:

- model status;
- exact verified license status;
- license evidence source;
- commercial use;
- EU allowance;
- self-host requirement when requested;
- exact artifact hash for every self-hosted model;
- requested capability.

A self-hosted model with a verified family license but no downloaded artifact hash is blocked with `ARTIFACT_HASH_MISSING`.

## F3 — Durable provenance path

The provenance record now supports:

- prompt hash, never raw prompt;
- parameter hash, never raw parameters;
- seed;
- output hash;
- result status;
- retry index;
- direct cost;
- failed attempts as well as successful attempts.

`JsonlProvenanceLedger` writes outside the repository with mode 0600. The in-memory ledger remains for tests.

Unknown cost remains unknown and makes cost-per-accepted-output incomplete rather than silently zero.

## F4 — Private asset hygiene

Benchmark source references committed to Git must be opaque `private-asset://` or `asset://` aliases.

The V0 rejects as committed source truth:

- file paths;
- public/private HTTP URLs;
- screenshots;
- AI-generated images;
- assets without confirmed rights.

Private benchmark directories and output directories are ignored in Git.

## Local verification

The hardening implementation was exercised in an isolated Node test harness before push:

- 30 tests
- 30 passed
- 0 failed

This is not a substitute for running the complete repository suite on the branch and for an independent re-audit.

## Remaining rule

No Creative Fidelity benchmark result counts until:

1. exact model artifact hashes are recorded;
2. the private 10-product dataset is mounted outside Git;
3. the durable ledger path is configured outside Git;
4. the provider/local adapter records its output hash, cost and retry state;
5. the independent audit confirms the hardening.
