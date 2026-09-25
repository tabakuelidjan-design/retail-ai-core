-- Additive, nullable: shipping charges, shipping VAT and shipping refunds captured from the source, plus the source order reference.
-- NULL means "not captured" (never assumed to be zero); 0 means the source reported no shipping. Existing rows are untouched until
-- the next order sync repopulates them (the sync is an idempotent upsert of the whole window).
--
-- shipping_price     original shipping price as presented by the source (incl. VAT when taxes_included), before shipping discounts
-- shipping_discount  discount applied to shipping (original - discounted price)
-- shipping_tax       VAT reported by the source on the shipping line(s)
-- shipping_tax_rate_bp  the source-reported VAT rate (basis points) when all shipping tax lines share one rate, otherwise NULL
-- refunds.shipping_subtotal / shipping_tax   shipping refunded (excl. VAT / VAT), from the source's refund shipping lines
-- order_name         the source's human order reference (for example "#1065"), used on exports

alter table orders
  add column order_name text,
  add column shipping_price numeric(12,2),
  add column shipping_discount numeric(12,2),
  add column shipping_tax numeric(12,2),
  add column shipping_tax_rate_bp integer;

alter table refunds
  add column shipping_subtotal numeric(12,2),
  add column shipping_tax numeric(12,2);

comment on column orders.shipping_price is 'Shipping price before shipping discounts, as presented by the source (incl. VAT when taxes_included). NULL = not captured.';
comment on column orders.shipping_tax is 'VAT reported by the source on shipping. NULL = not captured.';
comment on column refunds.shipping_subtotal is 'Shipping refunded, excl. VAT, from the source refund shipping lines. NULL = not captured.';
