-- Structural fingerprint of the schemas a staging backup must restore exactly (public, supabase_migrations): one sorted line per object.
-- Compared between the live staging database and the restored copy: any difference stops everything (no migration is applied).
with s as (select oid, nspname from pg_namespace where nspname in ('public', 'supabase_migrations'))
select line from (
  select 'table ' || s.nspname || '.' || c.relname || ' kind=' || c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity as line
    from pg_class c join s on s.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all select 'column ' || s.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join s on s.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
  union all select 'constraint ' || s.nspname || '.' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    from pg_constraint k join pg_class c on c.oid = k.conrelid join s on s.oid = c.relnamespace
  union all select 'index ' || i.schemaname || ' ' || i.indexdef from pg_indexes i where i.schemaname in ('public', 'supabase_migrations')
  union all select 'function ' || s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') returns ' || pg_get_function_result(p.oid)
                   || ' secdef=' || p.prosecdef || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' body=' || md5(p.prosrc)
    from pg_proc p join s on s.oid = p.pronamespace
  union all select 'trigger ' || s.nspname || '.' || c.relname || ' ' || pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join s on s.oid = c.relnamespace where not t.tgisinternal
  union all select 'policy ' || s.nspname || '.' || c.relname || '.' || p.polname || ' cmd=' || p.polcmd::text || ' permissive=' || p.polpermissive
                   || ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-') || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')
    from pg_policy p join pg_class c on c.oid = p.polrelid join s on s.oid = c.relnamespace
  union all select 'grant table ' || g.table_schema || '.' || g.table_name || ' ' || g.grantee || ' ' || g.privilege_type
    from information_schema.role_table_grants g where g.table_schema in ('public', 'supabase_migrations') and g.grantee in ('anon', 'authenticated', 'service_role')
  union all select 'grant function ' || s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || r.rolname || '=' || has_function_privilege(r.oid, p.oid, 'execute')
    from pg_proc p join s on s.oid = p.pronamespace cross join pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
) x order by 1;
