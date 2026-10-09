import test from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../src/activation/index.js';
import {
  IDS, M1, NOW, TOKENS, advance, connectorRow, createFakeHttp, credentialProvider, gbpRoutes, igRoutes, imageDelivery, jobOf, orderOf, preflightInput, runtime, services,
  textDelivery, ttRoutes, world,
} from './channel-fixtures.js';

const W = world();
const resp = (status, body = {}, headers = {}) => ({ status, headers, body });
const LOCATION = 'accounts/111/locations/222';
const gbpPost = (respond) => ({ method: 'POST', url: '/localPosts', respond });
const others = () => [...igRoutes(), ...ttRoutes()];
const run = async (routes = gbpRoutes(), { cycles = 1, step = 120_000, d, over = {} } = {}) => {
  const rt = await runtime(W, { routes: [...routes, ...others()], deliveries: d, ...over });
  for (let i = 0; i < cycles; i += 1) { await rt.executor.runDueJobs({ merchantId: M1 }); advance(rt, step); }
  return rt;
};
const gbpOnly = (textOptions = { topic_type: 'STANDARD' }, imageOptions = { topic_type: 'STANDARD', summary_asset_ref: 'asset://copy-1' }) => [
  imageDelivery(W, { connector_id: IDS.GBP, provider: 'google_business_profile', provider_options: imageOptions }), textDelivery(W, { provider_options: textOptions }),
];
const pre = (d, svcOver = {}, over = {}) => A.evaluateChannelExecutionPreflight(preflightInput(W, orderOf(W, d), services(W, { routes: [...gbpRoutes(), ...others()], ...svcOver }), over));
const posts = (rt) => rt.svc.http.raw.filter((r) => r.method === 'POST' && r.url.includes('/localPosts'));

test('Google Business scope and location: business.manage is required, the target is the connector location, never the first one', async () => {
  assert.deepEqual([...A.getChannelCapability('google_business_profile').required_scopes], ['https://www.googleapis.com/auth/business.manage']); // 133
  const narrow = credentialProvider({ [`${M1}:${IDS.GBP}`]: { access_token: TOKENS.GBP, granted_scopes: ['https://www.googleapis.com/auth/plus.business.manage'] } });
  assert.ok((await pre(undefined ?? [imageDelivery(W), textDelivery(W)], { credentials: narrow })).reason_codes.includes('SCOPE_MISSING'));
  const rt = await run(); // 134
  assert.equal(posts(rt)[0].url, `https://mybusiness.googleapis.com/v4/${LOCATION}/localPosts`);
  const notBound = [connectorRow({ id: IDS.IG, kind: 'instagram', externalId: '17841400000000001', config: { granted_scopes: ['instagram_business_basic', 'instagram_business_content_publish'] } }), connectorRow({ id: IDS.TT, kind: 'tiktok', externalId: 'tiktok-open-id-1', config: { granted_scopes: ['video.publish'] } }), connectorRow({ id: IDS.GBP, kind: 'google_business_profile', externalId: 'accounts/111', config: {} })];
  const bound = await A.evaluateChannelExecutionPreflight(preflightInput(W, orderOf(W), services(W), { connectors: notBound }));
  assert.ok(bound.reason_codes.includes('LOCATION_NOT_BOUND') || bound.reason_codes.includes('ORDER_INVALID') || bound.status === 'BLOCKED');
  const mismatch = (await pre(gbpOnly({ topic_type: 'STANDARD', location_ref: 'accounts/111/locations/999' }))).deliveries.find((x) => x.manifest_delivery_ref === W.textRef); // 147
  assert.deepEqual([mismatch.status, mismatch.reason_codes.includes('LOCATION_MISMATCH')], ['BLOCKED', true]);
  const sameLocation = (await pre(gbpOnly({ topic_type: 'STANDARD', location_ref: LOCATION }))).deliveries.find((x) => x.manifest_delivery_ref === W.textRef);
  assert.equal(sameLocation.status, 'READY');
  const verify = createFakeHttp(gbpRoutes()); // 148: verifying lists local posts of the designated location only; no account / location listing
  await A.createGoogleBusinessProfileAdapter({ http: verify }).verifyAccount({ connector: A.normalizeChannelConnector(connectorRow({ id: IDS.GBP, kind: 'google_business_profile', externalId: LOCATION, config: {} })), credential: await A.resolveChannelCredential(credentialProvider(), { merchantId: M1, connectorId: IDS.GBP, provider: 'google_business_profile', purpose: 'VERIFY', asOf: NOW }) });
  assert.deepEqual(verify.raw.map((r) => r.url), [`https://mybusiness.googleapis.com/v4/${LOCATION}/localPosts`]);
  assert.equal(verify.raw[0].headers.Authorization.reveal(), `Bearer ${TOKENS.GBP}`);
});

test('Google Business posts: LocalPost create mapping, standard, event and offer, product posts unsupported', async () => {
  const rt = await run(gbpRoutes(), { d: gbpOnly({ topic_type: 'STANDARD', language_code: 'fr' }) });
  const body = posts(rt).find((r) => r.body.summary === 'Venez découvrir la nouvelle collection en boutique.').body; // 135, 136
  assert.deepEqual(Object.keys(body).sort(), ['languageCode', 'summary', 'topicType']);
  assert.deepEqual([body.topicType, body.languageCode], ['STANDARD', 'fr']);
  assert.equal(jobOf(rt, 'google_business_profile').state, 'PUBLISHED');
  const eventOptions = { topic_type: 'EVENT', event_title_asset_ref: 'asset://event-title-1', event_start: '2026-10-20T18:00:00Z', event_end: '2026-10-20T21:30:00Z' }; // 137
  const event = await run(gbpRoutes(), { d: gbpOnly(eventOptions) });
  const eventBody = posts(event).find((r) => r.body.topicType === 'EVENT').body;
  assert.deepEqual([eventBody.event.title, eventBody.event.schedule.startDate, eventBody.event.schedule.endTime.minutes], ['Soirée de lancement', { year: 2026, month: 10, day: 20 }, 30]);
  assert.throws(() => A.normalizeProviderOptions('google_business_profile', { topic_type: 'EVENT' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  assert.throws(() => A.normalizeProviderOptions('google_business_profile', { ...eventOptions, event_end: '2026-10-20T17:00:00Z' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  const offerOptions = { ...eventOptions, topic_type: 'OFFER', offer_coupon_code_asset_ref: 'asset://caption-1', offer_redeem_url_asset_ref: 'asset://cta-url-1', offer_terms_asset_ref: 'asset://copy-1' }; // 138
  const offer = await run(gbpRoutes(), { d: gbpOnly(offerOptions) });
  const offerBody = posts(offer).find((r) => r.body.topicType === 'OFFER').body;
  assert.deepEqual(offerBody.offer, { couponCode: 'Nouveauté en boutique', redeemOnlineUrl: 'https://shop.example.test/collection', termsConditions: 'Venez découvrir la nouvelle collection en boutique.' });
  for (const topic of ['PRODUCT', 'PRODUCT_POST', 'ALERT', 'product']) { // 139: refused even with a complete event (nothing else may let it through)
    assert.throws(() => A.normalizeProviderOptions('google_business_profile', { topic_type: topic }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID', topic);
    assert.throws(() => A.normalizeProviderOptions('google_business_profile', { ...eventOptions, topic_type: topic }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID', topic);
  }
  assert.ok(A.getChannelCapability('google_business_profile').limitations.includes('PRODUCT_POST_UNSUPPORTED'));
  assert.deepEqual([...A.getChannelCapability('google_business_profile').supported_topic_types], ['STANDARD', 'EVENT', 'OFFER']);
  assert.throws(() => A.normalizeProviderOptions('google_business_profile', { topic_type: 'STANDARD', event_start: '2026-10-20T18:00:00Z' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
});

test('Google Business content: the call to action is never invented, the media goes through the resolver, the post id is captured', async () => {
  const none = posts(await run(gbpRoutes(), { d: gbpOnly() }));
  assert.ok(none.every((r) => r.body.callToAction === undefined)); // 140: no CTA unless the approved order carries one
  assert.throws(() => A.normalizeProviderOptions('google_business_profile', { topic_type: 'STANDARD', cta_url_asset_ref: 'asset://cta-url-1' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  assert.throws(() => A.normalizeProviderOptions('google_business_profile', { topic_type: 'STANDARD', cta_action_type: 'LEARN_MORE' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  assert.throws(() => A.normalizeProviderOptions('google_business_profile', { topic_type: 'STANDARD', cta_action_type: 'GET_OFFER', cta_url_asset_ref: 'asset://cta-url-1' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID'); // deprecated
  const withCta = await run(gbpRoutes(), { d: gbpOnly({ topic_type: 'STANDARD', cta_action_type: 'LEARN_MORE', cta_url_asset_ref: 'asset://cta-url-1' }) });
  assert.deepEqual(posts(withCta).find((r) => r.body.callToAction).body.callToAction, { actionType: 'LEARN_MORE', url: 'https://shop.example.test/collection' });
  const notApproved = (await pre(gbpOnly({ topic_type: 'STANDARD', cta_action_type: 'LEARN_MORE', cta_url_asset_ref: 'asset://invented-1' }), { transport: undefined })).deliveries.find((x) => x.manifest_delivery_ref === W.textRef);
  assert.deepEqual([notApproved.status, notApproved.reason_codes], ['BLOCKED', ['OPTION_NOT_APPROVED']]); // a link that is not in the approved content is refused
  const image = posts(withCta).find((r) => r.body.media).body; // 141
  assert.deepEqual([image.media[0].mediaFormat, image.media[0].sourceUrl.reveal(), image.summary], ['PHOTO', 'https://media.example.test/img-1.jpg?sig=SIGNEDSECRET', 'Venez découvrir la nouvelle collection en boutique.']);
  const rt = await run();
  const published = rt.store._rows.find((r) => r.provider === 'google_business_profile' && r.state === 'PUBLISHED'); // 142, 143
  assert.deepEqual([published.provider_post_id, published.provider_submission_id], ['accounts/111/locations/222/localPosts/9', 'accounts/111/locations/222/localPosts/9']);
  assert.equal(rt.svc.http.raw.filter((r) => r.method === 'GET' && /localPosts\/9/.test(r.url)).length, 0); // synchronous LIVE: no polling needed
});

test('Google Business errors: auth and scope normalized, transient quota retried, invalid payload final, a processing post is followed', async () => {
  const failing = (status, googleStatus) => [gbpPost(resp(status, { error: { status: googleStatus, message: `${TOKENS.GBP} secret` } })), ...gbpRoutes().filter((r) => !(r.method === 'POST'))];
  const auth = await run(failing(401, 'UNAUTHENTICATED')); // 144
  assert.deepEqual([jobOf(auth, 'google_business_profile').state, jobOf(auth, 'google_business_profile').last_error_code], ['FAILED_FINAL', 'AUTH_INVALID']);
  const scope = await run(failing(403, 'PERMISSION_DENIED'));
  assert.equal(jobOf(scope, 'google_business_profile').last_error_code, 'SCOPE_MISSING');
  const quota = await run(failing(429, 'RESOURCE_EXHAUSTED')); // 145
  assert.deepEqual([jobOf(quota, 'google_business_profile').state, jobOf(quota, 'google_business_profile').last_error_code], ['FAILED_RETRYABLE', 'RATE_LIMITED']);
  const invalid = await run(failing(400, 'INVALID_ARGUMENT')); // 146
  assert.deepEqual([jobOf(invalid, 'google_business_profile').state, jobOf(invalid, 'google_business_profile').last_error_code], ['FAILED_FINAL', 'INVALID_PAYLOAD']);
  const rejected = await run([gbpPost(resp(200, { name: `${LOCATION}/localPosts/9`, state: 'REJECTED' })), ...gbpRoutes().filter((r) => r.method !== 'POST')]);
  assert.equal(jobOf(rejected, 'google_business_profile').last_error_code, 'POLICY_VIOLATION');
  let polls = 0; // a post that is still PROCESSING is followed, a transient error while polling keeps it PROCESSING
  const slow = await run([gbpPost(resp(200, { name: `${LOCATION}/localPosts/9`, state: 'PROCESSING' })), { method: 'GET', url: '/localPosts/9', respond: () => { polls += 1; return polls === 1 ? resp(503) : resp(200, { name: `${LOCATION}/localPosts/9`, state: 'LIVE', createTime: '2026-10-13T09:05:00Z' }); } }, ...gbpRoutes().filter((r) => r.method !== 'POST')], { cycles: 4 });
  assert.equal(jobOf(slow, 'google_business_profile').state, 'PUBLISHED');
  assert.equal(polls, 2);
  assert.doesNotMatch(JSON.stringify([auth.store._rows, auth.logs]), new RegExp(TOKENS.GBP)); // raw provider messages are never kept
});

test('Google Business safe metadata: only a public permalink without query, and no secret URL is ever persisted', async () => {
  const rt = await run(gbpRoutes(), { cycles: 2 }); // 149, 150
  const row = jobOf(rt, 'google_business_profile');
  assert.deepEqual(row.safe_metadata, {}); // the search url carries a query: dropped
  const clean = await run([gbpPost(resp(200, { name: `${LOCATION}/localPosts/9`, state: 'LIVE', createTime: '2026-10-13T09:00:05Z', searchUrl: 'https://search.google.com/local/posts/abc' })), ...gbpRoutes().filter((r) => r.method !== 'POST')]);
  assert.deepEqual(jobOf(clean, 'google_business_profile').safe_metadata, { permalink: 'https://search.google.com/local/posts/abc' });
  const persisted = JSON.stringify([rt.store._rows, rt.logs]);
  assert.doesNotMatch(persisted, /SIGNEDSECRET|media\.example|sig=|Bearer|https?:\/\/[^"]*\?/);
  for (const token of Object.values(TOKENS)) assert.ok(!persisted.includes(token));
  assert.equal(rt.svc.http.raw.find((r) => r.url.includes('/localPosts')).headers.Authorization.toJSON(), '[REDACTED]');
});
