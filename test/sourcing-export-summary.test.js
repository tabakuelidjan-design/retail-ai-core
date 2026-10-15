// The export says how many photos it really holds: a photo the case lists but this device does not have is named, never invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, exportSummary } from '../src/sourcing/core/recovery.js';

const c = { id: 'k1', identity: { photos: [{}, {}, {}] }, documents: [{ id: 'd1' }] };

test('export summary: photos included vs listed, the missing ones named; the export file holds exactly the included ones', () => {
  const have = { 'photo:k1.0': 'data:image/jpeg;base64,AA', 'photo:k1.2': 'data:image/jpeg;base64,BB', 'docphoto:k1.d1': 'data:image/jpeg;base64,CC' };
  const s = exportSummary(c, (k) => have[k] ?? null);
  assert.deepEqual(s, { expected: 4, included: 3, missing: ['photo:k1.1'] });
  assert.deepEqual(Object.keys(JSON.parse(buildExport(c, (k) => have[k] ?? null)).photos).sort(), Object.keys(have).sort());
  assert.deepEqual(exportSummary({ id: 'k2', identity: {} }), { expected: 0, included: 0, missing: [] });
});
