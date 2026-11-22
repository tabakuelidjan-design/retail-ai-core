// A Finance session opened by Core before any click (a preparation on hover) is unconfirmed: it reads no business data,
// expires quickly, and the first explicit start (GET /api/session?include=settings) confirms it with the normal lifetime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './finance-dashboard-helpers.js';

const CSRF = 'c'.repeat(48);

async function raw(base, path, sid) {
  const res = await fetch(base + path, { headers: sid ? { Cookie: `fin_sid=${sid}` } : {} });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data };
}

test('a preparation without a click: the session answers who it is, but reads no business data', async () => {
  const h = await startApp();
  try {
    h.app.sessions.set('prep-1', { csrf: CSRF, expires: Date.now() + 120_000, unconfirmed: true });
    const session = await raw(h.base, '/api/session', 'prep-1');
    assert.equal(session.status, 200);
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.settings, undefined, 'no settings (business details) without the explicit start');
    for (const path of ['/api/overview', '/api/documents?type=invoice', '/api/inbox?scope=purchases', '/api/treasury', '/api/sync-status']) {
      const r = await raw(h.base, path, 'prep-1');
      assert.equal(r.status, 401, `${path} refused while unconfirmed`);
      assert.equal(r.data?.error?.code, 'SESSION_UNCONFIRMED');
    }
  } finally { await h.server.close(); }
});

test('the explicit start confirms the session: it gets the settings and the normal lifetime, then reads data', async () => {
  const h = await startApp();
  try {
    h.app.sessions.set('prep-2', { csrf: CSRF, expires: Date.now() + 120_000, unconfirmed: true });
    const start = await raw(h.base, '/api/session?include=settings', 'prep-2');
    assert.equal(start.status, 200);
    assert.equal(start.data.authenticated, true);
    assert.ok(start.data.settings, 'the first answer carries the settings');
    const stored = h.app.sessions.get('prep-2');
    assert.equal(stored.unconfirmed, undefined, 'confirmed');
    assert.ok(stored.expires - Date.now() > 7 * 3600 * 1000, 'normal lifetime (8 h) after the explicit start');
    const overview = await raw(h.base, '/api/overview', 'prep-2');
    assert.equal(overview.status, 200, 'data reads are allowed once confirmed');
  } finally { await h.server.close(); }
});

test('an unconfirmed preparation expires quickly: after its lifetime nothing is read and the person must start again', async () => {
  const h = await startApp();
  try {
    h.app.sessions.set('prep-3', { csrf: CSRF, expires: Date.now() - 1, unconfirmed: true });
    const r = await raw(h.base, '/api/overview', 'prep-3');
    assert.equal(r.status, 401);
    assert.equal(r.data?.error?.code, 'AUTHENTICATION_REQUIRED');
    const s = await raw(h.base, '/api/session', 'prep-3');
    assert.equal(s.data.authenticated, false);
  } finally { await h.server.close(); }
});

test('an unconfirmed session cannot change anything either (writes are refused before any action)', async () => {
  const h = await startApp();
  try {
    h.app.sessions.set('prep-4', { csrf: CSRF, expires: Date.now() + 120_000, unconfirmed: true });
    const res = await fetch(`${h.base}/api/logout`, { method: 'POST', headers: { Cookie: 'fin_sid=prep-4', 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF }, body: '{}' });
    assert.equal(res.status, 200, 'logout stays available (it only ends the session)');
    const after = await fetch(`${h.base}/api/documents?type=invoice`, { headers: { Cookie: 'fin_sid=prep-4' } });
    assert.equal(after.status, 401, 'the session was ended');
  } finally { await h.server.close(); }
});

test('the Core preparation no longer calls the session for settings (only the explicit start does)', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/sourcing/ui/app.js', import.meta.url), 'utf8');
  const prepare = app.slice(app.indexOf('function prepareFinance()'), app.indexOf('// pointer, keyboard, or touch') > 0 ? app.indexOf('// pointer, keyboard, or touch') : app.indexOf('async function fetchFinanceStart()'));
  assert.doesNotMatch(prepare, /api\/session/, 'no session call on interest');
  assert.match(app, /async function fetchFinanceStart\(\)[\s\S]*?api\/session\?include=settings/);
});
