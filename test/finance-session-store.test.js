// Finance sessions survive a restart when a persistence is given; the file holds hashed ids only; logout/expiry still revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSessionPersistence, createSessionStore } from '../src/finance/server/session-store.js';
import { startApp } from './finance-dashboard-helpers.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fin-sessions-')), 'sessions.json');

test('without persistence it behaves like the previous Map (get/set/has/delete)', () => {
  const s = createSessionStore();
  s.set('abc', { csrf: 'x', expires: Date.now() + 1000 });
  assert.equal(s.has('abc'), true); assert.equal(s.get('abc').csrf, 'x');
  assert.equal(s.delete('abc'), true); assert.equal(s.has('abc'), false); assert.equal(s.get('abc'), undefined);
});

test('a new store on the same file sees the sessions (restart), and the file never contains a session id', async () => {
  const path = tmpFile();
  const a = createSessionStore({ persistence: createFileSessionPersistence(path) });
  a.set('secret-session-id-123', { csrf: 'c1', expires: Date.now() + 60_000 });
  await a.flush();
  const text = readFileSync(path, 'utf8');
  assert.ok(!text.includes('secret-session-id-123'), 'raw session id written to disk');
  const b = createSessionStore({ persistence: createFileSessionPersistence(path) });
  assert.equal(b.get('secret-session-id-123').csrf, 'c1');
  b.delete('secret-session-id-123'); await b.flush();
  const c = createSessionStore({ persistence: createFileSessionPersistence(path) });
  assert.equal(c.has('secret-session-id-123'), false, 'logout must revoke across restarts');
});

test('expired sessions are dropped on load; a missing or corrupt file starts empty without throwing', () => {
  const path = tmpFile();
  writeFileSync(path, JSON.stringify({ v: 1, sessions: [['k1', { csrf: 'a', expires: Date.now() - 1 }], ['k2', { csrf: 'b', expires: Date.now() + 60_000 }]] }));
  let now = Date.now();
  const s = createSessionStore({ persistence: createFileSessionPersistence(path), now: () => now });
  assert.equal(s.get('whatever'), undefined);
  assert.doesNotThrow(() => createSessionStore({ persistence: createFileSessionPersistence(join(tmpdir(), 'does-not-exist', 'x.json')) }));
  writeFileSync(path, '{not json');
  assert.doesNotThrow(() => createSessionStore({ persistence: createFileSessionPersistence(path) }));
});

test('end to end: signed in on one server, still signed in on a restarted server sharing the file; logout then revokes', async () => {
  const path = tmpFile();
  const first = await startApp({ deps: { sessionPersistence: createFileSessionPersistence(path) } });
  let c;
  try {
    c = await first.authed();
    assert.equal((await c.get('/api/session')).data.authenticated, true);
    await first.app.sessions.flush();
  } finally { await first.close(); }
  const second = await startApp({ deps: { sessionPersistence: createFileSessionPersistence(path) } });
  try {
    const moved = second.client(); moved.cookie = c.cookie; moved.csrf = c.csrf;
    const s = await moved.get('/api/session');
    assert.equal(s.data.authenticated, true); assert.equal(s.data.csrf, c.csrf);
    assert.equal((await moved.get('/api/settings')).status, 200);
    assert.equal((await moved.post('/api/logout', {})).status, 200);
    assert.equal((await moved.get('/api/session')).data.authenticated, false);
  } finally { await second.close(); }
});
