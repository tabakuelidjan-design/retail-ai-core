// The per-request access check: the membership and the entitlement are read together (one round trip, not two in a row),
// and the answers and refusal order are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessChecker } from '../src/identity/sso-contract.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';

function fakeSupabase({ member, entitlement, delayMs = 40 }) {
  const log = [];
  return {
    log,
    async select(table) {
      const entry = { table, start: Date.now() };
      log.push(entry);
      await new Promise((r) => setTimeout(r, delayMs));
      entry.end = Date.now();
      if (String(table).includes('member')) return member ? [member] : [];
      return entitlement ? [entitlement] : [];
    },
    async rpc() { return []; },
  };
}

test('membership and entitlement are read at the same time (they overlap)', async () => {
  const sb = fakeSupabase({ member: { role: 'OWNER', status: 'ACTIVE', removed_at: null, merchant_id: M }, entitlement: { merchant_id: M, module_code: 'finance', status: 'ACTIVE' } });
  const check = createAccessChecker({ supabase: sb, merchantId: M });
  await check({ merchantId: M, userId: U, role: 'OWNER', module: 'finance' });
  assert.equal(sb.log.length, 2, 'both reads happen');
  const [a, b] = sb.log;
  assert.ok(b.start < a.end && a.start < b.end, 'the two reads overlap in time');
});

test('a refused membership still refuses, whatever the entitlement says (same codes as before)', async () => {
  const sb = fakeSupabase({ member: { role: 'OWNER', status: 'SUSPENDED', removed_at: null, merchant_id: M }, entitlement: { merchant_id: M, module_code: 'finance', status: 'ACTIVE' } });
  const check = createAccessChecker({ supabase: sb, merchantId: M });
  const r = await check({ merchantId: M, userId: U, role: 'OWNER', module: 'finance' });
  assert.deepEqual(r, { ok: false, code: 'MEMBER_SUSPENDED' });
});

test('a module that is not enabled is refused with its code', async () => {
  const sb = fakeSupabase({ member: { role: 'OWNER', status: 'ACTIVE', removed_at: null, merchant_id: M }, entitlement: null });
  const check = createAccessChecker({ supabase: sb, merchantId: M });
  const r = await check({ merchantId: M, userId: U, role: 'OWNER', module: 'finance' });
  assert.deepEqual(r, { ok: false, code: 'MODULE_NOT_ENABLED' });
});

test('a changed role is refused at once (no answer kept from an earlier request)', async () => {
  const sb = fakeSupabase({ member: { role: 'ADMIN', status: 'ACTIVE', removed_at: null, merchant_id: M }, entitlement: { merchant_id: M, module_code: 'finance', status: 'ACTIVE' } });
  const check = createAccessChecker({ supabase: sb, merchantId: M });
  assert.deepEqual(await check({ merchantId: M, userId: U, role: 'OWNER', module: 'finance' }), { ok: false, code: 'ROLE_CHANGED' });
});
