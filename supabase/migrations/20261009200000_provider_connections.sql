-- Provider Provisioning & Live Connections V1: provider_oauth_sessions + connector_credentials + the narrow Vault access functions.
-- Additive only: two tables, triggers and SECURITY DEFINER functions. Touches no existing table.
--
-- NO SECRET LIVES IN A TABLE. Tokens, PKCE verifiers and pending token bundles are Supabase Vault secrets (vault.secrets, encrypted at rest);
-- the tables below hold only METADATA (a vault secret id, scopes, expiry, status...). The raw OAuth state is never stored: only its SHA-256.
-- The functions are the ONLY door to vault.decrypted_secrets: fixed search_path, merchant/connector validated, no arbitrary secret lookup,
-- executable by the service role only (a browser / anon / authenticated role can never reach them). Without the Vault extension the
-- functions fail at call time (PC_VAULT_UNAVAILABLE in the application): there is no plaintext fallback.

create table provider_oauth_sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete restrict,
  provider text not null check (provider in ('instagram', 'tiktok', 'google_business_profile')),
  -- SHA-256 (hex) of the random state: the raw state is never persisted; single use is enforced by the status transition
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  pkce_challenge text check (pkce_challenge is null or pkce_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
  redirect_uri text not null check (redirect_uri ~ '^https?://[^#\s]+$'),
  requested_scopes text[] not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'AUTHORIZED', 'BOUND', 'FAILED', 'EXPIRED')),
  return_to text check (return_to is null or (return_to ~ '^/[^/\\]' and return_to !~ '[\s\\]')),
  actor_ref text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  authorized_at timestamptz,
  completed_at timestamptz,
  bound_connector_id uuid references merchant_connectors(id) on delete restrict,
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z_]{3,40}$'),
  -- metadata-only references to Vault secrets (the verifier / the tokens waiting for the merchant's explicit target choice)
  pkce_vault_secret_id uuid,
  pending_vault_secret_id uuid,
  constraint provider_oauth_sessions_bound_ck check (status <> 'BOUND' or (bound_connector_id is not null and completed_at is not null))
);
create index provider_oauth_sessions_merchant_idx on provider_oauth_sessions (merchant_id, status, expires_at);

create function provider_oauth_sessions_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.merchant_id is distinct from old.merchant_id or new.provider is distinct from old.provider or new.state_hash is distinct from old.state_hash
       or new.redirect_uri is distinct from old.redirect_uri or new.requested_scopes is distinct from old.requested_scopes
       or new.pkce_challenge is distinct from old.pkce_challenge or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
      raise exception 'provider_oauth_sessions: the identity of a session is immutable' using errcode = 'integrity_constraint_violation';
    end if;
    if old.status in ('BOUND', 'FAILED', 'EXPIRED') then
      raise exception 'provider_oauth_sessions: a finished session cannot change' using errcode = 'integrity_constraint_violation';
    end if;
    -- the callback is SINGLE USE: PENDING -> AUTHORIZED happens once; a replay finds the session already consumed
    if old.status = 'PENDING' and new.status not in ('PENDING', 'AUTHORIZED', 'FAILED', 'EXPIRED') then
      raise exception 'provider_oauth_sessions: a pending session is authorized, failed or expired' using errcode = 'integrity_constraint_violation';
    end if;
    if old.status = 'AUTHORIZED' and new.status not in ('AUTHORIZED', 'BOUND', 'FAILED', 'EXPIRED') then
      raise exception 'provider_oauth_sessions: an authorized session is bound, failed or expired' using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  if new.bound_connector_id is not null and not exists (
    select 1 from public.merchant_connectors c where c.id = new.bound_connector_id and c.merchant_id = new.merchant_id and c.kind = new.provider
  ) then
    raise exception 'provider_oauth_sessions: the bound connector does not belong to this merchant and provider' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger provider_oauth_sessions_guard_trg before insert or update on provider_oauth_sessions for each row execute function provider_oauth_sessions_guard();

create table connector_credentials (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete restrict,
  connector_id uuid not null references merchant_connectors(id) on delete restrict,
  provider text not null check (provider in ('instagram', 'tiktok', 'google_business_profile')),
  -- the Vault secret holding the token bundle. Null only once the credential is REVOKED (the secret is destroyed).
  vault_secret_id uuid,
  credential_kind text not null default 'OAUTH_TOKENS' check (credential_kind in ('OAUTH_TOKENS')),
  scopes text[] not null default '{}',
  expires_at timestamptz,
  refreshable boolean not null default false,
  issued_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'EXPIRED', 'REVOKED')),
  -- compare-and-set counter for rotation, and an anti-double-refresh lease
  rotation_version integer not null default 1 check (rotation_version >= 1),
  refresh_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  constraint connector_credentials_secret_ck check (status = 'REVOKED' or vault_secret_id is not null),
  constraint connector_credentials_revoked_ck check (status <> 'REVOKED' or (revoked_at is not null and vault_secret_id is null))
);
-- one live credential per connector; a REVOKED one stays as technical history and a reconnect creates a new row
create unique index connector_credentials_live_uq on connector_credentials (connector_id, credential_kind) where status <> 'REVOKED';
create index connector_credentials_merchant_idx on connector_credentials (merchant_id, provider);

create function connector_credentials_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.merchant_connectors c where c.id = new.connector_id and c.merchant_id = new.merchant_id and c.kind = new.provider) then
      raise exception 'connector_credentials: the connector does not belong to this merchant and provider' using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;
  if new.merchant_id is distinct from old.merchant_id or new.connector_id is distinct from old.connector_id or new.provider is distinct from old.provider
     or new.credential_kind is distinct from old.credential_kind or new.created_at is distinct from old.created_at then
    raise exception 'connector_credentials: the identity of a credential is immutable' using errcode = 'integrity_constraint_violation';
  end if;
  if old.status = 'REVOKED' then
    raise exception 'connector_credentials: a revoked credential cannot change' using errcode = 'integrity_constraint_violation';
  end if;
  new.updated_at = now();
  return new;
end $$;
create trigger connector_credentials_guard_trg before insert or update on connector_credentials for each row execute function connector_credentials_guard();

comment on table provider_oauth_sessions is 'OAuth sessions of Provider Provisioning. state_hash only: no raw state, no PKCE verifier, no authorization code, no token (those are Vault secrets, referenced by id).';
comment on table connector_credentials is 'Metadata of the provider credentials held in Supabase Vault (vault_secret_id, scopes, expiry). No token, no secret.';

alter table provider_oauth_sessions enable row level security;  -- no policy: service role only
alter table connector_credentials enable row level security;    -- no policy: service role only

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Narrow Vault access. Every function: SECURITY DEFINER, fixed search_path, validates merchant (+ connector / provider), returns jsonb.

create function provider_vault_store(
  p_merchant uuid, p_connector uuid, p_provider text, p_secret text, p_scopes text[], p_expires_at timestamptz, p_refreshable boolean, p_issued_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_secret uuid; v_row public.connector_credentials;
begin
  if p_secret is null or btrim(p_secret) = '' then raise exception 'provider_vault_store: empty secret' using errcode = 'invalid_parameter_value'; end if;
  if not exists (select 1 from public.merchant_connectors c where c.id = p_connector and c.merchant_id = p_merchant and c.kind = p_provider) then
    raise exception 'provider_vault_store: the connector does not belong to this merchant and provider' using errcode = 'integrity_constraint_violation';
  end if;
  v_secret := vault.create_secret(p_secret, 'nordla/connector/' || p_connector::text || '/' || gen_random_uuid()::text, 'provider credential');
  insert into public.connector_credentials (merchant_id, connector_id, provider, vault_secret_id, scopes, expires_at, refreshable, issued_at)
  values (p_merchant, p_connector, p_provider, v_secret, coalesce(p_scopes, '{}'), p_expires_at, coalesce(p_refreshable, false), p_issued_at)
  returning * into v_row;
  return to_jsonb(v_row);
end $$;

create function provider_vault_read(p_merchant uuid, p_connector uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.connector_credentials; v_secret text;
begin
  select * into v_row from public.connector_credentials
   where merchant_id = p_merchant and connector_id = p_connector order by (status = 'REVOKED'), created_at desc limit 1;
  if not found then return null; end if;
  if v_row.status = 'REVOKED' or v_row.vault_secret_id is null then return jsonb_build_object('metadata', to_jsonb(v_row), 'secret', null); end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_row.vault_secret_id;
  return jsonb_build_object('metadata', to_jsonb(v_row), 'secret', v_secret);
end $$;

create function provider_vault_metadata(p_merchant uuid, p_connector uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.connector_credentials;
begin
  select * into v_row from public.connector_credentials
   where merchant_id = p_merchant and connector_id = p_connector order by (status = 'REVOKED'), created_at desc limit 1;
  if not found then return null; end if;
  return to_jsonb(v_row);
end $$;

-- Rotation is a compare-and-set on rotation_version: a stale writer gets null and the secret is untouched.
create function provider_vault_rotate(
  p_merchant uuid, p_connector uuid, p_expected_version integer, p_secret text, p_scopes text[], p_expires_at timestamptz, p_refreshable boolean, p_issued_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.connector_credentials;
begin
  if p_secret is null or btrim(p_secret) = '' then raise exception 'provider_vault_rotate: empty secret' using errcode = 'invalid_parameter_value'; end if;
  update public.connector_credentials
     set scopes = coalesce(p_scopes, scopes), expires_at = p_expires_at, refreshable = coalesce(p_refreshable, refreshable), issued_at = coalesce(p_issued_at, issued_at),
         status = 'ACTIVE', rotation_version = rotation_version + 1, refresh_lease_until = null, rotated_at = now()
   where merchant_id = p_merchant and connector_id = p_connector and status <> 'REVOKED' and rotation_version = p_expected_version
   returning * into v_row;
  if not found then return null; end if;
  perform vault.update_secret(v_row.vault_secret_id, p_secret);
  return to_jsonb(v_row);
end $$;

create function provider_vault_refresh_lease(p_merchant uuid, p_connector uuid, p_now timestamptz, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.connector_credentials;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 600 then raise exception 'provider_vault_refresh_lease: invalid lease' using errcode = 'invalid_parameter_value'; end if;
  update public.connector_credentials set refresh_lease_until = p_now + make_interval(secs => p_lease_seconds)
   where merchant_id = p_merchant and connector_id = p_connector and status <> 'REVOKED' and (refresh_lease_until is null or refresh_lease_until <= p_now)
   returning * into v_row;
  if not found then return null; end if;
  return to_jsonb(v_row);
end $$;

create function provider_vault_release_lease(p_merchant uuid, p_connector uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_credentials set refresh_lease_until = null where merchant_id = p_merchant and connector_id = p_connector and status <> 'REVOKED';
end $$;

create function provider_vault_mark_expired(p_merchant uuid, p_connector uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.connector_credentials;
begin
  update public.connector_credentials set status = 'EXPIRED' where merchant_id = p_merchant and connector_id = p_connector and status = 'ACTIVE' returning * into v_row;
  if not found then return public.provider_vault_metadata(p_merchant, p_connector); end if;
  return to_jsonb(v_row);
end $$;

-- Revoke = the secret is destroyed in the Vault; the metadata row stays as technical history (publication history is untouched).
create function provider_vault_revoke(p_merchant uuid, p_connector uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.connector_credentials; v_secret uuid;
begin
  select vault_secret_id into v_secret from public.connector_credentials where merchant_id = p_merchant and connector_id = p_connector and status <> 'REVOKED';
  update public.connector_credentials set status = 'REVOKED', revoked_at = now(), vault_secret_id = null, refresh_lease_until = null
   where merchant_id = p_merchant and connector_id = p_connector and status <> 'REVOKED' returning * into v_row;
  if not found then return public.provider_vault_metadata(p_merchant, p_connector); end if;
  if v_secret is not null then delete from vault.secrets where id = v_secret; end if;
  return to_jsonb(v_row);
end $$;

-- Session secrets (PKCE verifier, tokens waiting for the explicit target choice): put / peek / take (read + destroy) / delete.
create function provider_vault_session_put(p_merchant uuid, p_session uuid, p_kind text, p_secret text) returns void language plpgsql security definer set search_path = '' as $$
declare v_session public.provider_oauth_sessions; v_id uuid;
begin
  if p_kind not in ('PKCE_VERIFIER', 'PENDING_TOKENS') or p_secret is null or btrim(p_secret) = '' then raise exception 'provider_vault_session_put: invalid request' using errcode = 'invalid_parameter_value'; end if;
  select * into v_session from public.provider_oauth_sessions where id = p_session and merchant_id = p_merchant;
  if not found then raise exception 'provider_vault_session_put: unknown session for this merchant' using errcode = 'integrity_constraint_violation'; end if;
  v_id := case when p_kind = 'PKCE_VERIFIER' then v_session.pkce_vault_secret_id else v_session.pending_vault_secret_id end;
  if v_id is null then
    v_id := vault.create_secret(p_secret, 'nordla/oauth-session/' || p_session::text || '/' || p_kind, 'oauth session secret');
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
  if p_kind = 'PKCE_VERIFIER' then update public.provider_oauth_sessions set pkce_vault_secret_id = v_id where id = p_session;
  else update public.provider_oauth_sessions set pending_vault_secret_id = v_id where id = p_session; end if;
end $$;

create function provider_vault_session_peek(p_merchant uuid, p_session uuid, p_kind text, p_now timestamptz) returns text language plpgsql security definer set search_path = '' as $$
declare v_session public.provider_oauth_sessions; v_id uuid; v_secret text;
begin
  select * into v_session from public.provider_oauth_sessions where id = p_session and merchant_id = p_merchant;
  if not found then return null; end if;
  if p_kind = 'PKCE_VERIFIER' then v_id := v_session.pkce_vault_secret_id; if p_now > v_session.expires_at then return null; end if;
  elsif p_kind = 'PENDING_TOKENS' then v_id := v_session.pending_vault_secret_id; if v_session.authorized_at is null or p_now > v_session.authorized_at + interval '30 minutes' then return null; end if;
  else return null; end if;
  if v_id is null then return null; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_id;
  return v_secret;
end $$;

create function provider_vault_session_take(p_merchant uuid, p_session uuid, p_kind text, p_now timestamptz) returns text language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_id uuid;
begin
  v_secret := public.provider_vault_session_peek(p_merchant, p_session, p_kind, p_now);
  select case when p_kind = 'PKCE_VERIFIER' then pkce_vault_secret_id else pending_vault_secret_id end into v_id
    from public.provider_oauth_sessions where id = p_session and merchant_id = p_merchant;
  if v_id is not null then
    delete from vault.secrets where id = v_id;
    if p_kind = 'PKCE_VERIFIER' then update public.provider_oauth_sessions set pkce_vault_secret_id = null where id = p_session;
    else update public.provider_oauth_sessions set pending_vault_secret_id = null where id = p_session; end if;
  end if;
  return v_secret;
end $$;

create function provider_vault_session_delete(p_merchant uuid, p_session uuid, p_kind text) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.provider_vault_session_take(p_merchant, p_session, p_kind, now());
end $$;

-- Cleanup: expired, never-bound sessions and their Vault secrets. Returns the number of sessions removed.
create function provider_oauth_cleanup(p_now timestamptz) returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  delete from vault.secrets where id in (
    select unnest(array[pkce_vault_secret_id, pending_vault_secret_id]) from public.provider_oauth_sessions
     where status in ('PENDING', 'AUTHORIZED', 'FAILED', 'EXPIRED') and expires_at < p_now - interval '1 hour'
  );
  delete from public.provider_oauth_sessions where status in ('PENDING', 'AUTHORIZED', 'FAILED', 'EXPIRED') and expires_at < p_now - interval '1 hour';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Executable by the service role ONLY (Supabase grants new functions to anon / authenticated by default: revoke it when those roles exist).
do $$
declare f record; r text;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'provider\_vault\_%' or p.proname = 'provider_oauth_cleanup') loop
    execute format('revoke all on function %s from public', f.sig);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f.sig, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
