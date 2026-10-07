# Nordla Marketing Creative — Premium Challengers V0

Status: BENCHMARK ONLY

Nordla keeps Alibaba/Qwen/Wan as the first working premium lane. This checkpoint adds two specialist challenger lanes without changing production routing.

## Challengers

### OpenAI — GPT Image 2.5 Sunburst

Official OpenAI pricing currently lists `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`. Sunburst is retained as the precision-image challenger for final fidelity comparisons.

No OpenAI key is committed. A live Nordla adapter is not considered production-ready until a dedicated key, privacy gate, spend guard and smoke test exist.

### Runway — Product Campaign Image

Official recipe:
- endpoint: `POST /v1/recipes/product_campaign_image`
- pinned version: `2026-06`
- one product image plus creative brief
- returns four campaign visuals
- purpose: specialist product-campaign challenger

### Runway — Product Ad

Official recipe:
- endpoint: `POST /v1/recipes/product_ad`
- pinned version: `2026-07`
- one to ten product references
- duration: 4–15 seconds
- purpose: specialist product-ad video challenger

## Benchmark rule

Same public HABB product, same brand brief, same fidelity gates.

Compare:
1. Alibaba Qwen Image 3.0 Pro
2. OpenAI GPT Image 2.5 Sunburst
3. Runway Product Campaign Image
4. Nordla Sandwich
5. Wan 3.0
6. Runway Product Ad

No universal score. Product fidelity is hard-gated before artistic quality.

## Privacy

V0 challenger adapters accept only PUBLIC product data. No faces, customer uploads, personalized names or private URLs.

## Production decision

A challenger is not adopted because it looks better once. It must beat or complement the incumbent on:
- hard product fidelity;
- accepted-output rate;
- retries;
- latency;
- cost per accepted output;
- visual quality;
- operational stability.
