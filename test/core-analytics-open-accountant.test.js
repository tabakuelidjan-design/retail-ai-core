// Full Core server (createSourcingApp: role gate, module gate, CSRF-free test gate): an ACCOUNTANT opens Analyses from Core,
// a read-only role (VIEWER) does not, and every write stays protected. The session gate is replaced by a fake that only
// returns the identity and role of the request (x-test-role); the role table, the read-only list and the module decision are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { K_ANALYTICS } from './fixtures/sso-test-keys.js';

const M = 'merchant-test-analytics';
const URL_ANALYTICS = 'https://analytics-staging.example.app/';

function serverFor() {
  const gate = {
    authorize: async (req) => ({ ok: true, access: { userId: 'u-' + (req.headers['x-test-role'] ?? 'none'), role: req.headers['x-test-role'] ?? null } }),
    handle: async () => false,
  };
  const core = createCoreHttp({
    runtime: null, store: {}, merchantId: M,
    analyticsSso: { publicUrl: URL_ANALYTICS.replace(/\/$/, ''), secret: K_ANALYTICS, merchantId: M },
    entitlements: async () => new Set(['analytics']),
  });
  return createSourcingApp({ gate, core, store: createMemoryStore(), uiDir: '.', coreDir: '.' }).handler;
}

async function call(handler, { method, path, role }) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    const headers = { 'content-type': 'application/json', host: `127.0.0.1:${port}` };
    if (role) headers['x-test-role'] = role;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  } finally { await new Promise((r) => s.close(r)); }
}

test('an ACCOUNTANT opens Analyses from Core: a one-time ticket for the Analytics domain', async () => {
  const h = serverFor();
  const r = await call(h, { method: 'POST', path: '/api/core/analytics/open', role: 'ACCOUNTANT' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/analytics-staging\.example\.app\/sso\?t=/);
});

test('a read-only role (VIEWER) cannot open Analyses from Core', async () => {
  const h = serverFor();
  const r = await call(h, { method: 'POST', path: '/api/core/analytics/open', role: 'VIEWER' });
  assert.equal(r.status, 403);
  assert.equal(r.body.url, undefined, 'no ticket for a read-only role');
});

test('the Analyses open does not open the door to writes: an ACCOUNTANT is still refused on a Core write', async () => {
  const h = serverFor();
  const r = await call(h, { method: 'POST', path: '/api/core/campaigns', role: 'ACCOUNTANT' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'FORBIDDEN_ROLE');
});

test('a request without a role is refused on the Analyses open', async () => {
  const h = serverFor();
  const r = await call(h, { method: 'POST', path: '/api/core/analytics/open', role: null });
  assert.equal(r.status, 403);
});
