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

## Final plan
- Plan id: **`trial-295639a1d700269b`**. It is bound to the model, the EU scope, eu-central-1, the limits, the product (variant Noir) and the photo's SHA-256 (`44bd4535…2f34`). Any change produces a new id.
- Calls: FRAME 1, IDEATE 1, ART_DIRECT 3, STAGE 3, refinements up to 6, critiques up to 6.

### Three money figures, kept apart
| Figure | Value | What it is |
|---|---|---|
| ESTIMATE, expected | ≈ 0.03 € | measured prompt sizes × list price of qwen3-vl-plus (EU) |
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
