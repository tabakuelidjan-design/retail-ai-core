# China Sourcing — checkpoint (2026-10-13)

Purpose: a durable, self-contained statement of what was done on the China Sourcing recovery line, what is verified and what is not, so that work can resume without the conversation. Documentation only; no code is changed by this file.

## 1. Branches and who owns what

| Branch | Tip | Pushed | Notes |
|---|---|---|---|
| `feature/china-sourcing-field-mode` | `3cd4dc7` | yes | the original branch; **left untouched** on purpose (its WIP was checkpointed elsewhere) |
| `feature/china-sourcing-v1-recovery` | `84828fe` (+ this file) | yes | the recovery line of this checkpoint: WIP checkpoint, Node 24 standard, P11-lite comparison |
| `feature/china-sourcing-field-v1` | `eb6be01` | yes | **built by another session on top of `84828fe`** (3 commits: `9f9a273` China Sourcing Field V1 — one field workflow: offer import, review, truth card, merchant fit, deal intelligence, field comparison, negotiation coach, questions to ask, what changed, supplier memory, evidence status, dependency-aware recompute, resumable workspace, Salon UI at 390 px; `02784d3` explicit merchant profile via env, real-phone acceptance flow, HABB profile inputs list; `eb6be01` HABB calibration sheet and a read-only real-quote check). **Not reviewed or verified by this checkpoint.** |

The worktree `C:\Users\etaba\Desktop\retail-ai-core-finance-resume` is currently on `feature/china-sourcing-field-v1` (another session's work). This file was committed from a temporary worktree of the recovery branch so as not to disturb it.

## 2. What the recovery line did (all verified on a clean clone of `84828fe`, Node 24.19)

1. **Checkpoint of the WIP** (`69a1e14`): 98 files (the voice engine in a Worker, turns, product observer / hypothesis, needs / coverage, spoken / spec extraction, a market-search request stub that answers `PROVIDER_NOT_CONFIGURED`, Conversation First UI updates, the ASR lab tooling — no keys, env-only, nothing called — and the sourcing tests). Classified file by file; nothing ambiguous, nothing from Core / shared / Finance / Buying / tenant / Supabase / Creative.
2. **Node 24 standard** (`719d4be`, owner decision "Option A", 2026-10-12): `src/sourcing/runtime.js` fails clearly on Node < 24 (called by the sourcing server at start); `.github/workflows/china-sourcing.yml` runs on Node 24 only (unit job required; e2e job informational); `docs/CHINA-SOURCING-RUNTIME.md` records the baseline and the known flakes. The repository-wide `engines` field is **deliberately not changed** (Railway reads it for Finance).
   Why: Node 20 has no global `WebSocket`; the ASR bench test hangs (its loopback server is never closed after the lookup fails), the e2e CDP helper cannot start, and two Finance wall-clock performance tests also behave differently. Node 20 compatibility is not pursued.
3. **P11-lite multi-offer comparison** (`6e541f3`, `84828fe`): `src/sourcing/core/comparison.js` — 2 to 5 existing cases; cells keep VERIFIED / SUPPLIER_CLAIM / ESTIMATED / UNKNOWN / CONFLICT; an UNKNOWN is never a value; no price-only winner (PREFERRED only by multi-dimension dominance among viable offers and never while another non-blocked offer is unknown or in conflict); roles PREFERRED / VIABLE / INVESTIGATE / BLOCKED; a recommendation envelope BUY_CANDIDATE / INVESTIGATE / PASS that is **always** `RECOMMENDATION_PENDING_APPROVAL`, `businessDecision: NOT_DECIDED`, `canCommitMoney: false` (SOURCING_EVALUATION is kept apart from BUSINESS_DECISION; the decision layer is not imported — a test checks the imports); deterministic ASK NEXT (open conflict > contradicting document > product not identified > no price > landed-cost inputs > missing document > MOQ > terms > carton > lead time); cross-case conflict when the same supplier and model are quoted differently; resumable (`comparisonDefinition` / `recomputeComparison`); mobile card view (`toMobileView`, lines ≤ 78 characters, FR/EN). Contract and limits: `docs/CHINA-SOURCING-P11-LITE-COMPARISON.md`. 17 tests (`test/sourcing-comparison.test.js`) + 2 (`test/sourcing-runtime.test.js`).
   Not built: a UI screen for the comparison, persistence of comparison sets, platform APIs, supplier entity, cash/VAT, Buying handoff.

## 3. Results

| Check | Result |
|---|---|
| Sourcing unit tests (`test/sourcing-*.test.js`), clean clone, Node 24 | 366 / 366 |
| Full suite (`npm test`), clean clone, Node 24 | 1884 / 1884 |
| Provider-free e2e (Windows, Edge): `sourcing:e2e`, `:fieldmode`, `asr:e2e`, `:v1` | 18/18, 19/19, 7/7, 13/13 |
| Node 20 (Docker, as a check, not a target) | sourcing unit 330/330 without the ASR-bench file (which hangs); full suite 1846/1848 (two Finance wall-clock tests; `finance-treasury` PERFORMANCE fails deterministically on Node 20 in Docker, passes on Node 24 in the same Docker) |
| Linux Chromium (Docker) | `fieldmode` checks 3, 4, 18 fail on Node 24 as well as Node 20 (Edge on Windows passes 19/19); `sourcing:e2e` 18/18 on Node 24 |
| CI | the workflow was pushed; **its result was never read** (no GitHub CLI, private repository) |
| Provider calls | 0 |

## 4. Known flakes and environment-specific results (documented, not hidden)

`sourcing:e2e:v1` — service-worker readiness wait (20 s) failed 2 of 3 runs on a cold Edge; `sourcing:e2e:voice` check 6 ("locuteur inconnu") failed once, then passed; `voice` e2e cannot run on a clean clone (needs git-ignored model files); `real-tunnel` e2e is never run (it opens a Cloudflare tunnel); `finance-accountant-export` VOLUME and `finance-treasury` PERFORMANCE are wall-clock tests sensitive to CPU load. All listed in `docs/CHINA-SOURCING-RUNTIME.md`.

## 5. Decisions on record

* Option A: China Sourcing requires Node 24 (2026-10-12). Root `engines` stays `>=20`.
* Sourcing recommends; the merchant / the Core decides. No import of the decision layer from Sourcing (Nordla constitution).
* Human-in-the-loop discovery; no platform scraping, no Alibaba / 1688 / WeChat APIs, no live ASR provider, no OCR provider in V1.
* Open owner decisions: raise the root `engines` to `>=24` (also changes the Railway / Finance runtime) — recommended: no; what to build next (UI screen for the comparison, P6 offer import, mapping the recommendation into the decision layer); whether to investigate the Linux Chromium e2e failures or keep the CI e2e job informational.

## 6. Exact next steps

1. Review `feature/china-sourcing-field-v1` (another session's work, 3 commits on top of `84828fe`): run the sourcing unit tests and the full suite on Node 24 in a clean clone, read its changed files, and decide whether it supersedes the comparison UI step.
2. Read the GitHub Actions result of `china-sourcing.yml` for the branch you intend to keep, and record it.
3. Then, on an owner decision only: P6 offer import, the comparison screen, supplier entity, or the Buying handoff (needs a Core contract; BLOCKED BY CORE until one exists).

Rules in force: no provider calls, no change to Core / Finance / Buying / tenant / shared / Supabase from the China branch, no change to Creative, no HABB / Shopify changes, one heavy local task at a time.
