// Finance merchant context: bound SERVER-SIDE to the authenticated Core session. A ticket for another merchant never opens a
// session; a session carries the merchant it was opened for and is re-checked on every request; no query parameter picks a merchant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket } from '../src/finance/sso-ticket.js';
import { startApp } from './finance-dashboard-helpers.js';
import { K_FINANCE } from './fixtures/sso-test-keys.js';

const SECRET = K_FINANCE;
const HABB = 'merchant-habb-test';
const OTHER = 'merchant-other-test';
const PERSON = { userId: '5c2f4d6e-ea34-452d-8107-0197a3eb54da', role: 'OWNER', module: 'finance' };
const sidOf = (cookie) => cookie.split(';')[0].replace(/^fin_sid=/, '');

async function openApp() {
  return startApp({ merchantId: HABB, deps: { sso: { secret: SECRET, checkAccess: async () => ({ ok: true, role: 'OWNER' }) } } });
}

test('a Core ticket for ANOTHER merchant never opens a session on the HABB server (403, no cookie)', async () => {
  const a = await openApp();
  try {
    const t = issueTicket({ secret: SECRET, merchantId: OTHER, person: PERSON });
    const r = await fetch(`${a.base}/sso?t=${encodeURIComponent(t)}`, { redirect: 'manual' });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('set-cookie'), null);
  } finally { await a.server.close(); }
});

test('a HABB session is bound to the merchant it was opened for, and works for that merchant only', async () => {
  const a = await openApp();
  try {
    const t = issueTicket({ secret: SECRET, merchantId: HABB, person: PERSON });
    const ok = await fetch(`${a.base}/sso?t=${encodeURIComponent(t)}`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const session = a.app.sessions.get(sidOf(cookie));
    assert.equal(session.sso.merchantId, HABB, 'the session records its merchant on the server');
    const me = await fetch(`${a.base}/api/session?include=settings`, { headers: { Cookie: cookie } }); // confirms the session (the explicit start)
    assert.equal(me.status, 200);
  } finally { await a.server.close(); }
});

test('a session whose merchant does not match this server is refused, on every request (no data)', async () => {
  const a = await openApp();
  try {
    const sid = 'a'.repeat(64);
    a.app.sessions.set(sid, { csrf: 'c'.repeat(48), expires: Date.now() + 60_000, sso: { userId: PERSON.userId, role: 'OWNER', merchantId: OTHER } });
    const r = await fetch(`${a.base}/api/documents`, { headers: { Cookie: `fin_sid=${sid}` } });
    assert.ok(r.status === 401 || r.status === 403, `refused, got ${r.status}`);
    const again = await fetch(`${a.base}/api/documents`, { headers: { Cookie: `fin_sid=${sid}` } });
    assert.ok(again.status === 401 || again.status === 403, 'and it stays refused on the next request (never served for another merchant)');
  } finally { await a.server.close(); }
});

test('no query parameter can choose another merchant (merchantId, merchant, tenant are ignored)', async () => {
  const a = await openApp();
  try {
    const t = issueTicket({ secret: SECRET, merchantId: HABB, person: PERSON });
    const ok = await fetch(`${a.base}/sso?t=${encodeURIComponent(t)}`, { redirect: 'manual' });
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    await fetch(`${a.base}/api/session?include=settings`, { headers: { Cookie: cookie } }); // confirm
    const r = await fetch(`${a.base}/api/documents?merchantId=${OTHER}&merchant=${OTHER}&tenant=${OTHER}`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(!body.includes(OTHER), 'the other merchant id never appears in the answer');
  } finally { await a.server.close(); }
});
