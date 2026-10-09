import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/provider-connections/index.js';
import { safeReturnTo, sha256Hex } from '../src/provider-connections/validation.js';
import { createOAuthSessionRepository } from '../src/provider-connections/oauth-session.js';
import {
  ENV, IG_ACCOUNT, M1, M2, SECRETS, START, allRoutes, igRoutes, makeRuntime, sessionRows, tenantOf, ttRoutes,
} from './provider-fixtures.js';

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const oauth = async (promise) => { try { await promise; } catch (error) { return `${error.code}/${error.detail?.oauth}`; } return assert.fail('expected an error'); };
const start = (ctx, provider = 'instagram', over = {}) => ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider, returnTo: '/connections', ...over });
const stateOf = (started) => new URL(started.authorization_url).searchParams.get('state');
const callback = (ctx, provider, state, extra = {}, tenant = ctx.tenant) => ctx.rt.provisioning.handleCallback({ tenant, provider, query: { code: SECRETS.code, state, ...extra } });
const everything = (ctx) => JSON.stringify([ctx.db._tables, ctx.logs, [...ctx.sessionSecrets._entries.keys()]]);

test('Starting a connection: a valid, secret-free session whose state is random, hashed and bound to merchant and provider', async () => {
  const ctx = makeRuntime();
  const started = await start(ctx); // 16
  assert.deepEqual(Object.keys(started).sort(), ['authorization_url', 'expires_at', 'session_ref']);
  assert.match(started.session_ref, /^[0-9a-f-]{36}$/);
  const url = new URL(started.authorization_url);
  assert.equal(url.origin + url.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.doesNotMatch(started.authorization_url, new RegExp(SECRETS.igClientSecret));
  const second = await start(ctx); // 17: 32 random bytes, base64url, never repeated
  assert.notEqual(stateOf(started), stateOf(second));
  assert.match(stateOf(started), /^[A-Za-z0-9_-]{43}$/);
  const session = sessionRows(ctx)[0];
  assert.equal(session.state_hash, sha256Hex(stateOf(started))); // 18
  assert.match(session.state_hash, /^[0-9a-f]{64}$/);
  assert.ok(!everything(ctx).includes(stateOf(started)) && !everything(ctx).includes(stateOf(second))); // 19: the raw state is nowhere in storage or logs
  assert.deepEqual([session.provider, session.merchant_id, session.status], ['instagram', M1, 'PENDING']); // 20, 21
  assert.equal(new Date(session.expires_at).getTime() - new Date(session.created_at).getTime(), 10 * 60_000); // 22
  assert.deepEqual([...session.requested_scopes], ['instagram_business_basic', 'instagram_business_content_publish']);
  assert.equal(P.findSecretLeaks(session).length, 0);
  assert.equal(await acode(start(makeRuntime({ env: { ...ENV, INSTAGRAM_CLIENT_SECRET: '' } }))), 'PC_APP_MISCONFIGURED');
});

test('Callback binding: unknown or tampered states, another provider, another merchant, replays and expiry are all refused', async () => {
  const ctx = makeRuntime();
  const started = await start(ctx);
  const state = stateOf(started);
  assert.equal(await oauth(callback(ctx, 'instagram', 'x'.repeat(43))), 'PC_OAUTH_ERROR/INVALID_STATE'); // 24
  assert.equal(await oauth(callback(ctx, 'instagram', undefined)), 'PC_OAUTH_ERROR/INVALID_STATE');
  assert.equal(await oauth(callback(ctx, 'instagram', `${state.slice(0, -1)}${state.endsWith('a') ? 'b' : 'a'}`)), 'PC_OAUTH_ERROR/INVALID_STATE');
  assert.equal(await oauth(callback(ctx, 'tiktok', state)), 'PC_OAUTH_ERROR/INVALID_STATE'); // 20, 27: the state belongs to Instagram
  assert.equal(await oauth(callback(ctx, 'instagram', state, {}, tenantOf(M2))), 'PC_OAUTH_ERROR/INVALID_STATE'); // 21: another merchant's server context never finds it
  const repository = createOAuthSessionRepository({ supabase: ctx.db }); // the repository itself is merchant-scoped, whatever the service does with it
  assert.equal(await repository.findByStateHash({ merchantId: M2, stateHash: sha256Hex(state) }), null); // 21
  assert.equal(await repository.getById({ merchantId: M2, id: started.session_ref }), null);
  assert.equal((await repository.findByStateHash({ merchantId: M1, stateHash: sha256Hex(state) })).id, started.session_ref);
  assert.equal(sessionRows(ctx)[0].status, 'PENDING'); // none of those consumed the session
  const done = await callback(ctx, 'instagram', state); // 23: single use
  assert.deepEqual([done.status, done.next], ['AUTHORIZED', 'SELECT_TARGET']);
  assert.equal(sessionRows(ctx)[0].status, 'AUTHORIZED');
  assert.equal(await oauth(callback(ctx, 'instagram', state)), 'PC_OAUTH_ERROR/INVALID_STATE'); // 25: replay
  const stale = makeRuntime(); // 26
  const old = await start(stale);
  stale.clock.t = START + 10 * 60_000;
  assert.equal(await oauth(callback(stale, 'instagram', stateOf(old))), 'PC_OAUTH_ERROR/SESSION_EXPIRED');
  assert.equal(sessionRows(stale)[0].status, 'EXPIRED');
  assert.equal(await oauth(callback(stale, 'instagram', stateOf(old))), 'PC_OAUTH_ERROR/SESSION_EXPIRED'); // an expired session never authorizes
});

test('OAuth errors are normalized, never carry a provider body, and a failed callback consumes the state', async () => {
  const flows = [
    ['USER_DENIED', makeRuntime(), 'instagram', { code: undefined, error: 'access_denied', error_reason: 'user_denied' }],
    ['CODE_EXCHANGE_FAILED', makeRuntime({ routes: [{ method: 'POST', url: 'api.instagram.com/oauth/access_token', respond: { status: 400, body: { error_type: 'OAuthException', error_message: `bad code ${SECRETS.code}` } } }, ...allRoutes()] }), 'instagram', {}],
    ['PROVIDER_UNAVAILABLE', makeRuntime({ routes: [{ method: 'POST', url: '/v2/oauth/token/', respond: { status: 503, body: {} } }, ...allRoutes()] }), 'tiktok', {}],
    ['TOKEN_RESPONSE_INVALID', makeRuntime({ routes: [...ttRoutes({ exchangeRespond: () => ({ status: 200, headers: {}, body: { open_id: 'x', scope: 'video.publish' } }) }), ...allRoutes()] }), 'tiktok', {}],
    ['SCOPE_MISSING', makeRuntime({ routes: [...ttRoutes({ scope: 'user.info.basic' }), ...allRoutes()] }), 'tiktok', {}],
    ['APP_MISCONFIGURED', makeRuntime({ routes: [{ method: 'POST', url: '/v2/oauth/token/', respond: { status: 401, body: { error: 'invalid_client', error_description: `secret ${SECRETS.ttClientSecret}` } } }, ...allRoutes()] }), 'tiktok', {}],
  ];
  for (const [expected, ctx, provider, extra] of flows) { // 28
    const started = await start(ctx, provider);
    const state = stateOf(started);
    const failure = await callback(ctx, provider, state, extra).catch((e) => e);
    assert.equal(failure.code, 'PC_OAUTH_ERROR', expected);
    assert.equal(failure.detail.oauth, expected);
    assert.doesNotMatch(JSON.stringify([failure.message, failure.detail]), new RegExp(`${SECRETS.code}|${SECRETS.ttClientSecret}|bad code|error_message`)); // no raw provider body
    assert.equal(sessionRows(ctx)[0].status, 'FAILED');
    assert.equal(sessionRows(ctx)[0].failure_code, expected);
    assert.equal(await oauth(callback(ctx, provider, state)), 'PC_OAUTH_ERROR/INVALID_STATE'); // the state is spent
  }
  assert.deepEqual(Object.values(P.OAUTH_ERROR).sort(), ['APP_MISCONFIGURED', 'CODE_EXCHANGE_FAILED', 'INVALID_STATE', 'PROVIDER_UNAVAILABLE', 'SCOPE_MISSING', 'SESSION_EXPIRED', 'TOKEN_RESPONSE_INVALID', 'USER_DENIED']);
});

test('No authorization code is ever persisted, and return_to is an internal allow-listed route (no open redirect)', async () => {
  const ctx = makeRuntime();
  const started = await start(ctx);
  await callback(ctx, 'instagram', stateOf(started));
  assert.ok(!everything(ctx).includes(SECRETS.code)); // 29
  assert.ok(!JSON.stringify(ctx.db.calls).includes(SECRETS.code));
  for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/connections/../admin', '/connections/%2e%2e/admin', 'javascript:alert(1)', '/admin', '/connections/a\u0000b', 'connections']) { // 30
    assert.throws(() => safeReturnTo(bad), (e) => e.code === 'PC_RETURN_TO_REFUSED', bad);
    assert.equal(await acode(start(makeRuntime(), 'instagram', { returnTo: bad })), 'PC_RETURN_TO_REFUSED', bad);
  }
  assert.equal(safeReturnTo('/connections/ig-1?tab=health'), '/connections/ig-1?tab=health');
  assert.equal(safeReturnTo(null), null);
  assert.equal(sessionRows(ctx)[0].return_to, '/connections');
  assert.equal(IG_ACCOUNT.length > 0 && igRoutes().length > 0, true);
});
