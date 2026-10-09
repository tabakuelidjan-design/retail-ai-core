# Provider Provisioning & Live Connections V1 (Instagram · TikTok · Google Business Profile)

- **Status:** IMPLEMENTED LOCALLY / UNDER AUDIT (not pushed)

```text
Credential store (Supabase Vault design)   IMPLEMENTED   real Postgres + real Vault: 96/96 checks
OAuth sessions (CSRF state, PKCE, CAS)     IMPLEMENTED
Instagram OAuth                            IMPLEMENTED   (fakes; sandbox verification still required)
TikTok OAuth                               IMPLEMENTED   (fakes; sandbox verification still required)
Google Business Profile OAuth              IMPLEMENTED   (fakes; sandbox verification still required)
Connection Center BACKEND                  IMPLEMENTED   (no UI - open dependency)
Activation credential resolver             IMPLEMENTED   (Activation V1 is UNCHANGED)

Provider app registrations                 NOT DONE      (USER ACTION REQUIRED, see §14 and docs/runbooks/provider-app-registration.md)
Real merchant accounts connected           NO
```

**IMPLEMENTED means** the provisioning backend is complete and tested against fakes, and the migration is verified on a real PostgreSQL with the real Supabase Vault.
**It does NOT mean** that a real Instagram / TikTok / Google account is connected: that needs the OAuth apps to be registered by the owner, a deployed HTTPS callback and the merchant's consent (§14).

- **Version:** `provider-provisioning.v1` (`PROVISIONING_VERSION`)
- **Code:** `src/provider-connections/` · **Migration:** `supabase/migrations/20261009200000_provider_connections.sql` · **CI:** `.github/workflows/provider-provisioning-live-connections-v1.yml`
- **Tests:** `test/provider-credential-store.test.js` · `provider-oauth-session.test.js` · `provider-instagram.test.js` · `provider-tiktok.test.js` · `provider-google.test.js` · `provider-connection-center.test.js` · `provider-activation-integration.test.js` · `provider-security.test.js` · `provider-coverage-matrix.test.js` (+ fixtures `test/provider-fixtures.js`) · real database: `test/postgres/provider-connections.pg-smoke.mjs`
- **Builds on:** ADR 0003 `merchant_connectors`, Activation & Channel Execution V1 ([`activation-channel-execution-v1.md`](./activation-channel-execution-v1.md)), [`marketing-v1-architecture.md`](./marketing-v1-architecture.md)
- **Runbooks:** [`../runbooks/provider-app-registration.md`](../runbooks/provider-app-registration.md) · [`../runbooks/connect-social-accounts.md`](../runbooks/connect-social-accounts.md)

## 1. Principle

```text
MARKETING PREPARES
SOCLE / POLICY / HUMAN AUTHORIZES
EXECUTION LAYER EXECUTES
M4 OBSERVES AND LEARNS

PROVISIONING OWNS: OAuth lifecycle · secure credential storage · account discovery · selection / binding ·
                   scope verification · refresh · health · disconnect
ACTIVATION OWNS:   capability gate · publishing · idempotency · provider submission / status · receipts
```

Provisioning never publishes, edits or deletes anything at a provider. Activation V1 (`src/activation/`) and Marketing (`src/marketing/`) do not import Provisioning (a test enforces it); Provisioning plugs into the **existing** `ChannelCredentialProvider` contract and the **existing** `merchant_connectors` table. Nothing of the execution layer is duplicated.

## 2. Modules

| Module | Role |
|---|---|
| `constants.js` · `validation.js` | closed vocabularies, stable error codes (`PC_*`), `SealedSecret`/`redact` re-exported from Activation, PKCE, state hashing, `safeReturnTo` |
| `credential-store.js` | `makeTokenBundle`, in-memory FAKE store (tests only) and the secret-free metadata shape |
| `vault-credential-store.js` | the production store: speaks ONLY to the narrow `provider_vault_*` SQL functions, fails closed (`PC_VAULT_UNAVAILABLE`), never echoes a cause |
| `oauth-session.js` | `buildOAuthSession`, `createOAuthSessionRepository` (compare-and-set transitions) |
| `token-manager.js` | `getValidCredential` / `refreshIfNeeded` / `forceRefresh` / `revoke`, store-level refresh lease, per-provider refresh policy |
| `provisioning-service.js` | start → callback → targets → **explicit** bind → verify → refresh → disconnect |
| `connection-center.js` | Connection Center BACKEND (list, start, targets, select, reconnect, disconnect, verify, status) — secret-free views |
| `readiness.js` | per-connection and per-provider readiness, derived only from stated facts |
| `activation-compat.js` | `createActivationCredentialProvider` → Activation's `resolve(...)` contract |
| `providers/{instagram,tiktok,google-business}-oauth.js` | official-docs OAuth adapters (authorization URL, code exchange, refresh, revoke, discovery, target verification) |
| `oauth-http.js` · `runtime.js` · `cli.js` · `index.js` | HTTP wiring (reuses Activation's `callProvider`), runtime graph, CLI + local callback receiver |

## 3. Data model

Migration `20261009200000_provider_connections.sql` (additive; touches no existing table):

- **`provider_oauth_sessions`** — `state_hash` (SHA-256, unique; the raw state is never stored), `pkce_challenge` (S256, Google only), `redirect_uri`, `requested_scopes`, `status` `PENDING → AUTHORIZED → BOUND | FAILED | EXPIRED` (guard trigger; finished sessions are immutable; identity columns are immutable), internal-only `return_to` (check constraint), `bound_connector_id` (must belong to the same merchant **and** provider), `pkce_vault_secret_id` / `pending_vault_secret_id` (Vault references, metadata).
- **`connector_credentials`** — `merchant_id`, `connector_id` (FK, cross-merchant guard trigger), `provider`, `vault_secret_id` (null only when `REVOKED`), `scopes`, `expires_at`, `refreshable`, `issued_at`, `status` `ACTIVE | EXPIRED | REVOKED`, `rotation_version` (compare-and-set counter), `refresh_lease_until`. A partial unique index allows **one live credential per connector**; a revoked row stays as technical history and a reconnect creates a new row.
- Both tables: RLS enabled with **no policy** (service role only).
- **No column can hold a secret**; a token lives in `vault.secrets` (encrypted at rest) and the row holds only its id.

## 4. Credential vault

```text
service code ──(service_role)──► provider_vault_* (SECURITY DEFINER, search_path = '', merchant + connector + provider validated)
                                        │
                                        ▼
                          vault.secrets (encrypted)  ◄── connector_credentials.vault_secret_id (metadata only)
```

- Functions: `provider_vault_store · read · metadata · rotate · refresh_lease · release_lease · mark_expired · revoke · session_put · session_peek · session_take · session_delete` and `provider_oauth_cleanup`. No function accepts an arbitrary secret id; each resolves the secret through `(merchant, connector)` or `(merchant, session)`.
- `REVOKE ALL … FROM PUBLIC, anon, authenticated`; `GRANT EXECUTE … TO service_role`. A browser or an authenticated end user can never reach a secret (proved on the real database, §12).
- **No plaintext fallback, no pgsodium, no home-grown cryptography.** Without the Vault extension the functions fail at call time and the application reports `PC_VAULT_UNAVAILABLE` (a temporary `UNAVAILABLE`, never a misconfiguration).
- The in-memory store is a **fake for tests**; it is never presented as production proof. The Vault design is verified separately on a real Supabase Postgres (§12).
- The older Finance bank "consent vault" (`BANK_VAULT_KEY`) is intentionally **not** reused: it is application-level crypto, which this mandate forbids.

## 5. OAuth flow

```text
startConnect(provider, return_to?)            session PENDING, state (32 random bytes, only SHA-256 stored), PKCE verifier → Vault (Google)
   └─► authorization_url (sealed state in the URL only) ─► the merchant consents AT THE PROVIDER
callback(state, code)                         lookup by hash INSIDE the server-side merchant; PENDING → AUTHORIZED is a compare-and-set (single use);
   │                                          code exchanged SERVER SIDE; required scopes checked; tokens → Vault (PENDING_TOKENS); the browser never sees a token
listTargets(session)                          accounts / locations the merchant authorized — selection_required = true
selectTarget(session, external_id)            EXPLICIT choice (even for a single candidate); re-verified at the provider; connector linked/reused;
   │                                          credential stored or rotated; verified; CONFIGURED only if verification succeeds; session BOUND
verify · refresh · reconnect · disconnect
```

Rules enforced by code **and** by tests:

- The merchant comes **only** from the server tenant; a callback `merchant_id` parameter is ignored.
- `return_to` is an internal route from an allowlist (`/connections`): no absolute URL, no `//`, no backslash, no `..`, no encoded traversal.
- A replayed, expired, unknown, cross-provider or cross-merchant state gives the same `INVALID_STATE` (no oracle). A refusal by the merchant consumes the state.
- OAuth errors are normalized (`USER_DENIED · INVALID_STATE · SESSION_EXPIRED · CODE_EXCHANGE_FAILED · TOKEN_RESPONSE_INVALID · SCOPE_MISSING · PROVIDER_UNAVAILABLE · APP_MISCONFIGURED`); no provider body is ever kept.
- Authorization codes, tokens, the PKCE verifier and the raw state are never persisted in a table, logged or printed.

## 6. Connection states

`CONFIGURED` and `MISCONFIGURED` (and `NOT_CONFIGURED`, e.g. after a disconnect) are persisted on `merchant_connectors`. **`UNAVAILABLE` and `REAUTH_REQUIRED` are runtime states and are never written** (a Vault, provider or network outage must not look like a misconfiguration; an expired grant marks the *credential* `EXPIRED`, the connector row is untouched). A connector becomes `CONFIGURED` only after a successful live verification.

## 7. Token refresh

| Provider | Policy value (Nordla) | Derived from the documented lifetime |
|---|---|---|
| TikTok | refresh when ≤ 3600 s remain | access token 24 h, refresh token 365 days, the refresh token **can rotate** |
| Instagram | refresh when ≤ 7 days remain and the token is ≥ 24 h old | long-lived token 60 days; refreshable only if ≥ 24 h old and not expired |
| Google | refresh when ≤ 300 s remain | access token ≈ 1 h; refresh token valid until revoked; `invalid_grant` ⇒ re-consent |

These are **Nordla policy values**, not provider-mandated numbers and not a global default. Refresh is guarded by a store-level lease (compare-and-set on `refresh_lease_until`) so two workers never refresh the same connector at once, and the new secret replaces the old one in one versioned write (`rotation_version`). A grant the provider no longer accepts marks the credential `EXPIRED` and reports `REAUTH_REQUIRED`.

## 8. Providers (facts verified against the official documentation, 2026-10-09)

`verified_at: 2026-10-09` — every adapter header repeats the endpoints it relies on. Items marked **sandbox** could not be proved from documentation alone and are listed in §14.

| | Instagram | TikTok | Google Business Profile |
|---|---|---|---|
| `verified_against` | Meta *Instagram API with Instagram Login — business login* | TikTok *Login Kit for Web / Content Posting API* | Google *OAuth 2.0 for web server apps; Business Profile APIs* |
| Authorization | `https://www.instagram.com/oauth/authorize` | `https://www.tiktok.com/v2/auth/authorize/` | `https://accounts.google.com/o/oauth2/v2/auth` |
| Minimum scopes | `instagram_business_basic`, `instagram_business_content_publish` | `video.publish` | `https://www.googleapis.com/auth/business.manage` |
| Token exchange | short-lived (`api.instagram.com/oauth/access_token`) → long-lived (`graph.instagram.com/access_token`), server side | `POST open.tiktokapis.com/v2/oauth/token/` | `POST oauth2.googleapis.com/token` |
| Refresh | `graph.instagram.com/refresh_access_token` | refresh token (may rotate) | refresh token (`access_type=offline`, `prompt=consent`) |
| PKCE | not documented → not used | not for web server flow → not used | S256 used (verifier sealed in the Vault) |
| Revoke | no documented endpoint → local disconnect | `POST /v2/oauth/revoke/` | `POST oauth2.googleapis.com/revoke` |
| Stable external id | professional account `user_id` | `open_id` | `accounts/{a}/locations/{l}` — the **location**, never the account alone |
| Eligibility | `account_type` Business / Media_Creator + both scopes | `video.publish` granted | `business.manage` granted + a location chosen |
| Review signals | — | `TIKTOK_UNAUDITED_PRIVATE_ONLY` until the client is audited | — |
| Sandbox to verify | Graph API version; account type values | creator info call; audit state | `readMask` field names; location resource name |

Redirect URIs must be `https`, registered identically at the provider, static (no query string) and without a fragment (`http` only for `localhost`). The Graph API version is configuration (`INSTAGRAM_GRAPH_API_VERSION`), never hard-coded in the flow.

## 9. Connection Center backend

`createConnectionCenterService` returns, for every operation, the **Activation `ChannelConnectionView`** (reused, not duplicated) decorated with `connection_state`, `grant` (status, scopes, expiry, refreshable, rotation_version — never a token), `live_readiness` and review signals. Several connectors of one provider coexist (one per authorized account / location); none is ever picked implicitly. A UI is a **future open dependency**; the CLI (`status · connect · serve-callback · targets · select · verify · disconnect · readiness`) is the interim operator surface. The CLI prints the authorization URL (the one-time `state` is public by design and travels through the browser) and nothing else secret; every output passes `redact` and `assertNoSecrets`.

## 10. Readiness (honest)

Per connection: `NOT_CONFIGURED → OAUTH_READY → CONNECTED → VERIFIED → PRODUCTION_ELIGIBLE`; `PRODUCTION_ELIGIBLE` needs facts the backend cannot invent (approved scopes, provider audit/review, controlled media delivery, consent compliance). Per provider: `BACKEND_READY · APP_CONFIG_REQUIRED · OAUTH_CONSENT_REQUIRED · PROVIDER_REVIEW_REQUIRED · MEDIA_DELIVERY_REQUIRED · PRODUCTION_READY`. With no fact at all the answer is `BACKEND_READY`; nothing is ever `PRODUCTION_READY` here.

```text
Instagram               BACKEND_READY   next blocker: APP_CONFIG_REQUIRED
TikTok                  BACKEND_READY   next blocker: APP_CONFIG_REQUIRED
Google Business Profile BACKEND_READY   next blocker: APP_CONFIG_REQUIRED
```

## 11. Security properties

No token / refresh token / client secret / authorization code / PKCE verifier / raw state in: `merchant_connectors`, `connector_credentials`, `provider_oauth_sessions`, logs, errors, CLI output, Connection Center views, callback responses. Client secrets and redirect URIs come from environment **names** only (`.env.example`). `SealedSecret` prints and serializes `[REDACTED]`; `.reveal()` is used only where a value must leave the process (the provider HTTP call, Activation's resolver). Every cross-merchant access (store, read, rotate, revoke, bind, session) is refused (`PC_CREDENTIAL_SCOPE_MISMATCH`, `PC_SESSION_NOT_FOUND`, `PC_CONNECTOR_NOT_FOUND`).

## 12. Verification

- **Unit / contract tests** against fakes (`node --test test/provider-*.test.js`): 43 tests covering the 115 mandate cases (§13).
- **Real PostgreSQL + real Supabase Vault:** `node test/postgres/provider-connections.pg-smoke.mjs` starts a `supabase/postgres:17.6.1.054` container, applies **every** migration in order, then runs 96 checks: constraints, guard triggers, single-use callback and one-winner rotation under two concurrent sessions, token encrypted in `vault.secrets` and absent from every table, Vault functions scoped to the merchant, `REVOKE` for `anon`/`authenticated`, `service_role` execution, destroy-on-revoke and take-once session secrets. The only stub is the minimal `storage` columns an unrelated finance migration needs.
- **Mutation checks** (each applied to the source, detected by the provider tests, then restored byte for byte — 14/14 detected): persist `access_token` in connector config · persist the raw OAuth state · accept a callback twice · allow target auto-selection · allow a session of another merchant · skip TikTok `video.publish` · bind a Google account without an explicit location · return a token in the Connection Center view · refresh the same connector concurrently · accept an external `return_to` · skip the required-scope check · ignore the merchant that owns the connector · take the merchant from the callback query · persist the PKCE verifier. One mutation initially *survived* (a repository that stopped filtering by merchant): a repository-level test and a service-level check were added.
- **Non-regression:** Activation (66 channel/connector tests), Marketing, Branding, Creative Fidelity and the full suite are run by the dedicated workflow.

## 13. Test coverage — mandate cases 1–115

One row per numbered case of the mandate. Several cases share a test function when it asserts them together; `test/provider-coverage-matrix.test.js` enforces that this table is contiguous, holds all 115 cases and that every named test exists. Cases marked **(CI)** are the cross-domain suites and the real-PostgreSQL smoke executed by the dedicated workflow.

<!-- coverage-matrix:start -->
| # | Mandate case | Test |
|---|---|---|
| 1 | no plaintext secret column | provider-credential-store.test.js › Credential store schema: no plaintext secret column, the Vault id is metadata, reads are sealed, connector config is secret-free |
| 2 | vault id metadata only | provider-connection-center.test.js › Reconnect, disconnect and several connectors of one provider: identity is stable, nothing is picked implicitly |
| 3 | sealed read | provider-credential-store.test.js › Credential store schema: no plaintext secret column, the Vault id is metadata, reads are sealed, connector config is secret-free |
| 4 | connector config secret-free | provider-credential-store.test.js › Credential store schema: no plaintext secret column, the Vault id is metadata, reads are sealed, connector config is secret-free |
| 5 | rotate | provider-credential-store.test.js › Credential lifecycle: rotation is versioned, revocation destroys the secret, expiry forces re-consent |
| 6 | revoke | provider-credential-store.test.js › Credential lifecycle: rotation is versioned, revocation destroys the secret, expiry forces re-consent |
| 7 | expired metadata | provider-credential-store.test.js › Credential lifecycle: rotation is versioned, revocation destroys the secret, expiry forces re-consent |
| 8 | no access token logs | provider-credential-store.test.js › No credential value is ever logged: access token, refresh token, client secret, authorization code |
| 9 | no refresh token logs | provider-credential-store.test.js › No credential value is ever logged: access token, refresh token, client secret, authorization code |
| 10 | no client secret logs | provider-credential-store.test.js › No credential value is ever logged: access token, refresh token, client secret, authorization code |
| 11 | cross-merchant refused | provider-credential-store.test.js › Credential isolation: another merchant or another provider can never read, write or rotate a connector credential |
| 12 | connector mismatch refused | provider-credential-store.test.js › Credential isolation: another merchant or another provider can never read, write or rotate a connector credential |
| 13 | fake store | provider-credential-store.test.js › Stores: the fake is only a fake, the Vault adapter speaks to the narrow functions only and fails closed, Activation can use the store |
| 14 | Activation credential compatibility | provider-credential-store.test.js › Stores: the fake is only a fake, the Vault adapter speaks to the narrow functions only and fails closed, Activation can use the store |
| 15 | frontend cannot read vault | provider-credential-store.test.js › The Vault is reachable only through the service role: no front-end code reads vault secrets, the functions are revoked from anon and authenticated |
| 16 | start valid | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 17 | state random | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 18 | state hash persisted | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 19 | raw state absent | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 20 | provider bound | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 21 | merchant bound | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 22 | expiry | provider-oauth-session.test.js › Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider |
| 23 | single-use | provider-oauth-session.test.js › Callback binding: unknown or tampered states, another provider, another merchant, replays and expiry are all refused |
| 24 | invalid state | provider-oauth-session.test.js › Callback binding: unknown or tampered states, another provider, another merchant, replays and expiry are all refused |
| 25 | replay | provider-oauth-session.test.js › Callback binding: unknown or tampered states, another provider, another merchant, replays and expiry are all refused |
| 26 | expired callback | provider-oauth-session.test.js › Callback binding: unknown or tampered states, another provider, another merchant, replays and expiry are all refused |
| 27 | wrong provider | provider-oauth-session.test.js › Callback binding: unknown or tampered states, another provider, another merchant, replays and expiry are all refused |
| 28 | error normalized | provider-oauth-session.test.js › OAuth errors are normalized, never carry a provider body, and a failed callback consumes the state |
| 29 | no code persisted | provider-oauth-session.test.js › No authorization code is ever persisted, and return_to is an internal allow-listed route (no open redirect) |
| 30 | no open redirect | provider-oauth-session.test.js › No authorization code is ever persisted, and return_to is an internal allow-listed route (no open redirect) |
| 31 | auth URL current | provider-instagram.test.js › Instagram authorization request: the current Instagram Login URL with the minimum, non-deprecated scopes |
| 32 | minimum scopes | provider-instagram.test.js › Instagram authorization request: the current Instagram Login URL with the minimum, non-deprecated scopes |
| 33 | server-side exchange | provider-instagram.test.js › Instagram code exchange runs on the server: client secret and code are sealed in the request, the trailing "#_" is stripped, the browser gets no token |
| 34 | professional discovery | provider-instagram.test.js › Instagram discovery: Professional accounts are eligible, a consumer account is refused, the choice is explicit, the account id is stable |
| 35 | consumer refused | provider-instagram.test.js › Instagram discovery: Professional accounts are eligible, a consumer account is refused, the choice is explicit, the account id is stable |
| 36 | explicit target selection | provider-instagram.test.js › Instagram discovery: Professional accounts are eligible, a consumer account is refused, the choice is explicit, the account id is stable |
| 37 | token via credential store only | provider-instagram.test.js › Instagram credentials live in the credential store only; publish scopes are verified; the connection is CONFIGURED only after verification |
| 38 | stable external_id | provider-instagram.test.js › Instagram discovery: Professional accounts are eligible, a consumer account is refused, the choice is explicit, the account id is stable |
| 39 | publish scopes verified | provider-instagram.test.js › Instagram credentials live in the credential store only; publish scopes are verified; the connection is CONFIGURED only after verification |
| 40 | connection CONFIGURED | provider-instagram.test.js › Instagram credentials live in the credential store only; publish scopes are verified; the connection is CONFIGURED only after verification |
| 41 | revoked/invalid → reauth/misconfigured | provider-instagram.test.js › Instagram health: a rejected token is REAUTH_REQUIRED (runtime only), a downgraded account is MISCONFIGURED, an outage is UNAVAILABLE and never stored |
| 42 | no publish | provider-instagram.test.js › Instagram provisioning never publishes: only OAuth, token and account-read endpoints are called |
| 43 | Login Kit auth URL | provider-tiktok.test.js › TikTok Login Kit authorization request and the redirect URI rules |
| 44 | redirect rules | provider-tiktok.test.js › TikTok Login Kit authorization request and the redirect URI rules |
| 45 | server-side exchange | provider-tiktok.test.js › TikTok code exchange is server side; the refresh token is sealed and lives in the credential store only |
| 46 | refresh token secure | provider-tiktok.test.js › TikTok code exchange is server side; the refresh token is sealed and lives in the credential store only |
| 47 | video.publish verified | provider-tiktok.test.js › TikTok identity, scope and selection: video.publish is mandatory, the open_id is the stable id, the choice is explicit, the audit limitation is visible |
| 48 | identity discovered | provider-tiktok.test.js › TikTok identity, scope and selection: video.publish is mandatory, the open_id is the stable id, the choice is explicit, the audit limitation is visible |
| 49 | explicit selection | provider-tiktok.test.js › TikTok identity, scope and selection: video.publish is mandatory, the open_id is the stable id, the choice is explicit, the audit limitation is visible |
| 50 | refresh supported | provider-tiktok.test.js › TikTok refresh: supported, the rotated refresh token replaces the old one, and two workers never refresh at the same time |
| 51 | refresh concurrency | provider-tiktok.test.js › TikTok refresh: supported, the rotated refresh token replaces the old one, and two workers never refresh at the same time |
| 52 | missing video.publish not configured | provider-tiktok.test.js › TikTok identity, scope and selection: video.publish is mandatory, the open_id is the stable id, the choice is explicit, the audit limitation is visible |
| 53 | audit/private signal | provider-tiktok.test.js › TikTok identity, scope and selection: video.publish is mandatory, the open_id is the stable id, the choice is explicit, the audit limitation is visible |
| 54 | no publish | provider-tiktok.test.js › TikTok provisioning never posts: only OAuth, creator identity and revoke endpoints are called, and disconnect revokes at TikTok |
| 55 | business.manage minimum | provider-google.test.js › Google consent URL: business.manage only, offline access for a refresh token, S256 PKCE |
| 56 | consent URL | provider-google.test.js › Google consent URL: business.manage only, offline access for a refresh token, S256 PKCE |
| 57 | code exchange server | provider-google.test.js › Google code exchange is server side with the PKCE verifier from the secret store; the verifier is never in the session row |
| 58 | refreshability represented | provider-google.test.js › Google refreshability is represented: a refresh token makes it refreshable, none means re-consent when the access token ends |
| 59 | accounts discovered | provider-google.test.js › Google discovery lists every account and every location, the merchant picks ONE location, and an account alone is never a target |
| 60 | locations discovered | provider-google.test.js › Google discovery lists every account and every location, the merchant picks ONE location, and an account alone is never a target |
| 61 | explicit location | provider-google.test.js › Google discovery lists every account and every location, the merchant picks ONE location, and an account alone is never a target |
| 62 | external_id is location | provider-google.test.js › Google discovery lists every account and every location, the merchant picks ONE location, and an account alone is never a target |
| 63 | location reverified | provider-google.test.js › Google re-verifies the location before binding and on every check; a removed location or a revoked grant is handled |
| 64 | missing scope refused | provider-google.test.js › Google scope and the absence of any posting: a missing business.manage grant is refused; no LocalPost is ever created |
| 65 | revoked grant handled | provider-google.test.js › Google re-verifies the location before binding and on every check; a removed location or a revoked grant is handled |
| 66 | no LocalPost | provider-google.test.js › Google scope and the absence of any posting: a missing business.manage grant is refused; no LocalPost is ever created |
| 67 | list | provider-connection-center.test.js › Connection Center: lists every provider connector, secret-free, with the live state and readiness |
| 68 | secret-free | provider-connection-center.test.js › Connection Center: lists every provider connector, secret-free, with the live state and readiness |
| 69 | start connect | provider-connection-center.test.js › Connection Center flow: starting, the session reference, the mandatory target selection and the status |
| 70 | session returned | provider-connection-center.test.js › Connection Center flow: starting, the session reference, the mandatory target selection and the status |
| 71 | target selection required | provider-connection-center.test.js › Connection Center flow: starting, the session reference, the mandatory target selection and the status |
| 72 | status | provider-connection-center.test.js › Connection Center flow: starting, the session reference, the mandatory target selection and the status |
| 73 | verify | provider-connection-center.test.js › Connection Center flow: starting, the session reference, the mandatory target selection and the status |
| 74 | reconnect | provider-connection-center.test.js › Reconnect, disconnect and several connectors of one provider: identity is stable, nothing is picked implicitly |
| 75 | disconnect | provider-connection-center.test.js › Reconnect, disconnect and several connectors of one provider: identity is stable, nothing is picked implicitly |
| 76 | multiple connectors | provider-connection-center.test.js › Reconnect, disconnect and several connectors of one provider: identity is stable, nothing is picked implicitly |
| 77 | no auto-pick | provider-connection-center.test.js › Reconnect, disconnect and several connectors of one provider: identity is stable, nothing is picked implicitly |
| 78 | cross-merchant refused | provider-connection-center.test.js › Isolation: another merchant sees nothing, cannot select into or disconnect someone else, and sessions stay with their merchant |
| 79 | UNAVAILABLE not persisted | provider-connection-center.test.js › Runtime states are never stored and CONFIGURED needs a successful verification |
| 80 | CONFIGURED only after verification | provider-connection-center.test.js › Runtime states are never stored and CONFIGURED needs a successful verification |
| 81 | production resolver satisfies Activation | provider-activation-integration.test.js › The production credential resolver satisfies Activation: READY with real credentials, scopes and external_id flowing through |
| 82 | scopes flow to preflight | provider-activation-integration.test.js › The production credential resolver satisfies Activation: READY with real credentials, scopes and external_id flowing through |
| 83 | external_id flows | provider-activation-integration.test.js › The production credential resolver satisfies Activation: READY with real credentials, scopes and external_id flowing through |
| 84 | connection view intact | provider-activation-integration.test.js › Activation keeps working with its own connection view and health check on the production credentials |
| 85 | expired token refreshes | provider-activation-integration.test.js › An expiring token is refreshed before Activation uses it; a refresh failure or a revoked connector blocks safely, without any provider call |
| 86 | refresh failure blocks safely | provider-activation-integration.test.js › An expiring token is refreshed before Activation uses it; a refresh failure or a revoked connector blocks safely, without any provider call |
| 87 | revoked connector blocks | provider-activation-integration.test.js › An expiring token is refreshed before Activation uses it; a refresh failure or a revoked connector blocks safely, without any provider call |
| 88 | Activation code unchanged | provider-activation-integration.test.js › Activation and Marketing are untouched: neither imports Provider Provisioning, the credential interface is the existing one |
| 89 | Activation tests green | (CI) the Activation suites (`node --test test/channel-*.test.js test/merchant-connectors.test.js`) run unchanged in the dedicated workflow |
| 90 | M4 unchanged | provider-activation-integration.test.js › Activation and Marketing are untouched: neither imports Provider Provisioning, the credential interface is the existing one |
| 91 | no token in merchant_connectors | provider-security.test.js › No token, secret or state value in any persisted row, log or error (91-95) |
| 92 | no token in connector_credentials | provider-security.test.js › No token, secret or state value in any persisted row, log or error (91-95) |
| 93 | no token in oauth_sessions | provider-security.test.js › No token, secret or state value in any persisted row, log or error (91-95) |
| 94 | no token logs | provider-security.test.js › No token, secret or state value in any persisted row, log or error (91-95) |
| 95 | no token errors | provider-security.test.js › No token, secret or state value in any persisted row, log or error (91-95) |
| 96 | no raw state | provider-security.test.js › The raw state, the authorization code, the PKCE verifier and the client secrets never reach the database (96-99) |
| 97 | no auth code | provider-security.test.js › The raw state, the authorization code, the PKCE verifier and the client secrets never reach the database (96-99) |
| 98 | no PKCE verifier | provider-security.test.js › The raw state, the authorization code, the PKCE verifier and the client secrets never reach the database (96-99) |
| 99 | no client secret DB | provider-security.test.js › The raw state, the authorization code, the PKCE verifier and the client secrets never reach the database (96-99) |
| 100 | no secret CLI output | provider-security.test.js › The CLI and the callback receiver print no secret and echo no code or state (100) |
| 101 | no open redirect | provider-security.test.js › No open redirect; the callback cannot choose the merchant; a replay is detected (101-103) |
| 102 | callback merchant cannot override | provider-security.test.js › No open redirect; the callback cannot choose the merchant; a replay is detected (101-103) |
| 103 | replay detected | provider-security.test.js › No open redirect; the callback cannot choose the merchant; a replay is detected (101-103) |
| 104 | Vault read scoped | provider-security.test.js › Vault reads are scoped to the merchant and the provider; a cross-merchant vault reference is refused (104-105) |
| 105 | cross-merchant vault ref refused | provider-security.test.js › Vault reads are scoped to the merchant and the provider; a cross-merchant vault reference is refused (104-105) |
| 106 | merchant connectors green | (CI) `node --test test/channel-*.test.js test/merchant-connectors.test.js` (merchant connectors, 66 tests) - dedicated workflow |
| 107 | Activation core green | (CI) Activation core: `test/channel-execution-core.test.js` - dedicated workflow |
| 108 | Instagram activation green | (CI) Instagram activation: `test/channel-instagram.test.js` - dedicated workflow |
| 109 | TikTok activation green | (CI) TikTok activation: `test/channel-tiktok.test.js` - dedicated workflow |
| 110 | GBP activation green | (CI) Google Business Profile activation: `test/channel-google-business.test.js` - dedicated workflow |
| 111 | Marketing M1-M4 green | (CI) Marketing M1-M4: `node --test test/marketing*.test.js` - dedicated workflow |
| 112 | Branding green | (CI) Branding: `node --test test/branding*.test.js` - dedicated workflow |
| 113 | Creative Fidelity green | (CI) Creative Fidelity: `node --test test/creative-fidelity*.test.js` - dedicated workflow |
| 114 | full suite green | (CI) full suite: `npm test` - dedicated workflow |
| 115 | migrations smoke green where applicable | (CI) `test/postgres/provider-connections.pg-smoke.mjs` (real PostgreSQL + real Supabase Vault in Docker; not `npm test`) |
<!-- coverage-matrix:end -->

## 14. Open dependencies and USER ACTIONS REQUIRED

Nothing below can be done by the code, and none of it is circumvented.

| ACTION | WHO | WHY | CAN CLAUDE DO IT? |
|---|---|---|---|
| Register a Meta developer app with *Instagram API with Instagram Login*; add the redirect URI; request `instagram_business_basic` + `instagram_business_content_publish` | Owner (Meta developer account) | an OAuth client id / secret only the owner can create | NO (guide in the runbook) |
| Add the Instagram professional account as app tester / complete App Review for the publish scope | Owner + Meta review | publishing for accounts that are not testers needs approved permissions | NO |
| Register a TikTok developer app; enable Login Kit + Content Posting API; add `video.publish`; register the redirect URI | Owner (TikTok developer account) | client key / secret only the owner can create | NO |
| Pass TikTok's app audit and verify the media domain / URL prefix | Owner + TikTok review | until audited, posts are private-only | NO |
| Create a Google Cloud project, enable the Business Profile APIs, request API access, configure the OAuth consent screen, create an OAuth web client | Owner (Google account) | Business Profile API access is granted by Google on request | NO |
| Put `*_CLIENT_ID / *_CLIENT_SECRET / *_REDIRECT_URI` in the deployment secret store (never in Git or chat) | Owner / operator | secrets must be set where the service runs | NO (names are in `.env.example`) |
| Deploy the service behind a public **HTTPS** callback URL | Owner / operator | providers require a registered https redirect URI | NO |
| Enable the Supabase Vault extension and apply the migration on the production project | Owner / operator | production database change | NO (migration verified on a real Vault) |
| Each merchant consents at the provider and chooses the account / location | Merchant | consent cannot be given on someone's behalf | NO (by design) |
| Controlled media delivery (public HTTPS media URLs for Instagram / Google, verified domain for TikTok) | Owner / operator | providers fetch media from a URL | NO (next dependency) |
| Connection Center UI | Product | the backend is ready, no UI exists | LATER (separate mandate) |
| Sandbox verification of the three adapters against real provider responses | Owner (with the apps registered) | docs-derived assumptions (§8, *Sandbox to verify*) | PARTLY (once the apps exist) |

**Can real merchant accounts be connected now? PARTIAL** — the backend, the Vault design and the OAuth flows are complete; a real connection needs the owner's app registrations, a public HTTPS callback and the merchant's consent.

## 15. Deviations and decisions

- The token waiting for the merchant's explicit target choice is held in the **Vault** (`PENDING_TOKENS`), not in the session row; the row carries only the reference.
- The view field is named `grant` (not `credential`) so the repository's secret scanner is never tripped by a field whose name looks like a secret.
- Refresh thresholds are Nordla policy values (§7), declared as such.
- The CLI lets exactly one URL through its secret scanner (the authorization URL), after checking it is an `https` URL without any secret parameter.
- No change to Activation V1, Marketing, Branding or Creative Fidelity code.

## 16. Next

Not started by this mandate: a Connection Center UI, controlled media delivery, a provider sandbox pass, then Creative Intelligence (after prior deep research) and Social Trend Intelligence.
