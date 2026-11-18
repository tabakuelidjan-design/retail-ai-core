// Phase 2 - Nordla SSO contract v2 (identity/sso-contract.js + finance/sso-ticket.js + core-pilot/http.js).
// The service re-checks the person's CURRENT access at USE time; refusals are named; tickets are single use and per merchant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket, createTicketVerifier, ANALYTICS_SSO_AUDIENCE, SSO_AUDIENCE } from '../src/finance/sso-ticket.js';
import { createAccessChecker, SSO_CONTRACT } from '../src/identity/sso-contract.js';
import { createCoreHttp } from '../src/core-pilot/http.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const OTHER = '7e570000-0000-4000-8000-000000000001';
const SECRET = 'a'.repeat(40);
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';

// A tiny in-memory stand-in for the Supabase REST reader (only select with eq filters is used by the checker).
function fakeDb({ members = [], entitlements = [], fail = false } = {}) {
  const calls = [];
  const eqOf = (v) => String(v ?? '').replace(/^eq\./, '');
  return {
    calls,
    select: async (table, q) => {
      calls.push({ table, q });
      if (fail) throw new Error('db down');
      if (table === 'merchant_members') return members.filter((r) => r.merchant_id === eqOf(q.merchant_id) && r.user_id === eqOf(q.user_id));
      return entitlements.filter((r) => r.merchant_id === eqOf(q.merchant_id) && r.module_code === eqOf(q.module_code));
    },
  };
}
const member = (over = {}) => ({ merchant_id: M, user_id: U, role: 'OWNER', status: 'ACTIVE', removed_at: null, ...over });
const ent = (over = {}) => ({ merchant_id: M, module_code: 'finance', status: 'ACTIVE', ...over });
const activeDb = (extra = {}) => fakeDb({ members: [member()], entitlements: [ent()], ...extra });

function verifierFor(db, { module = 'finance', audience = SSO_AUDIENCE, merchantId = M, now = () => Date.now() } = {}) {
  return createTicketVerifier({ secret: SECRET, merchantId, audience, module, requirePerson: true, checkAccess: createAccessChecker({ supabase: db, merchantId }), now });
}
const ticket = ({ role = 'OWNER', userId = U, module = 'finance', merchantId = M, audience = SSO_AUDIENCE } = {}) =>
  issueTicket({ secret: SECRET, merchantId, audience, person: { userId, role, module } });

test('contract: version 2, issuer nordla-core, one audience per module, 60 s default, 120 s maximum', () => {
  assert.equal(SSO_CONTRACT.version, 2); assert.equal(SSO_CONTRACT.issuer, 'nordla-core');
  assert.deepEqual(SSO_CONTRACT.audienceOf, { finance: 'nordla-finance', analytics: 'nordla-analytics' });
  assert.equal(SSO_CONTRACT.ticketTtlSeconds, 60); assert.equal(SSO_CONTRACT.maxTtlSeconds, 120);
});

test('happy path: an OWNER with an ACTIVE membership and entitlement opens Finance; the claims name the person and the module', async () => {
  const r = await verifierFor(activeDb()).verifyAsync(ticket());
  assert.equal(r.ok, true); assert.deepEqual(r.claims, { userId: U, role: 'OWNER', module: 'finance' });
});

test('ticket without person claims (contract v1) is refused where a person is required: no anonymous access', async () => {
  const v1 = issueTicket({ secret: SECRET, merchantId: M });
  assert.equal((await verifierFor(activeDb()).verifyAsync(v1)).code, 'SSO_NO_PERSON');
});

test('a ticket for another module is refused (SSO_WRONG_MODULE)', async () => {
  const t = ticket({ module: 'analytics' });
  assert.equal((await verifierFor(activeDb()).verifyAsync(t)).code, 'SSO_WRONG_MODULE');
});

test('a suspended member is refused at use time (MEMBER_SUSPENDED), even with a valid ticket', async () => {
  const db = fakeDb({ members: [member({ status: 'SUSPENDED' })], entitlements: [ent()] });
  assert.equal((await verifierFor(db).verifyAsync(ticket())).code, 'MEMBER_SUSPENDED');
});

test('a removed member is refused (NOT_MEMBER), whatever their status column says', async () => {
  const db = fakeDb({ members: [member({ removed_at: '2026-11-18T10:00:00Z' })], entitlements: [ent()] });
  assert.equal((await verifierFor(db).verifyAsync(ticket())).code, 'NOT_MEMBER');
});

test('a role changed after issuance is refused (ROLE_CHANGED): the ticket cannot keep an old role', async () => {
  const db = fakeDb({ members: [member({ role: 'ADMIN' })], entitlements: [ent()] });
  assert.equal((await verifierFor(db).verifyAsync(ticket({ role: 'OWNER' }))).code, 'ROLE_CHANGED');
});

test('no ACTIVE entitlement for the module is refused (MODULE_NOT_ENABLED), whether absent or suspended', async () => {
  assert.equal((await verifierFor(fakeDb({ members: [member()] })).verifyAsync(ticket())).code, 'MODULE_NOT_ENABLED');
  const suspended = fakeDb({ members: [member()], entitlements: [ent({ status: 'SUSPENDED' })] });
  assert.equal((await verifierFor(suspended).verifyAsync(ticket())).code, 'MODULE_NOT_ENABLED');
});

test('a VIEWER does not open Finance (MODULE_ROLE_FORBIDDEN); an ACCOUNTANT opens Analyses', async () => {
  const viewer = fakeDb({ members: [member({ role: 'VIEWER' })], entitlements: [ent()] });
  assert.equal((await verifierFor(viewer).verifyAsync(ticket({ role: 'VIEWER' }))).code, 'MODULE_ROLE_FORBIDDEN');
  const acc = fakeDb({ members: [member({ role: 'ACCOUNTANT' })], entitlements: [ent({ module_code: 'analytics' })] });
  assert.equal((await verifierFor(acc, { module: 'analytics', audience: ANALYTICS_SSO_AUDIENCE }).verifyAsync(ticket({ role: 'ACCOUNTANT', module: 'analytics', audience: ANALYTICS_SSO_AUDIENCE }))).ok, true);
});

test('isolation: a membership of ANOTHER merchant never counts for this merchant', async () => {
  const db = fakeDb({ members: [member({ merchant_id: OTHER })], entitlements: [ent()] });
  assert.equal((await verifierFor(db).verifyAsync(ticket())).code, 'NOT_MEMBER');
  // the reads are scoped to this merchant
  assert.ok(db.calls.every((c) => c.q.merchant_id === `eq.${M}`));
});

test('isolation: a ticket issued for another merchant is refused before any access read', async () => {
  const db = activeDb();
  assert.equal((await verifierFor(db).verifyAsync(ticket({ merchantId: OTHER }))).code, 'SSO_WRONG_MERCHANT');
  assert.equal(db.calls.length, 0, 'no database read for a ticket of another merchant');
});

test('a ticket is single use, even when the access check passes', async () => {
  const v = verifierFor(activeDb()); const t = ticket();
  assert.equal((await v.verifyAsync(t)).ok, true);
  assert.equal((await v.verifyAsync(t)).code, 'SSO_REPLAYED');
});

test('a failing database read refuses (SSO_ACCESS_UNAVAILABLE): default deny, never a guess', async () => {
  assert.equal((await verifierFor(fakeDb({ fail: true })).verifyAsync(ticket())).code, 'SSO_ACCESS_UNAVAILABLE');
});

test('a forged or expired ticket is refused before any access read', async () => {
  const db = activeDb(); const v = verifierFor(db);
  const t = ticket(); const forged = t.slice(0, -2) + (t.endsWith('A') ? 'B' : 'A');
  assert.equal((await v.verifyAsync(forged)).code, 'SSO_BAD_SIGNATURE');
  const old = verifierFor(db, { now: () => Date.now() + 10 * 60_000 });
  assert.equal((await old.verifyAsync(ticket())).code, 'SSO_EXPIRED');
  assert.equal(db.calls.length, 0);
});

test('Core issues the ticket only for a signed-in person, with their role and module (409 without a person)', async () => {
  const SSO = { publicUrl: 'https://finance-staging-staging.up.railway.app', secret: SECRET, merchantId: M };
  const core = createCoreHttp({ runtime: null, store: {}, merchantId: M, finance: { source: 'test', inbox: async () => ({}) }, financeSso: SSO, entitlements: async () => new Set(['finance']) });
  const call = async (actor) => {
    const chunks = []; let status = 0;
    const req = { method: 'POST', url: '/api/core/finance/open', headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); } };
    await core.handle(req, { writeHead(s) { status = s; }, setHeader() {}, end(b) { chunks.push(String(b)); } }, new URL('http://x/api/core/finance/open'), actor);
    return { status, body: JSON.parse(chunks.join('') || '{}') };
  };
  assert.equal((await call({ role: 'OWNER' })).status, 409, 'no person, no ticket');
  const ok = await call({ role: 'OWNER', userId: U });
  assert.equal(ok.status, 200);
  const t = new URL(ok.body.url).searchParams.get('t');
  const r = await verifierFor(activeDb()).verifyAsync(t);
  assert.equal(r.ok, true, 'the service accepts the Core ticket for the same person and merchant');
  assert.equal(r.claims.userId, U);
});
