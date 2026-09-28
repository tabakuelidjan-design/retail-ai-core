// Core C2 - memberships and roles (src/identity/members.js + migration 20260928140000). Synthetic merchants and users only.
// The in-memory database mirrors the two SQL functions (one uninterrupted body = one transaction under the per-merchant lock,
// change + journal entry committed together); the real SQL is validated separately in a throwaway PostgreSQL (PGlite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createMemberService, listActiveMerchants, MEMBER_RULES, ROLES, roleRuleRefusal, canManageMembers, MemberError } from '../src/identity/members.js';
import { createGoTrueVerifier } from '../src/identity/gotrue.js';
import { createRateLimiter } from '../src/identity/rate-limit.js';
import { loadRateLimitConfig } from '../src/identity/config.js';
import { createEventLog } from '../src/identity/events.js';
import { createIdentityVerifier } from '../src/identity/verify.js';

const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const UNKNOWN_MERCHANT = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';
const U = Object.fromEntries(['owner', 'owner2', 'admin', 'admin2', 'collab', 'viewer', 'acct', 'newbie', 'newbie2', 'outsider'].map((k, i) => [k, `${String(i + 1).padStart(8, '0')}-1111-4111-8111-${String(i + 1).padStart(12, '0')}`]));
const T0 = new Date('2026-09-28T08:00:00.000Z');

function world({ latencyMs = 0 } = {}) {
  const db = createIdentityDb({ merchants: [A, B], users: Object.values(U), latencyMs });
  const svc = (merchantId, module = 'core') => createMemberService({ supabase: db.supabase, merchantId, module, now: () => T0 });
  return { db, svc, a: svc(A), b: svc(B), members: () => db.table('merchant_members'), events: () => db.table('identity_events') };
}
/** Merchant A with owner, admin, collab, viewer, acct. */
async function staffed() {
  const w = world();
  assert.equal((await w.a.bootstrapOwner({ userId: U.owner })).ok, true);
  for (const [k, role] of [['admin', 'ADMIN'], ['collab', 'COLLABORATOR'], ['viewer', 'VIEWER'], ['acct', 'ACCOUNTANT']]) {
    assert.deepEqual(await w.a.addMember({ actorUserId: U.owner, targetUserId: U[k], role }), { ok: true, code: 'MEMBER_ADDED' });
  }
  return w;
}
const row = (w, merchant, user) => w.members().find((m) => m.merchant_id === merchant && m.user_id === user);

// ---------- first OWNER ----------
test('bootstrap: first OWNER on an empty merchant, journalled in the same call (MEMBER_BOOTSTRAPPED)', async () => {
  const w = world();
  assert.deepEqual(await w.a.bootstrapOwner({ userId: U.owner }), { ok: true, code: 'BOOTSTRAPPED' });
  assert.deepEqual(w.members().map((m) => [m.user_id, m.role, m.status, m.created_by]), [[U.owner, 'OWNER', 'ACTIVE', null]]);
  const [e] = w.events();
  assert.deepEqual([e.event_type, e.outcome, e.merchant_id, e.user_id, e.entity_type, e.entity_id, e.module], ['MEMBER_BOOTSTRAPPED', 'SUCCESS', A, null, 'user', U.owner, 'core']);
  assert.deepEqual(e.detail, { toRole: 'OWNER', toStatus: 'ACTIVE' });
  assert.deepEqual(w.db.calls.map((c) => c.op), ['rpc'], 'one database call: change and journal together');
});

test('bootstrap: a second initialisation is refused (and journalled); unknown merchant or user refused', async () => {
  const w = world();
  await w.a.bootstrapOwner({ userId: U.owner });
  assert.deepEqual(await w.a.bootstrapOwner({ userId: U.newbie }), { ok: false, code: 'ALREADY_INITIALIZED' });
  assert.equal(w.members().length, 1);
  assert.equal(w.events().at(-1).event_type, 'MEMBER_ACTION_DENIED');
  assert.deepEqual(await w.svc(UNKNOWN_MERCHANT).bootstrapOwner({ userId: U.owner }), { ok: false, code: 'MERCHANT_UNKNOWN' });
  assert.deepEqual(await w.b.bootstrapOwner({ userId: 'ffffffff-1111-4111-8111-ffffffffffff' }), { ok: false, code: 'USER_UNKNOWN' });
  assert.equal(w.members().filter((m) => m.merchant_id === B).length, 0);
});

test('bootstrap: 10 simultaneous initialisations from 3 instances -> exactly one OWNER', async () => {
  const w = world({ latencyMs: 1 });
  const nodes = [w.svc(A), w.svc(A), w.svc(A)];
  const users = [U.owner, U.owner2, U.admin, U.admin2, U.collab, U.viewer, U.acct, U.newbie, U.newbie2, U.outsider];
  const out = await Promise.all(users.map((u, i) => nodes[i % 3].bootstrapOwner({ userId: u })));
  assert.equal(out.filter((r) => r.ok).length, 1);
  assert.equal(out.filter((r) => r.code === 'ALREADY_INITIALIZED').length, 9);
  assert.equal(w.members().length, 1);
  assert.equal(w.events().filter((e) => e.event_type === 'MEMBER_BOOTSTRAPPED').length, 1);
});

test('atomic journal: if the event cannot be written, the change is not made (bootstrap and every mutation)', async () => {
  const w = await staffed();
  const before = JSON.stringify(w.members()); const eventsBefore = w.events().length;
  w.db.failEventsWith(new Error('journal down'));
  for (const run of [
    () => w.b.bootstrapOwner({ userId: U.owner }),
    () => w.a.addMember({ actorUserId: U.owner, targetUserId: U.newbie, role: 'VIEWER' }),
    () => w.a.changeRole({ actorUserId: U.owner, targetUserId: U.collab, role: 'VIEWER' }),
    () => w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.viewer }),
  ]) await assert.rejects(run(), (e) => e instanceof MemberError && e.code === 'MEMBER_STORE_FAILED' && !/journal down/.test(e.message));
  assert.equal(JSON.stringify(w.members()), before, 'no membership changed');
  assert.equal(w.events().length, eventsBefore);
  assert.equal(w.members().filter((m) => m.merchant_id === B).length, 0);
});

// ---------- role matrix ----------
test('matrix: OWNER, ADMIN and the three other roles', () => {
  assert.deepEqual(MEMBER_RULES.OWNER.manages, ROLES);
  assert.deepEqual(MEMBER_RULES.ADMIN.manages, ['COLLABORATOR', 'VIEWER', 'ACCOUNTANT']);
  assert.deepEqual(MEMBER_RULES.ADMIN.assigns, ['COLLABORATOR', 'VIEWER', 'ACCOUNTANT']);
  for (const r of ['COLLABORATOR', 'VIEWER', 'ACCOUNTANT']) { assert.deepEqual(MEMBER_RULES[r].manages, []); assert.equal(canManageMembers(r), false); }
  assert.equal(canManageMembers('OWNER'), true); assert.equal(canManageMembers('ADMIN'), true);
  assert.equal(roleRuleRefusal({ actorRole: 'ADMIN', targetRole: 'ADMIN', action: 'SUSPEND', self: true }), 'FORBIDDEN');
  assert.equal(roleRuleRefusal({ actorRole: 'ADMIN', targetRole: 'ADMIN', newRole: 'OWNER', action: 'CHANGE_ROLE', self: true }), 'SELF_PROMOTION');
});

test('OWNER adds every role; ADMIN adds only COLLABORATOR, VIEWER or ACCOUNTANT', async () => {
  const w = await staffed();
  for (const role of ROLES) {
    const fresh = world(); await fresh.a.bootstrapOwner({ userId: U.owner });
    assert.deepEqual(await fresh.a.addMember({ actorUserId: U.owner, targetUserId: U.newbie, role }), { ok: true, code: 'MEMBER_ADDED' }, `OWNER adds ${role}`);
  }
  assert.equal((await w.a.addMember({ actorUserId: U.admin, targetUserId: U.newbie, role: 'OWNER' })).code, 'FORBIDDEN');
  assert.equal((await w.a.addMember({ actorUserId: U.admin, targetUserId: U.newbie, role: 'ADMIN' })).code, 'FORBIDDEN');
  for (const role of ['COLLABORATOR', 'VIEWER', 'ACCOUNTANT']) {
    const r = await w.a.addMember({ actorUserId: U.admin, targetUserId: role === 'COLLABORATOR' ? U.newbie : role === 'VIEWER' ? U.newbie2 : U.outsider, role });
    assert.deepEqual(r, { ok: true, code: 'MEMBER_ADDED' }, `ADMIN adds ${role}`);
  }
});

test('ADMIN can manage neither an OWNER nor an ADMIN, cannot promote to ADMIN, cannot act on itself', async () => {
  const w = await staffed();
  await w.a.addMember({ actorUserId: U.owner, targetUserId: U.admin2, role: 'ADMIN' });
  const cases = [
    [w.a.changeRole, { targetUserId: U.owner, role: 'VIEWER' }, 'FORBIDDEN'],
    [w.a.suspendMember, { targetUserId: U.owner }, 'FORBIDDEN'],
    [w.a.changeRole, { targetUserId: U.admin2, role: 'VIEWER' }, 'FORBIDDEN'],
    [w.a.suspendMember, { targetUserId: U.admin2 }, 'FORBIDDEN'],
    [w.a.changeRole, { targetUserId: U.collab, role: 'ADMIN' }, 'FORBIDDEN'],
    [w.a.changeRole, { targetUserId: U.collab, role: 'OWNER' }, 'FORBIDDEN'],
    [w.a.changeRole, { targetUserId: U.admin, role: 'OWNER' }, 'SELF_PROMOTION'],
    [w.a.suspendMember, { targetUserId: U.admin }, 'FORBIDDEN'],
    [w.a.changeRole, { targetUserId: U.admin, role: 'VIEWER' }, 'FORBIDDEN'],
  ];
  for (const [fn, input, code] of cases) assert.equal((await fn({ actorUserId: U.admin, ...input })).code, code, JSON.stringify(input));
  assert.equal(row(w, A, U.owner).role, 'OWNER'); assert.equal(row(w, A, U.admin2).status, 'ACTIVE'); assert.equal(row(w, A, U.admin).role, 'ADMIN');
  // ADMIN manages the three others
  assert.equal((await w.a.changeRole({ actorUserId: U.admin, targetUserId: U.collab, role: 'ACCOUNTANT' })).ok, true);
  assert.equal((await w.a.suspendMember({ actorUserId: U.admin, targetUserId: U.viewer })).ok, true);
  assert.equal((await w.a.reactivateMember({ actorUserId: U.admin, targetUserId: U.viewer })).ok, true);
});

test('COLLABORATOR, VIEWER and ACCOUNTANT can manage nobody (not even themselves)', async () => {
  const w = await staffed();
  for (const actor of [U.collab, U.viewer, U.acct]) {
    for (const [fn, input] of [[w.a.addMember, { targetUserId: U.newbie, role: 'VIEWER' }], [w.a.changeRole, { targetUserId: U.viewer, role: 'COLLABORATOR' }], [w.a.suspendMember, { targetUserId: U.collab }], [w.a.changeRole, { targetUserId: actor, role: 'OWNER' }]]) {
      const r = await fn({ actorUserId: actor, ...input });
      assert.equal(r.ok, false); assert.ok(['FORBIDDEN', 'SELF_PROMOTION'].includes(r.code), r.code);
    }
  }
  assert.equal(w.members().length, 5);
});

test('suspension, reactivation, role change; a suspended actor is always refused; wrong targets are refused', async () => {
  const w = await staffed();
  assert.deepEqual(await w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.admin }), { ok: true, code: 'MEMBER_SUSPENDED' });
  const s = row(w, A, U.admin);
  assert.deepEqual([s.status, s.suspended_at, s.updated_by], ['SUSPENDED', T0.toISOString(), U.owner]);
  assert.equal((await w.a.addMember({ actorUserId: U.admin, targetUserId: U.newbie, role: 'VIEWER' })).code, 'ACTOR_SUSPENDED');
  assert.equal((await w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.admin })).code, 'ALREADY_SUSPENDED');
  assert.deepEqual(await w.a.reactivateMember({ actorUserId: U.owner, targetUserId: U.admin }), { ok: true, code: 'MEMBER_REACTIVATED' });
  assert.equal(row(w, A, U.admin).suspended_at, null);
  assert.equal((await w.a.reactivateMember({ actorUserId: U.owner, targetUserId: U.admin })).code, 'ALREADY_ACTIVE');
  assert.deepEqual(await w.a.changeRole({ actorUserId: U.owner, targetUserId: U.viewer, role: 'COLLABORATOR' }), { ok: true, code: 'MEMBER_ROLE_CHANGED' });
  assert.equal((await w.a.changeRole({ actorUserId: U.owner, targetUserId: U.viewer, role: 'COLLABORATOR' })).code, 'NO_CHANGE');
  assert.equal((await w.a.addMember({ actorUserId: U.owner, targetUserId: U.viewer, role: 'VIEWER' })).code, 'TARGET_ALREADY_MEMBER');
  assert.equal((await w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.outsider })).code, 'TARGET_NOT_MEMBER');
  assert.equal((await w.a.addMember({ actorUserId: U.outsider, targetUserId: U.newbie, role: 'VIEWER' })).code, 'ACTOR_NOT_MEMBER');
  assert.equal((await w.a.addMember({ actorUserId: U.owner, targetUserId: U.newbie, role: 'SUPERUSER' })).code, 'ROLE_INVALID');
  assert.equal((await w.svc(UNKNOWN_MERCHANT).addMember({ actorUserId: U.owner, targetUserId: U.newbie, role: 'VIEWER' })).code, 'MERCHANT_UNKNOWN');
  await assert.rejects(w.a.addMember({ actorUserId: 'not-a-uuid', targetUserId: U.newbie, role: 'VIEWER' }), (e) => e.code === 'INVALID_ARGUMENT' && !e.message.includes('not-a-uuid'));
});

// ---------- last OWNER ----------
test('the last active OWNER cannot be suspended or demoted (not even by itself); it can once a second OWNER exists', async () => {
  const w = await staffed();
  assert.equal((await w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.owner })).code, 'LAST_OWNER');
  for (const role of ['ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT']) assert.equal((await w.a.changeRole({ actorUserId: U.owner, targetUserId: U.owner, role })).code, 'LAST_OWNER');
  assert.equal(row(w, A, U.owner).role, 'OWNER'); assert.equal(row(w, A, U.owner).status, 'ACTIVE');
  // leaving properly: first another OWNER, then step down
  assert.equal((await w.a.changeRole({ actorUserId: U.owner, targetUserId: U.admin, role: 'OWNER' })).ok, true);
  assert.equal((await w.a.changeRole({ actorUserId: U.owner, targetUserId: U.owner, role: 'VIEWER' })).ok, true);
  assert.equal((await w.a.suspendMember({ actorUserId: U.admin, targetUserId: U.admin })).code, 'LAST_OWNER', 'the new sole owner is protected in turn');
  // a suspended OWNER does not count as an owner
  const x = await staffed();
  await x.a.addMember({ actorUserId: U.owner, targetUserId: U.owner2, role: 'OWNER' });
  await x.a.suspendMember({ actorUserId: U.owner, targetUserId: U.owner2 });
  assert.equal((await x.a.suspendMember({ actorUserId: U.owner, targetUserId: U.owner })).code, 'LAST_OWNER');
  // nothing in the service can delete a membership
  assert.ok(!Object.keys(w.a).some((k) => /delete|remove/i.test(k)));
});

test('two OWNERs demoting each other at the same time, from different instances: never zero OWNER', async () => {
  for (let run = 0; run < 20; run += 1) {
    const w = world({ latencyMs: 1 });
    await w.a.bootstrapOwner({ userId: U.owner });
    await w.a.addMember({ actorUserId: U.owner, targetUserId: U.owner2, role: 'OWNER' });
    const [n1, n2] = [w.svc(A), w.svc(A)];
    const variants = [
      [() => n1.changeRole({ actorUserId: U.owner, targetUserId: U.owner2, role: 'ADMIN' }), () => n2.changeRole({ actorUserId: U.owner2, targetUserId: U.owner, role: 'ADMIN' })],
      [() => n1.suspendMember({ actorUserId: U.owner, targetUserId: U.owner }), () => n2.suspendMember({ actorUserId: U.owner2, targetUserId: U.owner2 })],
      [() => n1.changeRole({ actorUserId: U.owner, targetUserId: U.owner, role: 'VIEWER' }), () => n2.suspendMember({ actorUserId: U.owner2, targetUserId: U.owner2 })],
    ][run % 3];
    const out = await Promise.all(variants.map((f) => f()));
    assert.equal(out.filter((r) => r.ok).length, 1, JSON.stringify(out));
    assert.ok(out.some((r) => ['LAST_OWNER', 'FORBIDDEN', 'ACTOR_SUSPENDED'].includes(r.code)), JSON.stringify(out));
    assert.equal(w.members().filter((m) => m.role === 'OWNER' && m.status === 'ACTIVE').length, 1);
  }
});

// ---------- isolation ----------
test('isolation: two merchants, one person with different roles in each; nothing crosses', async () => {
  const w = await staffed();
  await w.b.bootstrapOwner({ userId: U.newbie });
  await w.b.addMember({ actorUserId: U.newbie, targetUserId: U.collab, role: 'ADMIN' }); // collab: COLLABORATOR in A, ADMIN in B
  assert.equal(await w.a.getActiveRole(U.collab), 'COLLABORATOR');
  assert.equal(await w.b.getActiveRole(U.collab), 'ADMIN');
  assert.equal(await w.a.getMembership(U.newbie), null, 'B\'s owner is invisible from A');
  assert.equal(await w.b.getMembership(U.owner), null);
  // A's owner cannot touch B's people through A, nor B's owner A's people through B
  assert.equal((await w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.newbie })).code, 'TARGET_NOT_MEMBER');
  assert.equal((await w.b.suspendMember({ actorUserId: U.owner, targetUserId: U.newbie })).code, 'ACTOR_NOT_MEMBER');
  assert.equal((await w.a.addMember({ actorUserId: U.newbie, targetUserId: U.outsider, role: 'VIEWER' })).code, 'ACTOR_NOT_MEMBER');
  // the ADMIN power in B does not exist in A
  assert.equal((await w.a.suspendMember({ actorUserId: U.collab, targetUserId: U.viewer })).code, 'FORBIDDEN');
  // suspension in A leaves B untouched
  await w.a.suspendMember({ actorUserId: U.owner, targetUserId: U.collab });
  assert.deepEqual(await w.a.requireActiveMembership(U.collab), { ok: false, code: 'SUSPENDED' });
  assert.equal((await w.b.requireActiveMembership(U.collab)).role, 'ADMIN');
  assert.deepEqual(await listActiveMerchants({ supabase: w.db.supabase }, U.collab), [{ merchantId: B, role: 'ADMIN' }]);
  // events are recorded under the merchant where the action happened
  assert.ok(w.events().filter((e) => e.entity_id === U.collab && e.event_type === 'MEMBER_SUSPENDED').every((e) => e.merchant_id === A));
});

test('the merchant is fixed by the server layer: no function accepts a merchant id in its input', async () => {
  const w = await staffed();
  await assert.rejects(w.a.addMember({ actorUserId: U.owner, targetUserId: U.newbie, role: 'VIEWER', merchantId: B }), /does not accept "merchantId"/);
  await assert.rejects(w.a.bootstrapOwner({ userId: U.newbie, merchantId: B }), /does not accept "merchantId"/);
  assert.throws(() => createMemberService({ supabase: w.db.supabase, merchantId: 'HABB' }), MemberError);
  const src = readFileSync(new URL('../src/identity/members.js', import.meta.url), 'utf8');
  assert.ok(!/shopify|source_id|source_system/i.test(src), 'no Shopify reference identifies the merchant');
});

// ---------- events ----------
test('events carry only merchant, actor id, target id, roles / statuses, result and correlation - no personal data', async () => {
  const w = await staffed();
  await w.a.changeRole({ actorUserId: U.owner, targetUserId: U.collab, role: 'VIEWER', correlationId: '12345678-1234-4234-8234-123456789012' });
  await w.a.changeRole({ actorUserId: U.admin, targetUserId: U.owner, role: 'VIEWER' });
  const types = new Set(w.events().map((e) => e.event_type));
  for (const t of ['MEMBER_BOOTSTRAPPED', 'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_ACTION_DENIED']) assert.ok(types.has(t), t);
  const changed = w.events().find((e) => e.event_type === 'MEMBER_ROLE_CHANGED');
  assert.deepEqual([changed.user_id, changed.entity_id, changed.correlation_id, changed.detail], [U.owner, U.collab, '12345678-1234-4234-8234-123456789012', { fromRole: 'COLLABORATOR', toRole: 'VIEWER' }]);
  const denied = w.events().find((e) => e.event_type === 'MEMBER_ACTION_DENIED');
  assert.deepEqual([denied.outcome, denied.user_id, denied.detail], ['DENIED', U.admin, { action: 'CHANGE_ROLE', code: 'FORBIDDEN' }]);
  const allowed = new Set(['toRole', 'toStatus', 'fromRole', 'fromStatus', 'role', 'action', 'code']);
  for (const e of w.events()) {
    assert.ok(Object.keys(e.detail).every((k) => allowed.has(k)), JSON.stringify(e.detail));
    assert.match(e.entity_id, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(e).includes('@'));
  }
});

// ---------- relation with C1 and C3 ----------
test('a valid C1b identity without a C2 membership stays refused; an active membership returns a role and creates no session', async () => {
  const w = world();
  const person = { id: U.newbie, email: 'person@nordla-test.example', password: 'a long synthetic passphrase' };
  const auth = createFakeGoTrue({ users: [person] });
  const verifier = createIdentityVerifier({
    gotrue: createGoTrueVerifier({ config: { baseUrl: 'https://ref.supabase.example', anonKey: `anon-${randomBytes(20).toString('hex')}` }, fetchImpl: auth.fetchImpl }),
    limiter: createRateLimiter({ supabase: w.db.supabase, key: randomBytes(32), config: loadRateLimitConfig({}), now: () => T0 }),
    events: createEventLog({ supabase: w.db.supabase, now: () => T0 }),
    service: { merchantId: A, module: 'growth' },
  });
  const id = await verifier.verify({ email: person.email, password: person.password, ip: '203.0.113.5' });
  assert.equal(id.ok, true);
  assert.deepEqual(await w.a.requireActiveMembership(id.identity.userId), { ok: false, code: 'NOT_MEMBER' });
  await w.a.bootstrapOwner({ userId: U.owner });
  await w.a.addMember({ actorUserId: U.owner, targetUserId: U.newbie, role: 'ACCOUNTANT' });
  const m = await w.a.requireActiveMembership(id.identity.userId);
  assert.deepEqual(m, { ok: true, userId: U.newbie, merchantId: A, role: 'ACCOUNTANT' });
  assert.deepEqual(Object.keys(m).sort(), ['merchantId', 'ok', 'role', 'userId'], 'no module, no session in the answer');
  assert.equal(w.db.table('app_sessions').length, 0);
  assert.ok(!w.db.calls.some((c) => c.table === 'app_sessions'));
  const code = readFileSync(new URL('../src/identity/members.js', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  assert.ok(!/sessions\.js|createSessionStore|app_sessions|Set-Cookie|module_entitlements|finance|analytics|growth/i.test(code), 'members.js creates no session and opens no module');
});
