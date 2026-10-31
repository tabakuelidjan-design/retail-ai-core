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

## The one change outside src/creative-autonomy (NOT applied, needs the owner's authorisation)
The Alibaba lane allow-lists one text model. Adding the recommended model is one line. No port is rebuilt.

```diff
--- a/src/marketing-creative/alibaba/config.js
+++ b/src/marketing-creative/alibaba/config.js
 const ALLOWED_MODELS = Object.freeze({
-  text: new Set(['qwen3.8-max']),
+  text: new Set(['qwen3.8-max', 'qwen3-vl-plus']),
```
The SpendGuard keeps pricing every call at the qwen3.8-max rate with USD = EUR. It therefore over-reserves for qwen3-vl-plus, so the 1.50 € ceiling triggers before the real spend reaches it.

## Plan (scripts/creative-autonomy-trial.mjs --plan, no network)
- Plan id: `trial-b7d8b8a6c7c6a28b`. It is bound to model, scope, region, limits and products; changing any of them gives a new id.
- Calls per product: 20 maximum.
  - Text: FRAME 1, IDEATE 1, ART_DIRECT 3, STAGE 3, refinements 6.
  - Vision: 6 critiques.
- Forecast for both products:
  - Expected: about 0.06 €.
  - Worst case (every output at its cap): about 0.24 €.
  - Maximum reserved by the SpendGuard: 0.97 €.
  - Hard ceiling: 1.50 €.

## Safety
1. **Gate.** Nothing is connected without `NORDLA_TRIAL_AUTHORIZATION` equal to the plan id, even when a key is present.
2. **One attempt.** The live-call lock is never released by code.
3. **Free model check.** The provider's model list must show the model before the first paid call.
4. **One SpendGuard of 1.50 € for the whole trial.** The worst case is reserved before each call, and `BUDGET_EXCEEDED` stops both products.
5. **Call limits.** 20 text calls and 6 vision calls per product. Each output is capped at 4,000 tokens (text) or 2,200 tokens (vision). There is no retry and no model fallback.
6. **Journal.** Every call goes to `<plan>.calls.jsonl`: model, region, request id, tokens, estimated and settled cost, failure reason. No secret is written.
7. **Vision.** One owner record for the product photo (`EXTERNAL_MEDIA_AUTHORIZATION`, transmissible: the source and images derived from it, for this purpose only, retention 30 days, ZDR NOT_CONFIRMED). Each render then gets its own clearance bound to its bytes. Without that record, the critic stays NOT_CONNECTED and the creative quality is reported as "not measured".
8. **Nothing is published.** Every proposal ends as PROPOSED_FOR_OWNER_VALIDATION.

## Product photos
- Bottle TYESO TS-8771C, black: real photo, cut out automatically (CUT_OUT).
- Case iPhone 12: the Shopify CDN cannot be reached from this environment. The available copy is an illustrated mockup (grey gradient, baked shadow, caption "Apple iPhone 12"), refused by the examination (NEEDS_CLEAN_ASSET). Needed: a PNG with a transparent background, or a plain background with no shadow and no caption, exported from HABB's mockup pipeline. The product is not retouched to pass the check.
