import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/provider-connections/index.js';
import {
  IG_ACCOUNT, M1, SECRETS, allRoutes, allSecrets, connect, connectorRows, igRoutes, makeRuntime, sessionRows, ttRoutes, googleRoutes,
} from './provider-fixtures.js';

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const oauth = async (promise) => { try { await promise; } catch (error) { return error.detail?.oauth ?? error.code; } return assert.fail('expected an error'); };
const ok = (body) => ({ status: 200, headers: {}, body });
const ig = (over) => makeRuntime({ routes: [...igRoutes(over), ...ttRoutes(), ...googleRoutes()] });
const urls = (ctx) => ctx.http.raw.map((r) => `${r.method} ${r.url}`);

test('Instagram authorization request: the current Instagram Login URL with the minimum, non-deprecated scopes', async () => {
  const ctx = ig();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'instagram' });
  const url = new URL(started.authorization_url); // 31
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.instagram.com/oauth/authorize');
  assert.deepEqual([url.searchParams.get('client_id'), url.searchParams.get('response_type'), url.searchParams.get('redirect_uri')], ['ig-app-id-1', 'code', 'https://nordla.example.test/oauth/callback/instagram']);
  assert.equal(url.searchParams.get('scope'), 'instagram_business_basic,instagram_business_content_publish'); // 32
  assert.doesNotMatch(url.searchParams.get('scope'), /manage_messages|manage_comments|(^|,)business_basic|business_content_publish(?!$)/); // nothing beyond publishing, no deprecated business_* name
  assert.equal(url.searchParams.has('code_challenge'), false); // PKCE is not part of the documented Instagram flow
  assert.equal(P.createInstagramOAuth({ http: () => {} }).descriptor.verified_at, '2026-10-09T00:00:00.000Z');
  assert.ok(P.createInstagramOAuth({ http: () => {} }).descriptor.verified_against.every((u) => u.startsWith('https://developers.facebook.com/')));
});

test('Instagram code exchange runs on the server: client secret and code are sealed in the request, the trailing "#_" is stripped, the browser gets no token', async () => {
  const ctx = ig();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'instagram' });
  const state = new URL(started.authorization_url).searchParams.get('state');
  const result = await ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'instagram', query: { code: `${SECRETS.code}#_`, state } }); // 33
  assert.doesNotMatch(JSON.stringify(result), new RegExp(allSecrets().join('|')));
  const short = ctx.http.raw.find((r) => r.url === 'https://api.instagram.com/oauth/access_token');
  assert.equal(short.method, 'POST');
  assert.equal(short.form.client_secret.reveal(), SECRETS.igClientSecret);
  assert.equal(short.form.code.reveal(), SECRETS.code); // "#_" is not part of the code
  assert.equal(short.form.grant_type, 'authorization_code');
  assert.doesNotMatch(JSON.stringify(ctx.http.raw), new RegExp(`${SECRETS.igClientSecret}|${SECRETS.igShort}|${SECRETS.igLong}`)); // sealed values print as [REDACTED]
  const long = ctx.http.raw.find((r) => r.url === 'https://graph.instagram.com/access_token');
  assert.deepEqual([long.method, long.query.grant_type, long.query.client_secret.reveal(), long.query.access_token.reveal()], ['GET', 'ig_exchange_token', SECRETS.igClientSecret, SECRETS.igShort]);
});

test('Instagram discovery: Professional accounts are eligible, a consumer account is refused, the choice is explicit, the account id is stable', async () => {
  for (const type of ['Business', 'Media_Creator']) { // 34
    const ctx = ig({ accountType: type });
    const { targets } = await connect(ctx, 'instagram');
    assert.deepEqual([targets.targets.length, targets.targets[0].eligibility.eligible, targets.targets[0].account_type, targets.selection_required], [1, true, type, true]);
  }
  const consumer = ig({ accountType: 'Personal' }); // 35
  const flow = await connect(consumer, 'instagram');
  assert.deepEqual([flow.targets.targets[0].eligibility.eligible, [...flow.targets.targets[0].eligibility.reasons]], [false, ['ACCOUNT_NOT_PROFESSIONAL']]);
  const started = flow.started.session_ref;
  assert.equal(await acode(consumer.rt.connectionCenter.selectTarget({ tenant: consumer.tenant, sessionRef: started, externalId: IG_ACCOUNT })), 'PC_TARGET_INELIGIBLE');
  assert.equal(connectorRows(consumer).length, 0); // nothing was bound
  const ctx = ig(); // 36
  const f = await connect(ctx, 'instagram');
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: f.started.session_ref, externalId: undefined })), 'PC_TARGET_REQUIRED'); // even with ONE candidate
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: f.started.session_ref, externalId: '99999' })), 'PC_TARGET_NOT_FOUND');
  assert.equal(connectorRows(ctx).length, 0);
  const bound = await ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: f.started.session_ref, externalId: IG_ACCOUNT });
  assert.equal(connectorRows(ctx)[0].external_id, IG_ACCOUNT); // 38
  assert.equal(connectorRows(ctx)[0].kind, 'instagram');
  assert.equal(bound.connector_id, connectorRows(ctx)[0].id);
});

test('Instagram credentials live in the credential store only; publish scopes are verified; the connection is CONFIGURED only after verification', async () => {
  const ctx = ig();
  const flow = await connect(ctx, 'instagram', { externalId: IG_ACCOUNT });
  const stored = JSON.stringify([ctx.db._tables, ctx.logs, [...ctx.sessionSecrets._entries.keys()]]); // 37
  assert.ok(!allSecrets().some((s) => stored.includes(s)));
  assert.equal(ctx.credentialStore._secrets.size, 1);
  assert.match([...ctx.credentialStore._secrets.values()][0], new RegExp(SECRETS.igLong)); // the only place the token exists (the fake Vault)
  assert.equal(ctx.sessionSecrets._entries.size, 0); // the pending tokens were destroyed after binding
  assert.deepEqual([connectorRows(ctx)[0].status, flow.bound.verification.state, flow.bound.verification.persist_status], ['CONFIGURED', 'CONFIGURED', 'CONFIGURED']); // 40
  assert.deepEqual([...flow.bound.verification.view.granted_scopes], ['instagram_business_basic', 'instagram_business_content_publish']); // 39
  const missing = ig({ permissions: 'instagram_business_basic' });
  const started = await missing.rt.connectionCenter.startConnect({ tenant: missing.tenant, provider: 'instagram' });
  const state = new URL(started.authorization_url).searchParams.get('state');
  assert.equal(await oauth(missing.rt.provisioning.handleCallback({ tenant: missing.tenant, provider: 'instagram', query: { code: SECRETS.code, state } })), 'SCOPE_MISSING');
  assert.equal(connectorRows(missing).length, 0);
  assert.equal(sessionRows(missing)[0].failure_code, 'SCOPE_MISSING');
});

test('Instagram health: a rejected token is REAUTH_REQUIRED (runtime only), a downgraded account is MISCONFIGURED, an outage is UNAVAILABLE and never stored', async () => {
  let mode = 'ok';
  const routes = [
    { method: 'GET', url: '/me', respond: () => (mode === 'revoked' ? { status: 401, headers: {}, body: { error: { code: 190 } } } : mode === 'outage' ? { status: 503, headers: {}, body: {} } : ok({ user_id: IG_ACCOUNT, username: 'habb.be', account_type: mode === 'downgraded' ? 'Personal' : 'Business' })) },
    ...igRoutes().slice(0, 3), ...ttRoutes(), ...googleRoutes(),
  ];
  const ctx = makeRuntime({ routes });
  const { bound } = await connect(ctx, 'instagram', { externalId: IG_ACCOUNT });
  const id = bound.connector_id;
  mode = 'outage';
  let v = await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: id });
  assert.deepEqual([v.state, v.persist_status, connectorRows(ctx)[0].status], ['UNAVAILABLE', null, 'CONFIGURED']); // never persisted
  mode = 'revoked'; // 41
  v = await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: id });
  assert.deepEqual([v.state, v.persist_status, connectorRows(ctx)[0].status, v.view.review_signals.includes('REAUTH_REQUIRED')], ['REAUTH_REQUIRED', null, 'CONFIGURED', true]);
  assert.equal((await ctx.credentialStore.readMetadata({ merchantId: M1, connectorId: id })).status, 'EXPIRED');
  mode = 'ok';
  const again = makeRuntime({ routes });
  const second = await connect(again, 'instagram', { externalId: IG_ACCOUNT });
  mode = 'downgraded';
  v = await again.rt.connectionCenter.verify({ tenant: again.tenant, connectorId: second.bound.connector_id });
  assert.deepEqual([v.state, v.persist_status, connectorRows(again)[0].status, [...v.reason_codes].includes('ACCOUNT_NOT_PROFESSIONAL')], ['MISCONFIGURED', 'MISCONFIGURED', 'MISCONFIGURED', true]);
});

test('Instagram provisioning never publishes: only OAuth, token and account-read endpoints are called', async () => {
  const ctx = ig();
  const flow = await connect(ctx, 'instagram', { externalId: IG_ACCOUNT });
  await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: flow.bound.connector_id });
  await ctx.rt.tokenManager.forceRefresh({ merchantId: M1, connectorId: flow.bound.connector_id, provider: 'instagram' });
  const called = urls(ctx).map((u) => u.replace(/\?.*$/, ''));
  const allowed = /^(POST https:\/\/api\.instagram\.com\/oauth\/access_token|GET https:\/\/graph\.instagram\.com\/(access_token|refresh_access_token|v25\.0\/me))$/; // 42
  assert.deepEqual(called.filter((u) => !allowed.test(u)), []);
  assert.doesNotMatch(called.join('\n'), /media|media_publish|content_publish/);
  assert.equal((await ctx.rt.provisioning.disconnectConnection({ tenant: ctx.tenant, connectorId: flow.bound.connector_id })).remote_revoked, false); // no documented revoke endpoint: local only
});
