# ADR 0005 — Commercial Packaging and Variable Compute

- **Status:** PROVISIONAL / APPROVED DIRECTION
- **Date:** 2026-10-07
- **Scope:** commercial packaging, unit-economics guardrails, variable-compute treatment
- **Does not freeze:** final prices, final plan names, exact usage allowances, final support/SLA limits

## Context

Nordla is intended to be one integrated business operating system rather than a catalogue of separately purchased micro-modules.

The product may combine Finance, Analyses, Sales, Inventory, Buying & Suppliers, Marketing, Branding, Sales Development and other capabilities behind the same operating model. However, some workloads have very different marginal cost profiles.

Deterministic business logic, SQL, rules, Brand Memory, Product Marketing logic, print composition, many analyses and local processing can have low marginal compute cost once built. Premium image generation, generative video, high-cost external APIs, messaging and other externally metered services can have materially variable marginal cost.

A flat subscription that includes unrestricted heavy generative compute creates an asymmetric cost risk: the most active customers can become the least profitable. The opposite extreme — selling every business domain as a separate paid module — would recreate the complexity Nordla is explicitly designed to avoid.

## Decision direction

Nordla will pursue a **tiered integrated-product model with separately bounded variable compute**, subject to pilot validation.

### 1. Keep an integrated Nordla product

Nordla should not be commercialized as dozens of separately purchased technical modules.

A customer buys a Nordla commercial level, not Finance + Stock + Marketing + Branding as a basket of micro-add-ons.

Commercial levels may differ by:
- business complexity supported;
- data/document/transaction volume;
- number of users or operating locations where relevant;
- depth of analysis;
- automation depth;
- support/service level;
- included variable-compute allowance.

They must not differ by falsifying or deliberately withholding a truth required for a sound decision.

### 2. Preserve three commercial tiers as the current hypothesis

The working commercial hypothesis remains three levels, currently named:

- **Essential**
- **Pro**
- **Complete**

These names and bundle boundaries are not frozen.

Current price hypotheses for validation are:
- Essential: **€39/month excl. VAT**
- Pro: **€119/month excl. VAT**
- Complete: **€249/month excl. VAT**

These are research/testing anchors, not approved launch prices.

### 3. Do not map architecture levels to commercial tiers

Socle / Domains / Specialized Intelligence remain internal architecture levels.

Essential / Pro / Complete are commercial packaging concepts only.

### 4. Include intelligence; meter materially variable compute

Core software intelligence should be included according to the commercial level wherever its marginal cost is predictable and sustainable.

Examples expected to remain primarily subscription-funded:
- Socle Decision;
- Finance/Inventory/Sales/Analytics logic available to the plan;
- Product Marketing reasoning and Poussées;
- Brand Core / Brand Memory / Brand Guardian rules;
- campaign planning and briefs;
- deterministic print/layout/export;
- smartphone-assisted editing that can run economically on Nordla infrastructure;
- normal analysis, explanation and follow-up.

Workloads with materially variable external cost must not be promised as unlimited by default.

Examples:
- premium image generation at high volume;
- generative video;
- unusually expensive multimodal/document processing;
- paid messaging or other third-party metered services;
- future external services whose marginal cost is material.

These may use an included monthly allowance plus paid overage or pay-as-you-go.

### 5. Avoid abstract customer-facing credits where possible

Nordla should prefer business-readable usage language over tokens or opaque AI credits.

Possible presentation:
- Atelier allowance expressed in euros;
- estimated equivalent outputs ("about N premium images / N short videos");
- explicit estimated cost before a heavy generation;
- hard monthly cap by default;
- optional top-up after user approval.

The exact user-facing mechanism remains provisional.

### 6. Never offer unrestricted heavy generative compute by default

"No unlimited heavy compute" is a commercial safety principle.

An active customer must not be able to generate unbounded third-party/GPU cost inside a fixed low-price subscription.

### 7. Optimize routing before charging more

Nordla should minimize variable cost by routing each task to the least expensive engine that still meets the required quality, fidelity, privacy and licensing constraints.

Premium models are fallbacks when they add material value, not the default for every operation.

### 8. Instrument unit economics before launch pricing is frozen

Nordla must measure actual cost by:
- merchant;
- domain/capability;
- model/provider;
- modality (text, image, video, vision, document, messaging);
- retries/failures;
- support burden where attributable.

The launch price and included allowances must be based on observed pilot distributions, not only average theoretical API prices.

At minimum the product must be able to distinguish median, high-percentile and heavy-user cost profiles.

### 9. Pricing must protect contribution economics

Final pricing must be evaluated on complete direct unit economics, including relevant:
- inference/compute;
- hosting/storage;
- externally metered services;
- payment fees;
- retries/failures;
- directly attributable support.

R&D, sales/marketing and general operating expense remain separately tracked and must not be confused with COGS.

### 10. Pricing hypotheses are evidence-sensitive

If pilot evidence shows €39 / €119 / €249 is wrong, Nordla changes the price rather than distorting the product or hiding necessary truth.

Likewise, if a variable-compute allowance is too generous or too restrictive, adjust the allowance or overage model explicitly.

## Rejected directions

The following are rejected as default commercial principles:

1. **€79–99 all-inclusive with unrestricted heavy image/video generation.**
2. **One paid micro-module per business domain.**
3. **Architecture levels sold directly as subscription tiers.**
4. **Opaque AI credits/tokens as the primary customer mental model.**
5. **Using inactive customers to subsidize uncontrolled heavy users.**
6. **Free heavy compute without a cap merely because average API cost appears low.**

## Open questions

The following remain to be validated with HABB and a pilot cohort:

- final prices;
- exact plan names;
- plan boundaries;
- included Atelier/variable-compute allowance;
- overage/top-up mechanism;
- support limits/SLA;
- document/transaction/user/location limits;
- willingness to pay by SME segment;
- observed COGS distribution and P95/heavy-user behavior;
- break-even thresholds for self-hosting vs API usage.

## Compatibility with canonical architecture

This ADR does not alter:
- Enterprise → Subjects → Levers → Decisions → Follow-up;
- domain/Socle responsibility boundaries;
- the three internal architecture levels;
- NDR-019 (do not hide known truth to force upgrades).

It only defines the current commercial-packaging direction and unit-economic guardrails.
