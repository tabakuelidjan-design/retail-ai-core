// Growth reads the merchant's LOCAL calendar (weeks, weekdays, windows). The zone is explicit (merchant_profile.timezone or MERCHANT_TIMEZONE): a missing zone is refused with
// TIMEZONE_NOT_CONFIGURED and an invalid one with TIMEZONE_INVALID. No Growth source assumes UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProductPotentialSource } from '../src/growth/server/products.js';
import { createAudienceSource } from '../src/growth/server/audience.js';
import { createContentSource } from '../src/growth/server/content.js';
import { createStoreSource } from '../src/growth/server/store.js';

const SOURCES = { createProductPotentialSource, createAudienceSource, createContentSource, createStoreSource };
const supabase = { select: async () => [] };
const merchantId = '00000000-0000-4000-8000-000000000001';

test('every Growth source refuses to be created without an explicit merchant time zone', () => {
  for (const [name, create] of Object.entries(SOURCES)) {
    for (const timeZone of [undefined, null, '', '  ']) assert.throws(() => create({ supabase, merchantId, timeZone }), { code: 'TIMEZONE_NOT_CONFIGURED' }, `${name} ${JSON.stringify(timeZone)}`);
    for (const timeZone of ['CET', 'UTC+1', 'Europe/Nowhere']) assert.throws(() => create({ supabase, merchantId, timeZone }), { code: 'TIMEZONE_INVALID' }, `${name} ${timeZone}`);
    assert.equal(typeof create({ supabase, merchantId, timeZone: 'Europe/Brussels' }), 'function', name);
  }
});

test('no Growth server file falls back to UTC; the launcher resolves the zone through the shared business profile', () => {
  for (const f of ['products', 'audience', 'content', 'store', 'serve']) {
    const src = readFileSync(new URL(`../src/growth/server/${f}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /timeZone\s*=\s*'UTC'|\|\|\s*'UTC'/, f);
  }
  assert.match(readFileSync(new URL('../src/growth/server/serve.js', import.meta.url), 'utf8'), /resolveBusinessProfile\(/);
});
