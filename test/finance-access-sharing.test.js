// The per-request access re-check: simultaneous requests of the SAME session, merchant and module share one check while it runs;
// nothing is kept after it ends; a revoked right is refused on the next request; no secret, cookie or ticket reaches the logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './finance-dashboard-helpers.js';

import { randomBytes } from 'node:crypto';
const SECRET = randomBytes(32).toString('base64url'); // a valid SSO key (32 random bytes), made for this test only

/** A Finance app whose SSO access check is counted and can be slowed, so simultaneous requests really overlap. */
async function withCountingAccess(decide = async () => ({ ok: true, role: 'OWNER' }), delayMs = 60) {
  const calls = [];
  const h = await startApp({ deps: { sso: { secret: SECRET, requirePerson: false, checkAccess: async (args) => { calls.push(args); await new Promise((r) => setTimeout(r, delayMs)); return decide(args); } } } });
  const open = (sid, userId = 'user-1', role = 'OWNER') => h.app.sessions.set(sid, { csrf: 'c'.repeat(48), expires: Date.now() + 3600_000, sso: { userId, role } });
  const get = (sid) => fetch(`${h.base}/api/overview`, { headers: { Cookie: `fin_sid=${sid}` } });
  return { h, calls, open, get };
}

test('simultaneous requests of the same session share one access check', async () => {
  const { h, calls, open, get } = await withCountingAccess();
  try {
    open('same-1');
    const answers = await Promise.all(Array.from({ length: 5 }, () => get('same-1')));
    assert.ok(answers.every((r) => r.status === 200), 'all five are served');
    assert.equal(calls.length, 1, 'one check for five simultaneous requests');
  } finally { await h.server.close(); }
});

test('two different sessions never share a check', async () => {
  const { h, calls, open, get } = await withCountingAccess();
  try {
    open('sess-a', 'user-a'); open('sess-b', 'user-b');
    await Promise.all([get('sess-a'), get('sess-a'), get('sess-b'), get('sess-b')]);
    assert.equal(calls.length, 2, 'one check per session');
    assert.deepEqual(calls.map((c) => c.userId).sort(), ['user-a', 'user-b']);
  } finally { await h.server.close(); }
});

test('the shared check is keyed by merchant and module too (the key includes both)', async () => {
  const { readFile } = await import('node:fs/promises');
  const fin = await readFile(new URL('../src/finance/server/app.js', import.meta.url), 'utf8');
  assert.match(fin, /createHash\('sha256'\)\.update\(`\$\{openedSid\}\|\$\{merchantId\}\|finance`\)/);
  assert.match(fin, /const sharedAccess = \(key, fn\) => \{ const running = inFlightAccess\.get\(key\); if \(running\) return running;/);
  assert.match(fin, /finally \{ inFlightAccess\.delete\(key\); \}/, 'removed when it ends, success or failure');
});

test('once the check has ended, the next request checks again; a revoked right is refused at once', async () => {
  let revoked = false;
  const { h, calls, open, get } = await withCountingAccess(async () => (revoked ? { ok: false } : { ok: true, role: 'OWNER' }), 5);
  try {
    open('later-1');
    assert.equal((await get('later-1')).status, 200);
    assert.equal((await get('later-1')).status, 200);
    assert.equal(calls.length, 2, 'a check after each completed one: nothing is kept');
    revoked = true;
    const after = await get('later-1');
    assert.equal(after.status, 401, 'the revoked right closes the session on the next request');
    assert.equal(calls.length, 3);
  } finally { await h.server.close(); }
});

test('an error in the access check refuses the request (never a silent pass)', async () => {
  const h = await startApp({ deps: { sso: { secret: SECRET, requirePerson: false, checkAccess: async () => { throw new Error('upstream down'); } } } });
  try {
    h.app.sessions.set('err-1', { csrf: 'c'.repeat(48), expires: Date.now() + 3600_000, sso: { userId: 'u', role: 'OWNER' } });
    const r = await fetch(`${h.base}/api/overview`, { headers: { Cookie: 'fin_sid=err-1' } });
    assert.equal(r.status, 401);
  } finally { await h.server.close(); }
});

test('no secret, cookie or ticket is written to the logs during access checks', async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? '')).join(' ')); };
  const { h, open, get } = await withCountingAccess(async () => ({ ok: false }), 5);
  try {
    const sid = 'log-probe-cookie-value-0123456789';
    open(sid);
    await Promise.all([get(sid), get(sid)]);
    const text = logged.join('\n');
    assert.ok(!text.includes(sid), 'the session value is not logged');
    assert.ok(!text.includes(SECRET), 'the secret is not logged');
    assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}/, 'no ticket is logged');
  } finally {
    for (const k of Object.keys(orig)) console[k] = orig[k];
    await h.server.close();
  }
});
