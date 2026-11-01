# Nordla Création: premier essai réel (préparé, non lancé)

Facts read on 2026-11-01 in the Alibaba Cloud Model Studio documentation. Re-verify before the trial; the script also checks the provider's free model list before any paid call.

## Frankfurt: two deployment scopes, chosen when the workspace is created
- **EU**: inference stays in the EU.
- **Global**: "any available node, including Chinese mainland and overseas". Data is stored in Frankfurt, but inference can run anywhere.
- **No free quota in Frankfurt**: the 1M free tokens over 90 days apply to Singapore only.
- Standard retention of prompts and responses: up to 30 days. Zero Data Retention is for enterprise customers only, after an assessment. API data is not used for training.

| Model | Frankfurt scope | Input | USD / M in, out (≤32k) |
|---|---|---|---|
| qwen3.8-max | **Global only** | text | 1.65 / 4.951 |
| qwen3.7-plus | Global only | text, image, video | 0.276 / 1.101 |
| qwen-plus | EU and Global | text only | 0.40 / 1.20 (EU) |
| **qwen3-vl-plus** | **EU and Global** | text, image, video | **0.20 / 1.60 (EU)** |
| qwen3-vl-flash | EU and Global | text, image, video | not read |
| qwen3.8-flash | sources disagree | text, image, video | not used |

**Recommendation: qwen3-vl-plus, EU workspace.** It is the only model that keeps inference in the EU and also reads images. One model can therefore frame, imagine, stage AND critique the renders. qwen3.8-max is stronger on paper, but it cannot run in the EU scope.

## Decisions taken by the owner (2026-11-01)
- Model **qwen3-vl-plus**, Frankfurt, **EU** workspace.
- First trial on **one product**: the black TYESO bottle, 750 ml.

## The change outside src/creative-autonomy: applied
`src/marketing-creative/alibaba/config.js` now allow-lists `qwen3-vl-plus` next to `qwen3.8-max`.
- The default model, the image and video lists, the region and the SpendGuard price table are unchanged. `test/creative-autonomy-eu-model.test.js` covers this.
- The same test runs the whole route against a recording network double, with nothing sent to Alibaba. It shows that FRAME, IDEATE, ART_DIRECT, STAGE and the critic all call `qwen3-vl-plus` on `{workspace}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`.
- Parameters sent: only the documented ones (model, messages, temperature, max_tokens, enable_thinking=false, response_format json_object for the text stages).
- Images: an inline base64 PNG for the critic only. No streaming, no tools, no image URL.
- The key appears only in the Authorization header, never in the journal.

## Plans (updated 2026-11-01, 08:34 decision)
- **Ideation trial, text only**: plan **`trial-61e7eeb84a2de902`**, FROZEN in `plan-trial-61e7eeb84a2de902.json`. It supersedes `trial-b7c58aac7b7a59f3` and `trial-2d159b21c7ca20db`.
  - The SHA-256 of the full Shopify snapshot is bound: `2e0f33fe…a6ca`, identical to the live product sheet read on 2026-11-01. A change of price, description, stock or any variant gives a new id.
  - Objective given to Nordla: « Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB ».
  - The objective, the Shopify snapshot, the variant, the format and the HABB brand rules are now bound to the plan id. Before this fix, the objective was not.
  - 9 text calls: FRAME, IDEATE, SELECT (Nordla's own judgment of its concepts, existing Brain stage), 3 ART_DIRECT, 3 STAGE. No image is read or sent; nothing is rendered.
  - Expected ≈ 0.013 €; worst case ≈ 0.06 €; ledger ≤ 0.23 €; ceiling 1.50 €.
  - The report (`RAPPORT.md`) is built from the trace only and quotes the model's words as they came.
  - Status at the end: IDEATION_ONLY_NOT_A_VISUAL. It is not a visual production.
- **Full trial**: its plan id is computed from the HABB photo once it is chosen (the supplier photo is excluded: its rights are not established).
- The earlier id `trial-295639a1d700269b` is superseded: the limits now include the mode.

### Three money figures, kept apart
| Figure | Value | What it is |
|---|---|---|
| ESTIMATE, expected (full trial) | ≈ 0.03 € | measured prompt sizes × list price of qwen3-vl-plus (EU) |
| ESTIMATE, worst case | ≈ 0.12 € | every answer at its cap |
| CEILING, application | **1.50 €** | the SpendGuard refuses any call whose worst case would cross it, before sending |
| CEILING, ledger | ≤ 0.48 € | what the SpendGuard books; it prices at the qwen3.8-max rate with USD = EUR, so it runs higher than the real cost; it is a safety ledger, not a bill |
| USAGE | after the run | the tokens Alibaba reports in each response, priced at the list price; computed by the script |
| INVOICE | after the run | only in the Alibaba console (Billing); checked by hand |

## The key
- The key is never sent in a chat, written in a file of the repository, or put in a document.
- Option A: environment variables set by the owner in the session's environment settings (`ALIBABA_MODEL_STUDIO_API_KEY`, `ALIBABA_MODEL_STUDIO_WORKSPACE_ID`).
- Option B: a file named by `NORDLA_ALIBABA_SECRETS_FILE`. The script refuses it if it lies inside a git work tree or is readable by anyone else (chmod 600 required).
- The script prints only "présente / absente". Outputs and traces must also sit outside any git work tree.
- Use a dedicated key for this workspace. Revoke it after the trial if it is not reused.

## Photo rights
Status: **UNVERIFIED**. The script refuses to execute until `NORDLA_PHOTO_RIGHTS=OWNER_CONFIRMED`.
- The trial photo (1400 × 1400, SHA-256 `44bd4535…`) is the file sent in the conversation. Its only metadata is "HostComputer: imagery4": no author, no copyright. It matches none of the Shopify image sizes.
- The 14 images on the Shopify product are TYESO marketing files (`TYESO_Wander_…_20oz.webp`, `318.jpg`) plus one imported through cdn.dropmagic.ai. Nordla's own asset library classifies these names as `SUPPLIER_IMAGE`: the right to republish is not established. Shopify stores no rights field.
- Ways to clear it: written permission from TYESO covering advertising use and processing by an AI provider, or a HABB photo of the black bottle taken in the shop (`HABB_PHOTO`, owned).
- Note: the Shopify file names say "20oz" (about 590 ml) while the product title says 750 ml.

## Visual critic
`scripts/creative-autonomy-media-authorization.mjs` drafts the media record for the photo. The draft is inactive by construction (`revoked: true`, retention not acknowledged): the existing guard refuses it with RETENTION_NOT_ACKNOWLEDGED. It is activated only after the owner agrees. No image leaves the machine before that.

## First real attempt: trial-61e7eeb84a2de902 (2026-11-01)
- 5 real answers from Alibaba (FRAME, IDEATE, SELECT, ART_DIRECT, STAGE), then a stop at STAGE: `BRAIN_TEXT_INVALID` on `stage.rationale` (361 characters for a 300 limit).
- The ART_DIRECT answer contained leaves and foliage. At that time HABB's rules were not checked at that stage.
- The single attempt of this plan is used. Its lock stays in place.

### Corrections (no contract weakened)
- **Prompt**: STAGE asks for ONE sentence of about 180 to 220 characters. The hard limit stays 300.
- **HABB rules from ART_DIRECT on**:
  - The rules are given as a hint from the first call, and the answer is checked: atmosphere, materials, light, narrative and secondary elements, rationale. `forbidden_decorative_noise` is exempt, because that is where the model names what must not appear.
  - The verb "leaves" and "feuille de papier / de métal…" are not counted as foliage.
  - The list adds fern, frond, botanical, vegetation, greenery and verdure.
- **Bounded contract repair**:
  - When an ART_DIRECT or STAGE answer is valid JSON but breaks a rule (length, forbidden word, missing key…), Nordla may ask the same stage once more, with the exact field and rule.
  - The number of repairs is a plan limit (`max_repair_calls`), so it is part of what the owner authorises. The default is 0.
  - There is never a repair after a provider failure, never two repairs for one call, and every repair goes through the same SpendGuard, call cap and journal as any other call.
  - The refused answer stays in the trace.
- **New plan**: `trial-dd94896e8b89e81e`, PROPOSED and not authorised. It is identical to the previous one, plus `max_repair_calls: 2`.
  - Calls: 9 planned + up to 2 repairs.
  - Expected ≈ 0.015 €; worst case ≈ 0.073 €; ledger ≤ 0.29 €; ceiling 1.50 €.

### Offline replay of the 5 real answers
`scripts/creative-autonomy-replay.mjs --trial <trial folder> --product gourde-noire --diag <new folder>`
- The trial folder is read-only: every file is hashed before and after, and the run fails if anything changed. The lock is untouched.
- The answers are copied to the diagnostic folder and judged against the current contracts.
- No network, no new answer. The replay cannot continue the run: every stage after the last recorded answer needs a new authorised call.

## Autonomous review of 2026-11-01 (Claude, during the owner's absence; no live call)
Demonstrated weaknesses, fixed and covered by tests:
1. **The single attempt could be bypassed.** The lock lived in the output folder, so the same authorisation ran twice by changing `--out` (reproduced with a network double).
   - A machine-wide registry is now locked as well (`~/.nordla/attempt-locks/<plan>.lock`, or `NORDLA_ATTEMPT_REGISTRY`).
   - A second attempt is refused at preflight, before any request.
2. **The Brain did not know HABB when framing.** The observation carried only the section names (identity, visual_rules…).
   - HABB's identity, voice, visual prohibitions and the facts rule are now given in the brief's public facts from FRAME on.
3. **Prohibitions came too late.** They are now checked from IDEATE on, on every concept field that describes what is shown or told (not on the model's own list of risks), then at ART_DIRECT and STAGE.
4. **Invented capabilities were not checked.** Insulation, keeping drinks cold or hot, durations, leak-proof, unbreakable, BPA-free, eco claims, made in, guarantee and superlatives are refused unless the verified Shopify text states the same capability. Patterns are tuned so that staging words ("the light keeps the scene cool", "7h du matin") are not refused.
5. **`\b` does not work with accented letters in JavaScript**, so "étanche" and "écologique" escaped the check. Boundaries are now Unicode-aware.
6. **Repairs were limited to ART_DIRECT and STAGE.** The repair note is now appended to the stage's own instruction, so FRAME, IDEATE, SELECT, ART_DIRECT and STAGE can all be repaired, within the same budget for the whole run. The note does not leak into the next stage.
7. **The plan id did not bind the executed code.** It now includes `code_sha256` (Brain, autonomy route, Alibaba lane, trial and report scripts), with line endings normalised so a Windows checkout gives the same id. Any code change gives a new plan id.
8. **Secrets file on Windows.** Node cannot read NTFS permissions. The file is now refused with an explicit message, and on Windows the key comes from environment variables.
9. **Privacy of the real answers.** Tests no longer read a folder inside the repository. They read `NORDLA_REAL_TRIAL_CALLS`, pointed at the replay's copy. The `.gitignore` refuses `brain-calls/`, `*.response.txt`, `real-trial-*`, `nordla-essais/`, `nordla-diagnostics/` and `.nordla/`. A test fails if a recorded answer appears in the repository.
10. **Local engines on Windows** default to `python`, not `python3` (FULL mode only).

Proven with tests on the real lane objects (Qwen port and SpendGuard, with a fetch double):
- the call cap stops an invalid answer from looping;
- the two-repair limit holds for the whole run;
- the SpendGuard refuses a call whose worst case would cross the ceiling, before sending it;
- a key without authorisation sends nothing.

Plan `trial-dd94896e8b89e81e` is superseded and was never authorised. The plan id to authorise is the one printed by `--plan` for the reviewed commit; see `procedure-windows.md`.

### Independent review (2 passes, same reviewer, read-only, offline)
- **Pass 1**: 11 defects (0 HIGH, 6 MEDIUM, 5 LOW).
  - Most serious: the attempt registry was chosen by an environment variable outside the plan.
  - The code fingerprint did not cover the critic, intelligence and branding modules, nor runtime preloads.
  - The Brain's JSON re-ask was not counted as a repair: 4 paid calls for one STAGE.
  - Negations in the facts allowed a claim.
  - Prefix matching refused "au cœur de Namur" and "Luxembourg".
- **Pass 2**: 8 of those fixed, 2 partly fixed, 1 not fixed (documented, see below), and 4 new defects introduced by the rewrites (negation windows too wide, among others).
- **All closed since, with regression tests**:
  - negations are bounded to their clause, and "not only" is not a negation;
  - claims phrased with "sans", "never" or "without" are claims;
  - "tient au frais 12 heures" and "jusqu'au soir" are caught;
  - the gitignore rules are scoped to the trial layout;
  - the attempt registry uses the account's home from the OS.

### Residual risks (accepted, documented)
- ~~**Final settle (F9)**~~ **FIXED**, without touching the shared budget module.
  - Before each text or vision call, `providers.js` (`guardSettlement`) prices the call's provable maximum:
    - input: UTF-8 bytes of every text + 512 tokens of template overhead (Qwen's tokenizer is byte-level BPE, so a token covers at least one byte);
    - images: priced from the PNG's IHDR header, at least 3 000 tokens each; an unrecognised image counts as 16 384;
    - output: always counted at its max_tokens cap.
  - The call is refused before being sent if the ceiling cannot absorb that maximum. Once the ledger has gone above the ceiling, every further call is refused.
  - `test/creative-autonomy-settlement.test.js` reproduces the overshoot without the guard (0.1189 € for a 0.11 € ceiling). It then shows that, through the guard, the ledger never goes above the ceiling. That check runs on 4 ceilings and on 40 random rounds mixing ASCII, accents, emoji and CJK, under the densest tokenisation the guard allows.
  - The trial plan now shows `CEILING_provable_max_ledger_eur`: ideation about 0.51 €, full mode about 1.13 €, both under 1.50 €.
- **node_modules** (LOW): installed dependency code is covered only through `package-lock.json`, not hashed file by file.
- **Windows attempt registry**: `os.userInfo().homedir` is used instead of `%USERPROFILE%`. Its independence from the environment variable on Windows has not been verified on Windows.
- **HABB guard**: patterns, not understanding. They reduce the risk and do not prove it absent. The owner's review of every proposal remains the last control.
- **Creative quality**: never measured with a real model on a complete run. The tests prove the mechanics only.

### Known test failures
See `echecs-de-tests-connus.md`. These are the secrets scan (two of the files are the frozen plan record and the superseded proposal), LG-2 (Chantier D) and Node 24 (China Sourcing). None is hidden by weakening a test.
