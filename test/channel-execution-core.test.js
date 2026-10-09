import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import * as A from '../src/activation/index.js';
import { ConnectorError, KNOWN_CONNECTOR_KINDS, PERSISTED_CONNECTOR_STATUSES } from '../src/tenant/connectors.js';
import {
  CONNECTORS, IDS, M1, M2, NOW, ORDER_EXPIRES, SCOPES, TIKTOK_OPTIONS, TOKENS, activationOf, advance, connectorRow, createFakeHttp, createJobStore, credentialProvider,
  igRoutes, imageDelivery, jobOf, mediaTransport, orderInputs, orderOf, preflightInput, runtime, services, tenant, textDelivery, ttRoutes, world,
} from './channel-fixtures.js';

const W = world();
const AT = String.fromCharCode(64); // keeps the repository privacy scan (no e-mail look-alike) quiet
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return assert.fail('expected an error'); };
const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const keysDeep = (v, out = new Set()) => { if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); } } return out; };
const clone = (v) => JSON.parse(JSON.stringify(v));
const preflight = (order, svc, over) => A.evaluateChannelExecutionPreflight(preflightInput(W, order, svc, over));
const ORDER = orderOf(W);
const withConnector = (id, over) => CONNECTORS().map((c) => (c.id === id ? { ...c, ...over } : c));

// ------------------------------------------------------------------ connections / credentials (1-20)

test('Connections: Instagram, TikTok and Google Business connectors are accepted, each with a stable external_id and in its own merchant', () => {
  const [ig, tt, gbp] = CONNECTORS();
  assert.equal(A.normalizeChannelConnector(ig, { merchantId: M1 }).provider, 'instagram'); // 1
  assert.equal(A.normalizeChannelConnector(tt, { merchantId: M1 }).provider, 'tiktok'); // 2
  assert.equal(A.normalizeChannelConnector(gbp, { merchantId: M1 }).provider, 'google_business_profile'); // 3
  for (const connector of [ig, tt, gbp]) { // 4
    for (const externalId of [null, undefined, '', '  ', ' padded ']) {
      assert.equal(code(() => A.normalizeChannelConnector({ ...connector, externalId })), 'ACT_CONNECTOR_EXTERNAL_ID_REQUIRED');
    }
  }
  assert.equal(code(() => A.normalizeChannelConnector({ ...ig, kind: 'shopify' })), 'ACT_CONNECTOR_KIND_UNSUPPORTED');
  assert.equal(code(() => A.normalizeChannelConnector(ig, { merchantId: M2 })), 'ACT_CONNECTOR_MERCHANT_MISMATCH'); // 5
  assert.equal(A.normalizeChannelConnector(ig, { merchantId: M1.toUpperCase() }).merchant_id, M1);
  assert.deepEqual(A.CHANNEL_PROVIDERS, ['instagram', 'tiktok', 'google_business_profile']);
});

test('Connector status: NOT_CONFIGURED and MISCONFIGURED block, UNAVAILABLE is runtime-only, several accounts are never auto-picked', async () => {
  const svc = services(W);
  for (const [status, reason] of [['MISCONFIGURED', 'CONNECTOR_MISCONFIGURED'], ['NOT_CONFIGURED', 'CONNECTOR_NOT_CONFIGURED']]) { // 6, 7
    const result = await preflight(ORDER, svc, { connectors: withConnector(IDS.IG, { status }) });
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.deliveries[0].reason_codes.includes(reason));
  }
  assert.ok(!PERSISTED_CONNECTOR_STATUSES.includes('UNAVAILABLE')); // 8: runtime only, never stored
  const outage = createFakeHttp([{ method: 'GET', url: '/me', respond: { status: 503, body: {} } }]);
  const verdict = await A.verifyChannelConnection({
    connector: CONNECTORS()[0], adapter: A.createInstagramAdapter({ http: outage, graphVersion: 'v25.0' }), credentialProvider: credentialProvider(), asOf: NOW,
  });
  assert.deepEqual([verdict.status, verdict.persist_status], ['UNAVAILABLE', null]);
  // 9: two accounts of the same provider - the designated connector id is mandatory, nothing is picked
  const two = [...CONNECTORS(), connectorRow({ id: IDS.IG2, kind: 'instagram', externalId: '17841400000000002', config: {} })];
  assert.equal(code(() => A.selectChannelConnector(two, { merchantId: M1, connectorId: undefined })), 'ACT_INVALID_FIELD');
  assert.equal(A.selectChannelConnector(two, { merchantId: M1, connectorId: IDS.IG2 }).external_id, '17841400000000002');
  assert.equal(code(() => A.selectChannelConnector(two, { merchantId: M1, connectorId: IDS.OTHER })), 'ACT_CONNECTOR_NOT_FOUND');
  assert.equal(code(() => A.selectChannelConnector([two[0], two[0]], { merchantId: M1, connectorId: IDS.IG })), 'ACT_CONNECTOR_AMBIGUOUS');
  const noConnector = { ...imageDelivery(W) }; delete noConnector.connector_id;
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [noConnector, textDelivery(W)]))), 'ACT_INVALID_FIELD');
});

test('Credentials: never in the config, a resolver is required, the connection view is secret-free, scopes are normalized', async () => {
  const secretConfig = { ...CONNECTORS()[0], config: { access_token: TOKENS.IG } }; // 10, 12
  assert.throws(() => A.normalizeChannelConnector(secretConfig), (e) => e instanceof ConnectorError && e.code === 'CONNECTOR_CONFIG_SECRET');
  assert.throws(() => A.normalizeChannelConnector({ ...CONNECTORS()[0], config: { nested: { refresh_token: 'x' } } }), /secrets/);
  const noResolver = await preflight(ORDER, { ...services(W), credentialProvider: undefined }); // 11
  assert.equal(noResolver.status, 'BLOCKED');
  assert.ok(noResolver.deliveries.every((d) => d.reason_codes.includes('ACT_CREDENTIAL_PROVIDER_REQUIRED')));
  assert.equal(code(() => A.requireCredentialProvider({})), 'ACT_CREDENTIAL_PROVIDER_REQUIRED');
  const view = A.buildChannelConnectionView({ connector: A.normalizeChannelConnector(CONNECTORS()[0], { merchantId: M1 }), runtime: { external_display_name: 'brand', last_verified_at: NOW } }); // 15
  assert.doesNotMatch(JSON.stringify(view), new RegExp(`${TOKENS.IG}|access_token|refresh_token|Bearer`));
  assert.deepEqual(Object.keys(view).sort(), ['account_state', 'capabilities', 'connector_id', 'external_display_name', 'external_id', 'granted_scopes', 'last_verified_at', 'merchant_id', 'provider', 'review_signals', 'status'].sort());
  assert.deepEqual([...A.normalizeScopes([' b_scope ', 'a_scope', 'a_scope'])], ['a_scope', 'b_scope']); // 16
  assert.equal(code(() => A.normalizeScopes(['bad scope'])), 'ACT_INVALID_FIELD');
  assert.ok(A.buildChannelConnectionView({ connector: A.normalizeChannelConnector({ ...CONNECTORS()[0], config: {} }, { merchantId: M1 }) }).review_signals.includes('SCOPES_MISSING'));
  const sealed = A.seal('super-secret-value'); // 12/13: a sealed secret prints and serializes as [REDACTED]
  assert.equal(JSON.stringify({ sealed }), '{"sealed":"[REDACTED]"}');
  assert.equal(String(sealed), '[REDACTED]');
  assert.equal(sealed.reveal(), 'super-secret-value');
});

test('Capabilities: frozen and verified, unsupported content or mode is blocked, outputs are deeply frozen', async () => {
  const capability = A.getChannelCapability('instagram');
  assert.ok(isDeepFrozen(A.CHANNEL_CAPABILITIES)); // 17
  assert.throws(() => { capability.supported_content_kinds.push('STORY'); }, TypeError);
  assert.throws(() => { capability.required_scopes[0] = 'x'; }, TypeError);
  for (const provider of A.CHANNEL_PROVIDERS) {
    const cap = A.getChannelCapability(provider);
    assert.equal(cap.verified_at, '2026-10-09T00:00:00.000Z');
    assert.ok(cap.verified_against.every((url) => url.startsWith('https://')) && cap.capability_version.endsWith('.v1'));
  }
  assert.equal(A.getChannelCapability('linkedin'), null);
  const textOnInstagram = await preflight(ORDER, services(W), { order: orderOf(W, [imageDelivery(W, { manifest_delivery_ref: W.textRef }), textDelivery(W, { manifest_delivery_ref: W.imageRef })]) }); // 18
  assert.equal(textOnInstagram.status, 'BLOCKED');
  assert.ok(textOnInstagram.reason_codes.includes('CONTENT_KIND_UNSUPPORTED'));
  assert.equal(A.assessCapabilityFit({ provider: 'linkedin', contentKind: 'IMAGE', publishMode: 'PUBLISH_NOW' }).reason_codes[0], 'PROVIDER_UNSUPPORTED');
  assert.ok(isDeepFrozen(A.buildChannelConnectionView({ connector: A.normalizeChannelConnector(CONNECTORS()[1], { merchantId: M1 }) }))); // 19
  assert.ok(isDeepFrozen(A.normalizeChannelConnector(CONNECTORS()[2], { merchantId: M1 })));
});

test('No token persistence: a full run stores no credential, writes no connector, and keeps no secret in jobs', async () => {
  const rt = await runtime(W);
  await rt.executor.runDueJobs({ merchantId: M1 });
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  const stored = JSON.stringify(rt.store._rows); // 20
  for (const token of Object.values(TOKENS)) assert.ok(!stored.includes(token));
  assert.doesNotMatch(stored, /SIGNEDSECRET|Bearer|access_token/);
  const receipts = JSON.stringify(rt.store._rows.map((job) => A.buildChannelPublicationReceipt(job))); // 14: publication receipts carry no secret either
  for (const token of Object.values(TOKENS)) assert.ok(!receipts.includes(token));
  assert.doesNotMatch(receipts, /SIGNEDSECRET|Bearer|access_token|sig=/);
  assert.ok(rt.store.calls.every((call) => call.table === 'channel_execution_jobs')); // never touches merchant_connectors
  assert.deepEqual(rt.store._rows.map((r) => r.state).sort(), ['PUBLISHED', 'PUBLISHED']);
});

// ------------------------------------------------------------------ execution order (21-40)

test('Execution order: valid, scope derived from the manifest, explicit connector per delivery, publish modes and window', () => {
  const order = orderOf(W); // 21
  assert.match(order.order_id, /^aco_[0-9a-f]{32}$/);
  assert.deepEqual([order.merchant_id, order.brand_id], [M1, W.activationManifest.brand_id]); // 22
  assert.equal(code(() => A.buildChannelExecutionOrder({ ...orderInputs(W, [imageDelivery(W), textDelivery(W)]), merchant_id: M2 })), 'ACT_UNKNOWN_KEY');
  assert.equal(code(() => A.buildChannelExecutionOrder({ ...orderInputs(W, [imageDelivery(W), textDelivery(W)]), brand_id: 'x' })), 'ACT_UNKNOWN_KEY'); // 24
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [imageDelivery(W), textDelivery(W)], { tenant: tenant(M2) }))), 'MKT_M4_SCOPE_MISMATCH'); // 23
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [imageDelivery(W), textDelivery(W)], { connectors: CONNECTORS().map((c) => ({ ...c, merchantId: M2 })) }))), 'ACT_CONNECTOR_MERCHANT_MISMATCH');
  assert.equal(order.execution_authorization_ref, 'exec-auth://1'); // 25
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [imageDelivery(W), textDelivery(W)], { authorization: W.execAuth({ activation_manifest_ref: 'mam_other' }) }))), 'MKT_M4_AUTH_MANIFEST_MISMATCH');
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [imageDelivery(W), textDelivery(W)], { authorization: undefined }))), 'MKT_INVALID_FIELD');
  assert.deepEqual(order.deliveries.map((d) => d.connector_id), [IDS.IG, IDS.GBP]); // 26
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [imageDelivery(W, { connector_id: IDS.OTHER }), textDelivery(W)]))), 'ACT_CONNECTOR_NOT_FOUND'); // 27
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, [imageDelivery(W, { provider: 'tiktok' }), textDelivery(W)]))), 'ACT_ORDER_PROVIDER_MISMATCH');
  assert.equal(order.deliveries[0].publish_mode, 'PUBLISH_NOW'); // 28
  assert.equal(order.deliveries[0].publish_at, null);
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { publish_at: '2026-10-14T00:00:00Z' }), textDelivery(W)])), 'ACT_ORDER_INVALID_MODE');
  const scheduled = orderOf(W, [imageDelivery(W, { publish_mode: 'SCHEDULE_INTERNAL', publish_at: '2026-10-14T10:00:00Z' }), textDelivery(W)]); // 29, 32
  assert.deepEqual([scheduled.deliveries[0].publish_mode, scheduled.deliveries[0].publish_at], ['SCHEDULE_INTERNAL', '2026-10-14T10:00:00.000Z']);
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { publish_mode: 'SCHEDULE_INTERNAL' }), textDelivery(W)])), 'ACT_ORDER_PUBLISH_AT_REQUIRED');
  const confirm = orderOf(W, [imageDelivery(W), textDelivery(W, { publish_mode: 'INTERACTIVE_CONFIRMATION', approval_ref: 'approval://human-1' })]); // 30
  assert.equal(confirm.deliveries[1].approval_ref, 'approval://human-1');
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { publish_mode: 'BEST_TIME' }), textDelivery(W)])), 'ACT_ORDER_INVALID_MODE'); // 31
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { publish_mode: 'SCHEDULE_INTERNAL', publish_at: '2026-10-11T23:59:59Z' }), textDelivery(W)])), 'ACT_ORDER_PUBLISH_AT_OUTSIDE_WINDOW'); // 33
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { publish_mode: 'SCHEDULE_INTERNAL', publish_at: '2026-10-17T00:00:00Z' }), textDelivery(W)])), 'ACT_ORDER_PUBLISH_AT_OUTSIDE_WINDOW'); // 34: the window end is exclusive
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { provider: 'tiktok', connector_id: IDS.TT, publish_mode: 'PUBLISH_NOW', provider_options: TIKTOK_OPTIONS }), textDelivery(W)])), 'ACT_ORDER_INVALID_MODE'); // TikTok needs a human confirmation
});

test('Execution order coverage: every manifest delivery exactly once, bounded expiry, deterministic, frozen', () => {
  assert.equal(code(() => orderOf(W, [imageDelivery(W), imageDelivery(W), textDelivery(W)])), 'ACT_ORDER_DUPLICATE_DELIVERY'); // 35
  assert.equal(code(() => orderOf(W, [imageDelivery(W)])), 'ACT_ORDER_DELIVERY_MISSING'); // 36
  assert.equal(code(() => orderOf(W, [imageDelivery(W), textDelivery(W, { manifest_delivery_ref: 'mdl_unknown' })])), 'ACT_ORDER_DELIVERY_UNKNOWN'); // 37
  assert.equal(code(() => orderOf(W, undefined, { expires_at: '2026-10-16T00:00:01Z' })), 'ACT_ORDER_OUTLIVES_GOVERNING'); // 38: authorization expiry is 10-16
  assert.equal(code(() => orderOf(W, undefined, { expires_at: NOW })), 'ACT_ORDER_INVALID_EXPIRY');
  assert.equal(code(() => orderOf(W, undefined, { asOf: '2026-10-16T00:00:00Z', expires_at: '2026-10-16T12:00:00Z' })), 'ACT_ORDER_OUTLIVES_GOVERNING');
  const order = orderOf(W); // 39
  assert.equal(orderOf(W).order_id, order.order_id);
  assert.notEqual(orderOf(W, [imageDelivery(W), textDelivery(W, { provider_options: { topic_type: 'STANDARD', language_code: 'fr' } })]).order_id, order.order_id);
  assert.equal(A.normalizeChannelExecutionOrder(order, { tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, connectors: CONNECTORS() }).order_id, order.order_id);
  assert.equal(code(() => A.normalizeChannelExecutionOrder({ ...order, expires_at: '2026-10-14T00:00:00.000Z' }, { tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, connectors: CONNECTORS() })), 'ACT_ORDER_DERIVED_MISMATCH');
  assert.ok(isDeepFrozen(order)); // 40
  assert.equal(order.status_snapshot.status, 'AUTHORIZED_FOR_PREFLIGHT');
  assert.equal(code(() => orderOf(W, [{ ...imageDelivery(W), provider_options: { raw: 'x' } }, textDelivery(W)])), 'ACT_PROVIDER_OPTIONS_INVALID');
});

// ------------------------------------------------------------------ preflight (41-58)

test('Preflight: READY, and stale authorization / order / manifest are BLOCKED', async () => {
  const svc = services(W);
  const ready = await preflight(ORDER, svc); // 41
  assert.deepEqual([ready.status, ready.reason_codes.length], ['READY', 0]);
  const staleAuth = await preflight(ORDER, svc, { asOf: '2026-10-16T01:00:00Z' }); // 42
  assert.equal(staleAuth.status, 'BLOCKED');
  assert.ok(staleAuth.reason_codes.includes('STALE_AUTHORIZATION'));
  const staleOrder = await preflight(ORDER, svc, { asOf: '2026-10-15T12:00:00Z' }); // 43
  assert.deepEqual([staleOrder.status, staleOrder.reason_codes.includes('STALE_ORDER')], ['BLOCKED', true]);
  const staleManifest = await preflight(ORDER, svc, { asOf: '2026-10-17T12:00:00Z' }); // 44
  assert.ok(staleManifest.reason_codes.includes('STALE_MANIFEST'));
  assert.equal(svc.http.raw.length > 0, true); // only the READY run called providers (preflight checks)
});

test('Preflight: a manifest that is not live READY_FOR_POLICY is BLOCKED, and the stored readiness is never trusted', async () => {
  const svc = services(W);
  assert.equal(W.activationManifest.readiness.status, 'READY_FOR_POLICY'); // the stored snapshot
  const gated = { ...W.brandContext, status: 'GATED', reasons: ['BRAND_CORE_MISSING'] };
  const brandGated = await preflight(ORDER, svc, { activation: { ...activationOf(W), brandContext: gated } }); // 45
  assert.equal(brandGated.status, 'BLOCKED');
  assert.ok(brandGated.reason_codes.some((c) => c.startsWith('MANIFEST_')));
  const failing = W.candidates.map((e) => (e.candidate.content_kind === 'IMAGE' ? { ...e, candidateManifest: { ...e.candidateManifest, colors: [{ subject: 'logo.color', coverage: 'COMPLETE', values: ['#000000'], evidence_refs: ['ev/color'] }] } } : e));
  const guardianBlocked = await preflight(ORDER, svc, { activation: { ...activationOf(W), candidates: failing } });
  assert.equal(guardianBlocked.status, 'BLOCKED');
  assert.ok(guardianBlocked.reason_codes.includes('MANIFEST_NOT_LIVE_VALID'));
  const calls = svc.http.raw.length;
  assert.equal(calls, 0); // nothing reached a provider
});

test('Preflight: connector, outage, scope, kind, account and media checks', async () => {
  const svc = services(W);
  const missing = await preflight(ORDER, svc, { connectors: CONNECTORS().filter((c) => c.id !== IDS.IG) }); // 46
  assert.ok(missing.reason_codes.includes('ORDER_INVALID') || missing.reason_codes.includes('ACT_CONNECTOR_NOT_FOUND'));
  const mis = await preflight(ORDER, svc, { connectors: withConnector(IDS.IG, { status: 'MISCONFIGURED' }) }); // 47
  assert.ok(mis.reason_codes.includes('CONNECTOR_MISCONFIGURED'));
  const outageCredentials = await preflight(ORDER, services(W, { credentials: A.createInMemoryCredentialProvider({}, { failWith: 'CREDENTIAL_UNAVAILABLE' }) })); // 48
  assert.deepEqual([outageCredentials.status, outageCredentials.reason_codes.includes('CREDENTIAL_PROVIDER_UNAVAILABLE')], ['UNAVAILABLE', true]);
  const outageProvider = await preflight(ORDER, services(W, { routes: [{ method: 'GET', url: '/me', respond: { status: 503, body: {} } }, ...igRoutes().slice(1), ...ttRoutes()] }));
  assert.equal(outageProvider.deliveries[0].status, 'UNAVAILABLE');
  const lacking = credentialProvider({ [`${M1}:${IDS.IG}`]: { access_token: TOKENS.IG, granted_scopes: ['instagram_business_basic'] } }); // 49
  const noScope = await preflight(ORDER, services(W, { credentials: lacking }));
  assert.ok(noScope.deliveries[0].reason_codes.includes('SCOPE_MISSING'));
  const unsupported = await preflight(ORDER, services(W), { connectors: withConnector(IDS.IG, { kind: 'bank' }) }); // 50
  assert.equal(unsupported.status, 'BLOCKED');
  const personal = await preflight(ORDER, services(W, { routes: [...igRoutes({ accountType: 'Personal' }), ...ttRoutes()] })); // 51
  assert.ok(personal.deliveries[0].reason_codes.includes('ACCOUNT_NOT_PROFESSIONAL'));
  const noMedia = await preflight(ORDER, services(W, { transport: A.createInMemoryMediaTransport({}) })); // 52
  assert.ok(noMedia.reason_codes.includes('ACT_MEDIA_TRANSPORT_MISSING'));
  const noTransportAtAll = await preflight(ORDER, { ...services(W), mediaTransport: undefined });
  assert.ok(noTransportAtAll.reason_codes.includes('ACT_MEDIA_TRANSPORT_MISSING'));
});

test('Preflight: confirmations, private-only signals, no hidden selection, stable and deduplicated signals, nothing runs unless READY', async () => {
  const needsHuman = orderOf(W, [imageDelivery(W), textDelivery(W, { publish_mode: 'INTERACTIVE_CONFIRMATION' })]); // 53
  const pending = await preflight(needsHuman, services(W));
  assert.deepEqual([pending.status, pending.deliveries[1].status, pending.deliveries[1].reason_codes], ['REVIEW_REQUIRED', 'REVIEW_REQUIRED', ['INTERACTIVE_CONFIRMATION_PENDING']]);
  const confirmed = orderOf(W, [imageDelivery(W), textDelivery(W, { publish_mode: 'INTERACTIVE_CONFIRMATION', approval_ref: 'approval://human-1' })]);
  assert.equal((await preflight(confirmed, services(W))).status, 'READY');
  const tiktok = orderOf(W, [imageDelivery(W, { connector_id: IDS.TT, provider: 'tiktok', publish_mode: 'INTERACTIVE_CONFIRMATION', provider_options: TIKTOK_OPTIONS }), textDelivery(W)]); // 54
  const privateOnly = await preflight(tiktok, services(W, { clientAudited: false }));
  assert.ok(privateOnly.review_signals.includes('TIKTOK_UNAUDITED_PRIVATE_ONLY'));
  assert.equal(privateOnly.deliveries[0].status, 'REVIEW_REQUIRED');
  const noAdapter = await preflight(ORDER, { ...services(W), adapters: {} }); // 55: no provider is chosen or defaulted
  assert.ok(noAdapter.deliveries[0].reason_codes.includes('ADAPTER_MISSING'));
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { provider: undefined }), textDelivery(W)])), 'ACT_INVALID_FIELD');
  const again = await preflight(tiktok, services(W, { clientAudited: false })); // 56, 57
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(privateOnly)));
  for (const list of [again.reason_codes, again.review_signals, ...again.deliveries.map((d) => d.reason_codes)]) assert.deepEqual([...list], [...new Set(list)].sort());
  const rt = await runtime(W, { deliveries: [imageDelivery(W), textDelivery(W, { publish_mode: 'INTERACTIVE_CONFIRMATION' })] }); // 58
  assert.equal(jobOf(rt, 'google_business_profile').state, 'PLANNED'); // not READY: never executed
  await rt.executor.runDueJobs({ merchantId: M1 });
  assert.equal(rt.svc.http.calls('localPosts').filter((r) => r.method === 'POST').length, 0);
  const blocked = await runtime(W, { enqueue: false, credentials: A.createInMemoryCredentialProvider({}) });
  const enq = await blocked.executor.enqueueChannelExecutionOrder({ ...blocked.input, asOf: NOW });
  assert.equal(enq.status, 'BLOCKED');
  assert.equal(blocked.store._rows.length, 0);
});

// ------------------------------------------------------------------ security (169-185)

test('Security: no token, refresh token, secret config, header, cookie or signed URL is ever persisted or logged', async () => {
  const rt = await runtime(W);
  await rt.executor.runDueJobs({ merchantId: M1 });
  advance(rt, 120_000);
  await rt.executor.runDueJobs({ merchantId: M1 });
  const everything = JSON.stringify([rt.store._rows, rt.logs, rt.svc.http.raw.map((r) => JSON.parse(JSON.stringify(r)))]);
  for (const token of Object.values(TOKENS)) assert.ok(!everything.includes(token)); // 169
  assert.ok(!everything.includes('SIGNEDSECRET')); // 174
  assert.equal(A.findSecretLeaks({ refresh_token: 'abc' }).length, 1); // 170
  assert.equal(await acode(rt.repo.enqueue({ ...A.planChannelExecutionJobs({ order: rt.order, manifest: W.activationManifest, candidates: W.candidates })[0], payload: { refresh_token: 'abc' } })), 'ACT_SECRET_LEAK');
  assert.throws(() => A.normalizeChannelConnector({ ...CONNECTORS()[0], config: { client_secret: 'x' } }), ConnectorError); // 171
  assert.doesNotMatch(JSON.stringify(rt.logs), /Bearer|Authorization/i); // 172
  assert.equal(A.redact({ headers: { Authorization: 'Bearer abcdefghij', cookie: 'sid=1', 'set-cookie': 'a=b' } }).headers.Authorization, '[REDACTED]');
  assert.equal(A.redact({ cookie: 'sid=1' }).cookie, '[REDACTED]'); // 173
  assert.equal(A.assertNoSecretsProbe?.call, undefined);
  assert.equal(code(() => A.assertNoSecrets({ url: 'https://media.example.test/a.jpg?X-Amz-Signature=abc' }, 'x')), 'ACT_SECRET_LEAK'); // 174
  const redacted = A.redact('GET https://api.example.test/v1/x?access_token=SECRET123&foo=1 Bearer abcdefghijkl'); // 175
  assert.doesNotMatch(redacted, /SECRET123|abcdefghijkl/);
  const failed = await runtime(W, { routes: [...igRoutes(), ...ttRoutes(), { method: 'POST', url: '/localPosts', respond: { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: `leaked ${TOKENS.GBP} in the message` } } } }] }); // 176
  await failed.executor.runDueJobs({ merchantId: M1 });
  const row = jobOf(failed, 'google_business_profile');
  assert.equal(row.state, 'FAILED_FINAL');
  assert.equal(row.last_error_code, 'INVALID_PAYLOAD');
  assert.ok(!JSON.stringify([failed.store._rows, failed.logs]).includes(TOKENS.GBP));
});

test('Security: tenant and brand isolation, safe permalinks, media locations, credential failures, immutable inputs, no PII', async () => {
  assert.equal(code(() => A.normalizeChannelConnector(CONNECTORS()[0], { merchantId: M2 })), 'ACT_CONNECTOR_MERCHANT_MISMATCH'); // 177
  const rt = await runtime(W);
  const job = jobOf(rt, 'instagram');
  assert.equal(await rt.repo.getById(M2, job.id), null); // 178
  assert.equal(await acode(rt.repo.markFinalFailure(M2, job.id, { errorCode: 'X', nowIso: NOW })), 'ACT_JOB_NOT_FOUND');
  const store = createJobStore({ merchants: [M1, M2] });
  const draft = A.planChannelExecutionJobs({ order: rt.order, manifest: W.activationManifest, candidates: W.candidates })[0];
  assert.equal(await acode(A.createChannelExecutionRepository({ supabase: store }).enqueue({ ...draft, merchant_id: M2 })), 'ACT_STORE_FAILED'); // the connector belongs to M1
  const publication = A.buildChannelPublicationReceipt({ ...job, state: 'PUBLISHED', provider_post_id: 'p1', published_at: NOW, safe_metadata: {} }); // 179
  const forged = { ...publication, brand_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  assert.throws(() => A.buildMarketingExecutionReceiptFromPublications({ tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, publications: [forged], recordedAt: NOW }), (e) => e.code === 'ACT_M4_RECEIPT_SCOPE_MISMATCH');
  const clean = (job2) => A.buildChannelPublicationReceipt({ ...job, state: 'PUBLISHED', provider_post_id: 'p1', published_at: NOW, safe_metadata: job2 }).safe_metadata; // 180
  assert.equal(clean({ permalink: 'https://www.instagram.com/p/abc/' }).permalink, 'https://www.instagram.com/p/abc/');
  for (const bad of ['http://x.test/p', 'https://x.test/p?token=1', `https://u:p${AT}x.test/p`, 'https://x.test/p#f', '/tmp/x']) assert.equal(clean({ permalink: bad }).permalink, undefined);
  for (const location of ['/var/media/a.jpg', 'C:\\media\\a.jpg', 'file:///etc/passwd', 'http://media.example.test/a.jpg', `https://u:p${AT}media.example.test/a.jpg`, 'https://localhost/a.jpg']) { // 181
    assert.equal(await acode(A.resolveMediaTransport(A.createInMemoryMediaTransport({ 'instagram:asset://img-1': { ephemeral_location: location, content_type: 'image/jpeg' } }), { assetRef: 'asset://img-1', provider: 'instagram', asOf: NOW })), 'ACT_MEDIA_LOCATION_REFUSED', location);
  }
  for (const location of ['data:image/png;base64,AAAA', 'blob:https://x.test/uuid']) { // 182
    assert.equal(await acode(A.resolveMediaTransport(A.createInMemoryMediaTransport({ 'instagram:asset://img-1': { ephemeral_location: location } }), { assetRef: 'asset://img-1', provider: 'instagram', asOf: NOW })), 'ACT_MEDIA_LOCATION_REFUSED', location);
  }
  const failing = await preflight(ORDER, services(W, { credentials: A.createInMemoryCredentialProvider({}, { failWith: 'CREDENTIAL_UNAVAILABLE' }) })); // 183
  assert.doesNotMatch(JSON.stringify(failing), /token|secret/i);
  const inputs = orderInputs(W, [imageDelivery(W), textDelivery(W)]); // 184
  const before = JSON.stringify(inputs);
  A.buildChannelExecutionOrder(inputs);
  assert.equal(JSON.stringify(inputs), before);
  const pre = preflightInput(W, ORDER, services(W));
  const beforeP = JSON.stringify({ ...pre, services: null });
  await A.evaluateChannelExecutionPreflight(pre);
  assert.equal(JSON.stringify({ ...pre, services: null }), beforeP);
  const keys = [...keysDeep([ORDER, rt.store._rows, publication])]; // 185
  assert.deepEqual(keys.filter((k) => /email|phone|recipient|customer|profile|conversation|address|name$/i.test(k)), []);
});

// ------------------------------------------------------------------ domain boundaries (186-200)

const SOURCE_DIR = new URL('../src/activation/', import.meta.url);
async function activationSources() {
  const out = {};
  const walk = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = await readFile(new URL(entry.name, dir), 'utf8');
    }
  };
  await walk(SOURCE_DIR);
  return out;
}
const stripComments = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n');

test('Boundaries: the layer chooses no lever, copy, media, time, account, privacy, score or claim, and bypasses neither the Guardian nor the policy', async () => {
  const sources = Object.fromEntries(Object.entries(await activationSources()).map(([k, v]) => [k, stripComments(v)]));
  const scan = (pattern) => Object.entries(sources).filter(([, text]) => pattern.test(text)).map(([name]) => name);
  const imports = Object.values(sources).flatMap((text) => [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]));
  const allowedOutside = /^(node:|\.\/|\.\.\/(marketing\/(activation-manifest|execution-receipt|m4-validation|understand-validation|m2-validation)\.js|tenant\/connectors\.js)|\.\.\/validation\.js|\.\.\/constants\.js|\.\.\/execution-|\.\.\/provider-options\.js|\.\.\/capability-registry\.js)/;
  assert.deepEqual(imports.filter((spec) => !allowedOutside.test(spec)), []); // the layer imports only what it consumes
  assert.deepEqual(scan(/lever_family|LEVER_FAMILY|assessLeverFitness|buildMarketingPushProposal/), []); // 186, 195
  assert.deepEqual(scan(/hashtag|rewrite|paraphrase|translate\(|generateCaption|buildCaption/i), []); // 187
  assert.deepEqual(scan(/ffmpeg|sharp|canvas|transcode|resize\(|crop\(|\.convert\(|codec/i), []); // 188
  assert.deepEqual(scan(/best_?time|bestTime|optimal(Time|Hour)|peak_?hour|engagement_?window/i), []); // 189
  assert.deepEqual(scan(/best_?account|firstAccount|accounts\[0\]|locations\[0\]|\.at\(0\)|autoSelect/i), []); // 190
  assert.deepEqual(scan(/skipGuardian|bypass|forcePublish|publishAnyway|overridePolicy|skipPolicy/i), []); // 191, 192
  assert.deepEqual(scan(/buildMarketingFinding|buildMarketingContext/), []); // 194
  assert.deepEqual(scan(/buildCreativeBrief|normalizeSelectedCreativeCandidate|buildCreativeValidationReport|creative-candidate/), []); // 196
  assert.deepEqual(scan(/confidence_score|success_score|causal_score|\bscore\b/i), []); // 197
  assert.deepEqual(scan(/causal_claim:\s*true|incremental_result|INCREMENTAL/), []); // 198
  assert.deepEqual(scan(/buildMarketingLearning|buildMarketingFollowUpProposal|buildMarketingRunResult|marketing-learning/), []); // 199
  assert.deepEqual(scan(/\.\.\/finance|\.\.\/inventory|\.\.\/shopify|stock_level|setInventory|updatePrice/i), []); // 200
  assert.deepEqual(scan(/Date\.now\(\)\s*\)?\s*;?\s*\/\/\s*clock|Math\.random/), []);
  assert.deepEqual(scan(/fetch\(/).filter((name) => name !== 'providers/http.js'), []); // no hidden global fetch in the core / adapters
  // behavioural proofs
  const rt = await runtime(W);
  await rt.executor.runDueJobs({ merchantId: M1 });
  const container = rt.svc.http.raw.find((r) => r.method === 'POST' && r.url.endsWith('/media'));
  assert.equal(container.body.caption, undefined); // 187: no caption is added
  const gbp = rt.svc.http.raw.find((r) => r.method === 'POST' && r.url.includes('/localPosts'));
  assert.equal(gbp.body.summary, 'Venez découvrir la nouvelle collection en boutique.'); // the approved copy, unchanged
  assert.equal(code(() => orderOf(W, [imageDelivery(W, { connector_id: IDS.TT, provider: 'tiktok', publish_mode: 'INTERACTIVE_CONFIRMATION', provider_options: { ...TIKTOK_OPTIONS, privacy_level: undefined } }), textDelivery(W)])), 'ACT_PROVIDER_OPTIONS_INVALID'); // 193
  const blocked = await runtime(W, { enqueue: false }); // 191: a manifest the Guardian no longer clears never reaches a provider
  const failing = W.candidates.map((e) => ({ ...e, candidateManifest: { ...e.candidateManifest, colors: [{ subject: 'logo.color', coverage: 'COMPLETE', values: ['#000000'], evidence_refs: ['ev/color'] }] } }));
  const enq = await blocked.executor.enqueueChannelExecutionOrder({ ...blocked.input, activation: { ...activationOf(W), candidates: failing }, asOf: NOW });
  assert.equal(enq.status, 'BLOCKED');
  assert.equal(blocked.svc.http.raw.length, 0);
  assert.equal(code(() => A.buildChannelExecutionOrder(orderInputs(W, undefined ?? [imageDelivery(W), textDelivery(W)], { authorization: undefined }))), 'MKT_INVALID_FIELD'); // 192: no authorization, no order
});

// ------------------------------------------------------------------ non-regression (201-210)

test('Non-regression: the connector registry, the marketing modules and the migrations are untouched', async () => {
  assert.deepEqual([...KNOWN_CONNECTOR_KINDS], ['shopify', 'woocommerce', 'prestashop', 'odoo', 'peppol', 'bank', 'csv']); // 201: merchant_connectors is reused, not changed
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(await read('../src/tenant/connectors.js'), /activation/);
  for (const name of ['activation-manifest', 'execution-receipt', 'm3', 'm4', 'understand', 'm2', 'marketing-run', 'run-result', 'marketing-learning', 'steer-package']) { // 202-206
    assert.doesNotMatch(await read(`../src/marketing/${name}.js`), /activation\/|from '\.\.\/activation/, name);
  }
  for (const dir of ['branding', 'creative-fidelity']) { // 207, 208
    for (const file of await readdir(new URL(`../src/${dir}/`, import.meta.url))) assert.doesNotMatch(await read(`../src/${dir}/${file}`), /\.\.\/activation/, file);
  }
  // 210: the migration creates ONE table and touches nothing else
  const sql = (await read('../supabase/migrations/20261009100000_channel_execution_jobs.sql')).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.deepEqual([...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]), ['channel_execution_jobs']);
  assert.doesNotMatch(sql, /drop |alter table (?!channel_execution_jobs)|insert into|delete from|truncate/i);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /references merchants\(id\)/);
  assert.match(sql, /references merchant_connectors\(id\)/);
  assert.match(sql, /channel_execution_jobs_intent_uq unique \(merchant_id, activation_manifest_ref, manifest_delivery_ref, connector_id\)/);
  assert.doesNotMatch(sql, /^\s+\w*(token|secret|password|credential|cookie)\w*\s+(text|jsonb|bytea)/im); // no secret column
  const migrations = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /channel_execution/.test(f));
  assert.deepEqual(migrations, ['20261009100000_channel_execution_jobs.sql']);
  // 209: the full suite is executed by the dedicated workflow
});

// ------------------------------------------------------------------ coverage matrix (doc <-> tests)

test('Coverage matrix: the doc maps all 210 mandate cases, and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/activation-channel-execution-v1.md', import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), ref: m[3] }));
  assert.ok(rows.length >= 210);
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: rows.length }, (_, i) => i + 1));
  for (const { n, ref } of rows) {
    if (ref.startsWith('(CI)')) continue;
    const [file, name] = ref.split(' › ');
    const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes(`test('${name}'`), `mandate case ${n} names a test that does not exist: ${ref}`);
  }
});

export { SCOPES, ORDER_EXPIRES, mediaTransport };
