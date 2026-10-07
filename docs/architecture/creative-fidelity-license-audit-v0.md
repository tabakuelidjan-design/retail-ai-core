# Creative Fidelity V0 — first license audit

Verified on 2026-10-07 against primary/official project pages. This is an engineering gate, not legal advice.

## HiDream-O1-Image

- Source: https://github.com/HiDream-ai/HiDream-O1-Image/blob/main/LICENSE
- Official README: https://github.com/HiDream-ai/HiDream-O1-Image/blob/main/README.md
- License: MIT.
- Official README states the code and HiDream-O1-Image models are licensed under MIT.
- Engineering status: LICENSE VERIFIED for benchmark eligibility.
- Remaining requirement before execution: record the exact downloaded artifact/model hash.

## FLUX.2 Klein 4B

- Source: https://github.com/black-forest-labs/flux2
- License: Apache-2.0 for FLUX.2 Klein 4B and 4B Base according to the official model table.
- Important boundary: 9B and dev variants use a different non-commercial license and must not inherit the 4B approval.
- Official repo reports generation/editing/multi-reference support and approximately 8 GB VRAM fit for Klein 4B.
- Engineering status: LICENSE VERIFIED for the 4B benchmark candidate.
- Remaining requirement before execution: record the exact downloaded artifact/model hash.

## Qwen-Image-Edit-2511

- Official model page: https://huggingface.co/Qwen/Qwen-Image-Edit-2511/tree/main
- Page currently labels the model Apache-2.0.
- Engineering status: NEEDS_REVIEW until the exact artifact LICENSE/version is archived and checked before execution.

## Rule

A model may not move from BENCHMARK/WATCH to APPROVED solely from a website badge or model family name. Exact variant and artifact identity matter.
