// Instagram and TikTok READ-ONLY scope sets (opt-in, owner request 2026-11-17). Test doubles only: no account, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/provider-connections/index.js';
import { ENV, ttRoutes, igRoutes, googleRoutes, makeRuntime, makeBundle } from './provider-fixtures.js';

const APP = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://nordla.example.test/oauth/callback/x', graphVersion: 'v23.0' };
const scopeOf = (url) => new URL(url).searchParams.get('scope').split(',');
const FORBIDDEN = /publish|upload|manage_messages|manage_comments|message|post/i;
const respond = (calls, bodyOf) => async (request) => { calls.push({ method: request.method, url: request.url, query: request.query }); return { status: 200, headers: {}, body: bodyOf(request) }; };

test('RO-1 the defaults are unchanged (publishing scopes); the read-only sets ask for profile, media, insights and statistics and nothing that can post, upload or message', () => {
  assert.deepEqual(scopeOf(P.createInstagramOAuth({ http: () => {} }).buildAuthorizationRequest({ appConfig: APP, state: 's' })), ['instagram_business_basic', 'instagram_business_content_publish']);
  assert.deepEqual(scopeOf(P.createTikTokOAuth({ http: () => {} }).buildAuthorizationRequest({ appConfig: APP, state: 's' })), ['video.publish']);
  const ig = scopeOf(P.createInstagramOAuth({ http: () => {}, scopes: P.INSTAGRAM_READ_SCOPES }).buildAuthorizationRequest({ appConfig: APP, state: 's' }));
  const tt = scopeOf(P.createTikTokOAuth({ http: () => {}, scopes: P.TIKTOK_READ_SCOPES }).buildAuthorizationRequest({ appConfig: APP, state: 's' }));
  assert.deepEqual(ig, ['instagram_business_basic', 'instagram_business_manage_insights']); assert.deepEqual(tt, ['user.info.basic', 'user.info.stats', 'video.list']);
  for (const s of [...ig, ...tt]) assert.doesNotMatch(s, FORBIDDEN, s);
  assert.deepEqual(P.createInstagramOAuth({ http: () => {}, scopes: P.INSTAGRAM_READ_SCOPES }).descriptor.minimum_scopes, ig); assert.deepEqual(P.createTikTokOAuth({ http: () => {}, scopes: P.TIKTOK_READ_SCOPES }).descriptor.minimum_scopes, tt);
});

test('RO-2 TikTok read-only: the account is identified through User Info (never the posting API), eligible with the three scopes, SCOPE_MISSING without statistics, no "private only" posting warning', async () => {
  const calls = []; const http = respond(calls, () => ({ data: { user: { open_id: 'oid-1', display_name: 'habb' } }, error: { code: 'ok' } }));
  const adapter = P.createTikTokOAuth({ http, scopes: P.TIKTOK_READ_SCOPES });
  const tokens = makeBundle({ accessToken: 'tt-access-token-123', scopes: [...P.TIKTOK_READ_SCOPES], externalUserId: 'oid-1' });
  const [c] = await adapter.discoverTargets({ tokens, appConfig: APP });
  assert.equal(c.eligibility.eligible, true); assert.equal(c.display_name, 'habb'); assert.deepEqual(c.review_signals, []);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET'); assert.match(calls[0].url, /\/v2\/user\/info\/$/); assert.equal(calls[0].query.fields, 'open_id,display_name'); assert.ok(!calls.some((x) => /post\/publish/.test(x.url)), 'the posting API is never called');
  const partial = makeBundle({ accessToken: 'tt-access-token-123', scopes: ['user.info.basic', 'video.list'], externalUserId: 'oid-1' });
  const [p] = await adapter.discoverTargets({ tokens: partial, appConfig: APP }); assert.equal(p.eligibility.eligible, false); assert.deepEqual(p.eligibility.reasons, ['SCOPE_MISSING']);
  // the default (publishing) adapter still uses the posting creator-info call
  const callsDefault = []; const def = P.createTikTokOAuth({ http: respond(callsDefault, () => ({ data: { creator_nickname: 'habb', privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } })) });
  await def.discoverTargets({ tokens: makeBundle({ accessToken: 'tt-access-token-123', scopes: ['video.publish'], externalUserId: 'oid-1' }), appConfig: APP }); assert.match(callsDefault[0].url, /post\/publish\/creator_info/);
});

test('RO-3 Instagram read-only: a professional account with basic + insights is eligible; missing insights is SCOPE_MISSING; a publish-only grant is not enough for the read set', async () => {
  const calls = []; const http = respond(calls, () => ({ user_id: 'ig-1', username: 'habb_namur', account_type: 'Business' }));
  const adapter = P.createInstagramOAuth({ http, scopes: P.INSTAGRAM_READ_SCOPES });
  const ok = makeBundle({ accessToken: 'ig-access-token-123', scopes: [...P.INSTAGRAM_READ_SCOPES] });
  const [c] = await adapter.discoverTargets({ tokens: ok, appConfig: APP }); assert.equal(c.eligibility.eligible, true); assert.equal(c.display_name, 'habb_namur'); assert.match(calls[0].url, /graph\.instagram\.com\/v23\.0\/me$/);
  const noInsights = makeBundle({ accessToken: 'ig-access-token-123', scopes: ['instagram_business_basic'] });
  const [n] = await adapter.discoverTargets({ tokens: noInsights, appConfig: APP }); assert.deepEqual(n.eligibility.reasons, ['SCOPE_MISSING']);
  const publishOnly = makeBundle({ accessToken: 'ig-access-token-123', scopes: ['instagram_business_basic', 'instagram_business_content_publish'] });
  const [pp] = await adapter.discoverTargets({ tokens: publishOnly, appConfig: APP }); assert.equal(pp.eligibility.eligible, false, 'publishing rights do not make a read-only connection eligible');
});

test('RO-4 the runtime switch: NORDLA_PROVIDER_SCOPE_MODE=read requests the read-only scopes for Instagram and TikTok; unset keeps today\'s publishing scopes; Google is untouched', async () => {
  const mk = (env) => makeRuntime({ routes: [...ttRoutes(), ...igRoutes(), ...googleRoutes()], env });
  const scopes = async (ctx, provider) => scopeOf((await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider })).authorization_url);
  const off = mk(ENV); assert.deepEqual(await scopes(off, 'tiktok'), ['video.publish']); assert.deepEqual(await scopes(off, 'instagram'), ['instagram_business_basic', 'instagram_business_content_publish']);
  const on = mk({ ...ENV, NORDLA_PROVIDER_SCOPE_MODE: 'read' }); assert.deepEqual(await scopes(on, 'tiktok'), ['user.info.basic', 'user.info.stats', 'video.list']); assert.deepEqual(await scopes(on, 'instagram'), ['instagram_business_basic', 'instagram_business_manage_insights']);
  assert.deepEqual(await scopes(on, 'google_business_profile'), ['https://www.googleapis.com/auth/business.manage']);
});
