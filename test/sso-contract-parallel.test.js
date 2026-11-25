// Access check (identity/sso-contract.js) - concurrency and refusal order. The served behaviour is the reference:
// same answers as the sequential version, the independent reads overlap, and nothing is cached (every use reads again).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessChecker } from '../src/identity/sso-contract.js';
import { createSessionAssurance } from '../src/identity/session-assurance.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';
const member = (over = {}) => ({ merchant_id: M, user_id: U, role: 'OWNER', status: 'ACTIVE', removed_at: null, ...over });
const ent = (over = {}) => ({ merchant_id: M, module_code: 'analytics', status: 'ACTIVE', ...over });

// Reader with a fixed delay per read: lets the test see whether two reads are in flight at the same time.
function delayedDb({ members = [member()], entitlements = [ent()], mfa = { required: false, privileged: false, compliant: true }, delayMs = 20, failTable = null, noRpc = false, sessions = [] } = {}) {
  const calls = []; let inFlight = 0; let maxInFlight = 0;
  const eqOf = (v) => String(v ?? '').replace(/^eq\./, '');
  const timed = async (name, fn) => { calls.push(name); inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); try { await new Promise((r) => setTimeout(r, delayMs)); return fn(); } finally { inFlight -= 1; } };
  const db = {
    calls, get maxInFlight() { return maxInFlight; },
    select: (table, q) => timed(table, () => {
      if (table === failTable) throw new Error('db down');
      if (table === 'merchant_members') return members.filter((r) => r.merchant_id === eqOf(q.merchant_id) && r.user_id === eqOf(q.user_id));
      if (table === 'module_entitlements') return entitlements.filter((r) => r.merchant_id === eqOf(q.merchant_id) && r.module_code === eqOf(q.module_code));
      if (table === 'app_sessions') return sessions;
      return [];
    }),
  };
  if (!noRpc) db.rpc = (name) => timed(`rpc:${name}`, () => mfa);
  return db;
}
const check = (db, extra = {}) => createAccessChecker({ supabase: db, merchantId: M, ...extra });
const input = (over = {}) => ({ merchantId: M, userId: U, role: 'OWNER', module: 'analytics', ...over });

test('the membership and entitlement reads overlap (both in flight at once), and an active member is allowed', async () => {
  const db = delayedDb();
  const r = await check(db)(input());
  assert.deepEqual(r, { ok: true, role: 'OWNER' });
  assert.ok(db.maxInFlight >= 2, `expected overlapping reads, saw max ${db.maxInFlight}`);
});

test('refusal order is kept: a removed member is NOT_MEMBER even though the entitlement is active', async () => {
  assert.equal((await check(delayedDb({ members: [member({ removed_at: '2026-11-01T00:00:00Z' })] }))(input())).code, 'NOT_MEMBER');
});

test('refusal order is kept: a suspended member is MEMBER_SUSPENDED, a changed role is ROLE_CHANGED', async () => {
  assert.equal((await check(delayedDb({ members: [member({ status: 'SUSPENDED' })] }))(input())).code, 'MEMBER_SUSPENDED');
  assert.equal((await check(delayedDb({ members: [member({ role: 'ADMIN' })] }))(input({ role: 'OWNER' }))).code, 'ROLE_CHANGED');
});

test('refusal order is kept: no active entitlement is MODULE_NOT_ENABLED', async () => {
  assert.equal((await check(delayedDb({ entitlements: [ent({ status: 'SUSPENDED' })] }))(input())).code, 'MODULE_NOT_ENABLED');
});

test('a failed membership read denies (SSO_ACCESS_UNAVAILABLE), never a guess', async () => {
  assert.equal((await check(delayedDb({ failTable: 'merchant_members' }))(input())).code, 'SSO_ACCESS_UNAVAILABLE');
});

test('a non-member is still refused as NOT_MEMBER when the entitlement read fails (the refusal comes from the membership)', async () => {
  const db = delayedDb({ members: [], failTable: 'module_entitlements' });
  assert.equal((await check(db)(input())).code, 'NOT_MEMBER');
});

test('an active member whose entitlement read fails is denied (SSO_ACCESS_UNAVAILABLE)', async () => {
  assert.equal((await check(delayedDb({ failTable: 'module_entitlements' }))(input())).code, 'SSO_ACCESS_UNAVAILABLE');
});

test('MFA: an OWNER without a verified second factor is refused (MFA_REQUIRED_FOR_ROLE) when the rule requires it', async () => {
  const db = delayedDb({ mfa: { required: true, privileged: true, compliant: false } });
  assert.equal((await check(db)(input())).code, 'MFA_REQUIRED_FOR_ROLE');
});

test('MFA: no MFA reader at all is MFA_POLICY_UNAVAILABLE (default deny)', async () => {
  assert.equal((await check(delayedDb({ noRpc: true }))(input())).code, 'MFA_POLICY_UNAVAILABLE');
});

test('assurance refusal wins over an MFA block, as before (same code as the assurance check alone)', async () => {
  // no login event for this session: the assurance check refuses; the MFA state (blocked) must not replace its code
  const db = delayedDb({ mfa: { required: true, privileged: true, compliant: false }, sessions: [] });
  const alone = await createSessionAssurance({ supabase: delayedDb({ sessions: [] }) }).check({ merchantId: M, userId: U, sessionId: 's1', module: 'sourcing' });
  assert.equal(alone.ok, false);
  assert.equal((await check(db, { requireCoreSession: true })(input({ authSessionId: 's1' }))).code, alone.code);
});

test('no cache: every use reads again (a revocation takes effect on the next request)', async () => {
  const db = delayedDb();
  const c = check(db);
  await c(input()); const first = db.calls.length;
  await c(input()); assert.equal(db.calls.length, first * 2, 'the second use performs its own reads');
});
