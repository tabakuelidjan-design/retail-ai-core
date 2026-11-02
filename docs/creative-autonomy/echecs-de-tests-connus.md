# Known test failures — state on 2026-11-02 (branch `fix/creative-production-v1-audit-20261102`)

Full suite `node --test test/*.test.js`, 3 944 tests, Python 3.13 with numpy/Pillow/scipy:

| Node | pass | fail | skipped | failures |
|---|---|---|---|---|
| 20.20.2 | 3 912 | 11 | 21 | `finance-privacy` (Chantier D patch) + 10 China Sourcing tests (Node 24 required; `sourcing-asr-bench` hangs on Node 20 and was stopped) |
| 22.23.4 | 3 913 | 10 | 21 | `finance-privacy` (Chantier D patch) + 9 China Sourcing tests (Node 24 required) |
| 24.22.2 | 3 922 | **1** | 21 | `finance-privacy` (Chantier D patch) |

China Sourcing requires Node 24 by contract (`.github/workflows/china-sourcing.yml` runs it on Node 24 only; the server start checks it). Those failures on Node 20/22 are the documented requirement, not regressions.

## Fixed on this branch
- **LG-2** (`test/creative-production.test.js`): `resizePng` moved to `src/creative-intelligence/png-resize.js` (re-exported by the production module); `src/studio-compose/compose.js` imports it from there. The guard is unchanged.
- **finance-privacy, plan records**: the two full SHA-256 values in `plan-trial-61e7eeb84a2de902.json` and `plan-trial-dd94896e8b89e81e.json` are shortened to their first 16 characters with the git blob that holds the original file (history keeps them). The scan is unchanged. Note: this changes the text of the plan record documented as frozen; its content stays recoverable from the named blob.

## Earlier record (kept)

# Known test failures on `feature/creative-autonomy-v0` (documented, not hidden)

None of these failures is in the Creative Autonomy route. None of them is fixed by weakening a test.

## 1. `test/finance-privacy.test.js`: "no secrets, keys, tokens or hashes anywhere that could be committed"
The repository-wide scan refuses any 64-character hex string outside a short list of public integrity pins. It names 3 files:

| File | What it holds | Status | Why it is not changed here |
|---|---|---|---|
| `docs/chantier-d/e-proposals/alternative-to.patch` | a hex hash in a Chantier D patch | **already failing** on `80f66bd`, the Chantier D base commit, before any Creative Autonomy work | another module: out of scope |
| `docs/creative-autonomy/plan-trial-61e7eeb84a2de902.json` | `product_snapshot_sha256` and `brand_sha256`: SHA-256 hashes of PUBLIC data (Shopify snapshot, HABB brand rules), not secrets | added by `ea4dd9f` | **frozen** plan of the first real attempt: it must not change |
| `docs/creative-autonomy/plan-trial-dd94896e8b89e81e.json` | the same two public SHA-256 hashes | added by `e3a59c9` | plan proposed then superseded, never authorised; kept identical to preserve the plan history |

What was NOT done: no exception was added to the scan. An allow-list for these hashes would weaken a security check, even though these values are not secrets.

Prevention, in place:
- the trial and the replay write their plans, traces and answers only OUTSIDE any git repository (preflight check);
- `.gitignore` refuses the trial layout;
- `test/creative-autonomy-reliability.test.js` fails if a recorded answer or a trial file appears in the repository.

No new plan record with full hashes will be committed.

Owner's decision (one of):
1. `git rm` both plan records and keep them in private storage outside the repository. The history keeps them, but they are no longer tracked files.
2. Keep them and accept this known failure until Chantier D fixes its own file.
3. Shorten the hashes in `plan-trial-dd94896e8b89e81e.json` only (not frozen). That alone does not turn the test green: the two other files remain.

## 2. `test/creative-production.test.js`: LG-2 "the production is additive and offline…"
**Already failing** on `80f66bd`, before Creative Autonomy. `src/studio-compose/compose.js` (Chantier D) imports the production module, which LG-2 forbids. Out of scope.

## 3. China Sourcing (9 tests): "requires Node 24 or later"
This only happens in an environment running Node 22. These tests require Node 24, which the owner's Windows PC has (24.19.0).
