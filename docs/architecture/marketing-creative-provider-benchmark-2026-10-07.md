# Nordla Marketing Creative — provider benchmark decision (2026-10-07)

Status: IMAGE PROVIDER DECIDED / VIDEO AND TEXT STILL OPEN

## Decision

Image decision (2026-10-08): promote `qwen-image-3.0-pro` as Nordla/HABB's default image-generation and image-editing provider for the current phase. This decision is based on the real HABB TYESO benchmark, where Qwen preserved the source product more faithfully than the OpenAI image lane. Gemini Nano Banana 2.1 was not evaluated because the user's current Google project exposed a Free Tier rate limit of zero for that model. Video and text provider selection remain open.

The architecture stays provider-neutral. The benchmark must optimize for accepted commercial output, not benchmark hype.

## Shortlist

### Marketing reasoning / copy

1. `qwen3.8-max` — incumbent Alibaba candidate.
2. `gemini-3.8-flash` — challenger for cost/quality.
3. `gpt-5.6-sol` — premium reference for difficult campaign reasoning.

Qwen remains attractive on cost in Frankfurt. GPT-5.6 Sol is the premium reference, not the default. Gemini 3.8 Flash is the cost-efficient challenger.

### Image generation / editing

1. `qwen-image-3.0-pro` — **SELECTED DEFAULT FOR HABB/NORDLA**.
2. OpenAI image lane — retained as a reference/challenger, not the default.
3. `gemini-nano-banana-2.1` — not evaluated in the live HABB benchmark because the active Google project had a Free Tier rate limit of zero for this model.

Decision basis: on the real TYESO FLAIR 2.0 benchmark, Qwen preserved the source product state and identity more faithfully, including the open tumbler, ice, separated lid, straw, branding placement and overall geometry. The OpenAI result was aesthetically strong but reconstructed the product more aggressively. For HABB, product fidelity outranks generic aesthetic leaderboard position.

### Video generation / editing

Nordla will keep three official video lanes for the HABB benchmark:

1. `wan3.0-video` — Alibaba incumbent; already integrated and live-tested.
2. `gemini-omni-1.1-flash` — Google paid-tier challenger.
3. `MiniMax-H3` — MiniMax challenger for image-to-video, multimodal reference control and product/brand fidelity.

These three remain active benchmark candidates until the same real HABB source asset is tested across all three. No default video provider is selected yet.

Do not integrate Veo 3.1 as a new lane: Google has already published its October 22, 2026 shutdown/replacement path toward Gemini Omni 1.1 Flash.

Seedance remains a research-only candidate. Runway remains useful as a production/editing workflow reference, but Nordla should not add either as a default raw-generation provider before the three-lane benchmark is complete.

## Current evidence snapshot

### Images

Artificial Analysis AA-Image-T2I v2.0 currently places GPT Image 2.5 Sunburst (max) first and Flare second. Google Nano Banana 2 is lower on that generic leaderboard but has strong interactive-editing economics. Alibaba Qwen Image 3.0 Pro is significantly cheaper and explicitly supports complex layout/text rendering.

Approximate provider list prices at this checkpoint:

- Qwen Image 3.0 Pro: about USD 0.03 for a 1K international output.
- Gemini Nano Banana 2.1: about USD 0.0336 for 1K, 0.0504 for 2K, 0.113 for 4K.
- GPT Image 2.5: token-priced; max-quality leaderboard runs are materially more expensive than the low-cost Alibaba/Google lanes.

### Video

Current official pricing/capability checkpoint:

- Wan 3.0 Frankfurt: USD 0.082513/sec at 720P.
- Gemini Omni 1.1 Flash: about USD 0.10/sec effective at 720P; paid tier required.
- MiniMax H3: USD 0.08/sec at 768P; image-to-video supported, with output up to 15 seconds and optional 2K workflow.

A first-pass 5-second comparison across all three costs roughly USD 1.31 before retries, excluding small input/token overhead where applicable.

## HABB benchmark — what actually decides the winner

Use the same public, non-personal HABB source asset and the same commercial brief.

Do not rank by a universal aesthetic score. Record pass/fail plus dimensions.

### Image acceptance gates

Hard fail if any of these happens:

- product geometry changes;
- HABB logo/text is altered when preservation is required;
- cap, handle, opening, buttons, ports, material or proportions mutate;
- requested edit changes unrequested regions;
- generated typography is misspelled or unusable;
- obvious synthetic artifacts make the asset unsuitable for an ad.

Score accepted outputs on:

- source-product fidelity;
- typography;
- brand-style compliance;
- photorealism/material rendering;
- lighting/shadows;
- edit locality;
- first-pass usability;
- latency;
- cost per accepted output;
- retry count.

### Video acceptance gates

Hard fail if:

- the product identity drifts;
- labels/logo/text mutate;
- geometry changes between frames;
- product disappears/reappears incorrectly;
- physics or camera motion makes the product commercially unusable.

Score accepted outputs on:

- temporal product fidelity;
- motion coherence;
- prompt adherence;
- camera control;
- material realism;
- first-pass usability;
- latency;
- cost per accepted second;
- retry count.

## Benchmark sequence

Phase A — zero-risk evidence:
- keep current Alibaba smoke test unchanged;
- validate live Alibaba wiring on one public HABB asset under the existing EUR 1.50 ceiling;
- do not call that result a benchmark.

Phase B — image head-to-head:
- Qwen Image 3.0 Pro;
- GPT Image 2.5 Sunburst;
- Gemini Nano Banana 2.1;
- same source, prompt, output target and deterministic HABB overlay strategy.

Phase C — video three-way benchmark:
- Wan 3.0 at 720P;
- Gemini Omni 1.1 Flash at 720P;
- MiniMax H3 at 768P;
- same real HABB source image;
- same motion/camera brief;
- one 5-second clip per provider;
- no retry during the first pass;
- preserve the real product, branding, geometry, accessories and materials;
- judge temporal product fidelity before generic cinematic quality.

Phase D — text/campaign:
- Qwen 3.8 Max;
- Gemini 3.8 Flash;
- GPT-5.6 Sol;
- judge against one fixed HABB campaign brief using factuality, offer discipline, brand fit, actionability and edit effort.

## Promotion rule

A provider becomes a Nordla production candidate only when it wins on:

1. accepted-output rate;
2. product/brand fidelity;
3. cost per accepted result;
4. repeatability;
5. API reliability and operational fit;
6. privacy/data-routing fit.

Raw leaderboard rank alone is never sufficient.

## Current recommendation

Keep Alibaba installed and run its smoke test first.

For the real competitive benchmark:
- image premium reference: GPT Image 2.5 Sunburst;
- image efficiency challenger: Gemini Nano Banana 2.1;
- image incumbent: Qwen Image 3.0 Pro;
- video challenger: Gemini Omni 1.1 Flash;
- video incumbent: Wan 3.0.

This is the smallest serious shortlist. Adding more providers before these tests would increase integration work without improving the decision.

## Sources checked 2026-10-07

Official/provider documentation:
- OpenAI image generation/pricing and GPT-5.6 model documentation.
- Google Gemini API pricing/deprecations, including Gemini Omni 1.1 Flash and Nano Banana 2.1.
- Alibaba Cloud Model Studio Qwen Image 3.0 Pro, Qwen 3.8 Max, Wan 3.0 and pricing documentation.
- Runway Gen-4.5/API documentation for workflow comparison.
- Volcengine Seedance 2.5/2.0 pricing and API documentation.

Independent evidence:
- Artificial Analysis AA-Image-T2I v2.0.
- Arena.ai video leaderboard snapshots reported September 2026.



## Image provider decision — 2026-10-08

**Default:** `qwen-image-3.0-pro`

Reason:
- best observed fidelity to the real HABB product in the live TYESO benchmark;
- commercially usable visual quality;
- low observed cost (EUR 0.034 for the successful 1K benchmark output);
- already integrated in Nordla through Alibaba Model Studio;
- keeps real-product identity more reliably than the OpenAI lane tested in the same session.

Operational rule:
- use Qwen Image 3.0 Pro by default for HABB product advertising and product-scene editing;
- keep hard fidelity constraints and reject outputs that mutate product geometry, branding, text, accessories or materials;
- do not re-open provider selection unless a new candidate is tested on the same real-product benchmark and clearly beats Qwen on accepted-output quality, not leaderboard reputation alone.



### MiniMax H3 EU deployment rule

For Nordla/HABB in Belgium, use **MiniMax's hosted API only** for the H3 benchmark.

MiniMax states that the H3 open-weight license currently excludes the EU, UK, US and South Korea for local weight deployment, while the hosted API is available globally with provider safeguards. Therefore Nordla must not download or self-host H3 weights in the EU unless MiniMax grants the required formal authorization.

This does not block the hosted API benchmark.

## Video benchmark decision — 2026-10-08

Official HABB/Nordla shortlist:
- `wan3.0-video`
- `gemini-omni-1.1-flash`
- `MiniMax-H3`

All three are retained for testing. No video winner is selected yet.

Operational rule:
- reuse the same public TYESO source asset;
- use the same 5-second brief;
- first pass only, no retries;
- prioritize temporal product fidelity, logo/text stability, geometry stability and commercial usability;
- compare cost only after quality acceptance.
