-- M2 ROLLBACK - restores merchants.source_system / source_id / source_domain and merchants_source_unique. NEVER run without the
-- owner's explicit approval; one transaction; never modifies merchant_connectors or any business table; never changes a merchant id.
--
-- Source of each merchant's values, in this order - never a guess:
--   1. the proof exported right before M2 (optional): load it first into a TEMPORARY table in the same session:
--        create temporary table m2_proof (id uuid primary key, source_system text not null, source_id text not null, source_domain text);
--        insert into m2_proof values (...);   -- the rows of the export, unchanged
--   2. otherwise, rebuilt from merchant_connectors: exactly one connector of a kind with a natural id (shopify, woocommerce,
--      prestashop, odoo) -> (kind, external_id, external_domain);
--   3. no such connector -> the canonical Nordla placeholder ('nordla', 'nordla:' || id, no domain). M2 only ran when every
--      merchant was in case 2 or 3 exactly, so for the merchants that existed before M2 this is an exact restore.
-- Refused (raises, nothing changed) when a merchant has several candidate connectors and no proof row: that would be a choice.

set local lock_timeout = '5s';
lock table public.merchants in access exclusive mode;
lock table public.merchant_connectors in share mode;

alter table public.merchants add column source_system text, add column source_id text, add column source_domain text;

do $m2rb$
declare
  kinds constant text[] := array['shopify', 'woocommerce', 'prestashop', 'odoo'];
  has_proof boolean := to_regclass('pg_temp.m2_proof') is not null;
  n integer;
  ids text;
begin
  if has_proof then
    execute 'update public.merchants m set source_system = p.source_system, source_id = p.source_id, source_domain = p.source_domain
               from pg_temp.m2_proof p where p.id = m.id';
  end if;

  -- ambiguity: several candidate connectors and no proof row -> refuse
  select count(*), string_agg(x.id::text, ', ' order by x.id) into n, ids from (
    select m.id from public.merchants m join public.merchant_connectors c on c.merchant_id = m.id
     where m.source_system is null and c.kind = any (kinds) and c.external_id is not null
     group by m.id having count(*) > 1) x;
  if n > 0 then
    raise exception 'M2 rollback refused: merchant(s) % have several external connectors and no proof row - load the pre-M2 proof', ids using errcode = 'P0001';
  end if;

  update public.merchants m set source_system = c.kind, source_id = c.external_id, source_domain = c.external_domain
    from public.merchant_connectors c
   where m.source_system is null and c.merchant_id = m.id and c.kind = any (kinds) and c.external_id is not null;

  update public.merchants set source_system = 'nordla', source_id = 'nordla:' || id::text, source_domain = null where source_system is null;
end
$m2rb$;

alter table public.merchants alter column source_system set not null;
alter table public.merchants alter column source_id set not null;
alter table public.merchants add constraint merchants_source_unique unique (source_system, source_id);

comment on column public.merchants.source_id is
  'Stable external identity (e.g. the Shopify Shop GID). This, not name, is what upserts key on — a display name is never guaranteed unique across current or future merchants.';
comment on column public.merchants.source_domain is
  'Informational only (e.g. the myshopify.com domain) — for human readability/debugging. Never used for identity or uniqueness: a domain can change (custom domain migration, platform migration) independently of the merchant.';
comment on table public.merchants is null;
