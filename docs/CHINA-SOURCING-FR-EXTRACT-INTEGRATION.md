# China Sourcing - controlled integration of the French extraction fix

Branch `integration/sourcing-fr-extract-v1`, cut from the CURRENT `claude/nordla-core-p0`. Nothing merged, deployed or re-read.

## Exact SHAs (checked 2026-10-17)

| Ref | SHA |
|---|---|
| `fix/sourcing-extract-moq-leadtime` (authorised) | `0605a703f3fb4250cf07fba8c93c60fb24bf6562` |
| `claude/nordla-core-p0` (base, unchanged) | `0f83fd2b28f7114ba2919557fc9d32d031104cc4` |
| `release/sourcing-staging` (unchanged) | `a7ecccdc49d28def444bb6db0b68865372c55286` |
| `main` (unchanged) | `a9d0e2fb86e29755104380e99623018735291647` |
| **`integration/sourcing-fr-extract-v1`** (this branch) | see the PR; tip `2cc952dba2c80942c21d05423ce6eb90ccf5af39` when this report was written (the report commit comes after) |

`core-p0` is the merge base of the fix branch, so the fix is exactly "core-p0 + our changes". The fix branch was cut from `release/sourcing-staging`, so it also carries `a7ecccd` (`railway.json` of the staging service): that file is NOT taken.

## What is taken, what is not

| | |
|---|---|
| Taken (commit 531446e = cherry-pick of 8241ffd) | `extract/fr.js`, `extract/index.js`, `candidate-view.js`, `conversation.js`, `test/sourcing-extract-fr-terms.test.js`, `docs/CHINA-SOURCING-EXTRACT-FR-FIX.md` |
| Taken (commit 2cc952d, files from 0605a70) | correctable `quote.offeredQty` (`candidate-view.js`), `test/sourcing-offered-qty-contract.test.js`, `test/e2e/sourcing-french-note.e2e.js`, `test/e2e/sourcing-terrain-v2.e2e.js` (Incoterm card confirmed by name) |
| NOT taken | `.github/workflows/sourcing-extract-fix.yml` (temporary, branch-only), `railway.json` change of `release/sourcing-staging` |

## Conflicts with the rest of the convergence

Dry-run merges (`git merge-tree`) of the integration branch with: Parle à Nordla (`feature/parle-a-nordla-v2-voice`), Stock/Achats finalisation, Social publishing E, `integration/staging-candidate-final`, `integration/nordla-pre-china`, `integration/staging-activation-prep`, China mobile UX v2, China field v1, Marketing/Creative: **0 conflicts each**. Parle, Stock/Achat and the staging candidate are already inside `core-p0`; the fix does not touch their files. The fix only ADDS one fact key; consumers that enumerate keys (field answers, handoffs, procurement bridge, truth card) ignore unknown keys, and the full suite confirms it (below).

## Tests

- CI (existing workflow `nordla-integration-pre-china`, push on `integration/**`), run 39036721292 on 2cc952d: **full suite Node 20 success, full suite Node 24 success**. This includes Core, Parle, Stock/Achat, integration contracts and routing.
- China Sourcing workflow (`china-sourcing.yml`: sourcing unit + blocking phone suites, Node 24) only triggers on `feature/china-sourcing-**`, `core-p0` and pull requests. Pushing mirror branches did not trigger it and no dispatch token exists in this environment, so it will run when the PR is opened. Equivalent local run on this exact branch: see the results in the delivery message.
- Phone: the e2e suites run in a real Chromium-family browser through the DevTools Protocol at 360-430 px. They are not a physical phone.

## Railway candidate (proposal only)

`release/sourcing-staging` = `core-p0` + ONE commit (`a7ecccd`, root `railway.json`), release branch only, never merged back. Candidate update once the PR is merged into `core-p0` by the owner:

1. a NEW branch `candidate/sourcing-staging-fr-extract` from the merged `core-p0`,
2. cherry-pick `a7ecccd` onto it (or merge the new `core-p0` into a copy of `release/sourcing-staging`: only `railway.json` differs, so no conflict is expected),
3. CI exact on that SHA, then the owner decides whether `release/sourcing-staging` is moved to it (fast-forward, never force) and whether Railway redeploys.
Rollback: Railway redeploy of the previous release SHA `a7ecccd`; the new fact key is ignored by the old code (verified: the old code reads, confirms and continues a case containing it).

## Not done, on purpose

No merge, no push to `core-p0` / `release/sourcing-staging` / `main`, no Railway action, no re-reading of old notes. `case-mvcbnpmd` is validated separately, only on request.

## Local run on this exact branch (Windows, Node 24.19, Chrome, no `node_modules`)

- `test/sourcing-*.test.js`: 634 tests, 631 pass. The 3 failures are the known Windows / missing-dependency artefacts (`sourcing-ui-syntax` path separator, merchant-fit path, `sourcing-realistic` needs `pdfkit`); they pass on the Linux CI (Node 24 full suite, run 39036721292).
- Phone suites (real browser, 360-430 px): french-note 5/5, terrain-v2 20/20, field-v1 12/12, item-revision 8/8, price-currency 6/6, identification 5/5, origin-migration 7/7, photo-backup 6/6, hosted-signin 5/5, core-pilot 5/5, nordla-ask-ui 11/11.
