// Phase 4 - Finance answers GET /version without a session, with the commit and branch only (no data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './finance-dashboard-helpers.js';

test('GET /version answers without any session, with only the release fields', async () => {
  const a = await startApp({});
  try {
    const anon = a.client();
    const res = await fetch(`${a.base}/version`);
    const body = await res.json();
    assert.equal(res.status, 200, 'no session is needed to read the version');
    assert.equal(body.service, 'finance');
    assert.deepEqual(Object.keys(body).sort(), ['branch', 'service', 'sha', 'source']);
    assert.equal(typeof anon.login, 'function');
  } finally { await a.close(); }
});
