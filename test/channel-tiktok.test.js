import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as A from '../src/activation/index.js';
import {
  IDS, M1, NOW, TIKTOK_OPTIONS, TOKENS, advance, createFakeHttp, credentialProvider, gbpRoutes, igRoutes, imageDelivery, jobOf, mediaTransport, orderOf, preflightInput, runtime,
  services, tenant, textDelivery, ttRoutes, world,
} from './channel-fixtures.js';

const W = world();
const resp = (status, body = {}, headers = {}) => ({ status, headers, body });
const err = (status, errorCode) => resp(status, { error: { code: errorCode, message: `${TOKENS.TT} must never be kept` } });
const ttDelivery = (over = {}, options = {}) => imageDelivery(W, {
  connector_id: IDS.TT, provider: 'tiktok', publish_mode: 'INTERACTIVE_CONFIRMATION', approval_ref: 'approval://creator-consent-1', provider_options: { ...TIKTOK_OPTIONS, ...options }, ...over,
});
const deliveries = (over, options) => [ttDelivery(over, options), textDelivery(W)];
const others = () => [...igRoutes(), ...gbpRoutes()];
const run = async (routes, { cycles = 1, step = 120_000, over = {}, d = deliveries() } = {}) => {
  const rt = await runtime(W, { routes: [...routes, ...others()], deliveries: d, ...over });
  for (let i = 0; i < cycles; i += 1) { await rt.executor.runDueJobs({ merchantId: M1 }); advance(rt, step); }
  return rt;
};
const pre = (routes, { over = {}, d = deliveries(), svcOver = {} } = {}) => A.evaluateChannelExecutionPreflight(preflightInput(W, orderOf(W, d), services(W, { routes: [...routes, ...others()], ...svcOver }), over));
const tt = (r) => r.deliveries.find((x) => x.provider === 'tiktok');
const initRoute = (respond) => ({ method: 'POST', url: '/v2/post/publish/content/init/', respond });

test('TikTok scope and creator info: video.publish is enforced, creator_info is queried first, the privacy level must be a CURRENT creator option, PUBLIC is never hardcoded', async () => {
  const cap = A.getChannelCapability('tiktok');
  assert.deepEqual([...cap.required_scopes], ['video.publish']); // 109
  const noScope = credentialProvider({ [`${M1}:${IDS.TT}`]: { access_token: TOKENS.TT, granted_scopes: ['user.info.basic'] } });
  assert.ok(tt(await pre(ttRoutes(), { svcOver: { credentials: noScope } })).reason_codes.includes('SCOPE_MISSING'));
  const rt = await run(ttRoutes());
  const order = rt.svc.http.raw.filter((r) => r.url.includes('/v2/post/publish/')).map((r) => r.url.split('/v2/post/publish/')[1]); // 110
  assert.ok(order.indexOf('creator_info/query/') >= 0 && order.indexOf('creator_info/query/') < order.indexOf('content/init/'));
  const levels = ['MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']; // 111
  assert.equal(tt(await pre(ttRoutes({ options: levels }), { d: deliveries({}, { privacy_level: 'MUTUAL_FOLLOW_FRIENDS' }) })).status, 'READY');
  const mismatch = tt(await pre(ttRoutes({ options: ['SELF_ONLY'] }), { d: deliveries({}, { privacy_level: 'MUTUAL_FOLLOW_FRIENDS' }) }));
  assert.deepEqual([mismatch.status, mismatch.reason_codes.includes('PRIVACY_MISMATCH')], ['BLOCKED', true]);
  const noPrivacy = { ...TIKTOK_OPTIONS }; delete noPrivacy.privacy_level; // 112
  assert.throws(() => A.normalizeProviderOptions('tiktok', noPrivacy), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  const publicWanted = tt(await pre(ttRoutes({ options: ['SELF_ONLY'] }), { d: deliveries({}, { privacy_level: 'PUBLIC_TO_EVERYONE' }) }));
  assert.equal(publicWanted.status, 'BLOCKED');
  const source = (await readFile(new URL('../src/activation/providers/tiktok.js', import.meta.url), 'utf8')).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(source.match(/PUBLIC_TO_EVERYONE/g).length, 1); // only in the list of valid levels: no default, no fallback
  assert.equal(A.createTikTokAdapter({ http: createFakeHttp([]) }).clientAudited, false); // unaudited unless told otherwise
});

test('TikTok media: photo and video are supported through PULL_FROM_URL from a verified domain; unverified or invalid media is blocked', async () => {
  assert.deepEqual([...A.getChannelCapability('tiktok').supported_content_kinds], ['IMAGE', 'VIDEO']); // 113, 114
  const rt = await run(ttRoutes());
  const init = rt.svc.http.raw.find((r) => r.url.endsWith('/v2/post/publish/content/init/')); // 113, 118: a photo post through the verified domain
  assert.deepEqual([init.body.media_type, init.body.post_mode, init.body.source_info.source, init.body.source_info.photo_cover_index], ['PHOTO', 'DIRECT_POST', 'PULL_FROM_URL', 0]);
  assert.equal(init.body.source_info.photo_images[0].reveal(), 'https://media.example.test/img-1.jpg?sig=SIGNEDSECRET');
  assert.equal(init.headers.Authorization.reveal(), `Bearer ${TOKENS.TT}`);
  const unverified = mediaTransport({ 'tiktok:asset://img-1': { ephemeral_location: 'https://media.example.test/img-1.jpg', content_type: 'image/jpeg', domain_verified: false } }); // 119
  const blocked = tt(await pre(ttRoutes(), { svcOver: { transport: unverified } }));
  assert.deepEqual([blocked.status, blocked.reason_codes.includes('URL_OWNERSHIP_UNVERIFIED')], ['BLOCKED', true]);
  const long = mediaTransport({ 'asset://caption-1': { text: 'x'.repeat(91) } }); // 115: a photo title is limited to 90 characters, and is never shortened here
  const tooLong = tt(await pre(ttRoutes(), { d: deliveries({}, { title_asset_ref: 'asset://caption-1' }), svcOver: { transport: long } }));
  assert.deepEqual([tooLong.status, tooLong.reason_codes.includes('CAPTION_TOO_LONG')], ['BLOCKED', true]);
  const adapter = A.createTikTokAdapter({ http: createFakeHttp(ttRoutes()), clientAudited: true }); // 114, 120: the video route
  const video = await A.resolveMediaTransport(A.createInMemoryMediaTransport({ 'tiktok:asset://vid-1': { ephemeral_location: 'https://media.example.test/v.mp4?sig=X', content_type: 'video/mp4', domain_verified: true } }), { assetRef: 'asset://vid-1', provider: 'tiktok', asOf: NOW });
  const submission = adapter.buildSubmission({ content: { contentKind: 'VIDEO', transport: video, texts: {} }, options: A.normalizeProviderOptions('tiktok', TIKTOK_OPTIONS) });
  assert.deepEqual([submission.kind, submission.path, submission.body.source_info.source], ['TIKTOK_VIDEO', '/v2/post/publish/video/init/', 'PULL_FROM_URL']);
  const credential = await A.resolveChannelCredential(credentialProvider(), { merchantId: M1, connectorId: IDS.TT, provider: 'tiktok', purpose: 'PUBLISH', asOf: NOW });
  const http = createFakeHttp(ttRoutes());
  const sent = await A.createTikTokAdapter({ http, clientAudited: true }).submit({ credential, submission });
  assert.deepEqual([sent.outcome, sent.provider_submission_id, http.raw[0].url.endsWith('/v2/post/publish/video/init/')], ['PROCESSING', 'p_pub_url~v2.2', true]);
  const levels = await A.createTikTokAdapter({ http: createFakeHttp(ttRoutes()), clientAudited: true }).preflight({
    credential, content: { contentKind: 'VIDEO', transport: video, texts: {} }, options: A.normalizeProviderOptions('tiktok', TIKTOK_OPTIONS), delivery: { approval_ref: 'a' },
  });
  assert.equal(levels.status, 'READY');
  assert.ok(A.getChannelCapability('tiktok').limitations.includes('FILE_UPLOAD_NOT_IMPLEMENTED_V1'));
});

test('TikTok audit and consent: an unaudited client is private-only (surfaced), interactive confirmation is respected', async () => {
  const noApproval = [ttDelivery({ approval_ref: undefined }), textDelivery(W)];
  const pending = tt(await pre(ttRoutes(), { d: noApproval })); // 117
  assert.deepEqual([pending.status, pending.reason_codes], ['REVIEW_REQUIRED', ['INTERACTIVE_CONFIRMATION_PENDING']]);
  const waiting = await run(ttRoutes(), { d: noApproval });
  assert.equal(jobOf(waiting, 'tiktok').state, 'PLANNED'); // never executed without the human step
  assert.equal(waiting.svc.http.raw.filter((r) => r.url.includes('/init/')).length, 0);
  const unaudited = await pre(ttRoutes(), { svcOver: { clientAudited: false } }); // 116
  assert.deepEqual([tt(unaudited).status, unaudited.review_signals.includes('TIKTOK_UNAUDITED_PRIVATE_ONLY')], ['READY', true]); // private-only is surfaced, SELF_ONLY with a human approval is allowed
  const notPrivate = tt(await pre(ttRoutes(), { d: deliveries({}, { privacy_level: 'MUTUAL_FOLLOW_FRIENDS' }), svcOver: { clientAudited: false } }));
  assert.deepEqual([notPrivate.status, notPrivate.reason_codes.includes('PRIVATE_ONLY_RESTRICTION')], ['BLOCKED', true]);
  const audited = await pre(ttRoutes(), { svcOver: { clientAudited: true } });
  assert.ok(!audited.review_signals.includes('TIKTOK_UNAUDITED_PRIVATE_ONLY'));
  assert.deepEqual([...A.getChannelCapability('tiktok').supported_delivery_modes], ['INTERACTIVE_CONFIRMATION']);
});

test('TikTok publishing: publish_id captured, init is not published, the final status is polled, the webhook is not a finalizer', async () => {
  const rt = await run(ttRoutes({ statuses: ['PROCESSING_DOWNLOAD', 'PUBLISH_COMPLETE'] }), { cycles: 1 });
  const row = jobOf(rt, 'tiktok');
  assert.deepEqual([row.state, row.provider_submission_id], ['PROCESSING', 'p_pub_url~v2.1']); // 121, 122
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  assert.equal(jobOf(rt, 'tiktok').state, 'PROCESSING'); // 123: still downloading
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  const done = jobOf(rt, 'tiktok');
  assert.deepEqual([done.state, done.provider_submission_id, [...done.provider_post_ids]], ['PUBLISHED', 'p_pub_url~v2.1', ['7000000000001']]);
  assert.equal(rt.svc.http.raw.filter((r) => r.url.endsWith('/status/fetch/')).length, 2);
  const moderated = await run(ttRoutes({ publicIds: [] }), { cycles: 3 }); // the public id exists only after moderation
  assert.deepEqual([jobOf(moderated, 'tiktok').provider_submission_id, [...jobOf(moderated, 'tiktok').provider_post_ids]], ['p_pub_url~v2.1', []]);
  assert.ok(A.getChannelCapability('tiktok').limitations.includes('WEBHOOK_NOT_IMPLEMENTED_V1')); // 124: polling only; a webhook alone could not finalize
  assert.equal(Object.keys(A.createTikTokAdapter({ http: createFakeHttp([]) })).filter((k) => /webhook/i.test(k)).length, 0);
});

test('TikTok errors are normalized and safe: rate limit, token, scope, daily cap and restrictions are not retried blindly; no duplicate post', async () => {
  const failing = (respond) => [initRoute(respond), ...ttRoutes().filter((r) => !r.url.includes('/content/init/'))];
  const limited = await run(failing(err(429, 'rate_limit_exceeded'))); // 125
  assert.deepEqual([jobOf(limited, 'tiktok').state, jobOf(limited, 'tiktok').last_error_code], ['FAILED_RETRYABLE', 'RATE_LIMITED']);
  const token = await run(failing(err(401, 'access_token_invalid'))); // 126
  assert.deepEqual([jobOf(token, 'tiktok').state, jobOf(token, 'tiktok').last_error_code], ['FAILED_FINAL', 'AUTH_INVALID']);
  const scope = await run(failing(err(401, 'scope_not_authorized'))); // 127
  assert.equal(jobOf(scope, 'tiktok').last_error_code, 'SCOPE_MISSING');
  const spam = await run(failing(err(403, 'spam_risk_too_many_posts'))); // 128
  assert.deepEqual([jobOf(spam, 'tiktok').state, jobOf(spam, 'tiktok').last_error_code], ['FAILED_FINAL', 'DAILY_LIMIT_REACHED']);
  assert.doesNotMatch(JSON.stringify([spam.store._rows, spam.logs]), new RegExp(TOKENS.TT)); // the provider message is never kept
  const restricted = await run(failing(err(403, 'unaudited_client_can_only_post_to_private_accounts')), { cycles: 1 }); // 129
  assert.equal(jobOf(restricted, 'tiktok').last_error_code, 'PRIVATE_ONLY_RESTRICTION');
  const inits = restricted.svc.http.raw.filter((r) => r.url.includes('/init/')).length;
  advance(restricted, 7_200_000);
  await restricted.executor.runDueJobs({ merchantId: M1 });
  assert.equal(restricted.svc.http.raw.filter((r) => r.url.includes('/init/')).length, inits); // never retried
  const mismatch = await run(failing(err(403, 'privacy_level_option_mismatch')));
  assert.equal(jobOf(mismatch, 'tiktok').last_error_code, 'PRIVACY_MISMATCH');
  const outage = await run(failing(resp(503, {})), { cycles: 3 }); // 130: a creating call whose outcome is unknown is NEVER retried (the post may exist)
  assert.deepEqual([jobOf(outage, 'tiktok').state, jobOf(outage, 'tiktok').last_error_code], ['SUBMISSION_UNKNOWN', 'SUBMISSION_OUTCOME_UNKNOWN']);
  assert.equal(outage.svc.http.raw.filter((r) => r.url.includes('/content/init/')).length, 1);
  const ok = await run(ttRoutes(), { cycles: 5 });
  assert.equal(ok.svc.http.raw.filter((r) => r.url.includes('/content/init/')).length, 1);
  const failedStatus = await run(ttRoutes({ statuses: ['FAILED'] }).map((r) => (r.url.endsWith('/status/fetch/') ? { ...r, respond: resp(200, { data: { status: 'FAILED', fail_reason: 'file_format_check_failed' }, error: { code: 'ok' } }) } : r)), { cycles: 3 });
  assert.deepEqual([jobOf(failedStatus, 'tiktok').state, jobOf(failedStatus, 'tiktok').last_error_code], ['FAILED_FINAL', 'MEDIA_INVALID']);
  const okEnvelope = await pre([{ method: 'POST', url: '/creator_info/query/', respond: resp(200, { error: { code: 'spam_risk_user_banned_from_posting' } }) }]); // errors can arrive as HTTP 200
  assert.equal(tt(okEnvelope).status, 'BLOCKED');
});

test('TikTok decisions are never guessed: is_aigc, the brand toggles and the privacy level come from the approved order', async () => {
  for (const key of ['is_aigc', 'brand_content_toggle', 'brand_organic_toggle', 'privacy_level']) { // 131, 132
    const options = { ...TIKTOK_OPTIONS }; delete options[key];
    assert.throws(() => A.normalizeProviderOptions('tiktok', options), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID', key);
    assert.throws(() => A.normalizeProviderOptions('tiktok', { ...TIKTOK_OPTIONS, [key]: null }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID', key);
  }
  assert.throws(() => A.normalizeProviderOptions('tiktok', { ...TIKTOK_OPTIONS, is_aigc: 'yes' }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  assert.throws(() => A.normalizeProviderOptions('tiktok', { ...TIKTOK_OPTIONS, whatever: true }), (e) => e.code === 'ACT_PROVIDER_OPTIONS_INVALID');
  const rt = await run(ttRoutes(), { d: deliveries({}, { is_aigc: true, brand_content_toggle: true, brand_organic_toggle: false }) });
  const init = rt.svc.http.raw.find((r) => r.url.endsWith('/content/init/'));
  assert.deepEqual([init.body.is_aigc, init.body.post_info.brand_content_toggle, init.body.post_info.brand_organic_toggle, init.body.post_info.privacy_level], [true, true, false, 'SELF_ONLY']);
});

test('TikTok ids: the publish_id is a SUBMISSION id and never a post id; a private PUBLISH_COMPLETE still gets a receipt; public ids only when returned; M4 cites the internal receipt', async () => {
  const privatePost = await run(ttRoutes({ publicIds: [] }), { cycles: 3 }); // 211, 212
  const row = jobOf(privatePost, 'tiktok');
  assert.deepEqual([row.state, row.provider_submission_id, [...row.provider_post_ids]], ['PUBLISHED', 'p_pub_url~v2.1', []]); // the publish_id is NOT copied into the post ids
  assert.ok(!row.provider_post_ids.includes(row.provider_submission_id));
  const receipt = A.buildChannelPublicationReceipt(row);
  assert.deepEqual([receipt.provider_submission_id, [...receipt.provider_post_ids]], ['p_pub_url~v2.1', []]);
  assert.ok(receipt.evidence_refs.includes('provider-submission://tiktok/p_pub_url-v2.1'));
  assert.ok(!receipt.evidence_refs.some((ref) => ref.startsWith('provider-post://'))); // no post id was invented
  const publicPost = await run(ttRoutes({ publicIds: ['7000000000001', '7000000000002'] }), { cycles: 3 }); // 213
  const published = A.buildChannelPublicationReceipt(jobOf(publicPost, 'tiktok'));
  assert.deepEqual([...published.provider_post_ids], ['7000000000001', '7000000000002']);
  assert.ok(published.evidence_refs.includes('provider-post://tiktok/7000000000001'));
  const processing = await run(ttRoutes({ statuses: ['PROCESSING_DOWNLOAD', 'PUBLISH_COMPLETE'] }), { cycles: 2 });
  assert.deepEqual([jobOf(processing, 'tiktok').state, [...jobOf(processing, 'tiktok').provider_post_ids]], ['PROCESSING', []]); // nothing is claimed before PUBLISH_COMPLETE
  const adapter = A.createTikTokAdapter({ http: createFakeHttp([{ method: 'POST', url: '/status/fetch/', respond: resp(200, { data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } }) }]) });
  const credential = await A.resolveChannelCredential(credentialProvider(), { merchantId: M1, connectorId: IDS.TT, provider: 'tiktok', purpose: 'STATUS', asOf: NOW });
  assert.deepEqual([...(await adapter.fetchStatus({ credential, providerSubmissionId: 'p_pub_url~v2.9' })).provider_post_ids], []);
  assert.throws(() => A.buildChannelPublicationReceipt({ ...row, provider_submission_id: null }), (e) => e.code === 'ACT_RECEIPT_PROVIDER_REF_REQUIRED'); // neither a submission id nor a post id: no receipt
  const both = await run(ttRoutes({ publicIds: [] }), { cycles: 3 }); // 214
  const receipts = both.store._rows.filter((r) => r.state === 'PUBLISHED').map((r) => A.buildChannelPublicationReceipt(r));
  const handoff = A.buildMarketingExecutionReceiptFromPublications({
    tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, publications: receipts, recordedAt: new Date(both.clock.t).toISOString(),
  });
  const tiktokReceipt = receipts.find((r) => r.provider === 'tiktok');
  assert.ok(handoff.delivery_execution_refs.some((ref) => ref.delivery_execution_ref === tiktokReceipt.receipt_id)); // the INTERNAL publication receipt
  assert.ok(handoff.delivery_execution_refs.every((ref) => ref.delivery_execution_ref.startsWith('acr_')));
  assert.ok(!handoff.evidence_refs.some((ref) => ref.startsWith('provider-post://tiktok/'))); // and no fake post id
  assert.ok(handoff.evidence_refs.includes('provider-submission://tiktok/p_pub_url-v2.1'));
});
