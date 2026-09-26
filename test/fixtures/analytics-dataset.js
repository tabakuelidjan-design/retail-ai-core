import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeData } from './metrics-sample.js';

// Shared SYNTHETIC analytics dataset for the assistant tests (same construction as the period-selector tests). One product title carries an e-mail address on
// purpose, to prove that nothing personal reaches an AI provider even if a title did.
export const TZ = 'Europe/Brussels';
export const NOW = new Date('2026-09-26T10:00:00Z');
const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export async function writeDataset({ dirty = false } = {}) {
  const d = makeData();
  d.orders = []; d.orderLines = []; d.refunds = []; d.refundLines = [];
  const uuid = { p1: '11111111-1111-4111-8111-111111111111', p2: '22222222-2222-4222-8222-222222222222', p3: '33333333-3333-4333-8333-333333333333', p4: '44444444-4444-4444-8444-444444444444' };
  for (const p of d.products) p.id = uuid[p.id]; for (const v of d.variants) v.product_id = uuid[v.product_id];
  let i = 0;
  const add = (id, iso, q, price, disc, variant, channel, key) => {
    const tax = r2((q * price - disc) * 0.21 / 1.21);
    d.orders.push({ id, ordered_at: iso, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, channel_handle: channel, customer_key: key });
    d.orderLines.push({ id: `l-${id}`, order_id: id, variant_id: variant, title_snapshot: variant === 'v1' ? 'Fixture Widget' : (dirty ? 'Fixture Gadget jean.dupont@example.com' : 'Fixture Gadget'), sku_snapshot: null, quantity: q, unit_price: price, discount_amount: disc, tax_amount: tax });
  };
  for (let day = new Date('2026-06-12T12:00:00Z'); day <= new Date('2026-09-24T12:00:00Z'); day = new Date(day.getTime() + 2 * 86_400_000)) {
    i += 1; add(`g${i}`, day.toISOString(), (i % 3) + 1, 10 + (i % 5) * 5, i % 4 === 0 ? 2 : 0, i % 2 ? 'v1' : 'v2', i % 2 ? 'pos' : 'web', String.fromCharCode(97 + (i % 4)).repeat(64));
  }
  d.refunds.push({ id: 'rf1', order_id: 'g10', amount: 10, refunded_at: '2026-08-20T09:00:00Z' });
  d.refundLines.push({ id: 'rfl1', refund_id: 'rf1', order_line_id: 'l-g10', quantity: 1, amount: 10, tax_amount: 1.74 });
  d.firstOrderAt = '2026-06-12T12:00:00Z';
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-'));
  await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, generated_at: '2026-09-26T09:00:00.000Z', time_zone: TZ, currency: 'EUR', data: d }));
  return dir;
}
