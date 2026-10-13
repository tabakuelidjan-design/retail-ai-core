# Creative roadmap — before the China trip vs after return (2026-10-14)

Rule applied: **only what removes a real risk or a real blocker before travel goes in list A.** Creative is a marketing-content capability; the trip is about sourcing. Nothing in Creative stops the trip. Nothing below is started.

## A. BEFORE THE CHINA TRIP (strict)

| # | Item | Why it is worth doing now | Effort | Needs owner? |
|---|---|---|---|---|
| A1 | **Park the work safely**: tag restore points on the five phase tips (`6f7a4e8`, `860d8a6`, `9f30628`, `3f858f5`, `f9c8afd`), keep branches pushed, keep this documentation commit | an absent owner must not depend on one laptop or on a conversation; cheap, reversible | minutes | tag push needs a yes (not done tonight) |
| A2 | **Decide the merge route in principle** (see the merge dependency report): whole-history PR chain, or extraction. Decision only, no merge | the longer the branch lives, the more unrelated work (Finance, Marketing, Growth, China) it carries; deciding before travel avoids drift | 15 min reading | **yes** |
| A3 | **Shoot the benchmark assets (A9 of the runbook)** with a phone on a plain mid-grey ground: gift box, a UV-printed item, a case held in a hand, two touching products, a mirror-finish item | the real-product matrix is the weakest evidence we have; this is zero-code and runs while travelling is being prepared; also usable at suppliers | 30–60 min | **yes** |
| A4 | Optional, only if Creative output is wanted *on return*: a **segmentation provider benchmark** (runbook §2.1, ≈ 90 calls, small spend, owner-held credentials) | it is the single capability that unblocks the product path | half a day | **yes + credentials + budget** |

**BEFORE_TRIP_BLOCKERS = 0** (no Creative item blocks the trip). A1–A3 are recommended, A4 optional.

## B. AFTER RETURN (everything else, in this order)

1. **Wire `src/creative-integration` into the layered runtime** (today the layered runtime uses the older annotated-outline segmenter and places the product with `containFit`; `integrateProduct` has no caller outside tests). Includes a real entry point (script/CLI first, service later) chaining planning → brain → campaign → production plan → layered → integration → refine, with budget caps and the Brand Guardian configured.
2. **Native-alpha asset path** (4 of 9 real assets are pre-cut PNGs): trust the alpha, run alpha-appropriate checks (halo from baked glow, semi-transparency), refuse checkerboard fake transparency.
3. **Provider benchmark** per `BENCHMARK_RUNBOOK.md`, then connect, in value order: segmentation → plate/prop generator (layered port) → masked editing (new executable scope) → vision critic as a gate.
4. A **real understand port** (brief/doc/image ingestion) — without it the Brain only works on prepared briefs.
5. One supervised **end-to-end real run** on a real HABB campaign under a hard cost ceiling, with the visual acceptance sheets reviewed by a person.
6. Merge into `main` along the chosen route, CI green on Node 20 and 24, readiness re-run after each merge.
7. Later enhancements (not before 1–6): video, advanced upscale, broad multi-reference, advanced campaign automation, exotic image transformations, provider redundancy/failover, deep performance work, a conversation layer on top of REFINE, relight beyond the bounded gain field.

## What is explicitly NOT pre-trip
Wiring, providers, the native-alpha path, performance optimisation, merging, mutation work on image plumbing, new fixtures, any Phase 6.
