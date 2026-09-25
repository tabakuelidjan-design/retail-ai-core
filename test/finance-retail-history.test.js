import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRetailHistory } from '../src/finance/retail-history.js';

test('retail history: the last successful sync time comes from the run log, backfill facts only from the marker file', () => {
  const file = { completeFrom: '2026-01-12', storeCreatedOn: '2026-01-12', lastSyncedAt: '2026-09-21T16:03:28.132Z' };
  assert.deepEqual(mergeRetailHistory(file, '2026-09-26T10:02:00+00:00'), { completeFrom: '2026-01-12', storeCreatedOn: '2026-01-12', lastSyncedAt: '2026-09-26T10:02:00.000Z' });
  assert.deepEqual(mergeRetailHistory(null, '2026-09-26T10:02:00.500+00:00'), { completeFrom: null, storeCreatedOn: null, lastSyncedAt: '2026-09-26T10:02:00.500Z' }, 'no file on a host: nothing about the backfill is invented');
  assert.deepEqual(mergeRetailHistory(file, null), file, 'no run log: the file is used as before');
  assert.equal(mergeRetailHistory(null, null), null);
});
