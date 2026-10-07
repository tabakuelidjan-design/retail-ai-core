# ADR 0006 — Nordla Ownership-First Infrastructure Direction

- **Status:** PROVISIONAL / APPROVED DIRECTION
- **Date:** 2026-10-07
- **Scope:** infrastructure ownership, creative compute, storage, print and local processing
- **Does not freeze:** specific vendors, GPU models, storage hardware, exact ownership percentage, timing of migration from cloud/API to self-host

## Context

Nordla's long-term economic goal is to avoid structural dependence on many recurring SaaS subscriptions and expensive metered providers where equivalent capability can be owned, self-hosted or implemented safely by Nordla.

The guiding intent is **"99% Nordla"**: Nordla should own or control as much of the value-producing stack as is economically, legally and operationally sensible, while retaining external cloud/API services when they are clearly cheaper, safer or materially better.

This is not a requirement to self-host everything immediately. Early-stage cloud infrastructure can remain preferable when it costs only a few euros per month and avoids premature capital expenditure.

## Decision direction

### 1. Ownership-first hierarchy

For new capabilities, prefer in this order:

1. **BUILD / OWN IN NORDLA** when the capability is strategic differentiation or cheap to operate.
2. **OPEN SOURCE / OPEN WEIGHTS** with commercially compatible licensing.
3. **SELF-HOST** when volume, privacy, economics or resilience justify it.
4. **PAY-AS-YOU-GO API** when it is cheaper, safer or significantly better.
5. **RECURRING SaaS SUBSCRIPTION** only when it is materially superior and difficult to replace.

### 2. Storage

Nordla may use low-cost European object storage initially when the monthly cost is trivial relative to buying and maintaining hardware.

Long term, Nordla should be able to operate its own S3-compatible object storage for:
- brand assets;
- product originals;
- campaign outputs;
- videos;
- print files;
- customer uploads;
- model artifacts where permitted.

Self-hosted storage must never be the only copy. Off-site encrypted backup and tested restoration remain mandatory.

Storage migration decisions must compare:
- hardware purchase;
- disks;
- redundancy;
- UPS/power;
- electricity;
- maintenance;
- off-site backup;
- cloud cost;
- operational risk.

### 3. Creative image generation

Nordla should aim to generate the majority of routine image workloads locally or on Nordla-controlled compute using commercially usable open models.

Premium APIs remain selective fallbacks for:
- difficult edits;
- hero campaign assets;
- cases where benchmarked quality/fidelity is materially superior.

Asian models and providers must be benchmarked alongside Western ones.

### 4. Product fidelity and compositing

Where exact product fidelity is required, Nordla should prefer preserving real product pixels through segmentation/compositing rather than asking a generative model to redraw the product.

Local/open components should be preferred for:
- segmentation;
- background generation;
- OCR;
- product comparison;
- logo/text verification;
- compositing;
- resizing;
- format conversion.

### 5. Mini-studio

Nordla should own the normal smartphone-content processing pipeline as much as possible:
- transcription;
- shot detection;
- silence removal;
- audio cleanup;
- subtitles;
- reframing;
- resizing;
- basic color correction;
- export.

Generative video APIs are reserved for work that cannot be achieved economically with real-assisted content.

### 6. Print / PLV

Print/PLV generation should be implemented primarily with Nordla-owned deterministic code and open libraries:
- SVG/vector layout;
- exact dimensions;
- bleed/crop marks;
- PDF generation;
- ICC/CMYK handling where feasible;
- reusable templates.

Per-output SaaS dependency should be avoided for routine print production.

### 7. Local/self-host roadmap

Nordla should not buy heavy infrastructure prematurely.

The migration path is:

**Phase A — Early stage**
- low-cost European cloud storage;
- pay-as-you-go premium APIs;
- serverless/on-demand GPU for tests and bursts.

**Phase B — Growing usage**
- Nordla-controlled GPU/server for routine image, vision, OCR, transcription and media processing;
- continue premium APIs only for cases that benchmark better.

**Phase C — Scale**
- self-hosted storage where economically justified;
- multiple GPUs/worker pools;
- local cache and media pipelines;
- cloud retained for off-site backup, resilience and selective premium compute.

### 8. Economic rule

A capability should migrate from external service to Nordla-controlled infrastructure when the total cost of ownership becomes lower **and** reliability/security remain acceptable.

The decision must consider total cost, not only provider price:
- hardware amortization;
- energy;
- maintenance;
- redundancy;
- operations;
- backup;
- failures;
- upgrades;
- security.

### 9. Security/resilience compatibility

Ownership-first must not weaken canonical resilience requirements.

Nordla-controlled infrastructure must still preserve:
- merchant isolation;
- least privilege;
- immutable/off-site recovery capability;
- auditability;
- restore testing;
- no single physical point of failure for irreplaceable customer data.

## Rejected directions

- Buying permanent GPU capacity before utilization justifies it.
- Self-hosting storage solely to save a few euros per month.
- Keeping every generated draft permanently.
- Using a premium API for routine deterministic work.
- Making one external vendor foundational to Nordla Creative.
- Treating "self-hosted" as automatically cheaper without TCO measurement.

## Immediate implementation priority

The first concrete ownership-first experiment is **local image generation and product-fidelity processing**.

Benchmark:
- commercially usable open/self-host candidates;
- leading Asian alternatives;
- premium API references;
- Nordla compositing with preserved product pixels.

Measure:
- product fidelity;
- accepted-output rate;
- retries;
- latency;
- GPU requirement;
- cost per accepted output;
- licensing/territorial constraints.

The result will decide what Nordla runs locally versus by API.

## Compatibility

This ADR is compatible with:
- NDR-P08 (least-cost qualified routing);
- ADR 0005 (bounded variable compute);
- the Creative Fidelity Benchmark direction;
- canonical security and resilience requirements.

"99% Nordla" is an ownership aspiration, not permission to choose a lower-quality, unsafe or more expensive self-hosted option merely to avoid an external service.
