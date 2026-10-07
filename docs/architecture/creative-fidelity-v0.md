# Creative Fidelity V0

Experimental implementation authorized by NDR-P14. This is not production Creative Intelligence and does not activate NDR-D01/NDR-D02.

## Included in V0

- capability/model registry with explicit licensing and EU/commercial gates;
- provenance ledger with prompt hashing and source references;
- direct-cost accounting where unknown cost remains unknown;
- hard product-fidelity gates;
- visible qualitative axes without a universal score;
- benchmark case definitions for the five image tasks;
- Nordla Sandwich plan that preserves real product pixels and draws commercial text/logo/price deterministically;
- research candidate registry. No candidate is `APPROVED` by default.

## Intentionally not included

- live model downloads;
- API keys or provider calls;
- dynamic multi-model routing;
- autonomous winner selection;
- HABB production data;
- video generation;
- production deployment.

## Next checkpoint

1. Archive and verify exact LICENSE files for the first two self-host candidates.
2. Add provider adapters behind a narrow benchmark contract.
3. Add 10 real HABB product source assets outside generic code/configuration.
4. Execute the same benchmark cases across the two FREE candidates, GPT Image reference, and Sandwich compositing.
5. Measure accepted-output rate, retries, latency, GPU/runtime and cost per accepted output.
