-- Fictitious data for the report and access-checker tests. Owner only. Two merchants (A, B), three people (U1 owner without factor,
-- U2 member with a verified factor, U3 suspended), an entitlement per merchant, and one row in each report table for A and for B.
insert into public.merchants (id, name, vertical) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Services A (fictif)', 'general_retail'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Services B (fictif)', 'general_retail');

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'u1@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'u2@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'u3@example.test');
insert into auth.mfa_factors (user_id, status, factor_type) values ('22222222-2222-4222-8222-222222222222', 'verified', 'totp');

insert into public.merchant_members (merchant_id, user_id, role, status, created_at, updated_at, suspended_at) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'OWNER', 'ACTIVE', now(), now(), null),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '22222222-2222-4222-8222-222222222222', 'VIEWER', 'ACTIVE', now(), now(), null),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '33333333-3333-4333-8333-333333333333', 'VIEWER', 'SUSPENDED', now(), now(), now()),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '22222222-2222-4222-8222-222222222222', 'OWNER', 'ACTIVE', now(), now(), null);

insert into public.module_entitlements (merchant_id, module_code, status, enabled_at, created_at, updated_at, source, last_operation_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'analytics', 'ACTIVE', now(), now(), now(), 'provisioning:test', gen_random_uuid()),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'analytics', 'ACTIVE', now(), now(), now(), 'provisioning:test', gen_random_uuid());

insert into public.merchant_security_settings (merchant_id, updated_at, require_mfa_privileged) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', now(), true);

insert into public.merchant_profile (merchant_id, timezone, currency) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Europe/Brussels', 'EUR'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Europe/Brussels', 'EUR');

insert into public.products (merchant_id, title, source_system, source_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Produit A (fictif)', 'shopify', 'p-a-1'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Produit B (fictif)', 'shopify', 'p-b-1');
insert into public.variants (product_id, merchant_id, source_system, source_id) values
  ((select id from public.products where source_id = 'p-a-1'), 'aaaaaaaa-0000-4000-8000-00000000000a', 'shopify', 'v-a-1'),
  ((select id from public.products where source_id = 'p-b-1'), 'bbbbbbbb-0000-4000-8000-00000000000b', 'shopify', 'v-b-1');
insert into public.locations (merchant_id, name, type, source_system, source_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Boutique A', 'store', 'shopify', 'l-a-1'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Boutique B', 'store', 'shopify', 'l-b-1');
insert into public.orders (merchant_id, source_system, source_id, ordered_at, currency, status, taxes_included) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'shopify', 'o-a-1', now() - interval '2 days', 'EUR', 'PAID', true),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'shopify', 'o-b-1', now() - interval '2 days', 'EUR', 'PAID', true);
insert into public.order_lines (order_id, source_system, source_id, title_snapshot, quantity, unit_price, merchant_id) values
  ((select id from public.orders where source_id = 'o-a-1'), 'shopify', 'ol-a-1', 'Produit A (fictif)', 1, 10, 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ((select id from public.orders where source_id = 'o-b-1'), 'shopify', 'ol-b-1', 'Produit B (fictif)', 1, 20, 'bbbbbbbb-0000-4000-8000-00000000000b');
insert into public.order_attribution (merchant_id, order_id, source_system, touch) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', (select id from public.orders where source_id = 'o-a-1'), 'shopify', 'first_visit'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', (select id from public.orders where source_id = 'o-b-1'), 'shopify', 'first_visit');
insert into public.product_costs (variant_id, merchant_id, unit_cost, currency, source) values
  ((select id from public.variants where source_id = 'v-a-1'), 'aaaaaaaa-0000-4000-8000-00000000000a', 4, 'EUR', 'manual_entry'),
  ((select id from public.variants where source_id = 'v-b-1'), 'bbbbbbbb-0000-4000-8000-00000000000b', 8, 'EUR', 'manual_entry');
insert into public.product_collections (merchant_id, product_id, source_system, source_id, title) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', (select id from public.products where source_id = 'p-a-1'), 'shopify', 'c-a-1', 'Collection A'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', (select id from public.products where source_id = 'p-b-1'), 'shopify', 'c-b-1', 'Collection B');
insert into public.inventory_snapshots (variant_id, location_id, quantity, merchant_id) values
  ((select id from public.variants where source_id = 'v-a-1'), (select id from public.locations where source_id = 'l-a-1'), 3, 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ((select id from public.variants where source_id = 'v-b-1'), (select id from public.locations where source_id = 'l-b-1'), 7, 'bbbbbbbb-0000-4000-8000-00000000000b');
