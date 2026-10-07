# Nordla — Decision Register

- **Status:** CANONICAL
- **Effective date:** 2026-10-06

This register records product decisions that must survive across conversations, models and development sessions.

## Status vocabulary

- **FROZEN** — current decision; cannot be silently changed.
- **DECIDED / DEFERRED** — approved direction, implementation intentionally postponed.
- **PROVISIONAL** — current working decision, still open to evidence.
- **SUPERSEDED** — historical decision replaced by a later explicit decision.

## Frozen decisions

| ID | Decision | Status |
|---|---|---|
| NDR-001 | Nordla's shared operating model is **Enterprise → Subjects → Levers → Decisions → Follow-up**. | FROZEN |
| NDR-002 | Domains do not make independent final company decisions. They provide facts, domain rules/constraints, levers and execution capabilities. | FROZEN |
| NDR-003 | Specialist agents/intelligences may analyse and propose, but cannot bypass Socle Decision, policy enforcement or required human validation. | FROZEN |
| NDR-004 | Company-wide arbitration happens once through the common Socle decision procedure. | FROZEN |
| NDR-005 | Hard owner constraints eliminate options before comparison. A hard rule can only be changed explicitly and the change is logged. | FROZEN |
| NDR-006 | No opaque universal multiplicative score for cash, margin, risk, capacity, etc. Trade-offs remain visible by axis. | FROZEN |
| NDR-007 | `DO_NOTHING`, `TEST_SMALL` and `NOT_MEASURABLE` are first-class outcomes/capabilities. | FROZEN |
| NDR-008 | Deterministic code calculates material business numbers. LLMs/agents may explain, analyse and propose but must not fabricate numbers. | FROZEN |
| NDR-009 | Consequential actions require policy enforcement outside the LLM/agent and human approval unless a specific low-risk reversible rule has been explicitly pre-approved later. | FROZEN |
| NDR-010 | Evidence/provenance, data quality, observability and tenant isolation are Socle responsibilities. | FROZEN |
| NDR-011 | Agents/tools receive bounded capabilities, not unrestricted database or system authority. | FROZEN |
| NDR-012 | Shopify is a temporary/current source for HABB sales/inventory where useful; Shopify is not the target architecture. Nordla Sales and Inventory remain target domains. | FROZEN |
| NDR-013 | Marketing = **Understand → Build → Create → Steer**. | FROZEN |
| NDR-014 | Branding is separate from Marketing. | FROZEN |
| NDR-015 | Creative Intelligence is separate from Marketing; Marketing supplies strategy/brief, Creative Intelligence produces and quality-controls premium creative work. | FROZEN |
| NDR-016 | Sales Development is separate from Marketing and covers B2B, partnerships, prospecting and direct commercial growth. | FROZEN |
| NDR-017 | The three levels (Socle / Domains / Specialized Intelligence) are internal architecture levels, not subscription tiers. | FROZEN |
| NDR-018 | The Socle is not intended as a useful standalone commercial offer. Every customer offer must include enough business capability to solve real problems. | FROZEN |
| NDR-019 | Nordla must not intentionally hide known truths to force an upgrade. Commercial tiers, if created, differ by capabilities/depth, not by falsifying or withholding truth already required for a decision. | FROZEN |
| NDR-020 | HABB is pilot/client zero and configuration, never generic architecture. | FROZEN |
| NDR-021 | Nordla's foundational decision principles include real value creation, productive commerce, economic autonomy, useful deployment of capital/assets, healthy honest profit, durable benefit, long-term trust, sustainable growth and rejection of deception/manipulation. They are inspired in particular by documented examples associated with Uthman ibn Affan and Abdurrahman ibn Auf and are operationalized universally. | FROZEN |
| NDR-022 | Wealth/profit is not treated as the only objective. Nordla may optimize profitability only inside trust, sustainability, risk, capacity, reputation and real-customer-value constraints. | FROZEN |
| NDR-023 | No new architecture direction may silently override this register. Conflicting proposals require an explicit decision change. | FROZEN |

## Decided / deferred

See `NORDLA-DEFERRED.md` for implementation conditions and details.

| ID | Direction | Status |
|---|---|---|
| NDR-D01 | Multi-model routing | DECIDED / DEFERRED |
| NDR-D02 | Creative Intelligence implementation beyond current experiments | DECIDED / DEFERRED |
| NDR-D03 | Market Intelligence / Market Radar | DECIDED / DEFERRED |
| NDR-D04 | Specialist Fujitsu-like retail agents | DECIDED / DEFERRED |
| NDR-D05 | Event-driven agents/automations | DECIDED / DEFERRED |
| NDR-D06 | A2A-style agent communication where justified | DECIDED / DEFERRED |
| NDR-D07 | Advanced forecasting/statistical intelligence subject to data thresholds | DECIDED / DEFERRED |
| NDR-D08 | Separate analytics serving layer at scale if transaction workload requires it | DECIDED / DEFERRED |

## Provisional decisions

| ID | Decision | Status |
|---|---|---|
| NDR-P01 | Commercial packaging currently targets three integrated levels — Essential / Pro / Complete — but names, exact prices and bundle boundaries are not frozen. Current validation anchors are €39 / €119 / €249 excl. VAT. | PROVISIONAL |
| NDR-P02 | MCP is preferred for tool/connectors where it fits; A2A/AG-UI remain standards to monitor rather than mandatory foundations. | PROVISIONAL |
| NDR-P03 | Nordla should be sold as an integrated product, not as dozens of separately purchased business-domain micro-modules. | PROVISIONAL |
| NDR-P04 | Commercial tiers should primarily differ by supported complexity, volume, automation depth, service/support level and included variable-compute allowance, while respecting NDR-019. | PROVISIONAL |
| NDR-P05 | Materially variable external compute (especially high-volume premium image/video generation and similar metered services) must not be unlimited by default inside a low fixed subscription. | PROVISIONAL |
| NDR-P06 | Heavy variable compute may use an included monthly allowance plus approved overage/pay-as-you-go; customer-facing presentation should prefer business-readable units or an Atelier allowance over opaque AI tokens/credits. | PROVISIONAL |
| NDR-P07 | Final prices and included allowances must be based on observed per-merchant unit economics (including median and heavy-user profiles), not on average theoretical API costs alone. | PROVISIONAL |
| NDR-P08 | Nordla should route work to the least-cost engine that still satisfies quality, fidelity, privacy and licensing requirements; premium engines are selective fallbacks, not universal defaults. | PROVISIONAL |
| NDR-P09 | The commercial packaging direction and unit-economic guardrails are documented in ADR 0005; exact launch pricing remains evidence-sensitive. | PROVISIONAL |
| NDR-P10 | Nordla follows an ownership-first infrastructure direction: build/own strategic capability first, then commercially compatible open source/open weights, then self-host where justified, then pay-as-you-go API, with recurring SaaS as a last resort when materially superior. | PROVISIONAL |
| NDR-P11 | "99% Nordla" is the long-term ownership aspiration for value-producing capabilities, not a literal requirement to self-host everything regardless of quality, security or total cost. | PROVISIONAL |
| NDR-P12 | Low-cost cloud storage may be used initially; Nordla should become capable of self-hosting object storage at scale, always with encrypted off-site backup and tested restoration. | PROVISIONAL |
| NDR-P13 | Routine creative/media processing (product compositing, print/PLV, transcription, reframing, subtitles and similar deterministic work) should be Nordla-owned or open-source wherever practical; premium APIs are selective fallbacks. | PROVISIONAL |
| NDR-P14 | The first ownership-first implementation experiment is local image generation plus product-fidelity/compositing benchmarking, including Asian open/self-host candidates and premium API references. | PROVISIONAL |
| NDR-P15 | Premium creative providers may be integrated before local/free alternatives are finalized when measured quality justifies the cost. Alibaba Cloud Model Studio is the first V0 premium provider lane: Qwen for marketing/content, Qwen Image for premium image work, and Wan 3.0 for premium video. This is an operational candidate, not a frozen vendor dependency. | PROVISIONAL |
| NDR-P16 | Premium-provider execution must remain explicit and bounded: region-pinned where required, no silent cross-region fallback, no dynamic routing under NDR-D01, no private/customer media sent externally without an explicit data-sharing gate, no credentials in Git, and provenance/cost must be recorded before production use. | PROVISIONAL |

## How to change a frozen decision

A change proposal must contain:
- decision ID being challenged;
- evidence/reason;
- expected benefit;
- new risks;
- compatibility/migration implications;
- explicit replacement wording.

Only after approval is the old entry marked `SUPERSEDED`.
