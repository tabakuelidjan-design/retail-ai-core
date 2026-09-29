-- M2 (ADR 0003, section 7): merchants.id is the only Nordla identity; external systems are linked only through merchant_connectors (M1).
-- This migration makes the legacy external identity of merchants OPTIONAL and marks it deprecated, so a Nordla merchant can exist
-- without any Shopify identity. It removes nothing:
--   * merchants.source_system, source_id, source_domain are KEPT (no column dropped), with every existing value unchanged;
--   * source_system and source_id lose their NOT NULL; source_domain (already nullable) is left as it is;
--   * merchants_source_unique UNIQUE (source_system, source_id) and its index are KEPT: two identical non-null external identities are
--     still refused, while any number of merchants may have both values NULL (NULLs are distinct in a PostgreSQL unique constraint);
--   * the three columns get a DEPRECATED comment.
-- No row is inserted, updated or deleted in any table; no merchant UUID changes; merchant_connectors and every business table are
-- untouched. Dropping the columns is NOT part of M2: it would be a separate, later migration after a much longer stable period and a new
-- explicit decision. Rollback (docs/runbooks/m2-rollback.sql): restore the two NOT NULL, refused if any merchant has a NULL value.
--
-- One transaction; every check runs before the first ALTER and any anomaly raises (P0001), nothing changed.

set local lock_timeout = '5s';
lock table public.merchants in access exclusive mode;
lock table public.merchant_connectors in share mode;

do $m2$
declare
  kinds constant text[] := array['shopify', 'woocommerce', 'prestashop', 'odoo']; -- KINDS_REQUIRING_EXTERNAL_ID (src/tenant/connectors.js)
  n integer;
  ids text;
begin
  -- 0. expected starting schema: M1 present; the three columns as created by 20260920132500_phase1_merchant_identity.sql;
  --    merchants_source_unique exactly UNIQUE (source_system, source_id) with NULLs distinct
  if to_regclass('public.merchant_connectors') is null then
    raise exception 'M2 refused: merchant_connectors (M1) is missing' using errcode = 'P0001';
  end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'merchants' and data_type = 'text'
     and ((column_name in ('source_system', 'source_id') and is_nullable = 'NO') or (column_name = 'source_domain' and is_nullable = 'YES'));
  if n <> 3 then
    raise exception 'M2 refused: merchants legacy identity columns are not in the expected state (% of 3 as expected)', n using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.merchants'::regclass and conname = 'merchants_source_unique'
                  and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (source_system, source_id)') then
    raise exception 'M2 refused: merchants_source_unique is missing or is not UNIQUE (source_system, source_id) with NULLs distinct' using errcode = 'P0001';
  end if;

  -- 1. consistency with merchant_connectors: a merchant's external object is never linked to a connector of ANOTHER merchant
  select count(*), string_agg(distinct m.id::text, ', ') into n, ids
    from public.merchants m join public.merchant_connectors c on c.kind = m.source_system and c.external_id = m.source_id
   where c.merchant_id <> m.id;
  if n > 0 then
    raise exception 'M2 refused: external identity of merchant(s) % is linked to a connector of another merchant', ids using errcode = 'P0001';
  end if;

  -- 2. consistency with merchant_connectors: every external identity (a kind with a natural id) has its connector on the SAME merchant
  select count(*), string_agg(m.id::text, ', ' order by m.id) into n, ids
    from public.merchants m
   where m.source_system = any (kinds)
     and not exists (select 1 from public.merchant_connectors c
                      where c.merchant_id = m.id and c.kind = m.source_system and c.external_id = m.source_id);
  if n > 0 then
    raise exception 'M2 refused: % merchant(s) with an external identity and no matching connector: %', n, ids using errcode = 'P0001';
  end if;
end
$m2$;

alter table public.merchants alter column source_system drop not null, alter column source_id drop not null;

comment on column public.merchants.source_system is
  'DEPRECATED (M2, ADR 0003): legacy external identity, kept for compatibility only - never read to identify a merchant. The identity is merchants.id; external systems are linked through merchant_connectors. Optional: NULL for a merchant without external identity.';
comment on column public.merchants.source_id is
  'DEPRECATED (M2, ADR 0003): legacy external identity (e.g. the Shopify Shop GID), kept for compatibility only - never read to identify a merchant; see merchant_connectors.external_id. Optional: NULL for a merchant without external identity.';
comment on column public.merchants.source_domain is
  'DEPRECATED (M2, ADR 0003): informational legacy domain, kept for compatibility only - see merchant_connectors.external_domain.';

do $m2check$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'merchants'
        and column_name in ('source_system', 'source_id', 'source_domain') and is_nullable = 'YES') <> 3
     or not exists (select 1 from pg_constraint where conrelid = 'public.merchants'::regclass and conname = 'merchants_source_unique'
                     and pg_get_constraintdef(oid) = 'UNIQUE (source_system, source_id)') then
    raise exception 'M2 postcondition failed: the three columns must exist, all nullable, and merchants_source_unique must remain' using errcode = 'P0001';
  end if;
end
$m2check$;
