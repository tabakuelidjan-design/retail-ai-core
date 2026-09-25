-- Additive migration: the product's real primary image from Shopify (featuredImage), for surfacing
-- an actual product thumbnail in reporting UIs instead of a generic placeholder. Nothing existing is
-- altered or removed.

alter table products add column image_url text;
alter table products add column image_alt_text text;

comment on column products.image_url is
  'The source system''s (Shopify) featuredImage.url for this product. Null means the product genuinely has no image - never backfilled with another product''s image or a stock photo.';
comment on column products.image_alt_text is
  'The source system''s featuredImage.altText, if the merchant set one. Null is common and expected.';
