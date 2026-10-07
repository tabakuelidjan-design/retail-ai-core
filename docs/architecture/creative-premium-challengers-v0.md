# Creative Premium Challengers V0

Status: EXPERIMENTAL / NO PRODUCTION ROUTING

Purpose: compare premium specialists against the existing Alibaba lane on the same real HABB product before selecting any production default.

## Challenger A — OpenAI GPT Image 2.5 Sunburst

Pinned model:
- `gpt-image-2.5-sunburst-2026-09-08`

Use case:
- precise product-image editing;
- one real public product image as reference;
- high input fidelity;
- product identity/text/logo/geometry must still pass Nordla Fidelity Gates.

Official API:
- `POST https://api.openai.com/v1/images/edits`
- URL image input;
- PNG base64 output downloaded/stored immediately.

V0 remains PUBLIC-only and rejects faces/personal data.

## Challenger B — Runway Recipes

Pinned recipes:
- Product Campaign Image `2026-06`;
- Product Ad `2026-07`.

Product Campaign Image:
- 1 product image + creative brief;
- 4 campaign images;
- official price: 36 credits per output image = 144 credits/call.

Product Ad:
- 1-10 product images;
- 5 second 720p smoke target;
- official price: 200 credits for 4s + 36/additional second = 236 credits for 5s.

Runway credits are $0.01 each, so the two-recipe challenger smoke reserves 380 credits (~$3.80), excluding tax.

Provider output URLs are ephemeral and are copied immediately into Nordla-controlled local storage.

## Comparison rule

No automatic winner.

Compare:
- product identity;
- exact logo/text;
- geometry/piece count;
- material/color;
- realism;
- AI look;
- creative quality;
- retries;
- latency;
- cost per accepted output.

The existing Alibaba results remain the baseline:
- Qwen Image 3.0 Pro image;
- Wan 3.0 5s video.

Nordla Sandwich remains the fidelity reference because it preserves real product pixels instead of asking a generative model to reconstruct the SKU.

## Credentials

Never commit:
- `OPENAI_API_KEY`;
- `RUNWAYML_API_SECRET`.

Live challenger smoke command is intentionally separate from Alibaba and is not run in CI.

Required environment:
- `OPENAI_API_KEY`
- `RUNWAYML_API_SECRET`
- `PREMIUM_CHALLENGER_PRODUCT_URL`

Command:
- `npm run marketing-creative:challengers:smoke`
