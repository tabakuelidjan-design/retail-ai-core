-- Defence in depth: RLS (no policy) already denies anon / authenticated; remove their table privileges too. Service role only.
-- Applied on nordla-finance-staging (fvhiammdskpcnfodsnrc) on 2026-11-17 right after 20261009200000_provider_connections.sql.
revoke all on table public.provider_oauth_sessions from anon, authenticated;
revoke all on table public.connector_credentials from anon, authenticated;
