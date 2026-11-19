// Phase 2 - a refused request can be explained from its requestId, and the journal never holds a secret.
// Full Core server; the session gate is a fake that returns the role of the request (x-test-role), or 401 without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createAccessJournal } from '../src/sourcing/server/access-journal.js';
import { K_FINANCE, K_ANALYTICS } from './fixtures/sso-test-keys.js';

const M = 'merchant-refusal-journal';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-journal-'));
  const journal = createAccessJournal({ file: join(dir, 'access-journal.jsonl') });
  const core = createCoreHttp({
    runtime: null, store: {}, merchantId: M,
    financeSso: { publicUrl: 'https://finance.example.app', secret: K_FINANCE, merchantId: M },
    analyticsSso: { publicUrl: 'https://analytics.example.app', secret: K_ANALYTICS, merchantId: M },
    entitlements: async () => new Set(['finance', 'analytics']),
  });
  const gate = {
    authorize: async (req) => {
      const role = req.headers['x-test-role'];
      if (!role) return { ok: false, status: 401, body: { error: 'SESSION_INVALID', message: 'Votre session n’est plus valide.' } };
      return { ok: true, access: { userId: 'user-' + role + '-raw-id', role } };
    },
    handle: async () => false,
  };
  const handler = createSourcingApp({ gate, core, store: createMemoryStore(), uiDir: '.', coreDir: '.', accessJournal: journal }).handler;
  return { handler, journal, cleanup: () => rmSync(dir, { recursive: true, force: true }), file: join(dir, 'access-journal.jsonl') };
}

async function call(handler, { method = 'GET', path, role, headers = {} }) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    const h = { 'content-type': 'application/json', host: `127.0.0.1:${port}`, ...headers };
    if (role) h['x-test-role'] = role;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: h, body: method === 'GET' ? undefined : '{}' });
    const text = await res.text();
    return { status: res.status, headerId: res.headers.get('x-request-id'), body: text ? JSON.parse(text) : {} };
  } finally { await new Promise((r) => s.close(r)); }
}

test('a refused write returns a requestId in the header and the body, and is journaled with its code and role', async () => {
  const f = fixture();
  try {
    const r = await call(f.handler, { method: 'POST', path: '/api/core/campaigns', role: 'VIEWER' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'FORBIDDEN_ROLE');
    assert.ok(r.body.requestId, 'the body carries the requestId');
    assert.equal(r.body.requestId, r.headerId, 'the header and the body name the same request');
    const [entry] = f.journal.read({ requestId: r.body.requestId });
    assert.equal(entry.status, 403);
    assert.equal(entry.code, 'FORBIDDEN_ROLE');
    assert.equal(entry.role, 'VIEWER');
    assert.equal(entry.path, '/api/core/campaigns');
  } finally { f.cleanup(); }
});

test('an unauthenticated refusal (401 from the session gate) is journaled with no role', async () => {
  const f = fixture();
  try {
    const r = await call(f.handler, { path: '/api/core/status' });
    assert.equal(r.status, 401);
    const [entry] = f.journal.read({ requestId: r.body.requestId });
    assert.equal(entry.code, 'SESSION_INVALID');
    assert.equal(entry.role, null);
  } finally { f.cleanup(); }
});

test('the journal never holds a secret, a cookie, a query string, the raw user id or the client address', async () => {
  const f = fixture();
  try {
    await call(f.handler, {
      method: 'POST', path: '/api/core/campaigns?t=SECRET-TOKEN-123', role: 'VIEWER',
      headers: { cookie: '__Host-nordla_sourcing_sid=COOKIE-SECRET-456; __Host-nordla_sourcing_csrf=CSRF-SECRET-789' },
    });
    const text = readFileSync(f.file, 'utf8');
    for (const forbidden of ['SECRET-TOKEN-123', 'COOKIE-SECRET-456', 'CSRF-SECRET-789', 'user-VIEWER-raw-id', '127.0.0.1', '?t=']) {
      assert.equal(text.includes(forbidden), false, `journal contains ${forbidden}`);
    }
    const entry = JSON.parse(text.trim().split('\n').at(-1));
    assert.match(entry.actor, /^[0-9a-f]{12}$/, 'the user is referred to by a short hash');
  } finally { f.cleanup(); }
});

test('the refusals route is owner-only: an owner reads the entry of a requestId, an accountant is refused and that refusal is journaled', async () => {
  const f = fixture();
  try {
    const refused = await call(f.handler, { method: 'POST', path: '/api/core/campaigns', role: 'VIEWER' });
    const owner = await call(f.handler, { path: `/api/core/refusals?requestId=${refused.body.requestId}`, role: 'OWNER' });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.entries.length, 1);
    assert.equal(owner.body.entries[0].code, 'FORBIDDEN_ROLE');
    const accountant = await call(f.handler, { path: '/api/core/refusals', role: 'ACCOUNTANT' });
    assert.equal(accountant.status, 403);
    assert.equal(accountant.body.entries, undefined, 'no journal content for a non-owner');
    const denied = f.journal.read({ requestId: accountant.body.requestId });
    assert.equal(denied[0].path, '/api/core/refusals');
  } finally { f.cleanup(); }
});

test('a successful response is not changed: no requestId is added to a 200 body', async () => {
  const f = fixture();
  try {
    const r = await call(f.handler, { path: '/api/core/status', role: 'OWNER' });
    assert.equal(r.status < 400, true);
    assert.equal('requestId' in r.body, false);
    assert.ok(r.headerId, 'the header is still there on every response');
  } finally { f.cleanup(); }
});
