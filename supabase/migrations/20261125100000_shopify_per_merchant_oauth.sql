-- Shopify per-merchant OAuth (V1): allow the 'shopify' provider in the OAuth session table and keep the shop the merchant asked for
-- (a *.myshopify.com domain, not a secret) until the callback. Additive only: existing rows and providers are unchanged.
-- NOT APPLIED to any database yet: staging is applied only after the owner's approval.

alter table provider_oauth_sessions drop constraint if exists provider_oauth_sessions_provider_check;
alter table provider_oauth_sessions
  add constraint provider_oauth_sessions_provider_check
  check (provider in ('instagram', 'tiktok', 'google_business_profile', 'shopify'));

alter table provider_oauth_sessions add column if not exists target_hint text;
alter table provider_oauth_sessions
  add constraint provider_oauth_sessions_target_hint_ck
  check (target_hint is null or target_hint ~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$');
