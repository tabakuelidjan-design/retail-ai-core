-- Sécurité V3: "Exiger la double authentification des Propriétaires et Administrateurs" (per merchant, OFF by default). Additive; rollback: supabase/rollback/20261118130000_security_require_mfa_down.sql.
-- The RULE is stored here; it is ENFORCED by the HTTP gate on every request (so a session already open, a role change or a removed factor take effect at once): a member whose
-- role is OWNER or ADMIN and who has no VERIFIED second factor gets 403 MFA_REQUIRED_FOR_ROLE everywhere except Sécurité (to enrol) and the sign-in routes.
-- Only an ACTIVE OWNER who is compliant itself can change it (no lock-out by the person who turns it on). Every change is journalled in the same transaction.

create table merchant_security_settings (
  merchant_id uuid primary key references merchants(id) on delete restrict,
  require_mfa_privileged boolean not null default false,
  updated_at timestamptz not null,
  updated_by uuid
);
alter table merchant_security_settings enable row level security;
revoke all on table merchant_security_settings from anon, authenticated;
revoke insert, update, delete, truncate on table merchant_security_settings from service_role;

-- compliance of ONE member under the rule (read by the gate, cached a few seconds): { required, privileged, compliant }
create function security_mfa_status(p_merchant uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'required', coalesce((select s.require_mfa_privileged from public.merchant_security_settings s where s.merchant_id = p_merchant), false),
    'privileged', coalesce((select m.role in ('OWNER', 'ADMIN') from public.merchant_members m where m.merchant_id = p_merchant and m.user_id = p_user and m.status = 'ACTIVE'), false),
    'compliant', exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
  );
$$;

-- privileged ACTIVE members without a verified factor (for the screen: who would be blocked)
create function security_mfa_noncompliant(p_merchant uuid)
returns table (user_id uuid, role text, label text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.role, split_part(u.email::text, '@', 1)
    from public.merchant_members m join auth.users u on u.id = m.user_id
   where m.merchant_id = p_merchant and m.status = 'ACTIVE' and m.role in ('OWNER', 'ADMIN')
     and not exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified')
   order by m.role, u.email;
$$;

create function security_set_require_mfa(p_merchant uuid, p_actor uuid, p_enabled boolean, p_now timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.merchant_members; deny text; was boolean;
begin
  if p_merchant is null or p_actor is null or p_enabled is null or p_now is null or p_correlation is null then
    raise exception 'security_set_require_mfa: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN'); end if;
  perform public.identity_member_lock(p_merchant);
  select * into actor from public.merchant_members where merchant_id = p_merchant and user_id = p_actor;
  if actor.user_id is null or actor.status <> 'ACTIVE' or actor.role <> 'OWNER' then deny := 'FORBIDDEN';
  elsif p_enabled and not exists (select 1 from auth.mfa_factors f where f.user_id = p_actor and f.status = 'verified') then deny := 'ACTOR_NO_MFA';
  end if;
  if deny is not null then
    perform public.team_journal(p_merchant, p_actor, p_module, 'MFA_RULE_DENIED', 'DENIED', p_correlation, 'merchant', p_merchant::text, jsonb_build_object('code', deny), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  select require_mfa_privileged into was from public.merchant_security_settings where merchant_id = p_merchant;
  insert into public.merchant_security_settings (merchant_id, require_mfa_privileged, updated_at, updated_by) values (p_merchant, p_enabled, p_now, p_actor)
  on conflict (merchant_id) do update set require_mfa_privileged = excluded.require_mfa_privileged, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform public.team_journal(p_merchant, p_actor, p_module, 'MFA_RULE_CHANGED', 'SUCCESS', p_correlation, 'merchant', p_merchant::text, jsonb_build_object('enabled', p_enabled, 'was', coalesce(was, false)), p_now);
  return jsonb_build_object('ok', true, 'code', 'MFA_RULE_CHANGED', 'enabled', p_enabled);
end $$;

revoke execute on function security_mfa_status(uuid, uuid) from public, anon, authenticated;
revoke execute on function security_mfa_noncompliant(uuid) from public, anon, authenticated;
revoke execute on function security_set_require_mfa(uuid, uuid, boolean, timestamptz, uuid, text) from public, anon, authenticated;
