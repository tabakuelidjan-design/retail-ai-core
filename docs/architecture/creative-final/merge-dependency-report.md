# Creative 1–5 — merge / integration dependency report (2026-10-14)

Read-only analysis (git history and ESM import resolution; no test run on an extracted tree). **Nothing was merged, rebased, reset or pushed beyond this documentation. `main` untouched.**

## 1. Position
* `origin/main` = `a9d0e2f` ("Merge PR #5 finance-operations"). It is a linear ancestor of the Phase 5 tip `f9c8afd`: a **pure fast-forward** is possible. **Local `main` is stale** (`a5bd26c`, 10 Finance commits behind `origin/main`): update it before any work.
* Distance from `origin/main`: **345 commits** (337 non-merge + 8 merges), **851 files**, +118,891 / −577.
* Phase ladder (commits ahead of `origin/main`): c1-foundation `3d4f850` 227 → pre-c2 `8105a82` 306 → phase-1 `6f7a4e8` 309 → phase-2 `860d8a6` 313 → phase-3 `9f30628` 321 → phase-4 `3f858f5` 338 → phase-5 `f9c8afd` 345. The only tag is `creative-brain-baseline-2d5e885`.

## 2. What the branch contains
Of 337 non-merge commits: **95 pure Creative, 45 mixed (almost all Creative plus a shared file), 197 pure non-Creative** (≈ 140 commits are effectively Creative). The history is a chronological stack, not interleaved topic branches: commits 1–142 are 100 % non-Creative; the first Creative commit is #143 (`43bab23`, 2026-10-07, creative-fidelity v0); Creative then interleaves with Branding, Marketing M1–M4, Activation, Provider-connections and Socle.

Non-Creative lines present: **Finance** (≈ 85 commits, `src/finance`), **Core / sync / tenant** (13 sync, 4 tenant and 20 supabase-migration commits — **18 migrations**), **Analytics** (11), **Merchant Setup Wizard**, **`src/shared`** (79 files, a Finance design system), **Marketing M1–M4** (≈ 15), **Branding** (≈ 11), **Activation** (22 files), **Provider-connections** (18 files), **Socle** (`src/resources`), 135 docs commits, 44 CI commits. China sourcing is on other branches.

## 3. Dependencies of Creative on non-Creative code
| Dependency | Needed by | Class |
|---|---|---|
| `src/branding/{index,candidate-manifest,constants,expression-system}.js` (15 files transitively) | `creative-runtime/guardian-gate`, `creative-intelligence/*` (manifest, output-context, benchmark, pre-c2 probes), ≈ 12 tests | **HARD_DEPENDENCY** |
| `src/marketing/*` (28 files: M1–M4, creative-brief/candidate/handoff/validation, create-gate, …) | `creative-intelligence/validation.js`, m3 test world | **HARD_DEPENDENCY** (`phase3-contract.js`, `provenance.js` are already on `origin/main`) |
| `src/resources/*` (6 files) | `creative-intelligence/pre-c2-probes`, ≈ 9 tests | **HARD_DEPENDENCY** |
| `src/tenant/{connectors,index}.js` | via marketing | **HARD_DEPENDENCY** |
| npm `@resvg/resvg-js`, `harfbuzzjs`, `bidi-js` (commit `7faff71`) | rasteriser, typography | **HARD_DEPENDENCY** (package.json / lock) |
| `test/finance-privacy.test.js` (repo-wide secret/hash scan; Creative keeps adding exemptions) | the whole suite | **SOFT_DEPENDENCY** (an extracted branch fails without matching exemptions) |
| `NORDLA-DECISION-REGISTER.md` (NDR-P…) | docs | SOFT_DEPENDENCY (append-only; ID collisions possible) |
| `src/shared`, `src/finance`, `src/sync`, `src/shopify`, `src/metrics`, `src/supabase`, `src/analytics-premium`, `src/activation`, `src/provider-connections` | no Creative import found | **UNRELATED** |
| Finance commit "Creative + Dynamic Premium visual elevation pass" (`061fd78`) | name collision only | HISTORICAL_ONLY |

Minimal non-Creative set Creative needs: `src/branding/**`, 28 `src/marketing` files, `src/resources/**`, `src/tenant/{connectors,index}.js`, three test worlds, three npm packages, the privacy test and `THIRD_PARTY_NOTICES.md`. **Not run to confirm sufficiency.**

## 4. Shared-file conflict risk (only if `main` moves or Creative is extracted)
`package.json` HIGH · `package-lock.json` HIGH (regenerate, never hand-merge) · `test/finance-privacy.test.js` MEDIUM-HIGH · `NORDLA-DECISION-REGISTER.md` MEDIUM · `.github/workflows/*` MEDIUM · `.gitignore` LOW · `.gitattributes`, `THIRD_PARTY_NOTICES.md` LOW. Creative never edits Finance, Sync, Metrics, Buying or Supabase files.

## 5. Options
| Option | Verdict |
|---|---|
| (a) Creative paths only, applied on `origin/main` | **Does not run alone** (needs the 49 `src` files above + the privacy test). Avoid. |
| (b) Cherry-pick logical groups: tenant → branding → marketing M1–M4 → socle → deps → fidelity/Alibaba → brain/intelligence C1…C3 → phases 1–5 | Possible. "Creative only" in truth means Creative + Branding + Marketing M1–M4 + Socle + tenant (separate product lines needing their own review); hand-resolved conflicts in package.json, NDR, privacy test; 45 mixed commits to split. Use only if Creative must land without Finance/Analytics/Core. |
| (c) Stacked merge per phase | Gives rollback points but still carries all 197 non-Creative commits. |
| (d) Full shared history, as a **staged fast-forward** through the phase tips with CI at each stop | **Preferred technically**: conflict-free, clear rollback. Cost: 851 files and 18 supabase migrations land at once → large review/CI scope; the operational risk is in the migrations (not Creative). |

No rebase of shared branches is proposed; no force push.

## 6. Rollback points
Tag `origin/main` (`a9d0e2f`) as `pre-creative-merge` before any merge; tag each phase tip as it lands (`3d4f850`, `8105a82`, `6f7a4e8`, `860d8a6`, `9f30628`, `3f858f5`, `f9c8afd`); rollback = revert the merge commit(s) or reset `main` to the pre-merge tag (owner decision, never automatic). **None of these tags was created tonight.**

## 7. Risks
Stale local `main`; 18 Supabase migrations inside a "Creative" merge; the privacy test scans every tracked file (Creative hash-bearing JSON); Phase 5 CI evidence is run 38477140859 (read from the GitHub API on 2026-10-14).
