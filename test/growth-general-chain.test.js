// The REAL chain of Growth (real engines, real aggregator, real Général service) on a fake database:
//   (1) an opportunity that matches a featured offer written in Général is flagged, and nothing else moves (same ids, same order, same figures);
//   (2) the time zone written in Général is taken into account WITHOUT restarting anything (the engines are built once).
// This is automated coverage; the same two paths are proven separately in a real Growth session on the staging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrioritiesSource } from '../src/growth/server/priorities.js';
import { createProductPotentialSource } from '../src/growth/server/products.js';
import { createAudienceSource } from '../src/growth/server/audience.js';
import { createContentSource } from '../src/growth/server/content.js';
import { createStoreSource } from '../src/growth/server/store.js';
import { liveTimeZone } from '../src/metrics/profile.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { makeDemandData, NOW } from './fixtures/demand-sample.js';
import { createGeneralService } from '../src/settings-general/service.js';
import { createMemoryGeneralRepository } from '../src/settings-general/repository.js';

const M = 'm-synthetic';
function world({ timezone = 'UTC' } = {}) {
  const d = makeDemandData(); const db = createFakeSupabase();
  for (const [t, rows] of [['products', d.products], ['variants', d.variants], ['orders', d.orders], ['order_lines', d.orderLines], ['product_costs', d.costs], ['inventory_snapshots', d.snapshots]]) db._tables.set(t, rows.map((r) => ({ ...r, merchant_id: M })));
  db._tables.set('merchant_profile', [{ merchant_id: M, timezone, currency: 'EUR', country: 'BE' }]);
  return db;
}
const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'orientation' || k === 'general' ? undefined : v)));

test('GX-1 an opportunity matching a featured offer from Général is flagged on the real chain; ids, order and figures are exactly those of the run without Général', async () => {
  const db = world(); const args = { supabase: db, merchantId: M, timeZone: 'UTC', now: () => NOW, cacheMs: 0 };
  const engines = () => ({ productPotential: createProductPotentialSource(args), audience: createAudienceSource(args), content: createContentSource(args), store: createStoreSource(args), now: () => NOW });
  const base = await createPrioritiesSource(engines())();
  const product = base.sections.commercial.find((i) => i.entity?.type === 'product' && i.entity.title);
  assert.ok(product, 'the sample holds at least one product opportunity'); const offer = product.entity.title;
  // Général: the featured offer is written through the real service and read back through its module context
  const repo = createMemoryGeneralRepository({ merchants: { [M]: 'Boutique test' } }); const general = createGeneralService({ repo });
  await general.save({ tenant: { merchantId: M }, role: 'OWNER', actor: 'u', section: 'objectives', data: { priority: { value: 'sales' }, featured_offers: [{ label: offer }], constraints: { stock: { note: 'stock limité' } } } });
  const oriented = await createPrioritiesSource({ ...engines(), general: () => general.contextFor({ tenant: { merchantId: M }, module: 'growth' }) })();
  assert.equal(oriented.general.state, 'PRESENT'); assert.equal(oriented.general.priority, 'Développer les ventes'); assert.equal(oriented.general.constraints.stock, 'stock limité');
  assert.ok(oriented.general.focus.includes(product.id), 'the matching opportunity is in the focus');
  assert.equal(oriented.sections.commercial.find((i) => i.id === product.id).orientation.featuredOffer, offer);
  assert.deepEqual(strip(oriented), strip(base), 'same ids, same order, same figures: only annotations were added');
  assert.deepEqual(oriented.weekly.items.map((i) => i.id), base.weekly.items.map((i) => i.id), 'the weekly ranking is untouched');
});

test('GX-2 the time zone written in Général is followed without a restart: the engines are built ONCE, the window moves when the zone changes', async () => {
  const db = world({ timezone: 'UTC' }); let clock = 0; const live = liveTimeZone({ supabase: db, merchantId: M, env: {}, ttlMs: 1000, now: () => clock });
  const args = { supabase: db, merchantId: M, timeZone: live, now: () => NOW, cacheMs: 0 };
  const src = createProductPotentialSource(args); // built once
  const a = await src(); assert.ok(a.window?.start, 'the engine reports its measurement window');
  db._tables.set('merchant_profile', [{ merchant_id: M, timezone: 'Pacific/Kiritimati', currency: 'EUR', country: 'BE' }]); // Général changes the zone
  clock = 500; const same = await src(); assert.deepEqual(same.window, a.window, 'inside the 1 s ttl: still the old zone');
  clock = 5000; const b = await src(); assert.notDeepEqual(b.window, a.window, 'after the ttl: the SAME engine now measures in the new zone (UTC+14), no restart');
  const store = createStoreSource({ ...args, timeZone: live }); const s1 = await store(); assert.ok(s1);
});
