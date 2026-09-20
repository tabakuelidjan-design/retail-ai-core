-- phase1_merchant_identity.sql
-- Additive migration: gives merchants a real external identity, separate from the
-- display name. Does not touch 0001_phase1_schema.sql.

alter table merchants add column source_system text;
alter table merchants add column source_id text;
alter table merchants add column source_domain text;

update merchants
set source_system = 'shopify',
    source_id = 'gid://shopify/Shop/98815246684',
    source_domain = 'zmb5jr-wf.myshopify.com'
where name = 'HABB';

alter table merchants alter column source_system set not null;
alter table merchants alter column source_id set not null;

alter table merchants add constraint merchants_source_unique unique (source_system, source_id);

comment on column merchants.source_id is
  'Stable external identity (e.g. the Shopify Shop GID). This, not name, is what upserts key on — a display name is never guaranteed unique across current or future merchants.';

comment on column merchants.source_domain is
  'Informational only (e.g. the myshopify.com domain) — for human readability/debugging. Never used for identity or uniqueness: a domain can change (custom domain migration, platform migration) independently of the merchant.';
