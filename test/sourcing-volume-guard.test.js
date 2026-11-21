// Protection of the persistent storage on Railway: the sourcing data (cases, photos, workspace) must be on the attached volume or the server refuses to start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { assertDataOnVolume, startSourcingServer } from '../src/sourcing/server/index.js';

const RAIL = { RAILWAY_SERVICE_ID: 'svc-1', RAILWAY_ENVIRONMENT_ID: 'env-1' };
const MOUNT = resolve('/app/data');

test('volume guard: off Railway nothing is refused', () => {
  assert.equal(assertDataOnVolume({ env: {}, dir: '/anywhere' }).ok, true);
});

test('volume guard: on Railway the data directory inside the volume is accepted, outside or without a volume it is refused with DATA_NOT_ON_A_VOLUME', () => {
  assert.equal(assertDataOnVolume({ env: { ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, dir: join(MOUNT, 'sourcing') }).platform, 'RAILWAY_VOLUME');
  for (const [env, dir] of [[RAIL, MOUNT], [{ ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, resolve('/app/other')], [{ ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, resolve('/app/data-old')]]) {
    assert.throws(() => assertDataOnVolume({ env, dir }), (e) => e.code === 'DATA_NOT_ON_A_VOLUME' && /volume/.test(e.message));
  }
});

test('volume guard: a hosted start on Railway with SOURCING_DATA_DIR outside the volume fails BEFORE anything is written or opened', async () => {
  const env = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5', SOURCING_PUBLIC_ORIGIN: 'https://app.nordla-test.example', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', NORDLA_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', SOURCING_MERCHANT_ID: 'habb', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon', NORDLA_IDENTITY_RATE_LIMIT_KEY: 'a'.repeat(64), NORDLA_CSRF_KEY: 'b'.repeat(64), ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: resolve('/definitely-a-volume'), SOURCING_DATA_DIR: resolve('/tmp/not-on-the-volume') };
  await assert.rejects(() => startSourcingServer({ env, log: () => {}, port: 0, fetchImpl: async () => { throw new Error('no network'); } }), (e) => e.code === 'DATA_NOT_ON_A_VOLUME');
});
