-- Additive migration (Phase 2E): pseudonymous customer key on orders.
-- Privacy by construction: this column NEVER holds a source customer id, name, email, phone or address.
-- It holds HMAC-SHA256(secret, source customer id) as hex, computed at sync time with a secret kept in a local
-- environment variable (CUSTOMER_HASH_KEY, never in git). NULL = anonymous order or customer keys not enabled.

alter table orders add column customer_key text;

comment on column orders.customer_key is
  'Keyed hash (HMAC-SHA256, hex) of the source customer id. Pseudonymous, not reversible without the local secret. NULL for anonymous orders or when customer keys are not enabled. Used only for aggregate customer metrics.';

create index orders_customer_key_idx on orders (merchant_id, customer_key) where customer_key is not null;
