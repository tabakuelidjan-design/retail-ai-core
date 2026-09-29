-- M2 ROLLBACK - restores the NOT NULL of merchants.source_system and merchants.source_id, and nothing else. NEVER run without the
-- owner's explicit approval. One transaction. It never chooses a connector and never rebuilds an identity: if any merchant has a
-- NULL source_system or source_id (e.g. a merchant created without Shopify after M2), it REFUSES with an explicit message and changes
-- nothing - that merchant must be dealt with by an explicit owner decision first. Columns, values, merchants_source_unique,
-- merchant_connectors and business tables are untouched (the DEPRECATED comments stay: they describe the columns correctly).

set local lock_timeout = '5s';
lock table public.merchants in access exclusive mode;

do $m2rb$
declare
  n integer;
  ids text;
begin
  select count(*), string_agg(id::text, ', ' order by id) into n, ids
    from public.merchants where source_system is null or source_id is null;
  if n > 0 then
    raise exception 'M2 rollback refused: % merchant(s) have a NULL source_system or source_id: % - no identity is ever invented; decide explicitly first', n, ids using errcode = 'P0001';
  end if;
end
$m2rb$;

alter table public.merchants alter column source_system set not null, alter column source_id set not null;
