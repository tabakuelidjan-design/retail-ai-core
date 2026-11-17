-- Sécurité V2: account recovery WITHOUT e-mail (no SMTP, ADR 0004 D7): an OWNER / ADMIN of the merchant issues a one-time recovery link for a member who lost
-- their password; the member opens it on a Nordla page and chooses a new password. Additive; rollback: supabase/rollback/20261118121000_account_recovery_down.sql.
--
-- Rules (decided here under the per-merchant lock, journalled in the same transaction):
--   issuer   ACTIVE OWNER or ADMIN of the merchant; never for itself (a member who knows the password uses Sécurité > change password)
--   target   a member of THIS merchant, ACTIVE, not removed; an ADMIN may only target COLLABORATOR / VIEWER / ACCOUNTANT (never an owner or an administrator)
--   link     only the SHA-256 hash is stored; one PENDING link per target (issuing a new one cancels the previous one); valid 60 minutes; usable once
--   use      consuming the link marks it USED and revokes EVERY active Nordla session of that account (all merchants, all modules) in the same transaction
-- The journal gets the link id and the role only: no token, no e-mail.

create table member_recovery_links (
  id uuid primary key,
  merchant_id uuid not null references merchants(id) on delete restrict,
  user_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('PENDING', 'USED', 'CANCELLED', 'EXPIRED')),
  created_by uuid not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint member_recovery_used_ck check ((status = 'USED') = (used_at is not null))
);
create unique index member_recovery_token_uq on member_recovery_links (token_hash);
create unique index member_recovery_pending_uq on member_recovery_links (merchant_id, user_id) where status = 'PENDING';
alter table member_recovery_links enable row level security;
revoke all on table member_recovery_links from anon, authenticated;
revoke insert, update, delete, truncate on table member_recovery_links from service_role;

create function recovery_issue(p_merchant uuid, p_actor uuid, p_target uuid, p_token_hash text, p_now timestamptz, p_expires timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_role text; target public.merchant_members; deny text; new_id uuid := gen_random_uuid();
begin
  if p_merchant is null or p_actor is null or p_target is null or p_token_hash is null or p_now is null or p_expires is null or p_correlation is null then
    raise exception 'recovery_issue: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN'); end if;
  perform public.identity_member_lock(p_merchant);
  actor_role := public.team_actor_role(p_merchant, p_actor);
  select * into target from public.merchant_members where merchant_id = p_merchant and user_id = p_target;
  if actor_role is null then deny := 'FORBIDDEN';
  elsif p_actor = p_target then deny := 'SELF_RECOVERY';
  elsif target.user_id is null then deny := 'TARGET_NOT_MEMBER';
  elsif target.removed_at is not null or target.status <> 'ACTIVE' then deny := 'TARGET_NOT_ACTIVE';
  elsif actor_role = 'ADMIN' and target.role not in ('COLLABORATOR', 'VIEWER', 'ACCOUNTANT') then deny := 'FORBIDDEN';
  end if;
  if deny is not null then
    perform public.team_journal(p_merchant, p_actor, p_module, 'RECOVERY_DENIED', 'DENIED', p_correlation, 'user', p_target::text, jsonb_build_object('code', deny), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  update public.member_recovery_links set status = 'CANCELLED' where merchant_id = p_merchant and user_id = p_target and status = 'PENDING';
  insert into public.member_recovery_links (id, merchant_id, user_id, token_hash, status, created_by, created_at, expires_at)
  values (new_id, p_merchant, p_target, p_token_hash, 'PENDING', p_actor, p_now, p_expires);
  perform public.team_journal(p_merchant, p_actor, p_module, 'RECOVERY_ISSUED', 'SUCCESS', p_correlation, 'recovery', new_id::text, jsonb_build_object('role', target.role), p_now);
  return jsonb_build_object('ok', true, 'code', 'RECOVERY_ISSUED', 'link_id', new_id);
end $$;

-- what the public page may show: the commerce and the state (never the account's e-mail)
create function recovery_lookup(p_token_hash text, p_now timestamptz)
returns table (link_id uuid, merchant_name text, status text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.id, m.name, case when l.status = 'PENDING' and l.expires_at <= p_now then 'EXPIRED' else l.status end, l.expires_at
    from public.member_recovery_links l join public.merchants m on m.id = l.merchant_id where l.token_hash = p_token_hash;
$$;

-- Consumes the link (single use, row lock) and revokes every active session of the account in the SAME transaction. The password itself is set by the server right after
-- (Supabase Auth); if that fails the link is already burnt and the member's sessions are closed: fail closed, the issuer simply issues a new link.
create function recovery_consume(p_token_hash text, p_now timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l public.member_recovery_links; m public.merchant_members; deny text; closed integer := 0;
begin
  if p_token_hash is null or p_now is null or p_correlation is null then
    raise exception 'recovery_consume: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  select * into l from public.member_recovery_links where token_hash = p_token_hash for update;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'RECOVERY_INVALID'); end if;
  perform public.identity_member_lock(l.merchant_id);
  select * into m from public.merchant_members where merchant_id = l.merchant_id and user_id = l.user_id;
  if l.status <> 'PENDING' then deny := 'RECOVERY_' || l.status;
  elsif l.expires_at <= p_now then update public.member_recovery_links set status = 'EXPIRED' where id = l.id; deny := 'RECOVERY_EXPIRED';
  elsif m.user_id is null or m.status <> 'ACTIVE' or m.removed_at is not null then deny := 'TARGET_NOT_ACTIVE';
  end if;
  if deny is not null then
    perform public.team_journal(l.merchant_id, l.user_id, p_module, 'RECOVERY_DENIED', 'DENIED', p_correlation, 'recovery', l.id::text, jsonb_build_object('code', deny, 'action', 'USE'), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  update public.member_recovery_links set status = 'USED', used_at = p_now where id = l.id;
  update public.app_sessions set revoked_at = p_now, revoked_reason = 'REVOKED' where user_id = l.user_id and revoked_at is null;
  get diagnostics closed = row_count;
  perform public.team_journal(l.merchant_id, l.user_id, p_module, 'RECOVERY_USED', 'SUCCESS', p_correlation, 'recovery', l.id::text, jsonb_build_object('count', closed), p_now);
  return jsonb_build_object('ok', true, 'code', 'RECOVERY_USED', 'user_id', l.user_id, 'sessions_closed', closed);
end $$;

revoke execute on function recovery_issue(uuid, uuid, uuid, text, timestamptz, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function recovery_lookup(text, timestamptz) from public, anon, authenticated;
revoke execute on function recovery_consume(text, timestamptz, uuid, text) from public, anon, authenticated;
