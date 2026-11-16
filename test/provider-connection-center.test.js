import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/provider-connections/index.js';
import {
  GBP_LOCATIONS, IG_ACCOUNT, M1, M2, SECRETS, TT_OPEN_ID, allRoutes, allSecrets, connect, connectorRows, igRoutes, makeRuntime, sessionRows, tenantOf, ttRoutes, googleRoutes,
} from './provider-fixtures.js';

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const LOC1 = 'accounts/111/locations/222';
const LOC2 = 'accounts/111/locations/333';

async function threeBound() {
  const ctx = makeRuntime();
  const ig = await connect(ctx, 'instagram', { externalId: IG_ACCOUNT });
  const tt = await connect(ctx, 'tiktok', { externalId: TT_OPEN_ID });
  const gg = await connect(ctx, 'google_business_profile', { externalId: LOC1 });
  return { ctx, ig: ig.bound.connector_id, tt: tt.bound.connector_id, gg: gg.bound.connector_id };
}

test('Connection Center: lists every provider connector, secret-free, with the live state and readiness', async () => {
  const { ctx, ig, tt, gg } = await threeBound();
  const list = await ctx.rt.connectionCenter.listConnections({ tenant: ctx.tenant }); // 67
  assert.deepEqual(list.map((c) => c.provider).sort(), ['google_business_profile', 'instagram', 'tiktok']);
  assert.deepEqual(list.map((c) => c.connector_id).sort(), [ig, tt, gg].sort());
  assert.ok(list.every((c) => c.connection_state === 'CONFIGURED' && c.live_readiness.level === 'VERIFIED' && c.merchant_id === M1));
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]));
  const text = JSON.stringify(list); // 68
  assert.ok(!allSecrets().some((s) => text.includes(s)));
  assert.deepEqual(P.findSecretLeaks(list), []);
  assert.doesNotMatch(Object.keys(list[0]).join(' '), /token|secret|code|verifier/i);
  const ttCredential = list.find((c) => c.provider === 'tiktok').grant;
  assert.deepEqual([ttCredential.status, ttCredential.scopes, ttCredential.refreshable, ttCredential.rotation_version], ['ACTIVE', ['video.publish'], true, 1]);
  const ig0 = list.find((c) => c.provider === 'instagram');
  assert.deepEqual([ig0.external_id, ig0.account_state, ig0.external_display_name], [IG_ACCOUNT, 'Business', 'habb.be']);
  assert.ok(ig0.capabilities.required_scopes.includes('instagram_business_content_publish')); // the Activation view is reused as is
});

test('Connection Center flow: starting, the session reference, the mandatory target selection and the status', async () => {
  const ctx = makeRuntime();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'google_business_profile', returnTo: '/connections' }); // 69
  assert.match(started.authorization_url, /^https:\/\/accounts\.google\.com\//);
  assert.match(started.session_ref, /^[0-9a-f-]{36}$/); // 70
  assert.deepEqual([sessionRows(ctx)[0].id, sessionRows(ctx)[0].status], [started.session_ref, 'PENDING']);
  assert.equal(await acode(ctx.rt.connectionCenter.listTargets({ tenant: ctx.tenant, sessionRef: started.session_ref })), 'PC_SESSION_STATE_CONFLICT'); // nothing authorized yet
  const flow = await connect(ctx, 'google_business_profile');
  assert.equal(flow.targets.selection_required, true); // 71
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: flow.started.session_ref })), 'PC_TARGET_REQUIRED');
  assert.equal(connectorRows(ctx).length, 0);
  const bound = await ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: flow.started.session_ref, externalId: LOC2 });
  const status = await ctx.rt.connectionCenter.getConnectionStatus({ tenant: ctx.tenant, connectorId: bound.connector_id }); // 72
  assert.deepEqual([status.connection_state, status.live_readiness.level, status.external_id, status.status], ['CONFIGURED', 'VERIFIED', LOC2, 'CONFIGURED']);
  assert.deepEqual(status.live_readiness.blockers, ['MEDIA_DELIVERY_REQUIRED', 'PROVIDER_REVIEW_REQUIRED', 'CONSENT_COMPLIANCE_REQUIRED', 'SCOPES_APPROVAL_REQUIRED'].sort()); // production-eligible needs facts the backend cannot invent
  assert.equal(sessionRows(ctx).find((s) => s.id === flow.started.session_ref).status, 'BOUND');
  const verified = await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: bound.connector_id }); // 73
  assert.deepEqual([verified.state, verified.persist_status], ['CONFIGURED', 'CONFIGURED']);
});

test('Reconnect, disconnect and several connectors of one provider: identity is stable, nothing is picked implicitly', async () => {
  const { ctx, ig, gg } = await threeBound();
  const before = await ctx.credentialStore.readMetadata({ merchantId: M1, connectorId: gg });
  const re = await ctx.rt.connectionCenter.reconnect({ tenant: ctx.tenant, connectorId: gg }); // 74
  assert.match(re.authorization_url, /accounts\.google\.com/);
  const state = new URL(re.authorization_url).searchParams.get('state');
  await ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'google_business_profile', query: { code: SECRETS.code, state } });
  const again = await ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: re.session_ref, externalId: LOC1 });
  assert.equal(again.connector_id, gg); // the same account: the same connector (credential rotated, identity unchanged)
  assert.equal(connectorRows(ctx).filter((c) => c.kind === 'google_business_profile').length, 1);
  assert.equal((await ctx.credentialStore.readMetadata({ merchantId: M1, connectorId: gg })).rotation_version, before.rotation_version + 1);
  const second = await connect(ctx, 'google_business_profile', { externalId: LOC2 }); // 76: another location is another connector
  assert.notEqual(second.bound.connector_id, gg);
  const list = await ctx.rt.connectionCenter.listConnections({ tenant: ctx.tenant });
  assert.equal(list.filter((c) => c.provider === 'google_business_profile').length, 2);
  assert.deepEqual(list.filter((c) => c.provider === 'google_business_profile').map((c) => c.external_id).sort(), [LOC1, LOC2]);
  assert.equal(await acode(ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: undefined })), 'PC_INVALID_FIELD'); // 77: no id, no guess
  assert.equal(await acode(ctx.rt.connectionCenter.getConnectionStatus({ tenant: ctx.tenant, connectorId: 'a9999999-9999-4999-8999-999999999999' })), 'PC_CONNECTOR_NOT_FOUND');
  const gone = await ctx.rt.connectionCenter.disconnect({ tenant: ctx.tenant, connectorId: ig }); // 75
  assert.deepEqual([gone.status, gone.local_revoked, gone.remote_revoked], ['NOT_CONFIGURED', true, false]);
  assert.equal(connectorRows(ctx).some((c) => c.id === ig), true); // the connector row (and with it the publication history) is kept
  const status = await ctx.rt.connectionCenter.getConnectionStatus({ tenant: ctx.tenant, connectorId: ig });
  assert.deepEqual([status.connection_state, status.grant.status, status.review_signals.includes('NO_CREDENTIAL')], ['NOT_CONFIGURED', 'REVOKED', true]);
  assert.equal(ctx.credentialStore._secrets.size, 3); // 2 Google + TikTok remain, Instagram's secret is destroyed
});

test('Isolation: another merchant sees nothing, cannot select into or disconnect someone else, and sessions stay with their merchant', async () => {
  const { ctx, ig } = await threeBound();
  const other = tenantOf(M2);
  assert.deepEqual([...await ctx.rt.connectionCenter.listConnections({ tenant: other })], []); // 78
  assert.equal(await acode(ctx.rt.connectionCenter.getConnectionStatus({ tenant: other, connectorId: ig })), 'PC_CONNECTOR_NOT_FOUND');
  assert.equal(await acode(ctx.rt.connectionCenter.verify({ tenant: other, connectorId: ig })), 'PC_CONNECTOR_NOT_FOUND');
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'instagram' });
  const state = new URL(started.authorization_url).searchParams.get('state');
  await ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'instagram', query: { code: SECRETS.code, state } });
  assert.equal(await acode(ctx.rt.connectionCenter.listTargets({ tenant: other, sessionRef: started.session_ref })), 'PC_SESSION_NOT_FOUND');
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: other, sessionRef: started.session_ref, externalId: IG_ACCOUNT })), 'PC_SESSION_NOT_FOUND');
  assert.equal(await acode(ctx.rt.connectionCenter.listConnections({ tenant: { merchantId: M1, source: 'query-string' } })), 'PC_TENANT_INVALID'); // the tenant is the server context, nothing else
  assert.equal(sessionRows(ctx).every((s) => s.merchant_id === M1), true);
});

test('Runtime states are never stored and CONFIGURED needs a successful verification', async () => {
  const { ctx, ig } = await threeBound();
  const updatesBefore = ctx.db.calls.filter((c) => c.m === 'update' && c.table === 'merchant_connectors').length;
  const outage = makeRuntime();
  const flow = await connect(outage, 'tiktok', { externalId: TT_OPEN_ID });
  const store = outage.credentialStore;
  const original = store.readMerchantCredential.bind(store);
  store.readMerchantCredential = async () => { throw new P.ProvisioningError(P.PC_ERROR.VAULT_UNAVAILABLE, 'down'); }; // the Vault goes away
  const v = await outage.rt.connectionCenter.verify({ tenant: outage.tenant, connectorId: flow.bound.connector_id }); // 79
  assert.deepEqual([v.state, v.persist_status, connectorRows(outage)[0].status], ['UNAVAILABLE', null, 'CONFIGURED']);
  store.readMerchantCredential = original;
  assert.equal(ctx.db.calls.filter((c) => c.m === 'update' && c.table === 'merchant_connectors').length, updatesBefore + 0);
  let me = 0; // 80: the account answers three times (listing, discovery and re-verification at bind time) and then goes down: the binding must NOT become CONFIGURED
  const routes = [{ method: 'GET', url: '/me', respond: () => { me += 1; return me <= 3 ? { status: 200, headers: {}, body: { user_id: IG_ACCOUNT, username: 'habb.be', account_type: 'Business' } } : { status: 503, headers: {}, body: {} }; } }, ...igRoutes().slice(0, 3), ...ttRoutes(), ...googleRoutes()];
  const flaky = makeRuntime({ routes });
  const f = await connect(flaky, 'instagram', { externalId: IG_ACCOUNT });
  assert.equal(f.bound.verification.state, 'UNAVAILABLE');
  assert.equal(connectorRows(flaky)[0].status, 'NOT_CONFIGURED'); // linked, credential stored, but never CONFIGURED without a successful verification
  assert.equal(sessionRows(flaky)[0].status, 'AUTHORIZED'); // not bound: the merchant can retry
  assert.equal(flaky.sessionSecrets._entries.size, 1); // the pending tokens wait for the retry
  assert.equal(ig.length > 0 && M2.length > 0 && allRoutes().length > 0 && GBP_LOCATIONS.length > 0, true);
});
