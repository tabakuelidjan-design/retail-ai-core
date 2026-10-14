# Creative readiness — re-attestation PREPARED, not done (owner decision pending)

Branch `claude/nordla-core-p0`. Nothing in `docs/architecture/creative-readiness.json` or `creative-brain-readiness.json` was changed.

## Why it is needed

The readiness gate (NDR-P22, `src/creative-readiness/index.js`) binds the attestation to `codeHash()` of **all** of `src/`, `test/`,
`scripts/`, `package.json` and `package-lock.json` (`src/creative-brain-benchmark/readiness.js`). Any change anywhere in those paths
invalidates it.

| Tree | codeHash | Gate |
|---|---|---|
| Attested (`verified_commit` 086fae1) | `7033e1980aaf0ef767f2df3220c1a9cb98431769` | READY at that commit |
| Reference `integration/nordla-pre-china` 4c07586 | `72ea9590f648f11f311e788f2819181975027099` | **already NOT_READY** (`ATTESTATION_IS_FOR_OTHER_CODE`) before this branch |
| After merging core-resilience only | `008093d39f5380072e949545d44b151083f53cb9` | NOT_READY |
| Head of this branch (P0 commits) | recompute: `node -e "import('./src/creative-brain-benchmark/readiness.js').then(m=>console.log(m.codeHash()))"` | NOT_READY |

What core-resilience changed on the Creative side: `src/creative-brain/model-port.js` now takes `jsonSlice` / `findDuplicateKey` from
`src/core-resilience/structured-output.js` (same algorithm, moved), keeps `parseAnswer` / `findCollapsedKey` unchanged, and drops the unused
`askModel`; `src/creative-brain-benchmark/runner.js` gained 4 lines from the resilience branch. The Brain contract-layer, protocol-repair,
readiness and core-resilience tests pass (69/69 targeted, then the full suite).

## What a re-attestation requires (NDR-P22), once the owner says yes

1. Freeze the code commit (no further change in `src/`, `test/`, `scripts/`, package files).
2. Full suite on Node 24 **and** Node 20, each from a clean clone (`npm ci`, `node --test test/*.test.js`): record tests / pass / fail / skipped.
3. Mutation sweep of each active component (PLANNING, BRAIN, CAMPAIGN, PRODUCTION, LAYERED_RUNTIME, REFINE, INTEGRATION, END_TO_END):
   `killed + survivors_documented = total` for each.
4. CI green on that commit.
5. Write `verified_commit`, `code_hash` and the evidence into both attestation files, then `node scripts/check-creative-readiness.mjs`
   must print `CREATIVE_PIPELINE_READY`.

Readiness levels stay as they are: no real provider is connected, nothing is validated live.
