-- M2 pre-application check - READ ONLY (selects only). Run on the target database right before M2; every row returned is a blocker
-- (M2 itself raises on the same conditions). An empty result + the proof export (m2-merchants-legacy-identity.md, "Proofs") = ready.
with kinds(k) as (values ('shopify'), ('woocommerce'), ('prestashop'), ('odoo'))
select 'CONNECTOR_OF_ANOTHER_MERCHANT' as blocker, m.id::text as merchant_id
  from public.merchants m join public.merchant_connectors c on c.kind = m.source_system and c.external_id = m.source_id
 where c.merchant_id <> m.id
union all
select 'NO_MATCHING_CONNECTOR', m.id::text from public.merchants m
 where m.source_system in (select k from kinds)
   and not exists (select 1 from public.merchant_connectors c where c.merchant_id = m.id and c.kind = m.source_system and c.external_id = m.source_id)
union all
select 'SEVERAL_CONNECTORS_OF_IDENTITY_KIND', m.id::text from public.merchants m
  join public.merchant_connectors c on c.merchant_id = m.id and c.kind = m.source_system
 where m.source_system in (select k from kinds) group by m.id having count(*) > 1
union all
select 'DUPLICATED_LEGACY_IDENTITY', min(id::text) from public.merchants group by source_system, source_id having count(*) > 1
union all
select 'DOMAIN_NOT_REBUILDABLE', m.id::text from public.merchants m
  join public.merchant_connectors c on c.merchant_id = m.id and c.kind = m.source_system and c.external_id = m.source_id
 where m.source_system in (select k from kinds) and c.external_domain is distinct from m.source_domain
union all
select 'NON_REBUILDABLE_LEGACY_VALUE', m.id::text from public.merchants m
 where m.source_system not in (select k from kinds)
   and not (m.source_system = 'nordla' and m.source_id = 'nordla:' || m.id::text and m.source_domain is null)
union all
select 'OTHER_DEPENDENT_OBJECT', d.classid::regclass::text || ' ' || d.objid::text from pg_depend d
  join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
 where d.refclassid = 'pg_class'::regclass and d.refobjid = 'public.merchants'::regclass
   and a.attname in ('source_system', 'source_id', 'source_domain')
   and d.objid not in (select oid from pg_constraint where conrelid = 'public.merchants'::regclass
                         and (conname = 'merchants_source_unique' or (contype = 'n' and cardinality(conkey) = 1 and conkey[1] = a.attnum))
                       union select conindid from pg_constraint where conrelid = 'public.merchants'::regclass and conname = 'merchants_source_unique')
union all
select 'FUNCTION_MAY_USE_LEGACY_COLUMNS', p.oid::regprocedure::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
 where s.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   and p.prosrc ~* '\mmerchants\M' and p.prosrc ~* '\msource_(system|id|domain)\M';
