// /api/session?include=settings: the startup call carries the settings for a signed-in browser (one round trip instead of two),
// never for an anonymous caller; without the parameter the session answer is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp } from './finance-dashboard-helpers.js';

test('anonymous: include=settings never leaks the settings', async () => {
  const h = await startApp();
  try {
    const r = await h.client().get('/api/session?include=settings');
    assert.equal(r.status, 200); assert.deepEqual(r.data, { authenticated: false });
  } finally { await h.close(); }
});

test('signed in: without the parameter the answer is unchanged; with it, settings equal GET /api/settings exactly', async () => {
  const h = await startApp();
  try {
    const c = await h.authed();
    const plain = await c.get('/api/session');
    assert.deepEqual(Object.keys(plain.data).sort(), ['authenticated', 'csrf']);
    const boot = await c.get('/api/session?include=settings');
    assert.equal(boot.data.authenticated, true); assert.equal(boot.data.csrf, plain.data.csrf);
    assert.deepEqual(boot.data.settings, (await c.get('/api/settings')).data);
    assert.equal(boot.headers.get('cache-control'), 'no-store');
  } finally { await h.close(); }
});

test('the dashboard boots with one session+settings request (no separate /api/settings call at startup)', () => {
  const app = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8');
  const route = app.slice(app.indexOf('async function route()'), app.indexOf('async function route()') + 600);
  assert.match(route, /api\('GET', '\/api\/session\?include=settings'\)/);
  assert.match(route, /loadSettings\(s\.settings\)/);
});
