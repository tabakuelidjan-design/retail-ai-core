// The Core refuses to run its journal where the platform cannot carry its guarantees (Railway without a volume / outside it). Off Railway nothing is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { checkJournalDeployment } from '../src/core-pilot/deployment-guard.js';

const RAIL = { RAILWAY_SERVICE_ID: 'svc-1', RAILWAY_ENVIRONMENT_ID: 'env-1' };
const MOUNT = resolve('/app/data');

test('guard: off Railway nothing is refused (a PC or another host: the operator carries the guarantees)', () => {
  assert.equal(checkJournalDeployment({ env: {}, dir: '/anywhere' }).ok, true);
  assert.equal(checkJournalDeployment({ env: { NODE_ENV: 'production' }, dir: '/tmp/x' }).ok, true);
});

test('guard: on Railway the data directory must be INSIDE the attached volume; a missing volume or an outside path is refused with a reason', () => {
  assert.equal(checkJournalDeployment({ env: { ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, dir: MOUNT }).ok, true);
  assert.equal(checkJournalDeployment({ env: { ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, dir: join(MOUNT, 'local', 'sourcing') }).platform, 'RAILWAY_VOLUME');
  const none = checkJournalDeployment({ env: RAIL, dir: MOUNT }); assert.equal(none.ok, false); assert.equal(none.code, 'JOURNAL_NOT_ON_A_VOLUME'); assert.match(none.reason, /volume/);
  const outside = checkJournalDeployment({ env: { ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, dir: resolve('/app/other') }); assert.equal(outside.ok, false);
  const sibling = checkJournalDeployment({ env: { ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, dir: resolve('/app/data-old') }); assert.equal(sibling.ok, false, '/app/data-old is not inside /app/data');
  assert.equal(checkJournalDeployment({ env: { ...RAIL, RAILWAY_VOLUME_MOUNT_PATH: '   ' }, dir: MOUNT }).ok, false);
});
