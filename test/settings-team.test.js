// Paramètres -> Équipe et accès: the rights grid against the real enforcement, the service rules (memory repository mirroring the SQL functions), and the HTTP host
// (real host, fake sessions that read the CURRENT membership on every call, like the real access layer). The SQL itself is exercised in a rolled-back transaction on staging
// (see the delivery report); these tests prove the Node layers. Synthetic merchants and users only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTeamHost } from '../src/sourcing/server/team-host.js';
import { createTeamService, hashToken, TeamError } from '../src/settings-team/service.js';
import { createMemoryTeamRepository } from '../src/settings-team/repository.js';
import * as M from '../src/settings-team/model.js';
import { WRITER_ROLES as GENERAL_WRITERS, createGeneralService } from '../src/settings-general/service.js';
import { createMemoryGeneralRepository } from '../src/settings-general/repository.js';
import { createGeneralHost } from '../src/sourcing/server/general-host.js';
import { WRITER_ROLES as CONNECTION_WRITERS } from '../src/connections/service.js';
import { GBP_WRITERS } from '../src/sourcing/server/gbp-host.js';
import { VIDEO_WRITERS } from '../src/sourcing/server/video-host.js';
import { CREATOR_WRITERS } from '../src/creative-autonomy/creator/hosted.js';
import { PROCUREMENT_ROLE } from '../src/procurement/server/hosted.js';
import { capabilitiesOf } from '../src/procurement/server/permissions.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222';
const U = { own: 'a0000000-0000-4000-8000-000000000001', own2: 'a0000000-0000-4000-8000-000000000002', adm: 'a0000000-0000-4000-8000-000000000003', adm2: 'a0000000-0000-4000-8000-000000000004', view: 'a0000000-0000-4000-8000-000000000005', col: 'a0000000-0000-4000-8000-000000000006', ownB: 'b0000000-0000-4000-8000-000000000001', multi: 'c0000000-0000-4000-8000-000000000001' };
const users = [['own', 'owner@a.test', 'Olivia Owner'], ['own2', 'owner2@a.test', 'Oscar Second'], ['adm', 'admin@a.test', 'Adam Admin'], ['adm2', 'admin2@a.test', null], ['view', 'viewer@a.test', 'Vera Viewer'], ['col', 'collab@a.test', 'Colin'], ['ownB', 'owner@b.test', 'Bruno B'], ['multi', 'multi@x.test', 'Multi']].map(([k, email, name]) => ({ id: U[k], email, name }));
const T0 = '2026-11-18T08:00:00.000Z';
const mm = (merchant_id, user, role, status = 'ACTIVE') => ({ merchant_id, user_id: U[user], role, status, created_at: T0, updated_at: T0, suspended_at: status === 'SUSPENDED' ? T0 : null });
const roster = () => [mm(A, 'own', 'OWNER'), mm(A, 'adm', 'ADMIN'), mm(A, 'adm2', 'ADMIN'), mm(A, 'view', 'VIEWER'), mm(A, 'col', 'COLLABORATOR'), mm(B, 'ownB', 'OWNER'), mm(A, 'multi', 'VIEWER'), mm(B, 'multi', 'ADMIN')];
let clock = new Date(T0);
const world = (extra = {}) => {
  const repo = createMemoryTeamRepository({ merchants: { [A]: 'Boutique A', [B]: 'Boutique B' }, users, members: extra.members ?? roster(), now: () => clock });
  let n = 0; const auth = { createUser: async ({ email, name }) => { const id = `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; repo._state.users.set(id, { id, email, name }); return { ok: true, userId: id }; }, verifyPassword: async (email, password) => { const u = [...repo._state.users.values()].find((x) => x.email === email); return u && password === 'correct-horse-battery' ? { ok: true, userId: u.id } : { ok: false }; } };
  const svc = createTeamService({ repo, auth, now: () => clock, origin: 'https://nordla.test' });
  return { repo, svc, st: repo._state, auth };
};
const ctx = (merchant, user, role) => ({ tenant: { merchantId: merchant }, role, actor: U[user] });
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code; } };

// ------------------------------------------------------------------ the grid IS the enforcement
test('TM-1 the rights grid matches what the servers enforce (so it cannot drift)', () => {
  const lv = (id) => M.MODULE_RIGHTS.find((m) => m.id === id).levels;
  const writes = (set) => Object.fromEntries(['OWNER', 'ADMIN', 'VIEWER', 'COLLABORATOR', 'ACCOUNTANT'].map((r) => [r, set.has(r) ? 'edit' : 'view']));
  for (const [id, set] of [['general', GENERAL_WRITERS], ['connections', CONNECTION_WRITERS], ['gbp', GBP_WRITERS], ['videos', VIDEO_WRITERS], ['creator', CREATOR_WRITERS]]) assert.deepEqual({ ...lv(id) }, writes(new Set(set)), id);
  // Stock / Achats: a role maps to a procurement role; "edit" = may prepare, "view" = may read
  for (const r of Object.keys(lv('procurement'))) { const c = capabilitiesOf({ id: 'x', role: PROCUREMENT_ROLE[r] }); assert.equal(lv('procurement')[r], c.prepare ? 'edit' : c.read ? 'view' : 'none', `procurement ${r}`); }
  // approving an order: only the owner by role (grants are explicit and named)
  const ap = M.SENSITIVE_ACTIONS.find((a) => a.id === 'approve_order').levels; for (const r of ['OWNER', 'ADMIN', 'VIEWER']) assert.equal(ap[r] === 'yes', capabilitiesOf({ id: 'x', role: PROCUREMENT_ROLE[r] }).canApprove, `approve ${r}`);
  assert.deepEqual(M.SENSITIVE_ACTIONS.find((a) => a.id === 'manage_connection').levels, { OWNER: 'yes', ADMIN: 'yes', VIEWER: 'no' });
  assert.equal(M.rightsOf('VIEWER').modules.find((m) => m.id === 'team').level, 'none');
  assert.deepEqual([...M.ROLE_ORDER], ['OWNER', 'ADMIN', 'VIEWER']); assert.equal(M.NEXT_ROLE.label, 'Employé boutique');
});

// ------------------------------------------------------------------ members
test('TM-2 members: only OWNER/ADMIN read; search + filters; effective rights; merchant isolation', async () => {
  const { svc } = world();
  assert.equal(await code(svc.members(ctx(A, 'view', 'VIEWER'))), 'FORBIDDEN_ROLE');
  const all = await svc.members(ctx(A, 'own', 'OWNER')); assert.equal(all.total, 6); assert.ok(!all.members.some((m) => m.id === U.ownB), 'no member of another merchant');
  assert.equal((await svc.members({ ...ctx(A, 'own', 'OWNER'), q: 'VERA' })).total, 1); assert.equal((await svc.members({ ...ctx(A, 'own', 'OWNER'), q: 'admin2@' })).members[0].name, 'admin2', 'name falls back to the address');
  assert.equal((await svc.members({ ...ctx(A, 'own', 'OWNER'), roleFilter: 'ADMIN' })).total, 2); assert.equal((await svc.members({ ...ctx(A, 'own', 'OWNER'), status: 'SUSPENDED' })).total, 0);
  const d = await svc.member({ ...ctx(A, 'own', 'OWNER'), userId: U.view }); assert.equal(d.rights.modules.find((m) => m.id === 'general').level, 'view'); assert.equal(d.establishments.enforced, false);
  assert.equal(await code(svc.member({ ...ctx(A, 'own', 'OWNER'), userId: U.ownB })), 'NOT_FOUND', 'another merchant member is unknown here');
  assert.equal((await svc.members(ctx(B, 'ownB', 'OWNER'))).total, 2);
});

test('TM-3 actions offered follow the actor: an administrator manages only read-only members; the owner everything; nobody self-promotes', async () => {
  const { svc } = world();
  const asAdmin = (await svc.members(ctx(A, 'adm', 'ADMIN'))).members; const by = (id) => asAdmin.find((m) => m.id === U[id]);
  assert.deepEqual(by('view').actions.changeRole, []); assert.equal(by('view').actions.suspend, true); assert.equal(by('own').actions.suspend, false); assert.equal(by('adm2').actions.remove, false); assert.equal(by('adm').actions.suspend, false, 'not itself');
  const asOwner = (await svc.members(ctx(A, 'own', 'OWNER'))).members; assert.deepEqual(asOwner.find((m) => m.id === U.adm).actions.changeRole, ['OWNER', 'VIEWER']);
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'adm', 'ADMIN'), userId: U.view, newRole: 'ADMIN' })), 'FORBIDDEN', 'cannot delegate what it cannot hold');
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'adm', 'ADMIN'), userId: U.own, newRole: 'VIEWER' })), 'FORBIDDEN');
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'adm', 'ADMIN'), userId: U.adm2, action: 'SUSPEND' })), 'FORBIDDEN');
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'view', 'VIEWER'), userId: U.col, action: 'SUSPEND' })), 'FORBIDDEN_ROLE');
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.view, newRole: 'COLLABORATOR' })), 'ROLE_INVALID', 'only the three roles are offered');
});

test('TM-4 change role / suspend / reactivate / remove, with the last-owner protection and the journal (old and new role)', async () => {
  const { svc, st } = world();
  await svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.view, newRole: 'ADMIN' });
  const ev = st.events.find((e) => e.event_type === 'MEMBER_ROLE_CHANGED'); assert.deepEqual(ev.detail, { fromRole: 'VIEWER', toRole: 'ADMIN' });
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.view, newRole: 'ADMIN' })), 'NO_CHANGE');
  // the only owner cannot be suspended, removed or demoted (self or by anyone)
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.own, action: 'SUSPEND' })), 'LAST_OWNER');
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.own, action: 'REMOVE' })), 'LAST_OWNER');
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.own, newRole: 'ADMIN' })), 'LAST_OWNER');
  await svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.adm, newRole: 'OWNER' });   // a second owner: now the first may step down
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.own, newRole: 'ADMIN' })), 'OK');
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'adm', 'OWNER'), userId: U.adm, action: 'SUSPEND' })), 'LAST_OWNER');
  await svc.setStatus({ ...ctx(A, 'adm', 'OWNER'), userId: U.view, action: 'SUSPEND' }); assert.equal(st.members.find((m) => m.user_id === U.view && m.merchant_id === A).status, 'SUSPENDED');
  await svc.setStatus({ ...ctx(A, 'adm', 'OWNER'), userId: U.view, action: 'REACTIVATE' }); assert.equal(st.members.find((m) => m.user_id === U.view && m.merchant_id === A).status, 'ACTIVE');
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'adm', 'OWNER'), userId: U.view, action: 'REACTIVATE' })), 'ALREADY_ACTIVE');
});

test('TM-5 removing access keeps the row, the history and the person\'s access to OTHER merchants; a removed member cannot be reactivated or re-roled', async () => {
  const { svc, st } = world();
  await svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.multi, action: 'REMOVE' });
  const row = st.members.find((m) => m.merchant_id === A && m.user_id === U.multi); assert.equal(row.status, 'SUSPENDED'); assert.ok(row.removed_at); assert.equal(st.members.find((m) => m.merchant_id === B && m.user_id === U.multi).status, 'ACTIVE', 'the other merchant is untouched');
  assert.equal((await svc.member({ ...ctx(A, 'own', 'OWNER'), userId: U.multi })).member.status, 'REMOVED');
  for (const a of ['REACTIVATE', 'SUSPEND']) assert.equal(await code(svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.multi, action: a })), 'MEMBER_REMOVED');
  assert.equal(await code(svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.multi, newRole: 'ADMIN' })), 'MEMBER_REMOVED');
  assert.equal(await code(svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.multi, action: 'REMOVE' })), 'ALREADY_REMOVED');
  assert.ok(st.events.some((e) => e.event_type === 'MEMBER_REMOVED' && e.entity_id === U.multi));
});

// ------------------------------------------------------------------ invitations
const tokenOf = (link) => link.split('/invitation/')[1];
test('TM-6 invitation lifecycle: preview rights, duplicates, resend kills the old link, one use, intended recipient only, expiry, cancel', async () => {
  const { svc, st, repo } = world();
  assert.equal(await code(svc.invite({ ...ctx(A, 'view', 'VIEWER'), email: 'x@y.be', newRole: 'VIEWER' })), 'FORBIDDEN_ROLE');
  assert.equal(await code(svc.invite({ ...ctx(A, 'adm', 'ADMIN'), email: 'x@y.be', newRole: 'ADMIN' })), 'FORBIDDEN', 'an administrator invites read-only people only');
  assert.equal(await code(svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'pas-une-adresse', newRole: 'VIEWER' })), 'EMAIL_INVALID');
  assert.equal(await code(svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'VIEWER@a.test', newRole: 'VIEWER' })), 'ALREADY_MEMBER');
  const inv = await svc.invite({ ...ctx(A, 'own', 'OWNER'), email: ' Nouvelle@Test.be ', newRole: 'VIEWER' });
  assert.equal(inv.invitation.email, 'nouvelle@test.be'); assert.equal(inv.invitation.status, 'PENDING'); assert.match(inv.link, /^https:\/\/nordla\.test\/invitation\/[A-Za-z0-9_-]{43}$/);
  const stored = st.invitations[0]; assert.equal(stored.token_hash, hashToken(tokenOf(inv.link))); assert.ok(!JSON.stringify(stored).includes(tokenOf(inv.link)), 'only the hash is stored');
  const dup = await code(svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'nouvelle@test.be', newRole: 'ADMIN' })); assert.equal(dup, 'DUPLICATE_PENDING');
  const first = tokenOf(inv.link);
  const re = await svc.resend({ ...ctx(A, 'own', 'OWNER'), invitationId: inv.invitation.id }); const second = tokenOf(re.link); assert.notEqual(first, second);
  assert.equal((await svc.inviteInfo(first)).state, 'INVALID', 'the old link no longer works'); assert.equal((await svc.inviteInfo(second)).state, 'PENDING');
  assert.equal(await code(svc.acceptInvite({ token: first, password: 'a-long-enough-password', name: 'X' })), 'INVITATION_INVALID');
  assert.equal(await code(svc.acceptInvite({ token: second, password: 'court' })), 'PASSWORD_INVALID');
  const ok = await svc.acceptInvite({ token: second, password: 'a-long-enough-password', name: 'Nora' }); assert.equal(ok.ok, true);
  const created = [...st.users.values()].find((u) => u.email === 'nouvelle@test.be'); assert.ok(created, 'the account carries the INVITED address');
  const member = st.members.find((m) => m.user_id === created.id); assert.equal(member.merchant_id, A); assert.equal(member.role, 'VIEWER'); assert.equal(member.status, 'ACTIVE');
  assert.equal(await code(svc.acceptInvite({ token: second, password: 'a-long-enough-password' })), 'INVITATION_ACCEPTED', 'single use');
  assert.equal((await svc.invitations(ctx(A, 'own', 'OWNER'))).invitations[0].status, 'ACCEPTED');
  // expiry, cancel
  const i2 = await svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'late@test.be', newRole: 'VIEWER' }); clock = new Date(clock.getTime() + 8 * 86_400_000);
  assert.equal((await svc.inviteInfo(tokenOf(i2.link))).state, 'EXPIRED'); assert.equal(await code(svc.acceptInvite({ token: tokenOf(i2.link), password: 'a-long-enough-password' })), 'INVITATION_EXPIRED');
  assert.equal((await svc.invitations(ctx(A, 'own', 'OWNER'))).invitations.find((i) => i.email === 'late@test.be').status, 'EXPIRED');
  const re2 = await svc.resend({ ...ctx(A, 'own', 'OWNER'), invitationId: i2.invitation.id }); assert.equal((await svc.inviteInfo(tokenOf(re2.link))).state, 'PENDING', 'an expired invitation can be resent');
  await svc.cancel({ ...ctx(A, 'own', 'OWNER'), invitationId: i2.invitation.id }); assert.equal((await svc.inviteInfo(tokenOf(re2.link))).state, 'CANCELLED');
  assert.equal(await code(svc.resend({ ...ctx(A, 'own', 'OWNER'), invitationId: i2.invitation.id })), 'NOT_RESENDABLE');
  clock = new Date(T0); void repo;
});

test('TM-7 acceptance: an existing account must prove itself (wrong password refused), the account e-mail must match, merchant and role come from the invitation, a removed person returns through a new invitation', async () => {
  const { svc, st } = world();
  const inv = await svc.invite({ ...ctx(B, 'ownB', 'OWNER'), email: 'viewer@a.test', newRole: 'ADMIN' }); const t = tokenOf(inv.link);
  const info = await svc.inviteInfo(t); assert.equal(info.accountExists, true); assert.equal(info.merchantName, 'Boutique B'); assert.equal(info.roleLabel, 'Administrateur');
  assert.equal(await code(svc.acceptInvite({ token: t, password: 'wrong-password-123456' })), 'CREDENTIALS_INVALID');
  assert.equal((await svc.acceptInvite({ token: t, password: 'correct-horse-battery' })).ok, true);
  assert.deepEqual(st.members.filter((m) => m.user_id === U.view).map((m) => [m.merchant_id, m.role]).sort(), [[A, 'VIEWER'], [B, 'ADMIN']], 'granted on B only; A untouched');
  // the database refuses a mismatch even if the Node layer were bypassed
  const inv2 = await svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'someone@test.be', newRole: 'VIEWER' }); const other = st.users.get(U.col);
  assert.deepEqual(await world().repo.inviteAccept({ tokenHash: 'x'.repeat(64), user: U.col, now: T0 }), { ok: false, code: 'INVITATION_INVALID' }); void inv2; void other;
  const direct = await createMemoryTeamRepository({ merchants: { [A]: 'A' }, users, members: [mm(A, 'own', 'OWNER')], invitations: [{ id: 'i1', merchant_id: A, email: 'someone@test.be', role: 'VIEWER', token_hash: hashToken('t'), status: 'PENDING', created_at: T0, sent_at: T0, expires_at: '2027-01-01T00:00:00Z', send_count: 1, invited_by: U.own }] }).inviteAccept({ tokenHash: hashToken('t'), user: U.col, now: T0 });
  assert.deepEqual(direct, { ok: false, code: 'EMAIL_MISMATCH' });
  // removed, then invited again: the same row is reopened with the invited role, history kept
  const w = world(); await w.svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.view, action: 'REMOVE' });
  const back = await w.svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'viewer@a.test', newRole: 'VIEWER' }); await w.svc.acceptInvite({ token: tokenOf(back.link), password: 'correct-horse-battery' });
  const row = w.st.members.filter((m) => m.merchant_id === A && m.user_id === U.view); assert.equal(row.length, 1); assert.equal(row[0].status, 'ACTIVE'); assert.equal(row[0].removed_at, null);
  assert.ok(w.st.events.some((e) => e.event_type === 'MEMBER_REMOVED'), 'the removal stays in the history');
});

test('TM-8 isolation between two merchants: invitations, members and events never cross; another merchant\'s invitation is NOT_FOUND', async () => {
  const { svc } = world();
  const ia = await svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'only-a@test.be', newRole: 'VIEWER' });
  assert.equal((await svc.invitations(ctx(B, 'ownB', 'OWNER'))).invitations.length, 0);
  assert.equal(await code(svc.cancel({ ...ctx(B, 'ownB', 'OWNER'), invitationId: ia.invitation.id })), 'NOT_FOUND');
  assert.equal(await code(svc.resend({ ...ctx(B, 'ownB', 'OWNER'), invitationId: ia.invitation.id })), 'NOT_FOUND');
  assert.equal(await code(svc.changeRole({ ...ctx(B, 'ownB', 'OWNER'), userId: U.view, newRole: 'ADMIN' })), 'NOT_FOUND', 'a member of A is unknown in B (U.view is only in A)');
  const hb = await svc.history(ctx(B, 'ownB', 'OWNER')); assert.ok(!hb.items.some((e) => e.subject?.label === 'only-a@test.be'));
  const ha = await svc.history(ctx(A, 'own', 'OWNER')); assert.equal(ha.items[0].label, 'Invitation envoyée'); assert.equal(ha.items[0].subject.label, 'only-a@test.be'); assert.equal(ha.items[0].actor, 'Olivia Owner');
  assert.equal(await code(svc.history(ctx(A, 'view', 'VIEWER'))), 'FORBIDDEN_ROLE');
});

test('TM-9 history: who did what to whom and when, old/new role, refusals; the journal and the answers contain no token, link or e-mail in the events', async () => {
  const { svc, st } = world();
  const inv = await svc.invite({ ...ctx(A, 'own', 'OWNER'), email: 'h@test.be', newRole: 'VIEWER' });
  await svc.changeRole({ ...ctx(A, 'own', 'OWNER'), userId: U.view, newRole: 'ADMIN' });
  await code(svc.setStatus({ ...ctx(A, 'own', 'OWNER'), userId: U.own, action: 'SUSPEND' }));
  const h = await svc.history(ctx(A, 'own', 'OWNER'));
  const role = h.items.find((e) => e.type === 'MEMBER_ROLE_CHANGED'); assert.deepEqual(role.change, { from: 'Lecture seule', to: 'Administrateur' }); assert.equal(role.subject.label, 'Vera Viewer');
  const denied = h.items.find((e) => e.type === 'MEMBER_ACTION_DENIED'); assert.match(denied.refusal, /dernier propriétaire/);
  const raw = JSON.stringify(st.events); assert.ok(!raw.includes(tokenOf(inv.link)) && !raw.includes('h@test.be') && !raw.includes('/invitation/'), 'journal: no token, link or address');
  const out = JSON.stringify(h); assert.ok(!out.includes(tokenOf(inv.link)) && !out.includes('token_hash'));
  const page1 = await svc.history({ ...ctx(A, 'own', 'OWNER'), limit: 2 }); assert.equal(page1.items.length, 2); assert.ok(page1.next); const page2 = await svc.history({ ...ctx(A, 'own', 'OWNER'), limit: 2, before: page1.next }); assert.notEqual(page2.items[0]?.id, page1.items[0].id);
});

// ------------------------------------------------------------------ HTTP host
const SESS = { owner: [A, U.own], admin: [A, U.adm], viewer: [A, U.view], colB: [B, U.ownB], multi: [A, U.multi] };
function bootHost({ origin = '' } = {}) {
  const w = world();
  // the fake access layer reads the CURRENT membership on every call (a session already open sees a change at once), like src/identity/access.js
  const identity = { context: { module: 'sourcing' }, resolveAccessSession: async (tok) => { const s = SESS[tok]; if (!s) return { ok: false }; const m = w.st.members.find((x) => x.merchant_id === s[0] && x.user_id === s[1]); return m && m.status === 'ACTIVE' ? { ok: true, merchantId: s[0], userId: s[1], role: m.role, module: 'sourcing' } : { ok: false }; }, authenticateAndOpenSession: async () => ({ ok: false }), logoutSession: async () => {} };
  const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }) }, guardRead: () => ({ ok: true }), guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; return req.headers['x-nordla-csrf'] === 'good' ? { ok: true, access: a, sessionToken: t } : { ok: false, code: 'CSRF_INVALID' }; } };
  const gate = createSessionGate({ identity, security });
  return { w, gate, origin };
}
async function serve(handlers) {
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); for (const h of handlers) if (await h.handle(req, res, url)) return; res.writeHead(404); res.end('nf'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { as, method = 'GET', body, csrf = 'good', headers = {} } = {}) => { const res = await fetch(base + path, { method, headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(body ? { 'content-type': 'application/json', ...(as ? { 'x-nordla-csrf': csrf } : {}) } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: res.status, json, text, headers: res.headers }; };
  return { call, close: () => server.close() };
}
const bootTeam = async (opts = {}) => { const b = bootHost(opts); const host = await createTeamHost({ gate: b.gate, merchantId: A, service: b.w.svc, origin: opts.origin ?? '' }); const s = await serve([host]); return { ...b, ...s }; };

test('TM-10 HTTP: session + merchant required, CSRF on changes, strict CSP, pages and assets served, rights readable by a viewer, members refused to a viewer', async () => {
  const t = await bootTeam();
  try {
    assert.equal((await t.call('/api/team')).status, 401); assert.equal((await t.call('/api/team', { as: 'colB' })).status, 403);
    const ov = await t.call('/api/team', { as: 'viewer' }); assert.equal(ov.status, 200); assert.equal(ov.json.canManage, false); assert.deepEqual(ov.json.sections.map((s) => s.locked), [true, true, false, true]);
    assert.equal((await t.call('/api/team/rights', { as: 'viewer' })).status, 200);
    for (const p of ['/api/team/members', '/api/team/invitations', '/api/team/history']) assert.equal((await t.call(p, { as: 'viewer' })).status, 403, p);
    assert.equal((await t.call('/api/team/invitations', { as: 'viewer', method: 'POST', body: { email: 'a@b.be', role: 'VIEWER' } })).status, 403);
    assert.equal((await t.call('/api/team/invitations', { as: 'owner', method: 'POST', body: { email: 'a@b.be', role: 'VIEWER' }, csrf: 'bad' })).status, 403, 'CSRF');
    const page = await t.call('/settings/team/roles'); assert.equal(page.status, 200); assert.match(page.text, /team-assets\/team\.js/); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/); assert.equal((await t.call('/settings/team/inconnu')).status, 404);
    for (const f of ['team.js', 'team.css', 'invitation.js', 'shell.js', 'connections.css']) assert.equal((await t.call(`/team-assets/${f}`)).status, 200, f);
    assert.match((await t.call('/invitation/' + 'a'.repeat(43))).text, /invitation\.js/);
  } finally { t.close(); }
});

test('TM-11 HTTP: a session ALREADY OPEN sees a role change, a suspension and a reactivation on its very next request', async () => {
  const t = await bootTeam();
  try {
    assert.equal((await t.call('/api/team/members', { as: 'admin' })).status, 200);
    let r = await t.call(`/api/team/members/${U.adm}/role`, { as: 'owner', method: 'POST', body: { role: 'VIEWER' } }); assert.equal(r.status, 200);
    assert.equal((await t.call('/api/team/members', { as: 'admin' })).status, 403, 'demoted: the same session is now read-only');
    r = await t.call(`/api/team/members/${U.adm}/role`, { as: 'owner', method: 'POST', body: { role: 'ADMIN' } }); assert.equal((await t.call('/api/team/members', { as: 'admin' })).status, 200, 'back to administrator');
    await t.call(`/api/team/members/${U.adm}/suspend`, { as: 'owner', method: 'POST', body: {} }); assert.equal((await t.call('/api/team', { as: 'admin' })).status, 401, 'suspended: session refused');
    await t.call(`/api/team/members/${U.adm}/reactivate`, { as: 'owner', method: 'POST', body: {} }); assert.equal((await t.call('/api/team', { as: 'admin' })).status, 200, 'reactivated');
    await t.call(`/api/team/members/${U.adm}/remove`, { as: 'owner', method: 'POST', body: {} }); assert.equal((await t.call('/api/team', { as: 'admin' })).status, 401, 'removed: refused');
    const e = await t.call(`/api/team/members/${U.own}/suspend`, { as: 'owner', method: 'POST', body: {} }); assert.equal(e.status, 409); assert.equal(e.json.error.code, 'LAST_OWNER'); assert.match(e.json.error.message, /dernier propriétaire/);
  } finally { t.close(); }
});

test('TM-12 HTTP public invitation: invite -> accept in a separate (no cookie) client; wrong origin, non-JSON and rate limit refused; the token never travels in an API URL', async () => {
  const t = await bootTeam({ origin: 'http://allowed.test' });
  try {
    const mk = await t.call('/api/team/invitations', { as: 'owner', method: 'POST', body: { email: 'guest@test.be', role: 'VIEWER' }, headers: { origin: 'http://allowed.test' } }); assert.equal(mk.status, 200);
    const token = tokenOf(mk.json.link); const hdr = { origin: 'http://allowed.test' };
    assert.equal((await t.call('/api/invitations/info', { method: 'POST', body: { token }, headers: { origin: 'http://evil.test' } })).status, 403);
    assert.equal((await t.call('/api/invitations/info', { method: 'GET', headers: hdr })).status, 405);
    const info = await t.call('/api/invitations/info', { method: 'POST', body: { token }, headers: hdr }); assert.equal(info.json.state, 'PENDING'); assert.equal(info.json.email, 'guest@test.be'); assert.ok(!('token' in info.json));
    assert.equal((await t.call('/api/invitations/info', { method: 'POST', body: { token: 'nope' }, headers: hdr })).json.state, 'INVALID');
    const acc = await t.call('/api/invitations/accept', { method: 'POST', body: { token, password: 'a-long-enough-password', name: 'Guest' }, headers: hdr }); assert.equal(acc.status, 200);
    const again = await t.call('/api/invitations/accept', { method: 'POST', body: { token, password: 'a-long-enough-password' }, headers: hdr }); assert.equal(again.status, 410);
    const guest = [...t.w.st.users.values()].find((u) => u.email === 'guest@test.be'); SESS.guest = [A, guest.id];
    const ov = await t.call('/api/team', { as: 'guest' }); assert.equal(ov.status, 200); assert.equal(ov.json.me.role, 'VIEWER'); delete SESS.guest;
    let last; for (let i = 0; i < 40; i += 1) last = await t.call('/api/invitations/info', { method: 'POST', body: { token: `x${i}` }, headers: hdr }); assert.equal(last.status, 429);
  } finally { t.close(); }
});

// ------------------------------------------------------------------ Général: a read-only member (closes the unverified point of Général)
test('TM-13 Général with a read-only member: consults it, the legal rubric is closed (API + overview), every save is refused server-side, and the effect is immediate on an open session', async () => {
  const w = world(); const generalRepo = createMemoryGeneralRepository({ merchants: { [A]: 'Boutique A' } }); const service = createGeneralService({ repo: generalRepo });
  const identity = { context: { module: 'sourcing' }, resolveAccessSession: async (tok) => { const s = SESS[tok]; const m = w.st.members.find((x) => x.merchant_id === s[0] && x.user_id === s[1]); return m && m.status === 'ACTIVE' ? { ok: true, merchantId: s[0], userId: s[1], role: m.role, module: 'sourcing' } : { ok: false }; }, authenticateAndOpenSession: async () => ({ ok: false }), logoutSession: async () => {} };
  const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }) }, guardRead: () => ({ ok: true }), guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; return req.headers['x-nordla-csrf'] === 'good' ? { ok: true, access: a, sessionToken: t } : { ok: false, code: 'CSRF_INVALID' }; } };
  const gate = createSessionGate({ identity, security }); const general = await createGeneralHost({ gate, merchantId: A, service }); const team = await createTeamHost({ gate, merchantId: A, service: w.svc }); const s = await serve([general, team]);
  try {
    const own = await s.call('/api/general/profile', { as: 'owner' }); assert.equal(own.status, 200);
    const saved = await s.call('/api/general/profile', { as: 'owner', method: 'POST', body: { data: { name: 'Boutique A', description: 'v1' }, expectedVersion: own.json.version ?? null } }); assert.equal(saved.status, 200);
    // viewer: consult
    const ov = await s.call('/api/general', { as: 'viewer' }); assert.equal(ov.status, 200); assert.equal(ov.json.canWrite, false); assert.equal(ov.json.sections.find((x) => x.id === 'legal').locked, true);
    for (const sec of ['profile', 'activity', 'establishments', 'selling_modes', 'regional', 'objectives']) assert.equal((await s.call(`/api/general/${sec}`, { as: 'viewer' })).status, 200, `viewer reads ${sec}`);
    // viewer: legal closed on EVERY path that could return it
    assert.equal((await s.call('/api/general/legal', { as: 'viewer' })).status, 403); assert.equal((await s.call('/api/general/legal-check', { as: 'viewer' })).status, 403);
    const ctxLegal = await s.call('/api/general/context?module=marketing', { as: 'viewer' }); assert.equal(ctxLegal.status, 200); assert.ok(!('legal' in ctxLegal.json), 'the context endpoint never carries the legal rubric');
    for (const m of ['core', 'marketing', 'growth', 'stock', 'analytics', 'creative', 'sourcing']) assert.ok(!('legal' in (await s.call(`/api/general/context?module=${m}`, { as: 'viewer' })).json), m);
    // viewer: every write refused by the SERVER (CSRF valid, session valid)
    const v1 = await s.call('/api/general/profile', { as: 'viewer', method: 'POST', body: { data: { name: 'Pirate', description: 'hack' }, expectedVersion: saved.json.version } }); assert.equal(v1.status, 403); assert.equal(v1.json.error.code, 'FORBIDDEN_ROLE');
    assert.equal((await s.call('/api/general/regional', { as: 'viewer', method: 'POST', body: { data: { currency: 'EUR', timezone: 'Europe/Brussels' }, expectedVersion: null } })).status, 403);
    assert.equal((await s.call('/api/general/establishments', { as: 'viewer', method: 'POST', body: { establishment: { name: 'X' }, expectedVersion: null } })).status, 403);
    assert.equal((await s.call('/api/general/legal', { as: 'viewer', method: 'POST', body: { data: { legal_name: 'X' }, expectedVersion: null } })).status, 403);
    assert.equal((await s.call('/api/general/profile', { as: 'viewer' })).json.data.description, 'v1', 'nothing was changed');
    // the same open session after being promoted to administrator: it may now write, and the legal rubric opens
    await s.call(`/api/team/members/${U.view}/role`, { as: 'owner', method: 'POST', body: { role: 'ADMIN' } });
    assert.equal((await s.call('/api/general/legal', { as: 'viewer' })).status, 200, 'promoted: the legal rubric opens at once');
    await s.call(`/api/team/members/${U.view}/role`, { as: 'owner', method: 'POST', body: { role: 'VIEWER' } });
    assert.equal((await s.call('/api/general/legal', { as: 'viewer' })).status, 403, 'demoted: closed again at once');
    // the team API says the same
    assert.equal((await s.call('/api/team/members', { as: 'viewer' })).status, 403);
  } finally { s.close(); }
});

test('TM-14 the model refuses nothing silently: refusal messages exist for every code the SQL can return, and TeamError is typed', () => {
  for (const c of ['LAST_OWNER', 'FORBIDDEN', 'SELF_PROMOTION', 'ALREADY_MEMBER', 'DUPLICATE_PENDING', 'MEMBER_REMOVED', 'NOT_RESENDABLE', 'NOT_CANCELLABLE', 'TARGET_NOT_MEMBER']) assert.ok(M.REFUSAL[c], c);
  assert.ok(new TeamError('X', 'm') instanceof Error);
});

// ------------------------------------------------------------------ China Sourcing: roles enforced server-side (not only hidden)
test('TM-15 China Sourcing: a read-only member reads but every change is refused by the SERVER (API included); OWNER/ADMIN still save; the grid says so', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createSourcingApp, SOURCING_WRITERS } = await import('../src/sourcing/server/app.js'); const { createFileStore } = await import('../src/sourcing/store/file-store.js'); const { newCase } = await import('../src/sourcing/core/case.js');
  const dir = await mkdtemp(join(tmpdir(), 'tm15-')); const w = bootHost(); const store = createFileStore(dir);
  const app = createSourcingApp({ token: 'x'.repeat(32), gate: w.gate, store, uiDir: dir, coreDir: dir, allowedHosts: null });
  const s = await serve([{ handle: async (req, res) => { await app.handler(req, res); return true; } }]);
  try {
    assert.deepEqual([...SOURCING_WRITERS].sort(), ['ADMIN', 'COLLABORATOR', 'OWNER']); assert.equal(M.MODULE_RIGHTS.find((m) => m.id === 'sourcing').levels.VIEWER, 'view', 'the grid now states the enforced rule');
    const c = newCase({ id: 'case-1', name: 'gourde', now: new Date('2026-11-18T08:00:00Z') });
    assert.equal((await s.call('/api/cases/case-1', { as: 'owner', method: 'PUT', body: c })).status, 200, 'owner saves');
    assert.equal((await s.call('/api/cases/case-1', { as: 'admin', method: 'PUT', body: c })).status === 403, false, 'admin is not refused by the role gate');
    assert.equal((await s.call('/api/cases', { as: 'viewer' })).status, 200, 'viewer lists'); assert.equal((await s.call('/api/cases/case-1', { as: 'viewer' })).status, 200, 'viewer reads');
    const put = await s.call('/api/cases/case-1', { as: 'viewer', method: 'PUT', body: { ...c, name: 'piraté' } }); assert.equal(put.status, 403); assert.equal(put.json.error, 'FORBIDDEN_ROLE');
    assert.equal((await s.call('/api/cases/case-1', { as: 'viewer', method: 'DELETE', body: {} })).status, 403);
    assert.equal((await s.call('/api/field/workspace', { as: 'viewer', method: 'PUT', body: { x: 1 } })).status, 403);
    assert.equal((await s.call('/api/documents/extract', { as: 'viewer', method: 'POST', body: {} })).status, 403);
    assert.equal((await s.call('/api/core/ask', { as: 'viewer', method: 'POST', body: {} })).status === 403, false, 'asking Nordla is a read');
    assert.ok(!(await s.call('/api/cases/case-1', { as: 'viewer' })).text.includes('piraté'), 'nothing was changed');
  } finally { s.close(); await rm(dir, { recursive: true, force: true }); }
});

test('TM-16 the Équipe et accès card does not lead to a 404 when the module is off', async () => {
  const { createConnectionsService } = await import('../src/connections/service.js'); const { createRegistry } = await import('../src/connections/registry.js');
  const mk = (disabledSections) => createConnectionsService({ registry: createRegistry(), disabledSections });
  const off = await mk(['team']).settings({ tenant: { merchantId: A }, role: 'OWNER' }); const c = off.cards.find((x) => x.id === 'team'); assert.deepEqual([c.available, c.href], [false, null]);
  const on = await mk([]).settings({ tenant: { merchantId: A }, role: 'OWNER' }); assert.deepEqual([on.cards.find((x) => x.id === 'team').available, on.cards.find((x) => x.id === 'team').href], [true, '/settings/team']);
});
