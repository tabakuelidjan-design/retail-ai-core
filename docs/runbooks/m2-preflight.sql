-- M2 pre-application check - READ ONLY (selects only). Run on the target database right before M2; every row returned is a blocker
-- (M2 itself raises on the same conditions). An empty result + the proofs of the runbook = ready.
with kinds(k) as (values ('shopify'), ('woocommerce'), ('prestashop'), ('odoo'))
select 'M1_MISSING' as blocker, null::text as detail where to_regclass('public.merchant_connectors') is null
union all
select 'UNEXPECTED_COLUMN_STATE', count(*)::text || ' of 3 as expected' from information_schema.columns
 where table_schema = 'public' and table_name = 'merchants' and data_type = 'text'
   and ((column_name in ('source_system', 'source_id') and is_nullable = 'NO') or (column_name = 'source_domain' and is_nullable = 'YES'))
having count(*) <> 3
union all
select 'UNEXPECTED_UNIQUE_CONSTRAINT', null where not exists (
  select 1 from pg_constraint where conrelid = 'public.merchants'::regclass and conname = 'merchants_source_unique'
     and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (source_system, source_id)')
union all
select 'CONNECTOR_OF_ANOTHER_MERCHANT', m.id::text
  from public.merchants m join public.merchant_connectors c on c.kind = m.source_system and c.external_id = m.source_id
 where c.merchant_id <> m.id
union all
select 'NO_MATCHING_CONNECTOR', m.id::text from public.merchants m
 where m.source_system in (select k from kinds)
   and not exists (select 1 from public.merchant_connectors c where c.merchant_id = m.id and c.kind = m.source_system and c.external_id = m.source_id);
