// Phase 4 - Analytics answers GET /version BEFORE the access guard: it works without the token, with the release fields only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';

test('GET /version answers even when the access guard refuses everything, with the release and no data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-an-version-'));
  const denyAll = async (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}'); return false; };
  const handler = createAnalyticsPremiumApp({
    release: { sha: '0e333a104438a1c17d2b0cd9246834642d0001a2', branch: 'release/analytics-staging', source: 'declared' },
    reportsDir: dir, guard: denyAll, syncStatus: async () => ({}), reportStatus: () => ({}), ask: async () => ({}),
  });
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/version`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['branch', 'service', 'sha', 'source']);
    assert.equal(body.service, 'analytics');
    assert.equal(body.sha, '0e333a104438a1c17d2b0cd9246834642d0001a2');
    const data = await fetch(`http://127.0.0.1:${s.address().port}/api/brief`);
    assert.equal(data.status, 401, 'data still needs the guard');
  } finally { await new Promise((r) => s.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
