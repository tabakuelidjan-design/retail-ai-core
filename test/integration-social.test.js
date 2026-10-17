// Social Publishing (chantier E) wired into src/integration: discovery, ownership, authorisation, no publication without the owner's signed approval, errors, credentials bridge,
// end-to-end in SIMULATED mode. No network, no Meta, no real credential: fakes and simulated publishers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIntegration, MODULE as M, ENTITY as E, MODULE_MAP, OWNERSHIP, authorize, ACTION_POLICY, LEVEL, ERR, assertCanRead, assertCanWrite,
} from '../src/integration/index.js';
import { createSimulatedPublisher } from '../src/social/providers/simulated.js';
import { createChannelCredentialBridge } from '../src/social/credential-bridge.js';
import { createInMemoryCredentialProvider } from '../src/activation/credential-provider.js';
import { PROPOSAL_SCHEMA } from '../src/social/constants.js';
import {
  OWNER, asset, runtime,
} from './social-fixtures.js';

const TENANT = '00000000-0000-0000-0000-0000000000f1';
const CONNECTOR = '00000000-0000-0000-0000-0000000000c1';
const SECRET = 'IGAA-bridge-secret-token-0001-abcdefghij';
const wf = (n = 'wf-1') => ({ workflow_id: n, initiated_by: 'tester', from: M.CREATIVE });
const proposal = (over = {}) => ({
  schema: PROPOSAL_SCHEMA, proposal_id: 'd-2026-10-17-integ', producer: 'chantier-d', asset: asset(),
  subject: { kind: 'product', ref: 'shopify://product/coque-voyage', label: 'Coque voyage' }, caption: 'Une coque qui voyage avec vous. Fabriquée à Namur.',
  hashtags: ['habb', 'namur'], suggested_date: '2026-10-17T17:00:00Z', targets: [{ platform: 'instagram', format: 'IMAGE' }], ...over,
});
function world({ withSocial = true, credentialPort = null } = {}) {
  const sim = createSimulatedPublisher('instagram');
  const rt = runtime({ extraPublishers: { instagram: sim } });
  const integration = createIntegration({ tenant_id: TENANT, ...(withSocial ? { social: { service: rt.service, credentialPort } } : {}) });
  return { rt, sim, integration };
}
const snapshotOf = async (rt) => JSON.stringify(await rt.service.list());

test('IS-1 discovery: the module is in the map with readiness and reference; the hub lists it when wired, and answers MODULE_NOT_AVAILABLE (no crash) when not', async () => {
  const m = MODULE_MAP[M.SOCIAL_PUBLISHING];
  assert.ok(m.readiness && m.ref?.branch && m.ref?.sha);
  assert.match(m.readiness, /SIMULATED_ONLY/, 'readiness is honest: no real publication verified');
  for (const dep of Object.keys(m.depends)) assert.ok(MODULE_MAP[dep], `dependency ${dep} exists`);
  const on = world();
  assert.ok(on.integration.hub.modules().includes(M.SOCIAL_PUBLISHING));
  const off = world({ withSocial: false });
  assert.ok(!off.integration.hub.modules().includes(M.SOCIAL_PUBLISHING));
  const r = await off.integration.call(M.SOCIAL_PUBLISHING, 'read_calendar', {}, wf());
  assert.equal(r.status, 'MODULE_NOT_AVAILABLE'); assert.equal(r.code, ERR.MODULE_NOT_AVAILABLE);
  const down = createIntegration({ tenant_id: TENANT, social: { service: on.rt.service }, unavailable: [M.SOCIAL_PUBLISHING] });
  assert.equal((await down.call(M.SOCIAL_PUBLISHING, 'read_calendar', {}, wf())).status, 'MODULE_NOT_AVAILABLE');
});

test('IS-2 ownership: Social Publishing alone writes a social post; Creative and Marketing may read it, Buying may not', () => {
  assert.equal(OWNERSHIP[E.SOCIAL_POST].owner, M.SOCIAL_PUBLISHING);
  assert.doesNotThrow(() => assertCanWrite(M.SOCIAL_PUBLISHING, E.SOCIAL_POST));
  for (const other of [M.CREATIVE, M.MARKETING, M.ACTIVATION, M.BUYING]) assert.throws(() => assertCanWrite(other, E.SOCIAL_POST), (e) => e.code === ERR.OWNERSHIP_VIOLATION, other);
  assert.doesNotThrow(() => assertCanRead(M.CREATIVE, E.SOCIAL_POST));
  assert.throws(() => assertCanRead(M.BUYING, E.SOCIAL_POST), (e) => e.code === ERR.OWNERSHIP_VIOLATION);
});

test('IS-3 authorisation: reads are open, a proposal is a draft for review, approve / schedule / publish are BLOCKED even with a human approval record', () => {
  for (const c of ['read_calendar', 'read_post', 'read_connections']) assert.equal(authorize(`${M.SOCIAL_PUBLISHING}.${c}`).decision, 'ALLOW', c);
  assert.equal(authorize(`${M.SOCIAL_PUBLISHING}.propose_post`).decision, 'REVIEW_REQUIRED');
  for (const c of ['approve_post', 'schedule_post', 'publish_now']) {
    const action = `${M.SOCIAL_PUBLISHING}.${c}`;
    assert.equal(ACTION_POLICY[action], LEVEL.BLOCKED, c);
    const human = { action, subject_ref: 'nordla:post:x', approver: { kind: 'HUMAN', id: 'owner-1', role: 'OWNER' }, approved_at: '2026-10-17T08:00:00Z' };
    assert.equal(authorize(action, { approvals: [human], subject_ref: 'nordla:post:x' }).decision, 'BLOCK', `${c} stays blocked with an approval record`);
  }
  assert.equal(authorize(`${M.SOCIAL_PUBLISHING}.delete_everything`).decision, 'BLOCK', 'default deny');
});

test('IS-4 Creative proposes through the hub: a draft for review is created, nothing is approved, scheduled or published; approve / publish through the hub change nothing', async () => {
  const { rt, sim, integration } = world();
  const r = await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [proposal()] }, wf());
  assert.equal(r.ok, true); assert.equal(r.status, 'REVIEW_REQUIRED', 'the result is marked pending owner review');
  assert.equal(r.result.proposed, 1); assert.equal(r.result.published, 0);
  const [post] = await rt.service.list();
  assert.equal(post.state, 'READY_FOR_REVIEW');
  assert.equal(post.approval ?? null, null, 'no approval was created');
  const before = await snapshotOf(rt);
  for (const c of ['approve_post', 'schedule_post', 'publish_now']) {
    const out = await integration.call(M.SOCIAL_PUBLISHING, c, { post_id: post.id }, wf(`wf-${c}`));
    assert.equal(out.ok, false, c); assert.equal(out.status, 'BLOCKED', c); assert.equal(out.code, ERR.ACTION_BLOCKED, c);
  }
  assert.equal(await snapshotOf(rt), before, 'blocked calls changed nothing');
  assert.equal(sim.calls.length, 0, 'the platform was never called');
  const read = await integration.call(M.SOCIAL_PUBLISHING, 'read_post', { post_id: post.id }, wf('wf-read'));
  assert.equal(read.result.approval_valid, false); assert.equal(read.result.published, false);
  assert.equal(JSON.stringify(read.result).includes('Fabriquée'), false, 'no caption body in an integration result');
});

test('IS-5 end to end, SIMULATED: proposal -> owner approves and schedules in the owner flow -> the publisher publishes once; without the owner nothing goes out', async () => {
  const { rt, sim, integration } = world();
  await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [proposal()] }, wf());
  const [post] = await rt.service.list();
  // not approved yet: the due time comes and nothing is published
  rt.clock.now = Date.parse('2026-10-17T17:05:00Z');
  await rt.publisher.runDue();
  assert.equal(sim.calls.length, 0);
  // the owner decides, in the owner flow (signed approval bound to the exact content)
  rt.clock.now = Date.parse('2026-10-17T08:30:00Z');
  const hash = rt.service.contentHashOf(await rt.service.get(post.id));
  await rt.service.act(post.id, 'approve', OWNER, { expected_hash: hash });
  await rt.service.act(post.id, 'schedule', OWNER, { expected_hash: hash });
  const calendar = await integration.call(M.SOCIAL_PUBLISHING, 'read_calendar', { state: 'SCHEDULED' }, wf('wf-cal'));
  assert.equal(calendar.result.count, 1); assert.equal(calendar.result.posts[0].approval_valid, true);
  rt.clock.now = Date.parse('2026-10-17T17:05:00Z');
  await rt.publisher.runDue(); await rt.publisher.runDue();
  assert.equal(sim.calls.length, 1, 'published once, by the simulated publisher');
  const after = await rt.service.get(post.id);
  assert.equal(after.state, 'PUBLISHED'); assert.equal(after.publication.mode, 'SIMULATION');
  assert.notEqual(after.state, 'VERIFIED', 'a simulated publication is never verified');
  // the trace ledger shows only integration calls, with no token and no caption
  const entries = integration.ledger.list();
  assert.ok(entries.length === 2 && entries.every((e) => e.destination_module === M.SOCIAL_PUBLISHING), 'every call is traced');
  assert.equal(integration.ledger.verify().ok, true, 'the trace chain is intact');
  assert.equal(JSON.stringify(entries).includes('Fabriquée'), false, 'no caption in the ledger');
});

test('IS-6 a forged "approved" post written into the store is not published, and the integration read shows it as not validly approved', async () => {
  const { rt, sim, integration } = world();
  await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [proposal()] }, wf());
  const [post] = await rt.service.list();
  await rt.store.update(post.id, (p) => ({ ...p, rev: p.rev + 1, state: 'SCHEDULED', approval: { approved_by: 'owner:habb', approved_at: '2026-10-17T08:00:00.000Z', content_hash: rt.service.contentHashOf(p) } }));
  const read = await integration.call(M.SOCIAL_PUBLISHING, 'read_post', { post_id: post.id }, wf('wf-forged'));
  assert.equal(read.result.approval_valid, false);
  rt.clock.now = Date.parse('2026-10-17T17:05:00Z');
  await rt.publisher.runDue();
  assert.equal(sim.calls.length, 0);
});

test('IS-7 errors are reported, never thrown: unknown post, empty or invalid proposals, a store failure', async () => {
  const { rt, integration } = world();
  const unknown = await integration.call(M.SOCIAL_PUBLISHING, 'read_post', { post_id: 'post_does-not-exist' }, wf());
  assert.equal(unknown.ok, false); assert.equal(unknown.code, ERR.HANDOFF_INVALID);
  const empty = await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [] }, wf('wf-2'));
  assert.equal(empty.ok, false); assert.equal(empty.code, ERR.HANDOFF_INVALID);
  const bad = await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [{ ...proposal(), schema: 'wrong' }] }, wf('wf-3'));
  assert.equal(bad.ok, true); assert.equal(bad.result.proposed, 0); assert.equal(bad.result.report[0].result, 'REJECTED');
  assert.equal((await rt.service.list()).length, 0);
  const broken = createIntegration({ tenant_id: TENANT, social: { service: { ...rt.service, list: async () => { throw new Error('disk full'); } } } });
  const failed = await broken.call(M.SOCIAL_PUBLISHING, 'read_calendar', {}, wf('wf-4'));
  assert.equal(failed.ok, false); assert.equal(failed.status, 'ERROR');
  assert.throws(() => createIntegration({ tenant_id: TENANT, social: { service: {} } }), (e) => e.code === ERR.HANDOFF_INVALID);
});

test('IS-8 an identical proposal under another id is reported as a duplicate (D4) and the integration cannot publish it', async () => {
  const { rt, sim, integration } = world();
  await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [proposal()] }, wf());
  const second = await integration.call(M.SOCIAL_PUBLISHING, 'propose_post', { proposals: [proposal({ proposal_id: 'd-2026-10-17-twin' })] }, wf('wf-twin'));
  assert.equal(second.result.report[0].duplicate_of.length, 1);
  assert.equal(sim.calls.length, 0);
  assert.equal((await rt.service.list()).length, 2);
});

test('IS-9 credentials: the bridge reuses the platform Provider/Credentials interfaces; views are secret-free; unconfigured, wrong or expired connectors give no credential', async () => {
  const connectors = [{ id: CONNECTOR, merchantId: TENANT, kind: 'instagram', externalId: '17841400000000001', status: 'CONFIGURED', config: {} }];
  const provider = createInMemoryCredentialProvider({ [`${TENANT}:${CONNECTOR}`]: { access_token: SECRET, expires_at: '2027-01-01T00:00:00Z' } });
  const bridge = createChannelCredentialBridge({ credentialProvider: provider, connectors, merchantId: TENANT, connectorIds: { instagram: CONNECTOR }, now: () => Date.parse('2026-10-17T08:00:00Z') });
  const cred = await bridge.resolve('instagram');
  assert.equal(cred.account_id, '17841400000000001'); assert.equal(cred.access_token, SECRET); assert.equal(cred.expires_at, '2027-01-01T00:00:00.000Z');
  assert.equal(provider.calls[0].purpose, 'social_publishing');
  assert.equal(await bridge.resolve('facebook'), null, 'the platform has no Facebook Page provider kind: honestly not configured');
  assert.equal(bridge.describe('facebook').state, 'NOT_CONFIGURED');
  assert.equal(bridge.describe('instagram').state, 'OK');
  // the integration read of connections: states and accounts only
  const { integration } = world({ credentialPort: bridge });
  const r = await integration.call(M.SOCIAL_PUBLISHING, 'read_connections', {}, wf('wf-conn'));
  assert.equal(JSON.stringify(r).includes(SECRET), false); assert.equal(JSON.stringify(integration.ledger.list()).includes(SECRET), false);
  assert.deepEqual(r.result.connections.map((c) => [c.platform, c.state]), [['instagram', 'OK'], ['facebook', 'NOT_CONFIGURED']]);
  // not designated / other merchant / not configured / expired / provider down
  const none = createChannelCredentialBridge({ credentialProvider: provider, connectors, merchantId: TENANT, connectorIds: {} });
  assert.equal(await none.resolve('instagram'), null);
  const stranger = createChannelCredentialBridge({ credentialProvider: provider, connectors, merchantId: '00000000-0000-0000-0000-0000000000f2', connectorIds: { instagram: CONNECTOR } });
  assert.equal(await stranger.resolve('instagram'), null);
  const off = createChannelCredentialBridge({ credentialProvider: provider, connectors: [{ ...connectors[0], status: 'NOT_CONFIGURED' }], merchantId: TENANT, connectorIds: { instagram: CONNECTOR } });
  assert.equal(await off.resolve('instagram'), null); assert.equal(off.describe('instagram').state, 'NOT_CONFIGURED');
  const expired = createChannelCredentialBridge({ credentialProvider: provider, connectors, merchantId: TENANT, connectorIds: { instagram: CONNECTOR }, now: () => Date.parse('2028-01-01T00:00:00Z') });
  assert.equal(await expired.resolve('instagram'), null); assert.equal(expired.describe('instagram').state, 'EXPIRED');
  const down = createChannelCredentialBridge({ credentialProvider: createInMemoryCredentialProvider({}, { failWith: 'CREDENTIAL_UNAVAILABLE' }), connectors, merchantId: TENANT, connectorIds: { instagram: CONNECTOR } });
  assert.equal(await down.resolve('instagram'), null); assert.equal(down.describe('instagram').state, 'UNAVAILABLE');
  assert.equal(JSON.stringify([bridge.describe('instagram'), expired.describe('instagram')]).includes(SECRET), false);
});

test('IS-10 no regression: an integration without Social Publishing behaves as before (the other modules, the shared policy, the module map)', async () => {
  const { integration } = world({ withSocial: false });
  assert.ok(!integration.hub.modules().includes(M.SOCIAL_PUBLISHING));
  assert.ok(integration.hub.modules().includes(M.CHINA_SOURCING) && integration.hub.modules().includes(M.BUYING), 'the existing adapters are still there');
  for (const [id, m] of Object.entries(MODULE_MAP)) { assert.ok(m.readiness, id); assert.ok(m.ref?.branch && m.ref?.sha, id); }
  assert.equal(ACTION_POLICY[`${M.BUYING}.place_order`], LEVEL.OWNER_APPROVAL_REQUIRED);
  assert.equal(ACTION_POLICY[`${M.MARKETING}.publish`], LEVEL.OWNER_APPROVAL_REQUIRED);
  assert.equal(ACTION_POLICY[`${M.CREATIVE}.call_live_provider`], LEVEL.BLOCKED);
});
