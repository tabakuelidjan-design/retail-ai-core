# China Sourcing - runtime requirement and known test behaviour

**China Sourcing requires Node 24** (owner decision 2026-10-12, "Option A").

Why: the ASR benchmark helper (`tools/asr-bench/ws.mjs`) and the browser test helper (`test/e2e/cdp.js`) use the global `WebSocket`, which Node 20 does not have. On Node 20 the ASR bench test hangs (its loopback server is never closed after the lookup fails), the e2e scripts cannot start, and two Finance wall-clock performance tests also behave differently. Node 24 is green and is also what `finance-pg.yml` uses.

How it is enforced (China Sourcing only):
- `src/sourcing/runtime.js` (`assertSourcingRuntime`) is called when the sourcing server starts and fails with a clear message on Node < 24.
- `.github/workflows/china-sourcing.yml` runs on Node 24 only.
- The repository-wide `engines` field in `package.json` is **not** changed: it belongs to the whole repository (Railway reads it for the Finance deployment). Raising it is a separate owner decision.
- Node 20 compatibility is deliberately not pursued, and no Finance test was changed for it.

## Verified baseline (commit `ab38df0`, clean clone, Node 24.19)

| Suite | Result |
|---|---|
| `node --test test/sourcing-*.test.js` | 347 / 347 |
| `npm test` (whole repository) | 1865 / 1865 |
| `npm run sourcing:e2e` / `:fieldmode` / `asr:e2e` (Windows, Edge) | 18/18, 19/19, 7/7 |

## Known intermittent or environment-specific results (documented, not hidden)

| Test | Behaviour | Class |
|---|---|---|
| `sourcing:e2e:v1`, service-worker readiness wait (20 s) | failed 2 of 3 runs on a cold Edge, passed the third | intermittent (timing) |
| `sourcing:e2e:voice`, check 6 ("locuteur inconnu") | failed once, passed on the next runs | intermittent |
| `sourcing:e2e:fieldmode` checks 3, 4, 18 | fail on Linux Chromium in Docker (Node 24 as well as Node 20); pass on Windows with Edge | environment-specific (Linux/Chromium), cause not investigated |
| `sourcing:e2e:voice` | cannot run on a clean clone: it needs the local voice-bench model files (git-ignored) | environment |
| `real-tunnel` e2e | never run in CI: it opens a Cloudflare tunnel | by design |
| Finance `finance-accountant-export` VOLUME, `finance-treasury` PERFORMANCE | wall-clock bounds ("around/well under a second"); sensitive to CPU load (and to Node 20) | known wall-clock class, not sourcing |

The `e2e` job of the CI workflow is therefore informational (`continue-on-error`) until the Linux/Chromium differences are understood.
