# Runbook — Provider app registration (Instagram · TikTok · Google Business Profile)

Nordla can only connect a merchant's account through an **OAuth application that the owner registers at each provider**. Nobody else can create these, and Claude cannot do it for you. This runbook lists what to do, what to collect, and where to put it.

> **Never paste a client secret, a token or an authorization code into a chat, a ticket, an e-mail or Git.** Secrets go only into the deployment secret store (names are listed in `.env.example`). If one is exposed by mistake, rotate it at the provider immediately.

Facts below were verified against the providers' official documentation on **2026-10-09**. Provider consoles and review rules change: re-check the linked official page before each step. Items marked *sandbox* are assumptions to confirm with the first real connection.

## 0. Before any provider

| # | Action | Who |
|---|---|---|
| 0.1 | Decide the public **HTTPS** base URL of the Nordla service that will receive the OAuth callbacks (for example `https://<your-domain>/oauth/callback/<provider>`). A provider-registered redirect URI must be absolute `https`, static, **without a query string** and **without a fragment**. `http://localhost…` is accepted by some providers for development only. | Owner / operator |
| 0.2 | Make sure the **Supabase Vault** extension is enabled on the production Supabase project and apply migration `20261009200000_provider_connections.sql`. | Owner / operator |
| 0.3 | Prepare a place for secrets (Railway variables or equivalent). Never a committed file. | Owner / operator |

The three redirect URIs Nordla expects (replace the host):

```text
INSTAGRAM_REDIRECT_URI = https://<your-domain>/oauth/callback/instagram
TIKTOK_REDIRECT_URI    = https://<your-domain>/oauth/callback/tiktok
GOOGLE_REDIRECT_URI    = https://<your-domain>/oauth/callback/google_business_profile
```

## 1. Instagram (Instagram API with Instagram Login)

**USER ACTION REQUIRED** — Meta developer account.

1. In the Meta for Developers console, create an app and add the product **Instagram → API setup with Instagram login**.
2. Under the business-login settings, add the redirect URI above (exactly as it will be configured in Nordla).
3. Note the **Instagram app ID** and **Instagram app secret** (these are the `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` values — set them directly in the secret store).
4. Permissions Nordla requests (minimum to publish): `instagram_business_basic`, `instagram_business_content_publish`. The old `business_*` scope names were deprecated on 2025-01-27 and are not used.
5. The merchant's Instagram account must be a **professional account** (Business or Creator). A personal account can never publish through the API.
6. While the app is in development mode, only accounts added as **testers / app roles** can authorize. For any other merchant, Meta **App Review** of the publish permission is required (**PROVIDER_REVIEW_REQUIRED**).
7. Set `INSTAGRAM_GRAPH_API_VERSION` to a current Graph API version of the form `v<major>.<minor>` (*sandbox*: confirm the version in the console).

Collected: `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`, `INSTAGRAM_REDIRECT_URI`, `INSTAGRAM_GRAPH_API_VERSION`.
Note: there is no documented token-revoke endpoint; a disconnect in Nordla is local, and the merchant can also remove the app in their Instagram settings.

## 2. TikTok (Login Kit + Content Posting API)

**USER ACTION REQUIRED** — TikTok developer account.

1. In the TikTok developer portal, create an app and add **Login Kit** and **Content Posting API**.
2. Register the redirect URI above (absolute https, static, no query string, no fragment, under 512 characters).
3. Add the scope **`video.publish`** (the only one Nordla requests).
4. Note the **client key** and **client secret** (`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`).
5. Until TikTok has **audited** the app, posts can only be created with private visibility (Nordla surfaces this as the review signal `TIKTOK_UNAUDITED_PRIVATE_ONLY`). Request the audit when ready, and verify the domain / URL prefix that will host the media (**PROVIDER_REVIEW_REQUIRED**, **MEDIA_DELIVERY_REQUIRED**).
6. After the audit, set `TIKTOK_CLIENT_AUDITED=true`.

Collected: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` (+ `TIKTOK_CLIENT_AUDITED` later).
Note: TikTok refresh tokens can rotate; Nordla replaces the stored one atomically.

## 3. Google Business Profile

**USER ACTION REQUIRED** — Google account that manages the business locations.

1. In Google Cloud Console, create (or choose) a project.
2. Request **Business Profile API access** for the project (Google grants it on request) and enable the Business Profile APIs used for account and location discovery.
3. Configure the **OAuth consent screen**; add the scope `https://www.googleapis.com/auth/business.manage` (the only scope Nordla requests). Unverified consent screens are limited to test users.
4. Create an **OAuth client ID** of type *Web application* and add the redirect URI above.
5. Note the **client ID** and **client secret** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
6. Nordla asks for offline access (a refresh token) and forces consent on each connection; it also uses PKCE (S256). If Google ever answers `invalid_grant`, the merchant must connect again.
7. The binding target is a **location** (`accounts/{id}/locations/{id}`), never an account alone: the merchant picks the location in Nordla.

Collected: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

## 4. Provider readiness after registration

| Provider | After steps 1–3 | Still open |
|---|---|---|
| Instagram | `OAUTH_CONSENT_REQUIRED` (testers can already connect) | App Review for non-testers · media URLs |
| TikTok | `OAUTH_CONSENT_REQUIRED` | audit · verified media domain |
| Google Business Profile | `OAUTH_CONSENT_REQUIRED` | API access approval · consent-screen verification · media URLs |

`PRODUCTION_READY` requires approved scopes, provider audit/review, controlled media delivery and consent compliance. The code never claims it by itself.

## 5. Checklist (tick as you go; never write a secret here)

- [ ] HTTPS callback host decided and reachable
- [ ] Supabase Vault enabled, migration applied
- [ ] Instagram app created · redirect URI added · variables set
- [ ] TikTok app created · `video.publish` added · redirect URI added · variables set
- [ ] Google project · API access · consent screen · OAuth client · variables set
- [ ] Run `connect <provider>` from the CLI: it prints an authorization URL; if a variable is missing it fails with `APP_MISCONFIGURED` naming the variable (never its value). See `connect-social-accounts.md`
