# C2-B — Qwen Image IMAGE_EDIT adapter and the first controlled live run

**Status: ADAPTER IMPLEMENTED AND TESTED WITH FAKE RESPONSES. NO LIVE CALL HAS BEEN MADE** (credentials are not provisioned). Nothing was sent to Alibaba, no credential was created or requested by this work, and no second provider was used.

## 1. What was added (on the existing Alibaba lane, `src/marketing-creative/alibaba/`)

| File | Role |
|---|---|
| `qwen-image-edit.js` | `editProductImage`: ONE `IMAGE_EDIT` call of `qwen-image-3.0-pro` on the Frankfurt-pinned lane; `buildProductEditPrompt` (ephemeral prompt); `imageInfoOf` |
| `edit-acceptance.js` | `evaluateProviderEdit`: runs the IDENTITY_PRESERVE fidelity gate on the provider output; the only creator of an accepted provider candidate |
| `scoped-media-authorization.js` | (C2-A) the scoped clearance the adapter requires |
| `output-store.js`, `journal.js` | additive: `readBytes` on both stores; journal rows may carry latency, usage, input / prompt hashes, clearance id |
| `scripts/run-c2-habb-edit.mjs` | `--check` (no network) and `--live` (exactly one provider call) |

Rules enforced by code and tests: region `eu-central-1` only (no cross-region); `qwen-image-3.0-pro` only (no silent model fallback); no automatic retry (a retry can be billed again); the scoped clearance is checked from the **real bytes** before the budget is reserved and before anything is sent; the provider prompt is built from a structured request and only its hash is recorded; the request must declare `NO_CRITICAL_TEXT` and the prompt forbids any added text; `prompt_extend` is off so the provider cannot rewrite the instruction; one output image; the output is stored outside the repository and is validated as an image; no key, data URI, signed URL or prompt text ever reaches a journal or a result; the spend guard caps cost and image count.

**A provider output is not a candidate.** It becomes one only through `evaluateProviderEdit`, which measures IDENTITY_PRESERVE itself and registers the accepted result privately, so a hand-made object is never an accepted candidate. Statuses: `PROVIDER_OUTPUT_FIDELITY_PASS`, `PROVIDER_OUTPUT_FIDELITY_FAIL` (with the exact failed observations; nothing is improved afterwards), `BLOCKED`. None of them means "creatively successful": the deterministic text composition and the Creative Critic come after a fidelity PASS and are not part of this patch.

## 2. Required environment variables

| Variable | Required | Where it comes from |
|---|---|---|
| `ALIBABA_MODEL_STUDIO_API_KEY` | yes | Model Studio console, **Germany (Frankfurt)** region, API Key page: "Create API Key". Copy the key from the confirmation dialog immediately (it cannot be shown again). |
| `ALIBABA_MODEL_STUDIO_WORKSPACE_ID` | yes | Model Studio console home page of the **Frankfurt** region: click the image icon in the upper-right corner; the dialog shows the Workspace ID. |
| `ALIBABA_MODEL_STUDIO_REGION` | no (default and only value `eu-central-1`) | leave unset |
| `ALIBABA_QWEN_IMAGE_MODEL` | no (default and only value `qwen-image-3.0-pro`) | leave unset |
| `ALIBABA_MODEL_STUDIO_TIMEOUT_MS` | no (default 120000) | leave unset |
| `NORDLA_PRIVATE_DIR` | no (default `~/nordla-private/c2-habb-benchmark-001`) | a folder OUTSIDE any repository |

The legacy `DASHSCOPE_API_KEY` is deliberately not read.

## 3. Provisioning instructions

Official sources: [Get an API key](https://www.alibabacloud.com/help/en/model-studio/get-api-key), [Get the App ID and Workspace ID](https://help.aliyun.com/en/model-studio/obtain-the-app-id-and-workspace-id), [Select region and service scope](https://help.aliyun.com/en/model-studio/regions/). Frankfurt console (Workspace Management): `https://modelstudio.console.alibabacloud.com/eu-central-1?tab=globalset#/efm/business_management`.

1. Sign in to the Alibaba Cloud International console and open the Model Studio console. **Select Germany (Frankfurt)** in the region selector. Keys, endpoints and model lists are per region and cannot be used across regions.
2. In **Workspace Management**, create a **dedicated workspace** for Nordla C2 (service deployment scope Global/EU for Frankfurt, as the console proposes) so the key and the spend are isolated from anything else.
3. Copy the **Workspace ID** (image icon, upper-right corner, in the Frankfurt console).
4. On the **API Key** page of the Frankfurt region choose "Create API Key", select that workspace, and under **Permissions** choose **Custom**: limit the **Access Scope** to the models you need (`qwen-image-3.0-pro` now) and, if your network allows, add an **IP whitelist** (up to 20 entries). Copy the key.
5. Check in the Frankfurt model list that **`qwen-image-3.0-pro` is available and enabled for that workspace**. Alibaba's API reference does not state its regional availability; if it is not available the first call fails with a provider error and **no fallback happens**. Also confirm billing is active and set a budget alert in the Alibaba console (the script's own spend cap is 0.25 EUR and one image).
6. Zero Data Retention: ZDR is only for eligible enterprise customers of the International site and ZDR-enabled workspaces. Standard retention is up to 30 days. This work does **not** claim ZDR; if your workspace has it, give me the evidence and the authorization record can state it.
7. Put the two values **only in your own terminal session** (never in a file in Git, never in chat). PowerShell:

```powershell
$env:ALIBABA_MODEL_STUDIO_WORKSPACE_ID = "<workspace id>"
$env:ALIBABA_MODEL_STUDIO_API_KEY = "<api key>"
node scripts/run-c2-habb-edit.mjs --check
```

`--check` makes no network call: it verifies the credentials are present, the region, the real asset's pinned hash and the scoped clearance, and reports `READY_FOR_ONE_LIVE_CALL (nothing was sent)`. The live call (`--live`) is made only by the run that follows, once and with a lock file that refuses a second attempt. Rotate or delete the key when C2 V0 calibration is done (Alibaba: "Disable", "Reset" or "Delete").

Input limits of the edit API (official): JPG/PNG/WEBP/…; width and height 1–8000 px (384–2048 recommended); up to 10 MB; the output total pixels between 512×512 and 2048×2048. The real asset is a 1152×1536 JPEG.

## 4. First live transformation (when credentials exist)

One `IMAGE_EDIT` request, output size 1152×1536, goal: keep the exact personalised case identity; replace the raw dark tabletop with a clean, bright premium retail studio environment; make the case dominant; keep the camera module (three lens openings and the flash bump), the printed artwork and the printed quotation; no text, logo, price or watermark in the provider pixels. Then `IDENTITY_PRESERVE` on the output. A FAIL stops there and reports the failed observations; a PASS leads to the deterministic Nordla text composition and the first Creative Critic pass (not yet implemented).

**Known measurement limit to expect:** the identity registration allows scale and translation only. A provider that changes the camera angle or perspective of the case will fail the registration; that is a real finding about the edit, not a reason to loosen a tolerance silently.
