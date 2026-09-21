-- Additive migration (Phase 2D.1): order channel + marketing attribution.
-- Privacy by construction: no customer identity, no full URLs. Referrers are stored
-- as HOST only and landing pages as PATH only (query strings and fragments are never
-- kept: they can carry personal data or click identifiers). Attribution is Shopify's
-- own recorded first/last visit - an observation of the journey, not proof of cause.

alter table orders add column source_name text;
alter table orders add column channel_handle text;
alter table orders add column channel_name text;
alter table orders add column sub_channel_name text;
alter table orders add column customer_order_index integer;
alter table orders add column journey_ready boolean;
alter table orders add column days_to_conversion numeric;

comment on column orders.customer_order_index is
  'Position of this order in the customer''s order history as recorded by the source. Only meaningful when the order carries a real customer (online orders); POS orders without a customer default to 1 and must not be read as "new customer".';

create table order_attribution (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  order_id uuid not null references orders(id),
  source_system text not null,
  touch text not null check (touch in ('first_visit', 'last_visit')),
  occurred_at timestamptz,
  source text,
  source_type text,
  source_description text,
  referrer_host text,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  synced_at timestamptz not null default now(),
  unique (order_id, source_system, touch)
);

comment on table order_attribution is
  'One row per recorded visit (first/last) that led to an order. Orders with no recorded visit (all POS orders, some online) have no row: that absence is itself the "unattributed" fact.';

alter table order_attribution enable row level security;
