// Phase 1b - characterization of the CURRENT permission behaviour of every Core route, for every role.
// It records the HTTP status each (method, route, role) gets today, and fails if any status changes.
// It changes no behaviour: it freezes what the server does now, so the permission matrix (phase 1c) can be refactored safely.
// Regenerate the reference ONLY on purpose: CHARACTERIZE_WRITE=1 node --test test/core-permission-characterization.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { K_FINANCE, K_ANALYTICS } from './fixtures/sso-test-keys.js';

const SNAPSHOT = fileURLToPath(new URL('./fixtures/core-permission-snapshot.json', import.meta.url));
const M = 'merchant-characterization';
const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'COLLABORATOR', 'VIEWER', 'none'];
// Every Core route known today (src/core-pilot/http.js) plus the gated write route used as a control.
const ROUTES = [
  ['GET', '/api/core/status'], ['GET', '/api/core/modules'], ['GET', '/api/core/decisions'],
  ['GET', '/api/core/branding'], ['POST', '/api/core/branding/check'], ['POST', '/api/core/branding/approve'],
  ['GET', '/api/core/campaigns'], ['POST', '/api/core/campaigns'],
  ['GET', '/api/core/creation'], ['POST', '/api/core/creation'],
  ['GET', '/api/core/finance/inbox'], ['POST', '/api/core/finance/open'],
  ['POST', '/api/core/analytics/open'], ['POST', '/api/core/growth/open'],
  ['POST', '/api/core/ask'], ['POST', '/api/safety/check'],
  ['POST', '/api/core/decisions'], ['POST', '/api/core/unknown-route'],
];

function serverFor() {
  const core = createCoreHttp({
    runtime: null, store: {}, merchantId: M,
    financeSso: { publicUrl: 'https://finance.example.app', secret: K_FINANCE, merchantId: M },
    analyticsSso: { publicUrl: 'https://analytics.example.app', secret: K_ANALYTICS, merchantId: M },
    entitlements: async () => new Set(['finance', 'analytics', 'growth', 'sourcing']),
  });
  const gate = {
    authorize: async (req) => {
      const role = req.headers['x-test-role'];
      return { ok: true, access: { userId: 'u-' + role, role: role === 'none' ? null : role } };
    },
    handle: async () => false,
  };
  return createSourcingApp({ gate, core, store: createMemoryStore(), uiDir: '.', coreDir: '.' }).handler;
}

async function statusOf(handler, method, path, role) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}`, 'x-test-role': role },
      body: method === 'GET' ? undefined : '{}',
    });
    await res.text();
    return res.status;
  } finally { await new Promise((r) => s.close(r)); }
}

async function currentTable() {
  const h = serverFor();
  const table = {};
  for (const [method, path] of ROUTES) {
    for (const role of ROLES) table[`${method} ${path} ${role}`] = await statusOf(h, method, path, role);
  }
  return table;
}

test('characterization: the permission behaviour of every Core route and role is unchanged', async () => {
  const now = await currentTable();
  if (process.env.CHARACTERIZE_WRITE === '1') {
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + '\n');
    return;
  }
  const reference = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const changed = Object.keys({ ...reference, ...now }).filter((k) => reference[k] !== now[k])
    .map((k) => `${k}: was ${reference[k]}, now ${now[k]}`);
  assert.deepEqual(changed, [], 'permission behaviour changed');
});
