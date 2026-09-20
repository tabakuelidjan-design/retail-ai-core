# Shopify authentication for the HABB pilot runtime sync

This is a design/explanation document. **No credential has been requested or created by this session.** It explains exactly what's needed so you (the store owner) can create it yourself, per the "never handle credentials on the user's behalf" rule.

## Simplest legitimate method: a custom app on the HABB store

For a single-merchant pilot where the backend is our own code (not a public Shopify App other merchants install), the simplest legitimate authentication is a **custom app** installed directly on the HABB store. This is:

- Not an OAuth flow (that's for public apps distributed to many merchants).
- Not the deprecated private-app API keys (removed by Shopify).
- The standard, currently-supported way for a merchant to grant their own backend read access to their own store's Admin API.

## What you need to do manually (I cannot do this for you)

1. In HABB's Shopify Admin: **Settings → Apps and sales channels → Develop apps** (you may need to enable custom app development first if it's the first time).
2. **Create an app** — name it something like `retail-ai-core-sync` so it's clearly identifiable later.
3. **Configure Admin API scopes** — grant **only**:
   - `read_products`
   - `read_inventory`
   - `read_locations`

   Do not grant any `write_*` scope, and do not grant `read_orders` yet (Phase 1C, not this phase, and even then only if/when order sync is explicitly approved).
4. **Install the app** on the store.
5. Shopify will show an **Admin API access token** (starts with `shpat_...`) **exactly once**. Copy it immediately — it cannot be viewed again after you close that screen (only regenerated, which invalidates the old one).
6. Store it as `SHOPIFY_ADMIN_ACCESS_TOKEN` in a local `.env` file (see `.env.example`) — **never in Git, never in this chat, never in a screenshot you send anywhere**.

## Runtime configuration this expects

| Variable | Secret? | Value for HABB |
|---|---|---|
| `SHOPIFY_SHOP_DOMAIN` | No (but keep out of Git anyway, for hygiene) | `zmb5jr-wf.myshopify.com` (already known from Phase 1A `shop { myshopifyDomain }`) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | **Yes** | From the custom app above — you provide this |
| `SHOPIFY_API_VERSION` | No | e.g. `2024-10` — pin explicitly, bump deliberately |
| `SUPABASE_URL` | No | From the `retail-ai-core-dev` Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | From the same Supabase project's API settings — **server-side only, never in frontend code** |

## Where these live

- Locally: a `.env` file, which is git-ignored (`.gitignore` already excludes `.env` and `.env.*`, keeping `.env.example`).
- In any future CI/deployment: as encrypted secrets in that platform (e.g. GitHub Actions secrets), never inlined in workflow files or committed anywhere.

## Scope discipline

`read_products`, `read_inventory`, `read_locations` cover everything Phase 1A/1B need (catalog + inventory + cost, since cost comes from `InventoryItem.unitCost`, part of the inventory scope). No write scope is ever required for this phase. If a future phase needs `read_orders`, that's a separate, explicit scope addition requested and approved on its own — not bundled in now "just in case."
