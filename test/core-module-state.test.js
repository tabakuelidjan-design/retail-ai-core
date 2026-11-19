// Phase 6 - the module state shown by Core is the decision the open route takes for THIS role (no state that the API refuses).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { K_FINANCE, K_ANALYTICS } from './fixtures/sso-test-keys.js';

const M = 'merchant-module-state';
const ROLES = ['OWNER', 'ACCOUNTANT', 'VIEWER'];

function serverFor({ active = ['finance', 'analytics'] } = {}) {
  const core = createCoreHttp({
    runtime: null, store: {}, merchantId: M,
    finance: { source: 'test', inbox: async () => ({}) },
    analytics: { source: 'test' },
    financeSso: { publicUrl: 'https://finance.example.app', secret: K_FINANCE, merchantId: M },
    analyticsSso: { publicUrl: 'https://analytics.example.app', secret: K_ANALYTICS, merchantId: M },
    entitlements: async () => new Set(active),
  });
  const gate = {
    authorize: async (req) => ({ ok: true, access: { userId: 'u-' + req.headers['x-test-role'], role: req.headers['x-test-role'] } }),
    handle: async () => false,
  };
  return createSourcingApp({ gate, core, store: createMemoryStore(), uiDir: '.', coreDir: '.' }).handler;
}

async function req(handler, method, path, role) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}`, 'x-test-role': role }, body: method === 'GET' ? undefined : '{}' });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  } finally { await new Promise((r) => s.close(r)); }
}

for (const module of ['finance', 'analytics']) {
  for (const role of ROLES) {
    test(`${module} as ${role}: the state shown matches what the open route does`, async () => {
      const h = serverFor();
      const list = await req(h, 'GET', '/api/core/modules', role);
      const row = list.json.modules.find((m) => m.key === module);
      const open = await req(h, 'POST', `/api/core/${module}/open`, role);
      if (open.status === 200) {
        assert.equal(row.state, 'LECTURE SEULE', 'the open is allowed, so the state must not say reserved');
        assert.equal(row.dashboard, true);
      } else {
        assert.equal(row.state, 'ACCÈS RÉSERVÉ', `the open is refused (${open.status}), so the state must say reserved`);
        assert.equal(row.dashboard, false, 'no dashboard button for a role the open refuses');
      }
    });
  }
}

test('a module without an active entitlement is "NON ACTIVÉ" for every role, whatever the role', async () => {
  const h = serverFor({ active: [] });
  for (const role of ROLES) {
    const list = await req(h, 'GET', '/api/core/modules', role);
    assert.equal(list.json.modules.find((m) => m.key === 'finance').state, 'NON ACTIVÉ');
  }
});
