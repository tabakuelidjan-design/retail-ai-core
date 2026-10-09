import test from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../src/activation/index.js';
import {
  IDS, M1, NOW, SCOPES, TOKENS, advance, credentialProvider, createFakeHttp, gbpRoutes, igRoutes, jobOf, mediaTransport, orderOf, preflightInput, runtime, services, ttRoutes, world,
} from './channel-fixtures.js';

const W = world();
const ORDER = orderOf(W);
const resp = (status, body = {}, headers = {}) => ({ status, headers, body });
const rest = (...extra) => [...extra, ...ttRoutes(), ...gbpRoutes()];
const igPost = (path, respond) => ({ method: 'POST', url: `/17841400000000001/${path}`, respond });
const flow = async (routes, { cycles = 2, step = 120_000, over = {} } = {}) => {
  const rt = await runtime(W, { routes, ...over });
  for (let i = 0; i < cycles; i += 1) { await rt.executor.runDueJobs({ merchantId: M1 }); advance(rt, step); }
  return rt;
};
const preflightIg = (svc, over) => A.evaluateChannelExecutionPreflight(preflightInput(W, ORDER, svc, over));
const igDelivery = (r) => r.deliveries.find((d) => d.provider === 'instagram');

test('Instagram account: a Professional account is required, a consumer account is refused, the designated account is never swapped', async () => {
  for (const type of ['Business', 'Media_Creator']) { // 89
    const r = await preflightIg(services(W, { routes: rest(...igRoutes({ accountType: type })) }));
    assert.equal(igDelivery(r).status, 'READY', type);
  }
  const personal = igDelivery(await preflightIg(services(W, { routes: rest(...igRoutes({ accountType: 'Personal' })) }))); // 90
  assert.deepEqual([personal.status, personal.reason_codes], ['BLOCKED', ['ACCOUNT_NOT_PROFESSIONAL']]);
  const swapped = igDelivery(await preflightIg(services(W, { routes: rest(...igRoutes({ userId: '99999' })) }))); // 108: /me must answer for the connector's account
  assert.deepEqual([swapped.status, swapped.reason_codes], ['BLOCKED', ['ACCOUNT_MISMATCH']]);
  const svc = services(W);
  await preflightIg(svc);
  assert.ok(svc.http.raw.every((r) => !/accounts|me\/accounts|pages/.test(r.url.replace('/me', '')))); // no account / page listing, nothing is picked
  const calls = (await flow(igRoutes(), { cycles: 1 })).svc.http.raw.filter((r) => r.url.includes('/17841400000000001/'));
  assert.ok(calls.length > 0 && calls.every((r) => r.url.includes('/v25.0/17841400000000001/'))); // the connector's external_id, always
});

test('Instagram scopes and capabilities: canonical Instagram Login scopes, image gated to JPEG, reels for video, nothing else', async () => {
  const cap = A.getChannelCapability('instagram');
  assert.deepEqual([...cap.required_scopes], ['instagram_business_basic', 'instagram_business_content_publish']); // 91
  for (const deprecated of ['instagram_basic', 'instagram_content_publish', 'business_management', 'pages_show_list']) assert.ok(!cap.required_scopes.includes(deprecated)); // 92
  const onlyDeprecated = credentialProvider({ [`${M1}:${IDS.IG}`]: { access_token: TOKENS.IG, granted_scopes: ['instagram_basic', 'instagram_content_publish'] } });
  assert.ok(igDelivery(await preflightIg(services(W, { credentials: onlyDeprecated }))).reason_codes.includes('SCOPE_MISSING'));
  const png = mediaTransport({ 'instagram:asset://img-1': { transport_mode: 'PUBLIC_URL', ephemeral_location: 'https://media.example.test/img-1.png', content_type: 'image/png', expires_at: '2026-10-14T00:00:00Z' } }); // 93
  assert.deepEqual([igDelivery(await preflightIg(services(W, { transport: png }))).status, igDelivery(await preflightIg(services(W, { transport: png }))).reason_codes], ['BLOCKED', ['MEDIA_NOT_COMPATIBLE']]);
  assert.equal(igDelivery(await preflightIg(services(W))).status, 'READY');
  const adapter = A.createInstagramAdapter({ http: createFakeHttp([]), graphVersion: 'v25.0' }); // 94
  const video = await A.resolveMediaTransport(A.createInMemoryMediaTransport({ 'instagram:asset://vid-1': { ephemeral_location: 'https://media.example.test/v.mp4?sig=X', content_type: 'video/mp4' } }), { assetRef: 'asset://vid-1', provider: 'instagram', asOf: NOW });
  const reel = adapter.buildSubmission({ content: { contentKind: 'VIDEO', transport: video, texts: {} }, options: A.normalizeProviderOptions('instagram', {}) });
  assert.equal(reel.params.media_type, 'REELS');
  assert.ok(reel.params.video_url && !reel.params.image_url);
  assert.ok(cap.limitations.includes('CAROUSEL_NOT_SUPPORTED_V1') && cap.limitations.includes('STORIES_NOT_SUPPORTED_V1')); // 95
  assert.deepEqual([...cap.supported_content_kinds], ['IMAGE', 'VIDEO']);
  assert.equal(adapter.normalizeOptions && (() => { try { adapter.normalizeOptions({ media_type: 'STORIES' }); } catch (e) { return e.code; } return null; })(), 'ACT_PROVIDER_OPTIONS_INVALID');
  assert.throws(() => A.createInstagramAdapter({ http: createFakeHttp([]) }), /Graph API version/); // the version is configuration, never hardcoded
});

test('Instagram publishing: container -> status -> media_publish, processing is not published, the media id is the post id', async () => {
  const rt = await flow(igRoutes({ statuses: ['IN_PROGRESS', 'FINISHED'] }), { cycles: 1 });
  const creation = rt.svc.http.raw.find((r) => r.method === 'POST' && r.url.endsWith('/17841400000000001/media')); // 96
  assert.equal(creation.body.image_url.reveal(), 'https://media.example.test/img-1.jpg?sig=SIGNEDSECRET');
  assert.equal(creation.body.access_token.reveal(), TOKENS.IG);
  assert.equal(creation.headers, undefined);
  const row = jobOf(rt, 'instagram');
  assert.deepEqual([row.state, row.provider_submission_id], ['PROCESSING', 'container-1']); // 97, 98: a container is not a publication
  assert.doesNotMatch(row.provider_submission_id, /http|:|\//);
  assert.equal(rt.svc.http.raw.filter((r) => r.url.endsWith('/media_publish')).length, 0); // 99
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  assert.equal(jobOf(rt, 'instagram').state, 'PROCESSING'); // IN_PROGRESS first
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  const done = jobOf(rt, 'instagram');
  assert.deepEqual([done.state, done.provider_post_id], ['PUBLISHED', 'ig-media-1']); // 100
  const order = rt.svc.http.raw.filter((r) => r.url.includes('container-1') || r.url.endsWith('media_publish') || r.url.endsWith('/media')).map((r) => `${r.method} ${r.url.split('/').pop().split('?')[0]}`);
  assert.deepEqual(order.slice(0, 2), ['POST media', 'GET container-1']);
  assert.equal(order.at(-1), 'POST media_publish'); // published only AFTER media_publish
  assert.ok(done.published_at);
});

test('Instagram transport URLs are ephemeral and sealed: never persisted, logged or serialized; tokens never logged', async () => {
  const resolved = await A.resolveMediaTransport(mediaTransport(), { assetRef: 'asset://img-1', provider: 'instagram', asOf: NOW }); // 101
  assert.ok(resolved.ephemeral_location instanceof A.SealedSecret);
  assert.doesNotMatch(JSON.stringify(resolved), /SIGNEDSECRET|media\.example/);
  assert.deepEqual(Object.keys(A.describeMediaTransport(resolved)).sort(), ['byte_length', 'content_type', 'domain_verified', 'expires_at', 'transport_mode']);
  const expired = mediaTransport({ 'instagram:asset://img-1': { ephemeral_location: 'https://media.example.test/a.jpg', content_type: 'image/jpeg', expires_at: '2026-10-13T08:00:00Z' } });
  assert.ok(igDelivery(await preflightIg(services(W, { transport: expired }))).reason_codes.includes('ACT_MEDIA_TRANSPORT_MISSING'));
  const rt = await flow(igRoutes(), { cycles: 2 });
  const persisted = JSON.stringify([rt.store._rows, rt.logs]); // 102, 103
  assert.doesNotMatch(persisted, /SIGNEDSECRET|media\.example|sig=/);
  for (const token of Object.values(TOKENS)) assert.ok(!persisted.includes(token));
  assert.doesNotMatch(JSON.stringify(rt.svc.http.raw), new RegExp(TOKENS.IG)); // even the recorded requests print a sealed token as [REDACTED]
});

test('Instagram errors are normalized: rate limit, auth, permanent media errors; a published post is never published twice', async () => {
  const limited = await flow(rest(...igRoutes().filter((r) => !r.url.endsWith('/media')), igPost('media', resp(400, { error: { code: 4 } }))), { cycles: 1 }); // 104
  assert.deepEqual([jobOf(limited, 'instagram').state, jobOf(limited, 'instagram').last_error_code], ['FAILED_RETRYABLE', 'RATE_LIMITED']);
  const auth = await flow(rest(...igRoutes().filter((r) => !r.url.endsWith('/media')), igPost('media', resp(400, { error: { code: 190 } }))), { cycles: 1 }); // 105
  assert.deepEqual([jobOf(auth, 'instagram').state, jobOf(auth, 'instagram').last_error_code], ['FAILED_FINAL', 'AUTH_INVALID']);
  const scope = await flow(rest(...igRoutes().filter((r) => !r.url.endsWith('/media')), igPost('media', resp(403, { error: { code: 10 } }))), { cycles: 1 });
  assert.equal(jobOf(scope, 'instagram').last_error_code, 'SCOPE_MISSING');
  const media = await flow(igRoutes({ statuses: ['ERROR'] }), { cycles: 3 }); // 106
  assert.deepEqual([jobOf(media, 'instagram').state, jobOf(media, 'instagram').last_error_code], ['FAILED_FINAL', 'MEDIA_INVALID']);
  const once = await flow(igRoutes(), { cycles: 5 }); // 107
  assert.equal(jobOf(once, 'instagram').state, 'PUBLISHED');
  assert.equal(once.svc.http.raw.filter((r) => r.url.endsWith('/media_publish')).length, 1);
  const already = await flow(igRoutes({ statuses: ['PUBLISHED'] }), { cycles: 3 }); // the container says PUBLISHED but we hold no media id: never publish again
  assert.deepEqual([jobOf(already, 'instagram').state, jobOf(already, 'instagram').last_error_code], ['FAILED_FINAL', 'PUBLISH_RESULT_UNKNOWN']);
  assert.equal(already.svc.http.raw.filter((r) => r.url.endsWith('/media_publish')).length, 0);
  assert.equal(SCOPES.instagram.length, 2);
  assert.equal(IDS.IG.length, 36);
});
