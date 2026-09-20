# Shopify authentication for the HABB pilot runtime sync

This is a design/explanation document, verified against current Shopify documentation (shopify.dev) as of 2026-09. **No credential has been requested or created by this session.** It explains exactly what's needed so you (the store owner) can create it yourself.

## The 2026 model: Dev Dashboard + client credentials grant

Since **2026-01-01**, Shopify no longer allows creating new "admin-created custom apps" (the old flow with a static `shpat_...` token shown once in Settings → Apps → Develop apps). All new custom apps must be created via the **Shopify Dev Dashboard** (`dev.shopify.com/dashboard`), and they authenticate with the **OAuth 2.0 client credentials grant** — there is no long-lived token to copy from a screen anymore. This is the only supported method for a new app today, so it's what this project uses; it's not a choice between grants, it's the current requirement.

Practically, this means:
- You get a **Client ID** and **Client Secret** (not a token) from the Dev Dashboard.
- The application code exchanges those for a short-lived **access token** (currently ~24h) at runtime, and refreshes it before it expires.
- This only works when the app and the target store belong to the **same Shopify organization** in the Dev Dashboard — if HABB's store isn't already under an org you control there, that's the first thing to confirm.

## 1. What you need to do manually (I cannot do this for you)

1. Go to **[dev.shopify.com/dashboard](https://dev.shopify.com/dashboard/)** (or from HABB's Shopify Admin: Settings → Apps and sales channels → Develop apps → **Build apps in Dev Dashboard**).
2. Confirm HABB's store is under an organization you control there (client credentials won't work otherwise).
3. **Create an app**, name it `Retail AI Core - HABB Pilot`.
4. Choose **Custom distribution** (not Public — Custom means "install on a single store or the stores in one org, via a link you generate; no app review, no App Store listing").
5. In the app's configuration, set the **Admin API access scopes** for this version to exactly:
   - `read_products`
   - `read_inventory`
   - `read_locations`

   No write scope. Do not add `read_orders` yet — that's a separate, future, explicitly-approved change.
6. Release this version and **install the app** on the HABB store (Apps → this app → Installs → Install app).
7. Open the app's **API credentials** (Settings tab in the Dev Dashboard) — you'll see a **Client ID** and **Client Secret**. Copy both.
8. Store them locally in a `.env` file (see `.env.example`) as `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` — **never in Git, never pasted into this chat, never in a screenshot sent anywhere**.

## 2. Runtime authentication flow (what the code does)

At runtime, `src/shopify/client.js` does this automatically — no manual token copy, ever:

1. `POST https://{SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token` with `grant_type=client_credentials`, `client_id`, `client_secret` (form-encoded).
2. Shopify returns `{ access_token, expires_in }` (currently ~86399 seconds).
3. The client caches that token in memory (never written to disk or logs) and reuses it for subsequent GraphQL calls until shortly before it expires, then repeats step 1.
4. Every GraphQL request carries the token as `X-Shopify-Access-Token`.

This is why `.env.example` no longer lists a static `SHOPIFY_ADMIN_ACCESS_TOKEN` — it lists `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` instead, matching what the Dev Dashboard actually issues.

## 3. Runtime configuration

| Variable | Secret? | Value for HABB |
|---|---|---|
| `SHOPIFY_SHOP_DOMAIN` | No (kept out of Git anyway, for hygiene) | `zmb5jr-wf.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | No, but treat carefully | From the Dev Dashboard app's API credentials |
| `SHOPIFY_CLIENT_SECRET` | **Yes** | From the same page — you provide this |
| `SHOPIFY_API_VERSION` | No | e.g. `2024-10` — pinned explicitly |
| `SUPABASE_URL` | No | From the `retail-ai-core-dev` Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | See §4 below |
| `MERCHANT_TIMEZONE` | No | `Europe/Brussels` for HABB — see §5 below |

## 4. Why the Supabase service role key, and what would be least-privilege instead

The sync process runs as a trusted backend job, not as an end user — it needs to `INSERT`/`UPSERT` into `merchants`, `locations`, `products`, `variants`, `inventory_snapshots`, and `product_costs` without a logged-in Supabase Auth user. Supabase's REST API (PostgREST) enforces Row Level Security by role; **every table in this schema currently has RLS enabled with zero policies** (Phase 1 migration), which means, with anything less than the service role, **every insert would be silently rejected** — there's no policy granting any other role access yet.

The **service role key bypasses RLS entirely** and is the standard way a trusted server-side job authenticates to Supabase. It is:
- **Server-side only** — never sent to a browser, never referenced from any frontend code (none exists yet in this project, and this key must never be added when one does).
- **Never committed** — `.env` is gitignored, `.env.example` holds no real value.
- **Never printed in logs** — the sync code logs only summaries (counts), never full request/response bodies that could contain it.

**Least-privilege alternative (not implemented yet, proposed for later hardening):** write explicit RLS policies for a dedicated, narrowly-scoped Postgres role (e.g. `sync_writer`) that can only `INSERT`/`UPDATE` the six tables this sync touches, nothing else — and use that role's key instead of the full service role. This is real additional work (writing and testing 6+ policies) that wasn't in this phase's scope; using the service role now, kept strictly server-side, is the pragmatic minimal-risk choice for a single trusted sync job, not a shortcut to build on indefinitely.

## 5. Merchant-local day boundary for inventory

`MERCHANT_TIMEZONE=Europe/Brussels` (HABB's value) is read by the inventory sync to decide "same business day" using Brussels local time, not UTC — see `docs/architecture/inventory-cost-sync.md` for why this matters and the exact mechanism. This variable is optional and generic (defaults to UTC) — it is merchant configuration, never hardcoded in the sync code itself.

## Scope discipline

`read_products`, `read_inventory`, `read_locations` cover catalog + inventory + cost (cost comes from `InventoryItem.unitCost`, part of the inventory scope). No write scope is required for this phase. A future `read_orders` addition is its own explicit, approved change — never bundled in "just in case."
