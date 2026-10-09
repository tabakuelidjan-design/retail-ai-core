import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/provider-connections/index.js';
import {
  ENV, M1, SECRETS, TT_OPEN_ID, allSecrets, connect, connectorRows, googleRoutes, igRoutes, makeBundle, makeRuntime, ttRoutes,
} from './provider-fixtures.js';

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const oauth = async (promise) => { try { await promise; } catch (error) { return error.detail?.oauth ?? error.code; } return assert.fail('expected an error'); };
const tt = (over, env) => makeRuntime({ routes: [...ttRoutes(over), ...igRoutes(), ...googleRoutes()], env });
const requests = (ctx, needle) => ctx.http.raw.filter((r) => r.url.includes(needle));

test('TikTok Login Kit authorization request and the redirect URI rules', async () => {
  const ctx = tt();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'tiktok' });
  const url = new URL(started.authorization_url); // 43
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.deepEqual([url.searchParams.get('client_key'), url.searchParams.get('response_type'), url.searchParams.get('scope')], ['tt-client-key-1', 'code', 'video.publish']);
  assert.ok(url.searchParams.get('state') && url.searchParams.get('redirect_uri') === ENV.TIKTOK_REDIRECT_URI);
  assert.doesNotMatch(started.authorization_url, new RegExp(SECRETS.ttClientSecret));
  for (const redirect of ['http://nordla.example.test/cb', 'https://nordla.example.test/cb?id=1', 'https://nordla.example.test/cb#frag', `https://nordla.example.test/${'a'.repeat(520)}`]) { // 44
    const bad = tt({}, { ...ENV, TIKTOK_REDIRECT_URI: redirect });
    const failure = await bad.rt.connectionCenter.startConnect({ tenant: bad.tenant, provider: 'tiktok' }).catch((e) => e);
    assert.ok(['PC_APP_MISCONFIGURED', 'PC_OAUTH_ERROR'].includes(failure.code), redirect.slice(0, 40));
  }
  assert.equal(P.createTikTokOAuth({ http: () => {} }).descriptor.uses_pkce, false); // PKCE is for mobile / desktop apps only
});

test('TikTok code exchange is server side; the refresh token is sealed and lives in the credential store only', async () => {
  const ctx = tt();
  const flow = await connect(ctx, 'tiktok', { externalId: TT_OPEN_ID });
  const exchange = requests(ctx, '/v2/oauth/token/')[0]; // 45
  assert.equal(exchange.method, 'POST');
  assert.deepEqual([exchange.form.client_key, exchange.form.grant_type, exchange.form.redirect_uri], ['tt-client-key-1', 'authorization_code', ENV.TIKTOK_REDIRECT_URI]);
  assert.equal(exchange.form.client_secret.reveal(), SECRETS.ttClientSecret);
  assert.equal(exchange.form.code.reveal(), SECRETS.code);
  assert.equal(exchange.form.code_verifier, undefined);
  assert.doesNotMatch(JSON.stringify(flow.callback), new RegExp(allSecrets().join('|')));
  const stored = JSON.stringify([ctx.db._tables, ctx.logs, await ctx.rt.connectionCenter.listConnections({ tenant: ctx.tenant })]); // 46
  assert.ok(!stored.includes(SECRETS.ttRefresh) && !stored.includes(SECRETS.ttAccess));
  const read = await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId: flow.bound.connector_id });
  assert.equal(read.tokens.refresh_token.reveal(), SECRETS.ttRefresh);
  assert.equal(String(read.tokens.refresh_token), '[REDACTED]');
  assert.deepEqual([read.metadata.refreshable, read.metadata.scopes[0]], [true, 'video.publish']);
});

test('TikTok identity, scope and selection: video.publish is mandatory, the open_id is the stable id, the choice is explicit, the audit limitation is visible', async () => {
  const ctx = tt();
  const flow = await connect(ctx, 'tiktok');
  assert.deepEqual([...flow.callback.granted_scopes], ['video.publish']); // 47
  const [candidate] = flow.targets.targets; // 48
  assert.deepEqual([candidate.external_id, candidate.display_name, candidate.eligibility.eligible], [TT_OPEN_ID, 'habb', true]);
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: flow.started.session_ref, externalId: '' })), 'PC_TARGET_REQUIRED'); // 49
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: flow.started.session_ref, externalId: 'someone-else' })), 'PC_TARGET_NOT_FOUND');
  assert.equal(connectorRows(ctx).length, 0);
  assert.ok(candidate.review_signals.includes('TIKTOK_UNAUDITED_PRIVATE_ONLY')); // 53: an unaudited client can only post privately
  const bound = await ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef: flow.started.session_ref, externalId: TT_OPEN_ID });
  assert.ok(bound.verification.view.review_signals.includes('TIKTOK_UNAUDITED_PRIVATE_ONLY'));
  const audited = tt({}, { ...ENV, TIKTOK_CLIENT_AUDITED: 'true' });
  const audit = await connect(audited, 'tiktok');
  assert.ok(!audit.targets.targets[0].review_signals.includes('TIKTOK_UNAUDITED_PRIVATE_ONLY'));
  const noScope = tt({ scope: 'user.info.basic' }); // 52: without video.publish nothing is bound
  const started = await noScope.rt.connectionCenter.startConnect({ tenant: noScope.tenant, provider: 'tiktok' });
  const state = new URL(started.authorization_url).searchParams.get('state');
  assert.equal(await oauth(noScope.rt.provisioning.handleCallback({ tenant: noScope.tenant, provider: 'tiktok', query: { code: SECRETS.code, state } })), 'SCOPE_MISSING');
  assert.equal(connectorRows(noScope).length, 0);
  const lost = tt(); // a bound connector whose credential later lacks video.publish is MISCONFIGURED, not CONFIGURED
  const f = await connect(lost, 'tiktok', { externalId: TT_OPEN_ID });
  const meta = await lost.credentialStore.readMetadata({ merchantId: M1, connectorId: f.bound.connector_id });
  await lost.credentialStore.updateMerchantCredential({ merchantId: M1, connectorId: f.bound.connector_id, expectedVersion: meta.rotation_version, tokens: makeBundle({ accessToken: SECRETS.ttAccess2, refreshToken: SECRETS.ttRefresh2, scopes: ['user.info.basic'], externalUserId: TT_OPEN_ID, issuedAt: new Date(P.PROVISIONING_VERSION ? lost.clock.t : 0).toISOString() }) });
  const v = await lost.rt.connectionCenter.verify({ tenant: lost.tenant, connectorId: f.bound.connector_id });
  assert.deepEqual([v.state, [...v.reason_codes], connectorRows(lost)[0].status], ['MISCONFIGURED', ['SCOPE_MISSING'], 'MISCONFIGURED']);
});

test('TikTok refresh: supported, the rotated refresh token replaces the old one, and two workers never refresh at the same time', async () => {
  const ctx = tt();
  const flow = await connect(ctx, 'tiktok', { externalId: TT_OPEN_ID });
  const id = flow.bound.connector_id;
  const refreshed = await ctx.rt.tokenManager.forceRefresh({ merchantId: M1, connectorId: id, provider: 'tiktok' }); // 50
  assert.equal(refreshed.refreshed, true);
  const refreshRequest = requests(ctx, '/v2/oauth/token/').find((r) => r.form.grant_type === 'refresh_token');
  assert.deepEqual([refreshRequest.form.refresh_token.reveal(), refreshRequest.form.client_secret.reveal()], [SECRETS.ttRefresh, SECRETS.ttClientSecret]);
  const read = await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId: id });
  assert.deepEqual([read.tokens.access_token.reveal(), read.tokens.refresh_token.reveal(), read.metadata.rotation_version], [SECRETS.ttAccess2, SECRETS.ttRefresh2, 2]); // the rotated token wins
  assert.equal(ctx.credentialStore._secrets.size, 1);
  const race = tt(); // 51
  const f = await connect(race, 'tiktok', { externalId: TT_OPEN_ID });
  race.clock.t += 23.5 * 3_600_000; // inside the refresh window of the 24 h access token
  const results = await Promise.all([1, 2, 3].map(() => race.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId: f.bound.connector_id, provider: 'tiktok' })));
  assert.equal(requests(race, '/v2/oauth/token/').filter((r) => r.form.grant_type === 'refresh_token').length, 1); // one refresh for three concurrent workers
  assert.deepEqual(results.map((r) => r.tokens.access_token.reveal()), Array(3).fill(SECRETS.ttAccess2));
  assert.deepEqual(P.REFRESH_POLICY.tiktok, { refresh_before_seconds: 3600, min_token_age_seconds: 0 });
});

test('TikTok provisioning never posts: only OAuth, creator identity and revoke endpoints are called, and disconnect revokes at TikTok', async () => {
  const ctx = tt();
  const flow = await connect(ctx, 'tiktok', { externalId: TT_OPEN_ID });
  await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: flow.bound.connector_id });
  const disconnected = await ctx.rt.connectionCenter.disconnect({ tenant: ctx.tenant, connectorId: flow.bound.connector_id });
  const called = ctx.http.raw.map((r) => `${r.method} ${r.url}`); // 54
  assert.deepEqual(called.filter((u) => !/oauth\/token|oauth\/revoke|creator_info\/query/.test(u)), []);
  assert.doesNotMatch(called.join('\n'), /\/init\/|status\/fetch/);
  assert.deepEqual([disconnected.remote_revoked, disconnected.local_revoked, disconnected.status], [true, true, 'NOT_CONFIGURED']);
  const revoke = requests(ctx, '/v2/oauth/revoke/')[0];
  assert.deepEqual([revoke.form.client_key, revoke.form.token.reveal(), revoke.form.client_secret.reveal()], ['tt-client-key-1', SECRETS.ttAccess, SECRETS.ttClientSecret]);
});
