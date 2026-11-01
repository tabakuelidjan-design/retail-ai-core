# Windows procedure: update, offline tests, replay of the 5 real answers (no network, no cost)

Each block is to be pasted into a NEW PowerShell window. Replace the two paths at the top.

## 0. Paths
```powershell
$wt    = "C:\CHEMIN\VERS\retail-ai-core-worktree"   # the existing test worktree
$trial = "C:\CHEMIN\VERS\DOSSIER-ESSAI"             # the trial-61e7eeb84a2de902 folder (contains gourde-noire\brain-calls)
```

## 1. Update (offline session, no key loaded)
```powershell
Set-Location $wt
Remove-Item Env:ALIBABA_MODEL_STUDIO_API_KEY, Env:ALIBABA_MODEL_STUDIO_WORKSPACE_ID, Env:NORDLA_ALIBABA_SECRETS_FILE, Env:NORDLA_TRIAL_AUTHORIZATION -ErrorAction SilentlyContinue
git status --short                      # must print nothing
git fetch origin feature/creative-autonomy-v0
git merge --ff-only origin/feature/creative-autonomy-v0
git rev-parse HEAD                      # must equal the SHA given in the report
npm ci
```

## 2. Offline tests
```powershell
node --test test/creative-autonomy-guard.test.js test/creative-autonomy-reliability.test.js test/creative-autonomy-eu-model.test.js test/creative-autonomy.test.js test/alibaba-journal-repository-root.test.js test/marketing-creative-alibaba.test.js
```
Expected: 0 failures. Skipped: the real Blender test, plus the 2 real-answer tests until step 4.

## 3. Replay the 5 real answers (the trial folder stays read-only)
```powershell
$diag = Join-Path $env:USERPROFILE "nordla-diagnostics\replay-61e7eeb84a2de902"   # must not exist yet
node scripts/creative-autonomy-replay.mjs --trial $trial --product gourde-noire --diag $diag
Get-Content (Join-Path $diag "REPLAY.md")
```
- The console shows statuses only, never the model's text.
- Exit code 4 means a file in the trial folder changed during the replay, which must not happen. The lock is never touched.
- `REPLAY.md` and `brain-calls-copy\` contain the real answers. They stay in `nordla-diagnostics`, outside any repository. The `.gitignore` also refuses `brain-calls/` and `*.response.txt` as a safety net.

## 4. The 2 tests on the real answers (read from the replay's COPY)
```powershell
$env:NORDLA_REAL_TRIAL_CALLS = Join-Path $diag "brain-calls-copy"
node --test test/creative-autonomy-reliability.test.js
Remove-Item Env:NORDLA_REAL_TRIAL_CALLS
```
Expected:
- the STAGE answer is refused on `stage.rationale` (length over 300: 351 characters for the recorded answer);
- the ART_DIRECT answer is refused by HABB's rules (leaves / foliage).

## 5. Plan id (nothing is sent)
```powershell
node scripts/creative-autonomy-trial.mjs --plan --ideation --out (Join-Path $env:USERPROFILE "nordla-essais\plan-check") --product gourde-noire
```
- The `plan_id` and `code_sha256` must be identical to those in the report.
- If they differ, do not authorise anything: the code or the data on this machine is not the code reviewed.
