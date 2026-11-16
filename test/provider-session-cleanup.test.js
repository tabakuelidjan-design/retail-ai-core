import test from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../src/activation/index.js';
import * as P from '../src/provider-connections/index.js';
import { PENDING_BINDING_TTL_MS, SESSION_TTL_MS } from '../src/provider-connections/constants.js';
import { createFakeHttp, gbpRoutes, NOW } from './channel-fixtures.js';
import {
  GBP_LOCATIONS, IG_ACCOUNT, M1, M2, SECRETS, allSecrets, connect, connectorRows, makeRuntime, sessionRows, tenantOf,
} from './provider-fixtures.js';

// Audit additions after the 115-case matrix (cases 116-125): temporary OAuth secret lifecycle and Google location normalization.

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const LOC1 = 'accounts/111/locations/222';
const heldBy = (ctx, sessionId) => [...ctx.sessionSecrets._entries.keys()].filter((k) => k.includes(sessionId));
const cleanup = (ctx, over = {}) => ctx.rt.provisioning.cleanupExpiredOAuthSessions({ tenant: ctx.tenant, ...over });
const afterAuthorizationWindow = (ctx) => { ctx.clock.t += SESSION_TTL_MS + PENDING_BINDING_TTL_MS + 60_000; };

test('Cleanup: an abandoned target-selection session loses its pending token secret (116, 117)', async () => {
  const ctx = makeRuntime();
  const flow = await connect(ctx, 'instagram'); // consented, tokens waiting in the Vault, no target ever chosen
  const id = flow.started.session_ref;
  assert.deepEqual(heldBy(ctx, id).map((k) => k.split(':')[2]), ['PENDING_TOKENS']);
  assert.deepEqual({ ...await cleanup(ctx) }, { sessions_expired: 0, sessions_cleaned: 0 }); // 117: still inside the selection window: nothing is touched
  assert.equal(heldBy(ctx, id).length, 1);
  ctx.clock.t += PENDING_BINDING_TTL_MS + 1000; // the merchant walked away
  const done = await cleanup(ctx);
  assert.deepEqual({ ...done }, { sessions_expired: 1, sessions_cleaned: 1 });
  assert.equal(sessionRows(ctx)[0].status, 'EXPIRED');
  assert.deepEqual(heldBy(ctx, id), []); // 117: the pending token secret is gone
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: id, externalId: IG_ACCOUNT })), 'PC_SESSION_STATE_CONFLICT');
  assert.equal(connectorRows(ctx).length, 0);

  const lazy = makeRuntime(); // 116: an expired session found lazily (the merchant comes back too late) drops its secret as well
  const f2 = await connect(lazy, 'instagram');
  lazy.clock.t += PENDING_BINDING_TTL_MS + 1000;
  assert.equal(await acode(lazy.rt.connectionCenter.listTargets({ tenant: lazy.tenant, sessionRef: f2.started.session_ref })), 'PC_OAUTH_ERROR');
  assert.deepEqual(heldBy(lazy, f2.started.session_ref), []);
});

test('Cleanup: an expired Google PKCE verifier is removed, also after a denial or a failed exchange (118)', async () => {
  const ctx = makeRuntime();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'google_business_profile' });
  assert.deepEqual(heldBy(ctx, started.session_ref).map((k) => k.split(':')[2]), ['PKCE_VERIFIER']);
  await cleanup(ctx);
  assert.equal(heldBy(ctx, started.session_ref).length, 1); // a live PENDING session keeps its verifier
  ctx.clock.t += SESSION_TTL_MS + 1000;
  assert.deepEqual({ ...await cleanup(ctx) }, { sessions_expired: 1, sessions_cleaned: 1 });
  assert.deepEqual(heldBy(ctx, started.session_ref), []);
  const denied = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'google_business_profile' }); // the merchant refuses at Google
  const state = new URL(denied.authorization_url).searchParams.get('state');
  await assert.rejects(ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'google_business_profile', query: { error: 'access_denied', state } }));
  assert.deepEqual(heldBy(ctx, denied.session_ref), []); // removed at once, not at the next cleanup
  assert.equal(ctx.sessionSecrets._entries.size, 0);
});

test('Cleanup never deletes a credential bound to a connector, and is idempotent (119, 120)', async () => {
  const ctx = makeRuntime();
  const bound = await connect(ctx, 'google_business_profile', { externalId: LOC1 });
  const connectorId = bound.bound.connector_id;
  const stale = await connect(ctx, 'instagram'); // an abandoned one next to it
  const before = await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId });
  afterAuthorizationWindow(ctx);
  const first = await cleanup(ctx);
  assert.deepEqual({ ...first }, { sessions_expired: 1, sessions_cleaned: 1 });
  const after = await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId }); // 119
  assert.deepEqual([after.metadata.status, after.metadata.vault_secret_id, after.metadata.rotation_version], [before.metadata.status, before.metadata.vault_secret_id, before.metadata.rotation_version]);
  assert.equal(after.tokens.access_token.reveal(), SECRETS.googleAccess);
  assert.equal(sessionRows(ctx).find((s) => s.id === bound.started.session_ref).status, 'BOUND');
  assert.equal(connectorRows(ctx).find((c) => c.id === connectorId).status, 'CONFIGURED');
  assert.deepEqual(heldBy(ctx, stale.started.session_ref), []);
  const snapshot = JSON.stringify([ctx.db._tables, [...ctx.sessionSecrets._entries.keys()], [...ctx.credentialStore._secrets.keys()]]);
  const second = await cleanup(ctx); // 120: twice is safe, and changes nothing
  assert.equal(second.sessions_expired, 0);
  assert.equal(JSON.stringify([ctx.db._tables, [...ctx.sessionSecrets._entries.keys()], [...ctx.credentialStore._secrets.keys()]]), snapshot);
  assert.equal((await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId })).tokens.access_token.reveal(), SECRETS.googleAccess);
  assert.equal((await cleanup(ctx, { sessionRef: bound.started.session_ref })).sessions_cleaned, 0); // a BOUND session is never cleaned, even when asked
  assert.ok(ctx.credentialStore._secrets.size === 1);
});

test('Cleanup is merchant scoped: another merchant cannot clean, or even name, a session (121)', async () => {
  const ctx = makeRuntime();
  const flow = await connect(ctx, 'instagram');
  afterAuthorizationWindow(ctx);
  const other = tenantOf(M2);
  assert.equal(await acode(ctx.rt.provisioning.cleanupExpiredOAuthSessions({ tenant: other, sessionRef: flow.started.session_ref })), 'PC_SESSION_NOT_FOUND');
  assert.deepEqual({ ...await ctx.rt.provisioning.cleanupExpiredOAuthSessions({ tenant: other }) }, { sessions_expired: 0, sessions_cleaned: 0 });
  assert.equal(sessionRows(ctx)[0].status, 'AUTHORIZED'); // untouched by the other merchant
  assert.equal(heldBy(ctx, flow.started.session_ref).length, 1);
  assert.equal(await acode(ctx.rt.provisioning.cleanupExpiredOAuthSessions({ tenant: { merchantId: M1, source: 'query-string' } })), 'PC_TENANT_INVALID');
  assert.equal((await cleanup(ctx)).sessions_cleaned, 1); // its own merchant does
  assert.equal(heldBy(ctx, flow.started.session_ref).length, 0);
  assert.ok(!allSecrets().some((s) => JSON.stringify(ctx.logs).includes(s)));
});

test('Google: the canonical binding is built from the selected account and location, never assumed from discovery (122-125)', async () => {
  const ctx = makeRuntime();
  assert.ok(GBP_LOCATIONS.every((l) => /^locations\/\d+$/.test(l.location))); // the fake answers like Business Information: locations/{id}, no account
  const flow = await connect(ctx, 'google_business_profile');
  assert.deepEqual(flow.targets.targets.map((t) => t.external_id).sort(), ['accounts/111/locations/222', 'accounts/111/locations/333', 'accounts/444/locations/555']);
  const sid = flow.started.session_ref;
  for (const bad of ['accounts/111', 'locations/222', '222']) assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: sid, externalId: bad })), 'PC_TARGET_NOT_FOUND', bad); // 123
  for (const bad of ['accounts/444/locations/222', 'accounts/111/locations/555']) assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: sid, externalId: bad })), 'PC_TARGET_NOT_FOUND', bad); // 124
  assert.equal(connectorRows(ctx).length, 0);
  const bound = await ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: sid, externalId: LOC1 }); // 122
  assert.equal(connectorRows(ctx)[0].external_id, LOC1);
  assert.equal(P.googleLocationBinding('accounts/111', 'locations/222'), LOC1);
  assert.equal(P.googleLocationBinding('accounts/111', 'accounts/111/locations/222'), null); // a name that already carries an account is refused, not trusted
  assert.equal(P.googleLocationBinding('111', 'locations/222'), null);
  assert.equal(P.googleLocationBinding('accounts/111', 'locations/222/extra'), null);
  const row = connectorRows(ctx)[0]; // 125: the Activation adapter accepts exactly this binding and uses it as the LocalPosts parent
  const http = createFakeHttp(gbpRoutes());
  const adapter = A.createGoogleBusinessProfileAdapter({ http, now: () => Date.parse(NOW) });
  const health = await A.verifyChannelConnection({
    connector: { id: row.id, merchantId: M1, kind: row.kind, externalId: row.external_id, status: row.status, config: row.config },
    adapter, credentialProvider: ctx.rt.activationCredentialProvider, asOf: NOW,
  });
  assert.equal(health.status, 'CONFIGURED');
  assert.ok(http.raw[0].url.includes(`/${LOC1}/localPosts`));
  assert.equal(bound.verification.state, 'CONFIGURED');
});
