// Field V1 - server routes: the workspace (token, merge on a stale save, validation) and the merchant profile; the new core and UI files are served and listed in the offline shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createMemoryWorkspaceStore } from '../src/sourcing/store/workspace-store.js';
import { newWorkspace, setAskState } from '../src/sourcing/core/field/workspace.js';
import { PROFILE } from './sourcing-field-v1-fixtures.js';
import { fileURLToPath } from 'node:url';

const TOKEN = 'unit-test-token-0123456789-abcdef';
async function start({ withWs = true, profile = PROFILE } = {}) {
  const app = createSourcingApp({ token: TOKEN, store: createMemoryStore(), workspace: withWs ? createMemoryWorkspaceStore() : null, merchantProfile: profile, uiDir: fileURLToPath(new URL('../src/sourcing/ui/', import.meta.url)), coreDir: fileURLToPath(new URL('../src/sourcing/core/', import.meta.url)) });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = TOKEN } = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-sourcing-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, base, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

test('workspace routes need the token; a stale save is merged, never refused or lost; garbage is refused', async () => {
  const s = await start(); try {
    assert.equal((await s.call('/api/field/workspace', { token: null })).status, 401); assert.equal((await s.call('/api/field/workspace', { method: 'PUT', body: newWorkspace(), token: 'wrong-wrong-wrong-wrong-wrong' })).status, 401);
    const empty = await s.call('/api/field/workspace'); assert.equal(empty.status, 200); assert.equal(empty.body.schema, 1); assert.equal(empty.body.rev, 0);
    const a = setAskState(newWorkspace(), 'A', 'q1', 'ASKED', new Date('2026-10-20T10:00:00Z')); const b = setAskState(newWorkspace(), 'B', 'q2', 'ANSWERED', new Date('2026-10-20T10:05:00Z'));
    assert.equal((await s.call('/api/field/workspace', { method: 'PUT', body: a })).status, 200); const m = await s.call('/api/field/workspace', { method: 'PUT', body: b }); assert.equal(m.status, 200); assert.ok(m.body.askState.A.q1 && m.body.askState.B.q2, 'both devices survive'); assert.equal(m.body.rev, 2);
    for (const bad of [{}, { schema: 2 }, { schema: 1, comparisons: 'x', snapshots: {} }, null]) assert.equal((await s.call('/api/field/workspace', { method: 'PUT', body: bad })).status, 400);
  } finally { await s.close(); }
});

test('without a workspace store the route says so; the merchant profile is served to the phone (token) or reported absent', async () => {
  const s = await start({ withWs: false, profile: null }); try { assert.equal((await s.call('/api/field/workspace')).status, 503); assert.equal((await s.call('/api/field/merchant-profile')).status, 404); } finally { await s.close(); }
  const p = await start(); try { const r = await p.call('/api/field/merchant-profile'); assert.equal(r.status, 200); assert.equal(r.body.merchantId, 'habb'); assert.equal((await p.call('/api/field/merchant-profile', { token: null })).status, 401); } finally { await p.close(); }
});

test('the Field V1 files are served (whitelisted folders only) and listed in the offline shell manifest', async () => {
  const s = await start(); try {
    for (const f of ['/core/field/offer-import.js', '/core/field/derived.js', '/core/field/workspace.js', '/core/field/engine.js', '/screens/salon.js', '/screens/salon-views.js', '/salon.css']) assert.equal((await fetch(s.base + f)).status, 200, f);
    assert.equal((await fetch(s.base + '/core/field/..%2f..%2fserver%2fapp.js')).status, 404);
    assert.equal((await fetch(s.base + '/core/field/nested/x.js')).status, 404); assert.equal((await fetch(s.base + '/config/merchants/habb/sourcing-fit.json')).status, 404, 'the merchant data file is not a static asset: it is served only through the token route');
    const man = await (await fetch(s.base + '/shell-manifest.json')).json(); for (const f of ['/core/field/engine.js', '/core/field/revisions.js', '/screens/salon.js', '/screens/salon-fr.js', '/salon.css']) assert.ok(man.files.includes(f), `${f} must be cached for offline use`);
  } finally { await s.close(); }
});
