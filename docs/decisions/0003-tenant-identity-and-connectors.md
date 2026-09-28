# ADR 0003: Nordla tenant identity is independent of Shopify; Shopify becomes an optional connector

- **Status:** Accepted. **Built** in code and tests; **deployed on staging only**; **production NOT switched** (verified
  2026-09-28, see section 12 - the "no code, no migration yet" wording of the original status is out of date).
- **Date:** 2026-09-27 (state updated 2026-09-28, Core phase C0)
- **Baseline audited:** Finance `21dc924` (production), Core `b7973dd` (production), Analytics `e593475` (production), Growth `feature/growth-campaigns`

## Context

A Nordla customer may sell through Shopify, WooCommerce, PrestaShop, an ERP such as Odoo, use Peppol only, bank/CSV only, or have no
e-commerce at all. Today every Nordla service learns **who its tenant is by asking Shopify**, and Core **creates** the tenant from the
Shopify shop. A Shopify outage therefore stops Finance entirely, and a merchant without Shopify cannot exist.

## 1. Current architecture (as audited)

### 1.1 Identity flow

```
Finance boot (src/finance/server/index.js -> src/finance/runtime.js createRuntime())
  SHOPIFY_SHOP_DOMAIN + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   required, else crash
  -> POST https://<shop>/admin/oauth/access_token                   network call to Shopify
  -> GraphQL SHOP_QUERY -> shop.id
  -> SELECT merchants WHERE source_system = 'shopify' AND source_id = shop.id
  -> merchant.id, then passed explicitly everywhere (store, retail, sync status, createFinanceApp({ merchantId }))
```

- After boot, `merchantId` is already explicit in Finance (store, routes, stock, inbox, bank, pack).
- All 20 `merchant_id` columns in the migrations reference `merchants.id`. No business table uses a Shopify id as the tenant key.
- `merchants.source_system` / `source_id` are `NOT NULL` and `UNIQUE(source_system, source_id)` (migration `phase1_merchant_identity`):
  the tenant identity **is** the Shopify identity.

### 1.2 Shopify outage at Finance boot

- Error or refusal: `createRuntime()` throws, the process exits with code 1, Railway restarts it (`ON_FAILURE`, 10 retries). Finance is down,
  including purely financial features.
- Hanging Shopify: the Shopify client has no timeout, the HTTP port is never opened, the platform edge returns errors.

### 1.3 Shopify couplings

| Area | Location | Coupling | Severity |
|---|---|---|---|
| Finance boot | `src/finance/runtime.js` | token + `SHOP_QUERY` to find the merchant | Blocking |
| Finance CLI | `src/finance/cli.js` `boot()` | same lookup | Blocking (CLI) |
| Catalogue prices | `src/finance/catalog.js` `createShopifyPriceSource` | read-only price lookup | Already optional (price/picture left out) |
| Stock | `src/finance/stock.js` | `inventoryAdjustQuantities` | Already optional (`blocked: 'NO_SHOPIFY_CONNECTION'`) |
| Stock data contract | `fin_stock_movements.shopify_adjustment_id`, `appliedInShopify` | Shopify vocabulary in data | Low |
| Finance UI | `ui/app.js` sync pill, `ui/views-workspace.js` stock card | wording | Low |
| CSP | `server/app.js` `img-src https://cdn.shopify.com` | catalogue images | Low |
| Order references | `runtime.js` `listOrderRefs` | splits a Shopify GID | Low |
| **Tenant creation** | `src/sync/catalog.js` + `src/sync/normalize.js` `normalizeMerchant` | Core sync upserts `merchants` from the shop | Blocking |
| Core sync | `src/sync/index.js` | merchant found through `SHOP_QUERY` | Blocking (Core) |
| Analytics report | `src/report/index.js` (spawned by `analytics-premium/server/report-refresh.js`) | `SHOP_QUERY` to find the merchant | Report depends on Shopify |
| Analytics sync status | `analytics-premium/server/serve.js` | "the only merchant", else `MERCHANT_NOT_UNIQUE` | Breaks with 2 merchants |
| Other CLIs | `src/customers`, `src/marketing`, `src/buying/context.js` | `SHOP_QUERY` then merchant lookup | Blocking (CLI) |
| Local files | `data/local/finance/settings.json`, `data/local/sync-coverage.json`, `data/local/marketing-policy.json`, Analytics `reports/` | no `merchant_id` | One tenant per service |
| Growth | `src/growth/server` | demonstration data only | None today |

## 2. Target architecture

```
merchants                       Nordla tenant, own identity. merchants.id is THE tenant key (unchanged).
  |
  +-- merchant_connectors       0..N optional connections to the outside world
  |     kind: shopify | woocommerce | prestashop | odoo | peppol | bank | csv | ...
  |
  +-- Nordla modules            Finance, Core, Analytics, Growth: receive a merchant_id, never ask a connector who they are
```

- `merchants.id` is the Nordla identity. Connectors describe how a tenant is linked to external systems; they never define the tenant.
- A connector is loaded lazily and is **never called during boot**. A connector failure disables only the features that need it.

## 3. Tenant resolver contract

A single module (planned: `src/tenant/`) is the only place any service obtains its tenant. No service implements its own lookup.

### 3.1 Sources, in strict priority order

1. **Authenticated session tenant** - future multi-tenant architecture: the tenant bound to the authenticated session or user.
   Not implemented now; the resolver interface must allow it without changing the modules.
2. **`NORDLA_MERCHANT_ID`** - current single-tenant services (Finance, Core, Analytics): the explicit UUID of `merchants.id`.
3. **Legacy Shopify lookup** - migration only, and only when `NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP` is explicitly enabled:
   shop id -> `merchant_connectors (kind = 'shopify', external_id = shop id)` -> `merchant_id`. Logs a deprecation warning at every boot.

There is **no implicit fallback**: never "the first merchant", never "the only merchant in the database".

### 3.2 Rules

- Verifies that the UUID exists in `merchants`; logs the merchant's display name (not a secret) at boot.
- Never selects a merchant automatically, never creates a merchant.
- Fails cleanly with an explicit error when the id is missing, malformed or unknown and the mode requires it; it never falls back to
  another merchant.
- Makes **no Shopify call** to determine identity (source 3 only during migration, behind the flag).
- Returns `{ merchantId, source }` where `source` is `session | env | legacy_shopify`, so tests and logs can prove which path was used.

## 4. Connector contract

### 4.1 Table `merchant_connectors` (created by M1)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `merchant_id` | uuid NOT NULL -> `merchants(id)` | the tenant that owns the connection |
| `kind` | text NOT NULL | `shopify`, `woocommerce`, `prestashop`, `odoo`, `peppol`, `bank`, `csv`, ... |
| `external_id` | text NULL | stable id in the external system (Shopify: shop GID). NULL for kinds without a natural id (CSV) |
| `external_domain` | text NULL | informational only (e.g. myshopify domain), never used for identity |
| `status` | text NOT NULL | administrative state, see 4.3 |
| `config` | jsonb NOT NULL default `{}` | **non-secret** settings only |
| `created_at` | timestamptz NOT NULL default now() | |
| `updated_at` | timestamptz NOT NULL default now() | |

- **Secrets never go in `config`** (tokens, client secrets, API keys, passwords). They stay in environment variables, later in a vault.
- RLS enabled with no policy, like every other table (service role only).

### 4.2 Uniqueness: one constraint, not two

- `UNIQUE(kind, external_id)` - **kept**: one external object (e.g. one Shopify shop) belongs to exactly one tenant. This is the
  safety rule that prevents syncing a shop into two merchants.
- `UNIQUE(merchant_id, kind, external_id)` - **dropped as redundant**: any duplicate on these three columns is already a duplicate on
  `(kind, external_id)`, so the first constraint implies it.
- Added instead: a **non-unique index** on `(merchant_id, kind)` for the "load this tenant's connectors" lookup.
- `external_id` NULL (e.g. CSV): PostgreSQL treats NULLs as distinct, so several such connectors are allowed. If a kind must be
  limited to one per tenant, that is a per-kind partial unique index decided when that connector is built, not in M1.

### 4.3 Connector states

| State | Meaning | Stored? |
|---|---|---|
| `CONFIGURED` | connector declared and last verification passed | yes (`status`) |
| `NOT_CONFIGURED` | no connector of that kind for the tenant, or declared without credentials | yes, or implied by absence |
| `MISCONFIGURED` | credentials present but the external account does not match this tenant (e.g. shop id is not this merchant's connector) | yes |
| `UNAVAILABLE` | configured but unreachable right now (timeout, 5xx, network) | **runtime only**, reported, never persisted (avoids a write on every outage) |

Features that depend on a connector return its state (e.g. `NOT_CONFIGURED`) instead of failing; the rest of the module keeps working.

## 5. Module rules

### 5.1 Shopify

Shopify is a connector. Its credentials (`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`) configure the connector
only. When present, a **background** verification with a timeout checks that the shop id maps to this tenant's `shopify` connector;
on mismatch the connector is `MISCONFIGURED` and only Shopify features are disabled.

### 5.2 Finance without Shopify

Finance starts; Achats, Ventes (Finance documents), Banque, Tresorerie, Contacts and Pack Comptable work. Shopify-dependent features
(catalogue prices, stock adjustments, sales sync status) report `NOT_CONFIGURED`. A Shopify outage never stops Finance.

### 5.3 Core

Core sync no longer creates merchants. It receives a `merchant_id`, loads that merchant's `shopify` connector, and before any write
checks that the shop returned by Shopify is that connector's `external_id`. Wrong shop -> no write, run recorded as `FAILED`.
Tenant creation becomes an explicit provisioning step (create a merchant, then link a connector).

### 5.4 Analytics

No logic may depend on "the only merchant in the database". Analytics always receives or resolves its tenant explicitly (resolver).
The report is built from Nordla data already stored in Supabase and must build even when Shopify is unavailable.

### 5.5 Growth

No change today (demonstration data). It uses the resolver as soon as it reads real data.

## 6. Configuration

| Variable | Role | Status |
|---|---|---|
| `NORDLA_MERCHANT_ID` | UUID of `merchants.id` for a single-tenant service (Finance, Core, Analytics) | new; required once the switch is complete; not a secret |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Shopify connector configuration | optional for Finance/Analytics; required only by Core's Shopify sync |
| `NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP` | enables resolver source 3 | transitional; off by default once the switch is done, then removed |

No merchant-specific value is ever hardcoded; `NORDLA_MERCHANT_ID` is per-environment configuration.

## 7. Migration strategy

- **M1 - additive, part of the first switch:** create `merchant_connectors`; backfill one `shopify` connector per existing merchant with
  `source_system = 'shopify'` (`external_id = source_id`, `external_domain = source_domain`, `status = 'CONFIGURED'`).
  No existing merchant UUID changes, no business table changes, nothing deleted.
- **M2 - much later, never part of the first switch:** make `merchants.source_system` / `source_id` optional and mark them deprecated,
  only after every service uses the resolver and the fallback is removed. No column is dropped in M2.

## 8. HABB switch order (exact)

1. Apply M1.
2. Backfill HABB's Shopify connector (its current shop id, domain).
3. Deploy code compatible with both modes (resolver with the legacy flag on, still working without `NORDLA_MERCHANT_ID`).
4. Set `NORDLA_MERCHANT_ID` (HABB's existing `merchants.id`) on Finance, Core and Analytics.
5. Validate on staging (with the synthetic Shopify stub).
6. Validate in production.
7. Disable the Shopify fallback (`NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP` off).
8. Remove the fallback code - only later, in its own change.

## 9. Rollback strategy

- **M1:** additive; rollback = stop using the table (code falls back to the legacy flag); dropping it is optional because nothing else
  references it.
- **Code:** each step is its own branch and deployment; rollback = redeploy the previous known-good deployment on Railway
  (no force push), as for every Finance release.
- **Configuration:** with the legacy flag still on, removing `NORDLA_MERCHANT_ID` returns a service to today's behaviour.
- **Fallback removal (step 8)** is only done once production has run on `NORDLA_MERCHANT_ID` without the flag; until then every step
  stays reversible.

## 10. Mandatory tests

Every implementation step must keep these green (staging uses the synthetic Shopify stub):

1. Finance with Shopify configured: same behaviour as today.
2. Finance without Shopify: boots; Achats, Ventes, Banque, Tresorerie, Contacts, Pack work; Shopify features report `NOT_CONFIGURED`.
3. Shopify down: Finance boots; connector reports `UNAVAILABLE`.
4. Shopify misconfigured (credentials of another shop): connector `MISCONFIGURED`, Shopify features disabled, Finance keeps working.
5. Unknown merchant id: clean, explicit boot failure; never another merchant.
6. Two merchants present: the configured one is served; resolver never picks one automatically.
7. No Shopify request at Finance boot when no Shopify connector is configured (asserted, not assumed).
8. No leak between merchants: data of merchant A never appears for merchant B (extends the existing tenant-isolation tests).
9. Core refuses a shop linked to another merchant: no write, run `FAILED`.
10. Analytics works with several merchants without any "only merchant" logic.

## 11. Current multi-tenant limits (explicit)

- Nordla is **not** a multi-tenant application yet: we keep **one deployed service per tenant**.
- Reason: local files carry no `merchant_id` - Finance `settings.json`, `sessions.json`, `audit.log`, `sync-coverage.json`,
  `marketing-policy.json`, Analytics `reports/`. Serving two tenants from one process could mix them.
- The Supabase service-role key sees every tenant; isolation relies on `merchant_id` filters in code (already tested).
- Real multi-tenant isolation (tenant from the session, per-tenant storage for these files, RLS policies per tenant) is a separate,
  later project. Resolver source 1 is reserved for it.

## 12. Real state and remaining switch steps (verified 2026-09-28, Core phase C0)

Verified read-only: Git, full test suite (1256/1256 on `4c34896`), Railway deployments and variable *names*, SQL reads on both
Supabase projects. No secret value was displayed.

### 12.1 Built vs deployed

| Item | Built (code + tests) | Staging | Production |
|---|---|---|---|
| Resolver `src/tenant/index.js` (env source; session reserved) | yes (`tenant-resolver.test.js`) | yes | **no** |
| M1 `merchant_connectors` + Shopify backfill | yes (`merchant-connectors.test.js`) | yes (1 `shopify` connector, `CONFIGURED`) | **no** (table absent) |
| Finance boot from `NORDLA_MERCHANT_ID` (step 4 of the original plan) | yes (`finance-tenant-decoupling.test.js`) | yes | **no** |
| Core sync: tenant from resolver, shop checked against its connector, no merchant creation (step 5) | yes (`core-tenant-decoupling.test.js`) | yes | **no** |
| Analytics tenant, no "only merchant" (step 6) | yes (`analytics-tenant-decoupling.test.js`) | yes | **no** |
| CLI tools (buying, customers, marketing) through the resolver (step 7) | yes (`remaining-tenant-decoupling.test.js`) | yes (run locally) | n/a (not deployed services) |
| `NORDLA_SERVICE` start dispatcher | yes (`service-start.test.js`) | yes | **no** |

Production (Railway `app.nordla.app`, environment `production`), verified 2026-09-28:
- Finance `21dc924`: `src/finance/runtime.js` calls Shopify `SHOP_QUERY` at boot and selects `merchants` by `source_id = shop.id`.
- Core `b7973dd`: `src/sync/index.js` finds the merchant with `SHOP_QUERY`; `src/sync/catalog.js` **upserts `merchants` from the shop**
  (`normalizeMerchant`), i.e. Core still creates/updates the tenant from Shopify.
- Analytics `e593475`: `src/report/index.js` uses `SHOP_QUERY`; `src/analytics-premium/server/serve.js` still has the
  "exactly one merchant" rule (`MERCHANT_NOT_UNIQUE`).
- None of the three production services has `NORDLA_MERCHANT_ID` or `NORDLA_SERVICE`. **Deploying the current code chain without
  `NORDLA_SERVICE` makes the service refuse to start** (by design): both variables must be set before the switch deployment.
- Production database: 22 of the 23 repository migrations applied (all except `merchant_connectors`); no RLS policy anywhere.

### 12.2 Legacy Shopify fallback still in the code (not used anywhere today)

The migration-only source 3 (`NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP`) is present in four places: `src/finance/runtime.js`,
`src/sync/tenant-context.js`, `src/analytics-premium/server/tenant.js`, `src/tenant/tool-context.js` (allow-listed by
`test/remaining-tenant-decoupling.test.js`). No service sets the flag: staging uses `NORDLA_MERCHANT_ID`; production does not run this
code yet. `SHOP_QUERY` is otherwise used only for the identity **check** (`src/sync/tenant-context.js`, `src/connectors/shopify.js`),
never to choose the tenant.

### 12.3 Remaining switch steps for HABB (Core phase C6)

Status of the section 8 plan: steps 1-2 done on staging only; step 3 code built; steps 4-8 not done in production.

1. Apply M1 (`merchant_connectors`) on production; verify the HABB `shopify` backfill row.
2. Deploy the current chain to production Core, Finance and Analytics with `NORDLA_SERVICE` (`core` / `finance` / `analytics`) and
   `NORDLA_MERCHANT_ID` (HABB's existing `merchants.id`) set **before** the deployment; one service at a time, rollback = redeploy the
   previous commit.
3. Validate: no identity `SHOP_QUERY` at boot, sync writes checked against the connector, Analytics without the single-merchant rule.
4. Keep `NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP` unset (off); after a stable production period, remove the fallback code (own change).
5. Prepare M2 (make `merchants.source_system` / `source_id` optional, deprecated, nothing dropped). **M2 must be finished before the
   second external customer.**

### 12.4 Ordering decision (owner, 2026-09-28)

**C6 (this production switch) comes before C5 (public opening of Growth / Développement des ventes)**, including the internal HABB
beta. The Core roadmap and the identity decisions are in ADR 0004 (sections 7, 11 and 12).

### 12.5 Out-of-date documentation (flagged, cleanup in a separate small documentation commit)

- Section 1.3, table row "Growth ... demonstration data only" and section 5.5 "No change today (demonstration data)": out of date.
  Growth now reads the tenant's real synced data through the resolver (`src/growth/server/serve.js` + `resolveToolTenant`).
- `src/growth/server/serve.js` header comment "Without it, the demonstration pages still work": out of date (code comment; not
  changed in C0).
- `supabase/migrations/20260926160000_finance_purchase_document_model.sql` header says "NOT APPLIED": it is applied on production and
  staging (an applied migration is not rewritten; to be noted in the migration log instead).

## Consequences

- Finance, Core and Analytics can serve a tenant with no Shopify at all; Shopify outages only degrade Shopify features.
- A shop can be linked to exactly one tenant, and Core cannot write a shop's data into another tenant.
- New connectors (WooCommerce, PrestaShop, Odoo, Peppol, bank, CSV) plug in as `merchant_connectors` rows without touching tenant identity.
- One extra required variable per service (`NORDLA_MERCHANT_ID`) once the switch is complete.

## Alternatives considered

- **Keep Shopify discovery and add a timeout** - rejected: the tenant would still be defined by Shopify and non-Shopify merchants
  would remain impossible.
- **Pick "the only merchant" when there is one** - rejected: silent and unsafe the day a second merchant exists.
- **Make `merchants.source_*` nullable right away (M2 first)** - rejected for the first switch: M1 is enough and keeps every step reversible.
- **Full multi-tenant (session + RLS) now** - rejected for now: larger scope; one service per tenant stays the model until local files
  and settings carry `merchant_id`.
