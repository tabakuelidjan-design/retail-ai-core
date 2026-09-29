-- M2 (ADR 0003, owner decision 2026-09-29): merchants.id is the only Nordla identity; an external system is linked to a merchant
-- only through merchant_connectors (M1). This migration removes the legacy external identity columns of merchants
-- (source_system, source_id, source_domain - added by 20260920132500_phase1_merchant_identity.sql) and their unique constraint
-- merchants_source_unique. Nothing else: no merchant UUID changes, no merchant or connector row is inserted, updated or deleted,
-- no business table is touched (their own source_system / source_id columns identify synced ROWS, not the merchant, and stay).
--
-- It runs as one transaction and REFUSES (raises, nothing changed) before any drop unless every legacy value can be rebuilt exactly
-- afterwards (see docs/runbooks/m2-merchants-legacy-identity.md for the rollback):
--   * external identity (source_system is a connector kind with a natural id): exactly one connector of THAT merchant with the same
--     kind and external_id, and external_domain equal to source_domain;
--   * no external identity: only the canonical Nordla placeholder ('nordla', 'nordla:' || id, no domain) is accepted;
--   * the same external object may not be claimed by a connector of another merchant; no duplicate, no ambiguity;
--   * nothing but merchants_source_unique (and its index) may depend on the three columns; no function body may use them.
-- It never picks a connector or a merchant: any doubt is a refusal. Deploy only after every service runs code that no longer reads
-- merchants.source_* (C6-F everywhere) - the migration cannot see application code; the pre-application checklist can.

set local lock_timeout = '5s';
lock table public.merchants in access exclusive mode;
lock table public.merchant_connectors in share mode;

do $m2$
declare
  kinds constant text[] := array['shopify', 'woocommerce', 'prestashop', 'odoo']; -- KINDS_REQUIRING_EXTERNAL_ID (src/tenant/connectors.js)
  n integer;
  ids text;
begin
  -- 0. expected starting state (M1 present, the three columns present exactly as created)
  if to_regclass('public.merchant_connectors') is null then
    raise exception 'M2 refused: merchant_connectors (M1) is missing' using errcode = 'P0001';
  end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'merchants' and column_name in ('source_system', 'source_id', 'source_domain');
  if n <> 3 then
    raise exception 'M2 refused: merchants legacy identity columns are not in the expected state (% of 3 present)', n using errcode = 'P0001';
  end if;

  -- 1. the merchant's external object is claimed by a connector of ANOTHER merchant (checked first: the most specific diagnosis)
  select count(*), string_agg(distinct m.id::text, ', ') into n, ids
    from public.merchants m join public.merchant_connectors c on c.kind = m.source_system and c.external_id = m.source_id
   where c.merchant_id <> m.id;
  if n > 0 then
    raise exception 'M2 refused: external identity of merchant(s) % is linked to a connector of another merchant', ids using errcode = 'P0001';
  end if;

  -- 2. an external identity with no matching connector of the SAME merchant (kind + external_id)
  select count(*), string_agg(m.id::text, ', ' order by m.id) into n, ids
    from public.merchants m
   where m.source_system = any (kinds)
     and not exists (select 1 from public.merchant_connectors c
                      where c.merchant_id = m.id and c.kind = m.source_system and c.external_id = m.source_id);
  if n > 0 then
    raise exception 'M2 refused: % merchant(s) with an external identity and no matching connector: %', n, ids using errcode = 'P0001';
  end if;

  -- 3. ambiguity: more than one connector of the identity kind for a merchant (the legacy value could not be rebuilt without choosing),
  --    or two merchants with the same external identity (normally impossible: merchants_source_unique)
  select count(*), string_agg(x.merchant_id::text, ', ' order by x.merchant_id) into n, ids from (
    select m.id as merchant_id from public.merchants m join public.merchant_connectors c on c.merchant_id = m.id and c.kind = m.source_system
     where m.source_system = any (kinds) group by m.id having count(*) > 1) x;
  if n > 0 then
    raise exception 'M2 refused: ambiguous identity - merchant(s) % have several connectors of their identity kind', ids using errcode = 'P0001';
  end if;
  select count(*) into n from (select 1 from public.merchants group by source_system, source_id having count(*) > 1) d;
  if n > 0 then
    raise exception 'M2 refused: % duplicated legacy identity value(s) in merchants', n using errcode = 'P0001';
  end if;

  -- 4. the domain could not be rebuilt from the connector
  select count(*), string_agg(m.id::text, ', ' order by m.id) into n, ids
    from public.merchants m join public.merchant_connectors c on c.merchant_id = m.id and c.kind = m.source_system and c.external_id = m.source_id
   where m.source_system = any (kinds) and c.external_domain is distinct from m.source_domain;
  if n > 0 then
    raise exception 'M2 refused: source_domain of merchant(s) % differs from its connector external_domain', ids using errcode = 'P0001';
  end if;

  -- 5. no external identity: only the canonical placeholder is rebuildable exactly
  select count(*), string_agg(m.id::text, ', ' order by m.id) into n, ids
    from public.merchants m
   where not (m.source_system = any (kinds))
     and not (m.source_system = 'nordla' and m.source_id = 'nordla:' || m.id::text and m.source_domain is null);
  if n > 0 then
    raise exception 'M2 refused: merchant(s) % carry a legacy value that cannot be rebuilt (neither a connector identity nor the nordla placeholder)', ids using errcode = 'P0001';
  end if;

  -- 6. nothing but merchants_source_unique (and the index it owns) - and, on PostgreSQL 18+, the columns' own NOT NULL constraints -
  --    depends on the three columns
  select count(*), string_agg(distinct d.classid::regclass::text || ' ' || d.objid::text, ', ') into n, ids
    from pg_depend d
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
   where d.refclassid = 'pg_class'::regclass and d.refobjid = 'public.merchants'::regclass
     and a.attname in ('source_system', 'source_id', 'source_domain')
     and not (d.classid = 'pg_constraint'::regclass
              and d.objid in (select oid from pg_constraint where conrelid = 'public.merchants'::regclass
                               and (conname = 'merchants_source_unique' or (contype = 'n' and cardinality(conkey) = 1 and conkey[1] = a.attnum))))
     and not (d.classid = 'pg_class'::regclass
              and d.objid = (select conindid from pg_constraint where conrelid = 'public.merchants'::regclass and conname = 'merchants_source_unique'));
  if n > 0 then
    raise exception 'M2 refused: other object(s) depend on the legacy columns: %', ids using errcode = 'P0001';
  end if;
  select count(*), string_agg(p.oid::regprocedure::text, ', ') into n, ids
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
     and p.prosrc ~* '\mmerchants\M' and p.prosrc ~* '\msource_(system|id|domain)\M';
  if n > 0 then
    raise exception 'M2 refused: function(s) % may use the legacy columns', ids using errcode = 'P0001';
  end if;
end
$m2$;

-- The drop itself: RESTRICT (no CASCADE), so an unexpected dependent object still aborts the whole transaction.
alter table public.merchants drop constraint merchants_source_unique;
alter table public.merchants drop column source_domain, drop column source_id, drop column source_system;

do $m2check$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'merchants' and column_name like 'source\_%')
     or exists (select 1 from pg_constraint where conrelid = 'public.merchants'::regclass and conname = 'merchants_source_unique') then
    raise exception 'M2 postcondition failed: legacy identity still present' using errcode = 'P0001';
  end if;
end
$m2check$;

comment on table public.merchants is
  'Nordla tenant: merchants.id is the only identity. External systems (Shopify, ...) are linked only through merchant_connectors (M1, M2).';
