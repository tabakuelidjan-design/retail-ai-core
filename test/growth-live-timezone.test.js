// Growth follows the time zone set in Général without a restart (liveTimeZone), fail closed at the first read, keeps the last real zone on a transient error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveTimeZone, ProfileError } from '../src/metrics/profile.js';
import { createStoreSource } from '../src/growth/server/store.js';
import { createProductPotentialSource } from '../src/growth/server/products.js';
import { createAudienceSource } from '../src/growth/server/audience.js';
import { createContentSource } from '../src/growth/server/content.js';

const M = '11111111-1111-4111-8111-111111111111';
const fake = (rows) => ({ calls: 0, async select() { this.calls += 1; if (rows.error) throw rows.error; return rows.value; } });

test('GT-1 the zone follows merchant_profile after the ttl, not before; one read per ttl', async () => {
  const rows = { value: [{ merchant_id: M, timezone: 'Europe/Brussels' }] }; const supabase = fake(rows); let t = 0;
  const get = liveTimeZone({ supabase, merchantId: M, env: {}, ttlMs: 1000, now: () => t });
  assert.equal(await get(), 'Europe/Brussels'); rows.value = [{ merchant_id: M, timezone: 'America/New_York' }];
  t = 500; assert.equal(await get(), 'Europe/Brussels', 'inside the ttl: cached'); assert.equal(supabase.calls, 1);
  t = 1500; assert.equal(await get(), 'America/New_York', 'after the ttl: the new zone, no restart'); assert.equal(supabase.calls, 2);
});

test('GT-2 fail closed: no zone at the first read throws (UTC is never assumed); a later transient error keeps the last real zone; a missing/invalid zone later still throws', async () => {
  const none = liveTimeZone({ supabase: fake({ value: [] }), merchantId: M, env: {} });
  await assert.rejects(none(), (e) => e instanceof ProfileError && e.code === 'TIMEZONE_NOT_CONFIGURED');
  const rows = { value: [{ merchant_id: M, timezone: 'Europe/Brussels' }] }; const errors = []; let t = 0;
  const get = liveTimeZone({ supabase: fake(rows), merchantId: M, env: {}, ttlMs: 10, now: () => t, onError: (e) => errors.push(e.message) });
  assert.equal(await get(), 'Europe/Brussels'); rows.error = new Error('db down'); t = 100;
  assert.equal(await get(), 'Europe/Brussels', 'database hiccup: last good zone'); assert.equal(errors.length, 1);
  delete rows.error; rows.value = [{ merchant_id: M, timezone: 'CET' }]; t = 200;
  await assert.rejects(get(), (e) => e.code === 'TIMEZONE_INVALID', 'an invalid zone is never papered over');
});

test('GT-3 the four Growth sources accept a getter or a string; a string is still validated at build time', () => {
  const supabase = fake({ value: [] }); const getter = async () => 'Europe/Brussels';
  for (const make of [createStoreSource, createProductPotentialSource, createAudienceSource, createContentSource]) {
    assert.doesNotThrow(() => make({ supabase, merchantId: M, timeZone: getter }));
    assert.doesNotThrow(() => make({ supabase, merchantId: M, timeZone: 'Europe/Brussels' }));
    assert.throws(() => make({ supabase, merchantId: M, timeZone: 'EST' }));
  }
});
