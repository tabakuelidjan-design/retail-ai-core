# Phase 2D.1 — Marketing measurement

Merchant-generic, deterministic **measurement** of where demand comes from and where acquisition or conversion is weak. Facts, provenance and gates only: **no recommendations, no causal claims, no LLM.** Run: `npm run marketing:report [-- --validate --write-flags]` → `reports/marketing-facts-<date>.json` (gitignored).

## Boundary: adapters vs core

```
Shopify orders ──adapter (src/marketing/adapters/shopify.js)──▶ neutral rows: orders.channel_*, order_attribution
imported files (traffic / ads / search) ──contract validators──▶ neutral facts
                                   core (src/marketing/*): taxonomy · channel facts · landing/product/campaign facts
                                                            · traffic/conversion gate · paid readiness · search · quality
```
Platform shapes (`customerJourneySummary`, `channelInformation`) exist **only** in the adapter (a test enforces it). Merchant specifics — own domains, target markets, brand terms, channel rules — are configuration under `config.marketing`, empty by default and reported as *unknown* rather than guessed.

**Privacy by construction:** referrers are stored as host only, landing pages as path only (query strings and fragments, which can carry personal data or click ids, are never kept), no customer identity is read. Click identifiers (e.g. Google Ads `gclid`) are not observable: Shopify returns landing pages without query strings.

## Attribution and provenance model

Model: **`last_recorded_visit`** — an online order is assigned to the last visit the source recorded before it; POS orders by their sales channel; an online order with no recorded visit is `unattributed`, never guessed. Every fact group carries `provenance`:
`source_system`, `attribution_model`, `source_fields`, `window`, `limitations[]`, `completeness` (`COMPLETE`/`PARTIAL`/`UNAVAILABLE`), `evidence_kind`, `causal_claim: false`.

| evidence_kind | Meaning | Example |
|---|---|---|
| `observed` | Read from a recorded field | order sales channel (POS); exported sessions |
| `attributed` | Assigned by a stated model | channel via explicit `utm_medium` or the source's own source type |
| `inferred` | Derived by a configurable rule | host lists (search engines, social, AI assistants), own-host referrer |
| `unavailable` | The data does not exist | online order with no visit |

Attributed and inferred facts always carry `ATTRIBUTION_IS_NOT_CAUSAL_PROOF`. A channel that shows more orders is not shown to have caused them.

## Channel taxonomy (configurable, in precedence order)

`pos` / `other_channel` (order sales channel) → explicit `utm_medium` (`mediumMap`) → the source's own source type (`sourceTypeMap`) → AI-assistant / search / social host lists → own-host referrer → recorded direct → `campaign_unclassified` (UTM present, unmapped) → `referral` → `unknown`. Each result records the `rule` that fired. A UTM source without medium/campaign is reported (`UTM_INCOMPLETE`); a paid medium with an organic source type is reported (`PAID_MEDIUM_BUT_SEO_SOURCE_TYPE`).

## Facts

- **Channel facts** (yesterday / 7 / 30 days / available window, merchant timezone): orders, units, gross sales, discounts, refunds (attributed to the order's channel), net sales, net sales ex tax, AOV (net sales ÷ orders), revenue share, new vs returning (online orders only, from the recorded customer order index; POS is `UNAVAILABLE`: an index of 1 there would not mean "new"), attribution coverage (attributed ÷ online orders; POS excluded), unattributed share of online revenue. Money follows the Phase 2A definitions.
- **Landing pages** of attributed online orders (locale prefixes normalised, product landings mapped to products by handle; whether buyers bought the landing product). *Orders only — this is where buyers landed, not where visitors landed.*
- **Product / category / collection** facts: orders, units, net sales split POS vs online, share of a product's orders with no observed digital journey. Collections overlap (not additive).
- **Campaign concentration** over attributed online orders: tagged vs untagged, top share, HHI. Campaign tags are merchant-chosen strings, not verified identifiers.
- **Traffic** (imported): sessions by channel / landing page / country; orders and sessions are shown side by side always; conversion only through the gate below.
- **Search** (imported): impressions, clicks, CTR (always recomputed), impression-weighted position, by page; branded/non-branded **only** through explicit `brandRules` (otherwise `unclassified`).
- **Paid** (imported): impressions, clicks, spend, CPC, CTR, platform-reported conversions.

## Gates

| Metric | Opens only when |
|---|---|
| Conversion (sessions ↔ orders) | Traffic scope is the online store · window is covered by the order history · the traffic window matches (tolerance) · **sessions are market-valid** (non-target share ≤ threshold; `TARGET_MARKETS_NOT_CONFIGURED` = unknown = gated) · enough sessions (overall and per channel). Channel mapping is labelled approximate. |
| CPC / CTR | Spend rows exist for the clicks. |
| ROAS (platform-reported and attributed) | Spend covers ≥ `minSpendCoverage` of the window days (undated rows: unverifiable = gated) · no duplicate rows / multi-name campaign ids · no clicks without spend · currency matches · ≥ `minAttributedOrdersForPaidMetrics` attributed paid orders · online attribution complete enough · paid orders linkable to ad campaigns (≥ `minCampaignLinkage`). |
| CAC | ROAS gates plus reliable new-customer paid orders. |
| Profit after ad spend | ROAS gates plus the Phase 2A/2B margin gate open. |
| Branded / non-branded | Explicit brand rules configured. |

When gated the value is `null` with the reasons; nothing is estimated.

## Data-quality rules (merchant-level flags, one per rule)

`MKT_UNATTRIBUTED_ONLINE_ORDERS` · `MKT_MISSING_UTM` · `MKT_SOURCE_MISMATCH` (contradictory order fields; traffic vs order attribution disagreeing by channel or in total) · `MKT_TRAFFIC_WINDOW_INCOMPATIBLE` · `MKT_TRAFFIC_MARKET_MISMATCH` · `MKT_DUPLICATE_CAMPAIGN_ID` (ad duplicates, one id with several names, one UTM campaign under several source/medium pairs) · `MKT_MISSING_SPEND` (clicks without spend; paid-attributed orders with no spend data) · `MKT_PARTIAL_CONNECTOR_COVERAGE` (missing/truncated/inconsistent imports). Persisted idempotently via `--write-flags`.

## Import contracts (see `docs/examples/marketing-*.example.json`)

`traffic` `{ source_system, method: api|manual_export, scope: online_store|all_channels, window{start,end exclusive}, dimensions[{dimension: channel|landing_page|country, complete, rows[{key, sessions, completed_checkout_sessions?}]}] }`
`ads` `{ source_system, platform, account_ref?, currency, window, rows[{date?, campaign_id, campaign_name?, ad_group_id?, search_term?, impressions, clicks, cost, conversions?, conversion_value?}] }`
`search` `{ source_system, window, rows[{query, page?, impressions, clicks, position, country?, device?}] }`
Files go in `data/local/marketing/` (gitignored). A `complete: false` dimension means absence is **not** evidence of zero.

## What future connectors would add

- **Shopify Analytics sessions at runtime:** needs the `read_reports` scope **plus** protected-customer-data approval — not available to the current app. Until then traffic is a manual export.
- **Google Ads:** spend, clicks, impressions, conversions, campaign/ad group/search term → opens CPC and, with enough attributed orders and linkage, ROAS/CAC.
- **Search Console:** queries, impressions, position, landing page → search intelligence and branded split.

## Not built

Recommendations, connectors, first-party tracking, multi-touch or modelled attribution, incrementality, external trend data, dashboards.
