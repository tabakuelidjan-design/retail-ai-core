# Nordla Marketing Creative — provider benchmark decision (2026-10-07)

Status: BENCHMARK REQUIRED / NO SINGLE PROVIDER WINNER YET

## Decision

Do not replace the existing Alibaba integration. Keep it as the first controlled provider lane, but do not promote it to "best provider" until it wins Nordla's HABB benchmark.

The architecture stays provider-neutral. The benchmark must optimize for accepted commercial output, not benchmark hype.

## Shortlist

### Marketing reasoning / copy

1. `qwen3.8-max` — incumbent Alibaba candidate.
2. `gemini-3.8-flash` — challenger for cost/quality.
3. `gpt-5.6-sol` — premium reference for difficult campaign reasoning.

Qwen remains attractive on cost in Frankfurt. GPT-5.6 Sol is the premium reference, not the default. Gemini 3.8 Flash is the cost-efficient challenger.

### Image generation / editing

1. `qwen-image-3.0-pro` — incumbent low-cost HABB candidate.
2. `gpt-image-2.5-sunburst` — premium quality reference.
3. `gemini-nano-banana-2.1` — high-efficiency challenger with 1K/2K/4K output.

Current independent text-to-image evidence puts GPT Image 2.5 Sunburst at the top of the Artificial Analysis image leaderboard. This is useful evidence, but Nordla must still test real-product fidelity, typography, brand constraints and edit preservation on HABB assets.

### Video generation / editing

1. `wan3.0-video` — incumbent Alibaba candidate.
2. `gemini-omni-1.1-flash` — primary challenger.
3. Seedance 2.5 — research candidate only until direct API, commercial terms and data-routing requirements are accepted.

Do not integrate Veo 3.1 as a new lane: Google has already published its October 22, 2026 shutdown/replacement path toward Gemini Omni 1.1 Flash.

Runway remains useful as a production/editing workflow reference, but Nordla should not add it as the default raw-generation provider merely because its UI/workflow is strong.

## Current evidence snapshot

### Images

Artificial Analysis AA-Image-T2I v2.0 currently places GPT Image 2.5 Sunburst (max) first and Flare second. Google Nano Banana 2 is lower on that generic leaderboard but has strong interactive-editing economics. Alibaba Qwen Image 3.0 Pro is significantly cheaper and explicitly supports complex layout/text rendering.

Approximate provider list prices at this checkpoint:

- Qwen Image 3.0 Pro: about USD 0.03 for a 1K international output.
- Gemini Nano Banana 2.1: about USD 0.0336 for 1K, 0.0504 for 2K, 0.113 for 4K.
- GPT Image 2.5: token-priced; max-quality leaderboard runs are materially more expensive than the low-cost Alibaba/Google lanes.

### Video

Public arena evidence as of September 2026 places Gemini Omni 1.1 Flash and Wan 3.0 in the leading group for text-to-video and image-to-video. Seedance 2.5 is also competitive, especially in editing, but is not yet a justified Nordla integration.

Approximate 720p list prices at this checkpoint:

- Wan 3.0: about USD 0.10/sec international.
- Gemini Omni 1.1 Flash: about USD 0.10/sec effective Standard price.

A 5-second head-to-head between Wan and Gemini therefore costs roughly USD 1.00 before retries.

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

Phase C — video head-to-head:
- Wan 3.0;
- Gemini Omni 1.1 Flash;
- same HABB source image;
- one 5-second 720p clip each;
- no retry during the first pass.

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

