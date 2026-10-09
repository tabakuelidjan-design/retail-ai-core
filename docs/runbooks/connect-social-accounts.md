# Runbook — Connect a merchant's social accounts

How an operator connects Instagram, TikTok and Google Business Profile for a merchant, once the provider apps are registered ([`provider-app-registration.md`](./provider-app-registration.md)). The Connection Center **UI** does not exist yet; this runbook uses the CLI backend.

> The merchant gives consent **at the provider**, in their own browser session. Nordla never sees a password and never connects an account on someone's behalf. **Never paste a token, a code or a secret into a chat or a ticket.**

## Prerequisites

- The deployment has the `*_CLIENT_ID / *_CLIENT_SECRET / *_REDIRECT_URI` variables set (names in `.env.example`), a public HTTPS callback that reaches the service, the Supabase Vault enabled and the migration applied.
- The merchant is the tenant the service runs for (the merchant comes from the server context, never from a URL).

## Steps (any provider)

1. **Start.** From the CLI: `connect <provider>` where `<provider>` is `instagram`, `tiktok` or `google_business_profile`. It prints the **authorization URL** and a `session_ref`. The session expires after 10 minutes.
2. **Receive the callback.** The provider redirects the merchant to the registered redirect URI; the service consumes the one-time `state` and exchanges the code on the server. (For local checks `serve-callback` runs a receiver on `127.0.0.1`; a provider that requires an HTTPS redirect needs the real deployment in front.)
3. **The merchant consents.** Open the URL in the merchant's browser; they sign in at the provider and approve the requested permission(s). Refusing is fine: the session simply ends (`USER_DENIED`).
4. **List the authorized targets.** `targets <session_ref>` shows the accounts / locations the merchant authorized, with an eligibility verdict each (for example an Instagram personal account is `ACCOUNT_NOT_PROFESSIONAL`; a missing scope is `SCOPE_MISSING`). **Selection is mandatory, even with a single candidate.** You have 15 minutes after the callback.
5. **Choose.** `select <session_ref> <external_id>` binds exactly that account / location. Nordla re-verifies it at the provider, stores the credential in the Vault, and marks the connector `CONFIGURED` only if verification succeeds.
6. **Check.** `status` lists every connector with `connection_state`, granted scopes, expiry and `live_readiness`. `verify <connector_id>` re-checks a connection at any time.

## Per provider

| Provider | What the merchant needs | What to choose at step 5 |
|---|---|---|
| Instagram | a **professional** (Business / Creator) account; grants `instagram_business_basic` and `instagram_business_content_publish` | the Instagram professional account id shown in `targets` |
| TikTok | a TikTok account; grants `video.publish` | the account `open_id` shown in `targets` |
| Google Business Profile | a Google account that manages the location; grants `business.manage` | a **location** (`accounts/…/locations/…`) — an account alone is never a target |

Several accounts / locations of one provider can be connected side by side (one connector each); none is ever chosen automatically.

## When something is off

| Symptom | Meaning | What to do |
|---|---|---|
| `INVALID_STATE` | unknown, tampered, reused or cross-merchant state | start again with `connect` |
| `SESSION_EXPIRED` | more than 10 minutes between `connect` and the callback, or 15 minutes before `select` | start again |
| `USER_DENIED` | the merchant refused | ask the merchant, then start again |
| `SCOPE_MISSING` | a required permission was not granted | start again and ask the merchant to approve every requested permission |
| `APP_MISCONFIGURED` | missing/invalid client id, secret or redirect URI (names only are reported) | fix the variable in the secret store; check the provider console |
| `PROVIDER_UNAVAILABLE` / `connection_state UNAVAILABLE` | temporary outage (provider, network or Vault) | retry later; nothing is changed in the stored state |
| `REAUTH_REQUIRED` | the provider no longer accepts the grant (revoked, expired, password change…) | `connect` again for the same account: the same connector is reused and its credential rotated |
| `PC_VAULT_UNAVAILABLE` | the Vault cannot be reached or is not enabled | enable/repair the Vault; there is **no** plaintext fallback |

## Reconnect, disconnect

- **Reconnect:** run `connect` again and choose the same account / location — identity (`external_id`) is stable, the connector is reused and the credential is rotated.
- **Disconnect:** `disconnect <connector_id>` destroys the stored secret, tries to revoke at the provider when an official endpoint exists (TikTok, Google; Instagram has none — remove the app in Instagram settings too) and sets the connector to `NOT_CONFIGURED`. The publication history is kept.

## What this does not do

It does not publish anything, does not approve a campaign (Marketing prepares, the Socle/human authorizes, the execution layer executes) and does not make a provider `PRODUCTION_READY`: app review/audit, scopes approval and controlled media delivery remain separate steps.
