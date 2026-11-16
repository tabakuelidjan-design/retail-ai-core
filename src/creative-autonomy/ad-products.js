// The products for which the advertisement route (AD) has a validated product sheet (config/creator/ad-products/registry.json). A product that is not listed cannot use the AD route:
// the route needs the confirmed invariants of the product (what must never change in the image), which only the owner's sheet carries.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'creator', 'ad-products');

export function loadAdProducts(dir = DEFAULT_DIR) {
  const registry = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'));
  const snapshots = Object.fromEntries(readdirSync(join(dir, 'snapshots')).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(dir, 'snapshots', f), 'utf8'))]));
  const entries = registry.products.map((p) => ({ key: p.key, shopify_product_id: p.shopify_product_id, definition: JSON.parse(readFileSync(join(dir, 'sheets', p.sheet), 'utf8')), snapshots }));
  return Object.freeze({ list: () => entries.map(({ key, shopify_product_id }) => ({ key, shopify_product_id })), has: (id) => entries.some((e) => e.shopify_product_id === id), find: (id) => entries.find((e) => e.shopify_product_id === id) ?? null });
}
