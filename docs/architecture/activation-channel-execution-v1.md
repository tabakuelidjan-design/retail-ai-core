# Activation & Channel Execution V1 (Instagram · TikTok · Google Business Profile)

- **Status:** IMPLEMENTED LOCALLY / UNDER AUDIT — not pushed, not COMPLETE until audit, push and CI
- **Version:** `activation-channel-execution.v1` (`ACTIVATION_VERSION`)
- **Code:** `src/activation/` · **Migration:** `supabase/migrations/20261009100000_channel_execution_jobs.sql` · **CI:** `.github/workflows/activation-channel-execution-v1.yml`
- **Tests:** `test/channel-execution-core.test.js` · `channel-execution-repository.test.js` · `channel-instagram.test.js` · `channel-tiktok.test.js` · `channel-google-business.test.js` · `channel-execution-m4-integration.test.js` (+ fixtures `test/channel-fixtures.js`)
- **Builds on:** ADR 0003 `merchant_connectors`, Marketing M3 `ActivationManifest`, Marketing M4 `SocleExecutionAuthorization` / `MarketingExecutionReceipt` ([`marketing-v1-architecture.md`](./marketing-v1-architecture.md), [`marketing-m4-steer-contract.md`](./marketing-m4-steer-contract.md))

## 1. Principle

```text
MARKETING PREPARES
SOCLE / POLICY / HUMAN AUTHORIZES
EXECUTION LAYER EXECUTES
M4 OBSERVES AND LEARNS
```

Activation & Channel Execution is **not** Marketing decision logic. It is the governed execution layer that consumes an approved `ActivationManifest`, checks the capabilities of the connected account, executes ONE external call per delivery through a provider adapter, guarantees it never happens twice, follows the real provider status, keeps the proof and returns a `MarketingExecutionReceipt` that the existing M4 accepts unchanged. It never chooses what to publish, which account to use, the best time, the copy, the media or the privacy level, and it stores no token.

```text
ActivationManifest (READY_FOR_POLICY) + SocleExecutionAuthorization (given)
  -> ChannelExecutionOrder -> Channel Capability Gate -> live preflight
  -> durable outbox job (channel_execution_jobs) -> provider adapter (Instagram | TikTok | Google Business Profile)
  -> provider status -> ChannelPublicationReceipt -> MarketingExecutionReceipt -> M4 — STEER
```

## 2. Provider facts verified on 2026-10-09

Checked against the official documentation pages listed in each capability's `verified_against`. Re-verify before extending a capability.

**Instagram (Instagram API with Instagram Login).** Scopes `instagram_business_basic` + `instagram_business_content_publish`. Professional accounts only (`account_type` `Business` or `Media_Creator`; `GET /me?fields=user_id,username,account_type`). Publishing: `POST /<IG_ID>/media` creates a **container** (`image_url` or `video_url`, `media_type` `REELS` for video, `caption`), `GET /<container>?fields=status_code` (`IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED`, `PUBLISHED`; poll about once a minute, at most about five minutes), then `POST /<IG_ID>/media_publish {creation_id}` returns the media id. Images must be **JPEG**. The media must be on a **publicly accessible server** at the time of the attempt. About 100 API-published posts per rolling 24 h per account (the page also mentions 50 for carousels: unresolved on the page, so treated as an unverified quota). The documentation passes the token as the `access_token` parameter (sealed here, never logged). The examples use Graph API `v25.0`; the version is **configuration**, never hardcoded. Limitations kept in V1: carousels and Stories are not implemented; Page Publishing Authorization may block publishing; shopping tags are not supported.

**TikTok (Content Posting API, Direct Post).** Scope `video.publish`. `POST /v2/post/publish/creator_info/query/` **before** a direct post (`privacy_level_options`, `comment_disabled`, `duet_disabled`, `stitch_disabled`, `max_video_post_duration_sec`). Video: `POST /v2/post/publish/video/init/` (`source` `PULL_FROM_URL` or `FILE_UPLOAD`). Photo: `POST /v2/post/publish/content/init/` (`media_type PHOTO`, `post_mode DIRECT_POST`, `source` `PULL_FROM_URL` only, up to 35 URLs, verified by the app). `privacy_level` must be one of the creator's current options. **An unaudited client can only post privately** (`unaudited_client_can_only_post_to_private_accounts`). `PULL_FROM_URL` requires a verified URL prefix or domain (`url_ownership_unverified`). `POST /v2/post/publish/status/fetch/` returns `PROCESSING_DOWNLOAD`, `PROCESSING_UPLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED` (+ `fail_reason`); `publicaly_available_post_id` (sic) is filled only when the post is public and moderated. Errors can arrive as HTTP 200 with `error.code != ok`. Rate limits per user token: 6 init/min, 20 creator_info/min, 30 status/min. Posting webhooks exist at TikTok; V1 uses polling only.

**Google Business Profile (My Business API v4 `localPosts`).** `POST https://mybusiness.googleapis.com/v4/{accounts/*/locations/*}/localPosts` (`accounts.locations.localPosts.create`), scope `https://www.googleapis.com/auth/business.manage` (`plus.business.manage` is the legacy alias, not used). Returns the created `LocalPost` (`name`, `state` `LIVE` / `PROCESSING` / `REJECTED` / `SCHEDULED`, `searchUrl`). `topicType` is `STANDARD`, `EVENT`, `OFFER` or `ALERT`: **there is no PRODUCT topic type, so Product Posts are NOT supported by this API**. `EVENT` and `OFFER` need an `event` (title + start/end date and time); `offer` carries `couponCode`, `redeemOnlineUrl`, `termsConditions`. `callToAction.actionType` is `BOOK`, `ORDER`, `SHOP`, `LEARN_MORE`, `SIGN_UP`, `CALL` (`GET_OFFER` is deprecated). LocalPost media supports `sourceUrl` only.

## 3. Reuse of `merchant_connectors` and the credential boundary

No second table of social connections. A connector is a `merchant_connectors` row whose `kind` is the provider id (`instagram`, `tiktok`, `google_business_profile`; the registry is open-set, `src/tenant/connectors.js` is **not modified**) and whose `external_id` is the stable account: the professional account id (Instagram), the authorized open id (TikTok), the canonical `accounts/{id}/locations/{id}` resource (Google). This layer **requires** that external_id (`ACT_CONNECTOR_EXTERNAL_ID_REQUIRED`) and **never auto-selects** a connector, an account or a location: every delivery names its `connector_id`.

Secrets: never in `merchant_connectors.config`, jobs, receipts, logs or errors. The only door is the injectable `ChannelCredentialProvider.resolve({ merchant_id, connector_id, provider, purpose })`; a resolved credential is held in a `SealedSecret` (prints and serializes as `[REDACTED]`, revealed only at the HTTP boundary). V1 ships an in-memory fake for tests. **PRODUCTION_CREDENTIAL_STORE is an open dependency**: without a resolver, real execution fails cleanly (`ACT_CREDENTIAL_PROVIDER_REQUIRED`). `ChannelConnectionView` is the secret-free Connection Center contract (no UI). `verifyChannelConnection` follows ADR 0003: `CONFIGURED` / `MISCONFIGURED` are persistable, `UNAVAILABLE` is runtime-only (`persist_status` null). OAuth framework: not built (the credential store hands tokens over).

## 4. Channel Capability Registry

`CHANNEL_CAPABILITIES` (deep-frozen): `provider`, `account_requirements`, `supported_content_kinds`, `supported_delivery_modes`, `requires_public_media_url`, `supports_direct_publish`, `supports_status_polling`, `supports_webhook_status`, `supports_provider_scheduling`, `requires_interactive_confirmation`, `required_scopes`, `limitations`, `capability_version`, `verified_against`, `verified_at`. No capability is invented: Instagram `IMAGE`/`VIDEO`(Reel); TikTok `IMAGE`(photo)/`VIDEO`, `INTERACTIVE_CONFIRMATION` only; Google `TEXT`/`IMAGE`, topic types `STANDARD`/`EVENT`/`OFFER`. The live preflight may still degrade or refuse.

## 5. ChannelExecutionOrder

`order_id (aco_…) · merchant_id · brand_id · activation_manifest_ref · execution_authorization_ref · created_at · expires_at · deliveries[] · status_snapshot`. Scope is derived from the manifest. It reuses the **M4 `SocleExecutionAuthorization`** (no second kind of authorization). Every manifest delivery appears exactly once; each delivery: `delivery_ref`, `manifest_delivery_ref`, `connector_id`, `provider` (must be the connector's), `publish_mode`, `publish_at`, closed `provider_options`, `approval_ref?`. Modes: `PUBLISH_NOW`, `SCHEDULE_INTERNAL` (needs a `publish_at` chosen elsewhere, inside `[activation_window.start, end)`), `INTERACTIVE_CONFIRMATION`. The layer never computes a best time. `expires_at` is bounded by the manifest, the authorization and the activation window. A stored order is a snapshot; the live answer is the preflight. After authorization, a change of assets, copy refs, provider options, connector or `publish_at` is a **new** order (the request fingerprint changes: `ACT_IDEMPOTENCY_CONFLICT`).

## 6. Preflight (READY · REVIEW_REQUIRED · BLOCKED · UNAVAILABLE)

Nothing is executed unless `READY`, and the preflight runs again at execution time. `BLOCKED`: stale authorization / order / manifest, manifest not **live** `READY_FOR_POLICY` (re-evaluated with the M3 `evaluateActivationReadiness` from its originals; the stored readiness is never trusted), missing / `NOT_CONFIGURED` / `MISCONFIGURED` connector, missing scope, unsupported content kind or mode, ineligible account (Instagram: not Professional, or `/me` is not the connector's account), incompatible media (Instagram image not JPEG), unverified TikTok domain, TikTok privacy not among the creator's options, an option pointing at an asset that is not in the approved manifest content, a provider restriction. `UNAVAILABLE`: credential provider / provider / media transport outage. `REVIEW_REQUIRED`: interactive confirmation pending (TikTok always needs `approval_ref`), TikTok private-only (unaudited client) limitation. Signals are sorted and deduplicated.

## 7. Durable outbox, idempotency, retries

`channel_execution_jobs` (RLS on, service role only; FK `merchants`, `merchant_connectors`; a trigger refuses a connector of another merchant; identity immutable; terminal states immutable; `PUBLISHED` needs a post id and a time; no secret column). Unique `(merchant_id, activation_manifest_ref, manifest_delivery_ref, connector_id)` and `(merchant_id, idempotency_key)`. The repository is merchant-scoped on every call; every state change is a **compare-and-set** (atomic claim; two workers, one winner; an enqueue race loses on the UNIQUE constraint and settles on the first job; same key + other fingerprint = `ACT_IDEMPOTENCY_CONFLICT`).

States `PLANNED · READY · SUBMITTING · PROCESSING · PUBLISHED · FAILED_RETRYABLE · FAILED_FINAL · CANCELLED`, closed transitions (`PUBLISHED`, `FAILED_FINAL`, `CANCELLED` are terminal; `SUBMITTING -> READY` only hands a claimed job back when the live preflight needs a human). Retries only for `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TIMEOUT`, `PROCESSING_TRANSIENT`; backoff 1m → 5m → 15m → 60m, `Retry-After` wins when later, never past the deadline (the order expiry), at most 5 attempts. Auth, scope, media, privacy, policy, account and permanent 4xx errors are final. **A creating call whose outcome is unknown is never retried** (TikTok init, Google create: timeout or 5xx → `SUBMISSION_OUTCOME_UNKNOWN`, human review), and a worker that died after claiming is never resubmitted blindly (`SUBMISSION_STATE_UNKNOWN`). Instagram only creates a container in `submit`; `media_publish` happens in a separate, claimed status step, so a timeout cannot create a second post (a container already `PUBLISHED` without a known media id is `PUBLISH_RESULT_UNKNOWN`). Status polling is claimed atomically and bounded (12 polls, the deadline).

## 8. Adapters, media and logging

Adapter interface: `preflight`, `buildSubmission`, `submit`, `fetchStatus`, `verifyAccount`, `normalizeProviderError`. Every call goes through an **injected** `http` with a hard timeout (`createFetchHttp` builds the real one on an injected `fetch`; there is no hidden global fetch). `provider_options` are **closed schemas** per provider and never forwarded raw. Every text / link used by a post (caption, CTA url, event title, coupon…) is an approved asset ref of the manifest, resolved through the transport boundary; TikTok `privacy_level`, `is_aigc` and both brand toggles are **required explicit values of the approved order** (never guessed; `PUBLIC_TO_EVERYONE` is never a default).

`MediaTransportProvider.resolve({ asset_ref, provider, purpose })` turns a durable ref into an **ephemeral** location (sealed, public `https` only: a file path, `data:`/`blob:`, plain `http`, a credentialed URL or `localhost` is refused). The URL is used for one call and **never persisted, logged or fingerprinted**. This layer converts, crops, transcodes and captions nothing (`MEDIA_NOT_COMPATIBLE` goes back to Creative / Production). **CONTROLLED_MEDIA_DELIVERY is an open dependency.** Logs carry codes and ids only and pass through the redaction guard (`redact`, `assertNoSecrets`).

## 9. Receipts and the M4 handoff

`ChannelPublicationReceipt` (`acr_…`) exists **only** for a job confirmed `PUBLISHED`: merchant, brand, manifest, delivery, connector, provider, provider submission id, provider post id, `published_at`, evidence refs `provider-post://…`, safe metadata (a public https permalink without query). It does not say the marketing worked. `buildMarketingExecutionReceiptFromPublications` produces the **existing** M4 `MarketingExecutionReceipt` (validated by M4's own normalizer; M4 is unchanged): all deliveries published → `EXECUTED`, at least one but not all → `PARTIAL`, none → no receipt (`ACT_M4_NOTHING_PUBLISHED`, never a fake PARTIAL); `delivery_execution_refs` reference the internal publication receipt ids; provider ids travel as evidence refs for future measurement. Published ≠ engaged ≠ profitable ≠ incremental.

## 10. Production readiness

`assessActivationProductionReadiness(facts)` returns, per provider, `CONTRACT_READY` → `ADAPTER_READY` → `SANDBOX_READY` → `PRODUCTION_READY` and the open blockers. Default (no fact): **ADAPTER_READY with every blocker open**. `PRODUCTION_READY` is never inferred; it needs a production credential store, app registration / approval, target account authorization, media transport and the required audits.

| Provider | Blockers before production |
|---|---|
| Instagram | Meta app configuration · approved scopes · Professional account · credential store · media transport |
| TikTok | registered app · Content Posting API enabled · `video.publish` approved · target account authorized · client audit for public visibility · verified media domain for `PULL_FROM_URL` · creator UX / consent compliance · credential store |
| Google Business Profile | Google Cloud / API access · OAuth client · `business.manage` grant · authorized business account · explicit location binding · credential store · media transport |

## 11. Deviations and interpretations (documented)

1. The M4 `SocleExecutionAuthorization` is reused as the execution authorization. The order builder takes the original `push` (M4 already validates the authorization against it).
2. The job row carries `brand_id`, `publish_mode`, `deadline_at`, `payload`, `status_poll_count` and `safe_metadata` beyond the mandate's conceptual fields (needed to execute and poll from the outbox alone); all are refs / codes.
3. TikTok V1 uses `PULL_FROM_URL` for photo and video (the only photo mode); `FILE_UPLOAD` is not implemented. TikTok always requires `INTERACTIVE_CONFIRMATION` with an `approval_ref` (the creator's explicit consent); an unaudited client is surfaced as `TIKTOK_UNAUDITED_PRIVATE_ONLY` and limited to `SELF_ONLY`.
4. Google `mediaFormat: PHOTO` for `sourceUrl` media follows the v4 `MediaItem` resource; the `GET {name}` status read and the list call used to verify access follow the v4 localPosts reference. To re-verify at the sandbox stage together with the generic Graph API error codes used to classify Instagram errors (190 auth, 4 / 17 / 32 / 613 rate limit, 10 / 200-299 permission).
5. Instagram: the ~100 posts / 24 h quota is not enforced pre-emptively (a `content_publishing_limit` check is a later improvement); the two figures on the page are unresolved.
6. A timeout or 5xx on a **creating** call is final (`SUBMISSION_OUTCOME_UNKNOWN`) for TikTok and Google rather than retried, to honor "never duplicate a post". Rate limits (429) and Instagram container creation are retried.
7. `INTERACTIVE_CONFIRMATION` is satisfied by an `approval_ref` on the order delivery (a human approval done elsewhere); there is no confirmation UI.

## 12. Open dependencies

production credential vault · real OAuth app registrations · provider app reviews / audits · user OAuth consent UI · Connection Center UI · controlled media delivery service · real provider accounts · public webhook endpoint / deployment · provider metrics ingestion · Decision Ledger integration · notification / alert UI · remote delete / edit workflows · comments / messages · Social Trend Intelligence.

## 13. Test coverage — mandate cases 1–210

One row per numbered case of the mandate (§44). Several cases share a test function when it asserts them together; `test/channel-execution-core.test.js` enforces that this table is contiguous, holds all 210 cases and that every named test exists. Cases marked **(CI)** are the cross-domain suites executed by the dedicated workflow (and, for Marketing, by `Marketing V1`).

<!-- coverage-matrix:start -->
| # | Mandate case | Test |
|---|---|---|
| 1 | instagram connector accepted | channel-execution-core.test.js › Connections: Instagram, TikTok and Google Business connectors are accepted, each with a stable external_id and in its own merchant |
| 2 | tiktok connector accepted | channel-execution-core.test.js › Connections: Instagram, TikTok and Google Business connectors are accepted, each with a stable external_id and in its own merchant |
| 3 | GBP connector accepted | channel-execution-core.test.js › Connections: Instagram, TikTok and Google Business connectors are accepted, each with a stable external_id and in its own merchant |
| 4 | each requires external_id in activation layer | channel-execution-core.test.js › Connections: Instagram, TikTok and Google Business connectors are accepted, each with a stable external_id and in its own merchant |
| 5 | merchant mismatch refused | channel-execution-core.test.js › Connections: Instagram, TikTok and Google Business connectors are accepted, each with a stable external_id and in its own merchant |
| 6 | MISCONFIGURED blocks | channel-execution-core.test.js › Connector status: NOT_CONFIGURED and MISCONFIGURED block, UNAVAILABLE is runtime-only, several accounts are never auto-picked |
| 7 | NOT_CONFIGURED blocks | channel-execution-core.test.js › Connector status: NOT_CONFIGURED and MISCONFIGURED block, UNAVAILABLE is runtime-only, several accounts are never auto-picked |
| 8 | UNAVAILABLE runtime only | channel-execution-core.test.js › Connector status: NOT_CONFIGURED and MISCONFIGURED block, UNAVAILABLE is runtime-only, several accounts are never auto-picked |
| 9 | multiple accounts never auto-picked | channel-execution-core.test.js › Connector status: NOT_CONFIGURED and MISCONFIGURED block, UNAVAILABLE is runtime-only, several accounts are never auto-picked |
| 10 | config contains no secrets | channel-execution-core.test.js › Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized |
| 11 | credential resolver required | channel-execution-core.test.js › Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized |
| 12 | credentials never in config | channel-execution-core.test.js › Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized |
| 13 | never in logs | channel-execution-core.test.js › Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized |
| 14 | never in receipts | channel-execution-core.test.js › No token persistence: a full run stores no credential, writes no connector, and keeps no secret in jobs |
| 15 | connection view secret-free | channel-execution-core.test.js › Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized |
| 16 | scopes normalized | channel-execution-core.test.js › Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized |
| 17 | capability frozen | channel-execution-core.test.js › Capabilities: frozen and verified, unsupported content or mode is blocked, outputs are deeply frozen |
| 18 | unsupported capability blocked | channel-execution-core.test.js › Capabilities: frozen and verified, unsupported content or mode is blocked, outputs are deeply frozen |
| 19 | deep freeze | channel-execution-core.test.js › Capabilities: frozen and verified, unsupported content or mode is blocked, outputs are deeply frozen |
| 20 | no token persistence | channel-execution-core.test.js › No token persistence: a full run stores no credential, writes no connector, and keeps no secret in jobs |
| 21 | valid order | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 22 | scope derived | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 23 | merchant matched | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 24 | brand matched | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 25 | auth ref required | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 26 | explicit connector per delivery | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 27 | no implicit account | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 28 | PUBLISH_NOW | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 29 | SCHEDULE_INTERNAL | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 30 | INTERACTIVE_CONFIRMATION | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 31 | invalid mode refused | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 32 | schedule inside window | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 33 | before window refused | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 34 | after window refused | channel-execution-core.test.js › Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window |
| 35 | duplicate delivery refused | channel-execution-core.test.js › Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen |
| 36 | all manifest deliveries exactly once | channel-execution-core.test.js › Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen |
| 37 | unknown delivery refused | channel-execution-core.test.js › Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen |
| 38 | expiry bounded | channel-execution-core.test.js › Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen |
| 39 | deterministic id | channel-execution-core.test.js › Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen |
| 40 | deep freeze | channel-execution-core.test.js › Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen |
| 41 | READY | channel-execution-core.test.js › Preflight: READY, and stale authorization / order / manifest are BLOCKED |
| 42 | stale auth blocked | channel-execution-core.test.js › Preflight: READY, and stale authorization / order / manifest are BLOCKED |
| 43 | stale order blocked | channel-execution-core.test.js › Preflight: READY, and stale authorization / order / manifest are BLOCKED |
| 44 | stale manifest blocked | channel-execution-core.test.js › Preflight: READY, and stale authorization / order / manifest are BLOCKED |
| 45 | manifest not live READY_FOR_POLICY blocked | channel-execution-core.test.js › Preflight: a manifest that is not live READY_FOR_POLICY is BLOCKED, and the stored readiness is never trusted |
| 46 | connector not configured | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 47 | connector misconfigured | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 48 | temporary outage unavailable | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 49 | missing scope | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 50 | unsupported kind | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 51 | account ineligible | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 52 | missing media transport | channel-execution-core.test.js › Preflight: connector, outage, scope, kind, account and media checks |
| 53 | interactive confirmation review | channel-execution-core.test.js › Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY |
| 54 | TikTok private-only surfaced | channel-execution-core.test.js › Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY |
| 55 | no hidden provider selection | channel-execution-core.test.js › Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY |
| 56 | stable signals | channel-execution-core.test.js › Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY |
| 57 | deduped signals | channel-execution-core.test.js › Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY |
| 58 | no execution unless READY | channel-execution-core.test.js › Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY |
| 59 | enqueue once | channel-execution-repository.test.js › Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped |
| 60 | same intent idempotent | channel-execution-repository.test.js › Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped |
| 61 | fingerprint conflict | channel-execution-repository.test.js › Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped |
| 62 | DB unique race protected | channel-execution-repository.test.js › Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped |
| 63 | tenant scoped | channel-execution-repository.test.js › Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped |
| 64 | connector scoped | channel-execution-repository.test.js › Outbox: enqueue once, the same intent is idempotent, a changed fingerprint conflicts, a race is protected, jobs are tenant and connector scoped |
| 65 | PLANNED→READY | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 66 | READY→SUBMITTING | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 67 | SUBMITTING→PROCESSING | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 68 | SUBMITTING→PUBLISHED | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 69 | PROCESSING→PUBLISHED | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 70 | retryable failure | channel-execution-repository.test.js › Job failures and cancellation: retryable and final failures, cancel only before anything reached the provider |
| 71 | final failure | channel-execution-repository.test.js › Job failures and cancellation: retryable and final failures, cancel only before anything reached the provider |
| 72 | pre-submit cancel | channel-execution-repository.test.js › Job failures and cancellation: retryable and final failures, cancel only before anything reached the provider |
| 73 | published not retry | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 74 | published not cancel | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 75 | final failed not retry | channel-execution-repository.test.js › Job state machine: every legal transition works, terminal states are final, a published job is never retried or cancelled |
| 76 | atomic claim | channel-execution-repository.test.js › Atomic claim: only one worker wins a job, even concurrently, and attempts increment |
| 77 | two workers one claim | channel-execution-repository.test.js › Atomic claim: only one worker wins a job, even concurrently, and attempts increment |
| 78 | attempt increments | channel-execution-repository.test.js › Job failures and cancellation: retryable and final failures, cancel only before anything reached the provider |
| 79 | deterministic backoff | channel-execution-repository.test.js › Retry policy: deterministic backoff 1m 5m 15m 60m, Retry-After wins when later, never past the deadline, exhausted after five attempts |
| 80 | Retry-After | channel-execution-repository.test.js › Retry policy: deterministic backoff 1m 5m 15m 60m, Retry-After wins when later, never past the deadline, exhausted after five attempts |
| 81 | no retry after expiry | channel-execution-repository.test.js › Retry policy: deterministic backoff 1m 5m 15m 60m, Retry-After wins when later, never past the deadline, exhausted after five attempts |
| 82 | no retry permanent 4xx | channel-execution-repository.test.js › Provider errors: only transient failures are retried, never a permanent 4xx, an auth failure or a changed deadline |
| 83 | retry 429 | channel-execution-repository.test.js › Provider errors: only transient failures are retried, never a permanent 4xx, an auth failure or a changed deadline |
| 84 | retry 5xx | channel-execution-repository.test.js › Provider errors: only transient failures are retried, never a permanent 4xx, an auth failure or a changed deadline |
| 85 | timeout retryable | channel-execution-repository.test.js › Provider errors: only transient failures are retried, never a permanent 4xx, an auth failure or a changed deadline |
| 86 | auth failure no blind retry | channel-execution-repository.test.js › Provider errors: only transient failures are retried, never a permanent 4xx, an auth failure or a changed deadline |
| 87 | outputs frozen | channel-execution-repository.test.js › Outbox outputs are frozen and the persisted rows carry no secret |
| 88 | persistence secret-free | channel-execution-repository.test.js › Outbox outputs are frozen and the persisted rows carry no secret |
| 89 | professional account required | channel-instagram.test.js › Instagram account: a Professional account is required, a consumer account is refused, the designated account is never swapped |
| 90 | consumer refused | channel-instagram.test.js › Instagram account: a Professional account is required, a consumer account is refused, the designated account is never swapped |
| 91 | required scopes | channel-instagram.test.js › Instagram scopes and capabilities: canonical Instagram Login scopes, image gated to JPEG, reels for video, nothing else |
| 92 | deprecated scope not canonical | channel-instagram.test.js › Instagram scopes and capabilities: canonical Instagram Login scopes, image gated to JPEG, reels for video, nothing else |
| 93 | image capability gated | channel-instagram.test.js › Instagram scopes and capabilities: canonical Instagram Login scopes, image gated to JPEG, reels for video, nothing else |
| 94 | reel capability | channel-instagram.test.js › Instagram scopes and capabilities: canonical Instagram Login scopes, image gated to JPEG, reels for video, nothing else |
| 95 | unsupported kind blocked | channel-instagram.test.js › Instagram scopes and capabilities: canonical Instagram Login scopes, image gated to JPEG, reels for video, nothing else |
| 96 | create container | channel-instagram.test.js › Instagram publishing: container -> status -> media_publish, processing is not published, the media id is the post id |
| 97 | safe submission id | channel-instagram.test.js › Instagram publishing: container -> status -> media_publish, processing is not published, the media id is the post id |
| 98 | processing != published | channel-instagram.test.js › Instagram publishing: container -> status -> media_publish, processing is not published, the media id is the post id |
| 99 | media_publish required | channel-instagram.test.js › Instagram publishing: container -> status -> media_publish, processing is not published, the media id is the post id |
| 100 | media id as post id | channel-instagram.test.js › Instagram publishing: container -> status -> media_publish, processing is not published, the media id is the post id |
| 101 | transport URL ephemeral | channel-instagram.test.js › Instagram transport URLs are ephemeral and sealed: never persisted, logged or serialized; tokens never logged |
| 102 | transport URL not persisted | channel-instagram.test.js › Instagram transport URLs are ephemeral and sealed: never persisted, logged or serialized; tokens never logged |
| 103 | token never logged | channel-instagram.test.js › Instagram transport URLs are ephemeral and sealed: never persisted, logged or serialized; tokens never logged |
| 104 | rate limit normalized | channel-instagram.test.js › Instagram errors are normalized: rate limit, auth, permanent media errors; a published post is never published twice |
| 105 | auth normalized | channel-instagram.test.js › Instagram errors are normalized: rate limit, auth, permanent media errors; a published post is never published twice |
| 106 | media error permanent | channel-instagram.test.js › Instagram errors are normalized: rate limit, auth, permanent media errors; a published post is never published twice |
| 107 | no duplicate publish | channel-instagram.test.js › Instagram errors are normalized: rate limit, auth, permanent media errors; a published post is never published twice |
| 108 | no auto account selection | channel-instagram.test.js › Instagram account: a Professional account is required, a consumer account is refused, the designated account is never swapped |
| 109 | video.publish enforced | channel-tiktok.test.js › TikTok scope and creator info: video.publish is enforced, creator_info is queried first, the privacy level must be a CURRENT creator option, PUBLIC is never hardcoded |
| 110 | creator_info required | channel-tiktok.test.js › TikTok scope and creator info: video.publish is enforced, creator_info is queried first, the privacy level must be a CURRENT creator option, PUBLIC is never hardcoded |
| 111 | privacy option current | channel-tiktok.test.js › TikTok scope and creator info: video.publish is enforced, creator_info is queried first, the privacy level must be a CURRENT creator option, PUBLIC is never hardcoded |
| 112 | hardcoded public refused | channel-tiktok.test.js › TikTok scope and creator info: video.publish is enforced, creator_info is queried first, the privacy level must be a CURRENT creator option, PUBLIC is never hardcoded |
| 113 | photo supported by capability | channel-tiktok.test.js › TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked |
| 114 | video supported by capability | channel-tiktok.test.js › TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked |
| 115 | invalid media blocked | channel-tiktok.test.js › TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked |
| 116 | unaudited private-only surfaced | channel-tiktok.test.js › TikTok audit and consent: an unaudited client is private-only (surfaced), interactive confirmation is respected |
| 117 | interactive confirmation respected | channel-tiktok.test.js › TikTok audit and consent: an unaudited client is private-only (surfaced), interactive confirmation is respected |
| 118 | photo verified pull URL | channel-tiktok.test.js › TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked |
| 119 | unverified URL blocked | channel-tiktok.test.js › TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked |
| 120 | video transport tested | channel-tiktok.test.js › TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked |
| 121 | publish id captured | channel-tiktok.test.js › TikTok publishing: publish_id captured, init is not published, the final status is polled, the webhook is not a finalizer |
| 122 | init != published | channel-tiktok.test.js › TikTok publishing: publish_id captured, init is not published, the final status is polled, the webhook is not a finalizer |
| 123 | final status polling | channel-tiktok.test.js › TikTok publishing: publish_id captured, init is not published, the final status is polled, the webhook is not a finalizer |
| 124 | webhook boundary if implemented | channel-tiktok.test.js › TikTok publishing: publish_id captured, init is not published, the final status is polled, the webhook is not a finalizer |
| 125 | rate limit normalized | channel-tiktok.test.js › TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post |
| 126 | invalid token | channel-tiktok.test.js › TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post |
| 127 | missing scope | channel-tiktok.test.js › TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post |
| 128 | spam/daily limit safe | channel-tiktok.test.js › TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post |
| 129 | no retry permanent restriction | channel-tiktok.test.js › TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post |
| 130 | no duplicate post | channel-tiktok.test.js › TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post |
| 131 | AIGC flag not guessed | channel-tiktok.test.js › TikTok decisions are never guessed: is_aigc, the brand toggles and the privacy level come from the approved order |
| 132 | brand toggles not guessed | channel-tiktok.test.js › TikTok decisions are never guessed: is_aigc, the brand toggles and the privacy level come from the approved order |
| 133 | business.manage scope | channel-google-business.test.js › Google Business scope and location: business.manage is required, the target is the connector location, never the first one |
| 134 | explicit location | channel-google-business.test.js › Google Business scope and location: business.manage is required, the target is the connector location, never the first one |
| 135 | LocalPost create mapping | channel-google-business.test.js › Google Business posts: LocalPost create mapping, standard, event and offer, product posts unsupported |
| 136 | standard/update | channel-google-business.test.js › Google Business posts: LocalPost create mapping, standard, event and offer, product posts unsupported |
| 137 | event if implemented | channel-google-business.test.js › Google Business posts: LocalPost create mapping, standard, event and offer, product posts unsupported |
| 138 | offer if implemented | channel-google-business.test.js › Google Business posts: LocalPost create mapping, standard, event and offer, product posts unsupported |
| 139 | product post unsupported | channel-google-business.test.js › Google Business posts: LocalPost create mapping, standard, event and offer, product posts unsupported |
| 140 | CTA not invented | channel-google-business.test.js › Google Business content: the call to action is never invented, the media goes through the resolver, the post id is captured |
| 141 | media resolver | channel-google-business.test.js › Google Business content: the call to action is never invented, the media goes through the resolver, the post id is captured |
| 142 | local post id captured | channel-google-business.test.js › Google Business content: the call to action is never invented, the media goes through the resolver, the post id is captured |
| 143 | sync success published | channel-google-business.test.js › Google Business content: the call to action is never invented, the media goes through the resolver, the post id is captured |
| 144 | auth normalized | channel-google-business.test.js › Google Business errors: auth and scope normalized, transient quota retried, invalid payload final, a processing post is followed |
| 145 | temporary error retryable | channel-google-business.test.js › Google Business errors: auth and scope normalized, transient quota retried, invalid payload final, a processing post is followed |
| 146 | invalid payload final | channel-google-business.test.js › Google Business errors: auth and scope normalized, transient quota retried, invalid payload final, a processing post is followed |
| 147 | location mismatch | channel-google-business.test.js › Google Business scope and location: business.manage is required, the target is the connector location, never the first one |
| 148 | no first-location selection | channel-google-business.test.js › Google Business scope and location: business.manage is required, the target is the connector location, never the first one |
| 149 | safe metadata only | channel-google-business.test.js › Google Business safe metadata: only a public permalink without query, and no secret URL is ever persisted |
| 150 | no secret URL persistence | channel-google-business.test.js › Google Business safe metadata: only a public permalink without query, and no secret URL is ever persisted |
| 151 | published creates receipt | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 152 | deterministic receipt | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 153 | post id required | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 154 | merchant preserved | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 155 | brand preserved | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 156 | manifest preserved | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 157 | delivery preserved | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 158 | connector preserved | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 159 | published_at required | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 160 | no success claim | channel-execution-m4-integration.test.js › Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim |
| 161 | all published→M4 EXECUTED | channel-execution-m4-integration.test.js › M4 handoff: all published -> EXECUTED, a subset -> PARTIAL, nothing -> no receipt; the refs map the internal publication receipts |
| 162 | subset→M4 PARTIAL | channel-execution-m4-integration.test.js › M4 handoff: all published -> EXECUTED, a subset -> PARTIAL, nothing -> no receipt; the refs map the internal publication receipts |
| 163 | zero→no fake PARTIAL | channel-execution-m4-integration.test.js › M4 handoff: all published -> EXECUTED, a subset -> PARTIAL, nothing -> no receipt; the refs map the internal publication receipts |
| 164 | execution refs map receipts | channel-execution-m4-integration.test.js › M4 handoff: all published -> EXECUTED, a subset -> PARTIAL, nothing -> no receipt; the refs map the internal publication receipts |
| 165 | no M4 modification | channel-execution-m4-integration.test.js › The handoff is an EXISTING M4 receipt: M4 builds its Run from it unchanged, provider ids are evidence refs, nothing is causal |
| 166 | M4 tests green | (CI) the M4 / Marketing suites, run by the `Activation & Channel Execution V1` and `Marketing V1` workflows |
| 167 | provider ids become evidence refs | channel-execution-m4-integration.test.js › The handoff is an EXISTING M4 receipt: M4 builds its Run from it unchanged, provider ids are evidence refs, nothing is causal |
| 168 | no causal claim | channel-execution-m4-integration.test.js › The handoff is an EXISTING M4 receipt: M4 builds its Run from it unchanged, provider ids are evidence refs, nothing is causal |
| 169 | no access token persistence | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 170 | no refresh token persistence | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 171 | no secret config | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 172 | no auth header log | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 173 | no cookie log | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 174 | no signed URL persistence | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 175 | query token redaction | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 176 | raw error redaction | channel-execution-core.test.js › Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged |
| 177 | cross-merchant connector refused | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 178 | cross-merchant job refused | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 179 | cross-brand mismatch refused | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 180 | safe public permalink only | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 181 | local file path refused | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 182 | data/blob refused | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 183 | credential provider failure safe | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 184 | input not mutated | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 185 | no PII added | channel-execution-core.test.js › Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII |
| 186 | no marketing lever choice | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 187 | no caption creative change | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 188 | no media change | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 189 | no best-time choice | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 190 | no best-account choice | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 191 | no Guardian bypass | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 192 | no policy bypass | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 193 | no auto privacy choice | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 194 | no MarketingFinding creation | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 195 | no Push creation | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 196 | no Creative candidate creation | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 197 | no success score | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 198 | no incrementality claim | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 199 | no M4 learning write | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 200 | no Finance/Inventory mutation | channel-execution-core.test.js › Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy |
| 201 | merchant connector tests green | (CI) `test/merchant-connectors.test.js`, run by the `Activation & Channel Execution V1` workflow |
| 202 | M1 green | (CI) the M1 tests (`test/marketing*.test.js`) |
| 203 | M1.5 green | (CI) the M1.5 tests (`test/marketing*.test.js`) |
| 204 | M2 green | (CI) the M2 tests (`test/marketing*.test.js`) |
| 205 | M3 green | (CI) the M3 tests (`test/marketing*.test.js`) |
| 206 | M4 green | (CI) the M4 tests (`test/marketing*.test.js`) |
| 207 | Branding green | (CI) the Branding suite, run by the `Branding V1` workflow |
| 208 | Creative Fidelity green | (CI) the Creative Fidelity suite, run by its workflow |
| 209 | full suite green | (CI) the full suite (`npm test`), run by the `Activation & Channel Execution V1` workflow |
| 210 | migrations isolated to execution layer | channel-execution-core.test.js › Non-regression: the connector registry, the marketing modules and the migrations are untouched |
<!-- coverage-matrix:end -->
