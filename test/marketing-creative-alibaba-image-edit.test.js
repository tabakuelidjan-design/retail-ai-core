import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertScopedExternalMediaUse,
  buildProductEditPrompt,
  editProductImage,
  evaluateProviderEdit,
  FileOutputStore,
  imageInfoOf,
  isAcceptedProviderCandidate,
  loadAlibabaCreativeConfig,
  MemoryCallJournal,
  MemoryOutputStore,
  PROVIDER_OUTPUT_STATUS,
  SpendGuard,
} from '../src/marketing-creative/alibaba/index.js';
import { ANNOTATIONS, buildCandidate, SOURCE, SOURCE_ASSET, sha } from './identity-preserve-world.js';

// IMAGE_EDIT on the Frankfurt Alibaba lane, with FAKE provider responses only (`// IE-N` markers): CI holds no credential and sends nothing.

const root = new URL('../', import.meta.url);
const committed = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-c2-external-media-authorization.json', root), 'utf8'));
// the committed record names the REAL asset; these tests clear the synthetic asset in the same shape (same provider, region, purpose, operations)
const authorization = { ...committed, asset: { ...committed.asset, asset_ref: SOURCE_ASSET, asset_sha256: sha(SOURCE) } };
const API_KEY = 'sk-test-0123456789abcdef-NEVER-LEAK';
const WORKSPACE = 'ws-test123';
const config = loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: WORKSPACE });
const SIGNED = 'https://dashscope-result-eu.example.com/out/edit-1.png?Expires=1&Signature=SIGNED-URL-SECRET';
const GOOD = buildCandidate({ background: 'studio', x: 300, y: 250, sx: 1.0, sy: 1.0 });

const request = (over = {}) => ({
  request_id: 'edit-1', capability: 'IMAGE_EDIT', text_policy: 'NO_CRITICAL_TEXT', purpose: 'C2_HABB_BENCHMARK_001', size: '1080*1350',
  scene: 'a clean, bright, seamless premium retail studio surface with soft realistic light',
  product_role: 'the case is the dominant hero, large and centred',
  preserve: ['the exact case outline and proportions', 'the camera module and its three lens openings', 'the printed artwork', 'the printed quotation'],
  forbid: ['hearts', 'leaves', 'fake gold', 'warm gradient', 'glow'],
  ...over,
});
const asset = (bytes = SOURCE) => ({ ref: SOURCE_ASSET, bytes, media_type: 'image/png' });

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  async text() { return JSON.stringify(payload); },
});
const okPayload = (over = {}) => ({
  output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: SIGNED }] } }] },
  usage: { output_width: 1080, output_height: 1350, input_image_count: 1, input_image_type: 'png', output_image_count: 1, output_image_type: 'png' },
  request_id: 'req-edit-0001',
  ...over,
});
/** A fake provider: records every call; POST answers the payload, GET serves the output bytes. */
function fakeFetch({ payload = okPayload(), status = 200, output = GOOD.png, outputStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    if (init.method === 'POST') return response(payload, status);
    return { ok: outputStatus === 200, status: outputStatus, headers: { get: () => 'image/png' }, async arrayBuffer() { return new Uint8Array(output).buffer; } };
  };
  fn.calls = calls;
  return fn;
}
const setup = (over = {}) => ({
  config, authorization, asset: asset(), request: request(), budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 1, maxVideoSeconds: 0 }), journal: new MemoryCallJournal(),
  outputStore: new MemoryOutputStore(), fetchImpl: fakeFetch(), now: (() => { let t = 1000; return () => { t += 1234; return t; }; })(), ...over,
});
const code = async (promise) => promise.then(() => null, (error) => error.code ?? error.message);
const dump = (value) => JSON.stringify(value);

test('A valid edit sends one request to the Frankfurt workspace endpoint and returns a private provider output with full provenance', async () => {
  const input = setup();
  const result = await editProductImage(input);
  const post = input.fetchImpl.calls.filter((c) => c.method === 'POST');
  // IE-1 exactly one provider request, to the Frankfurt workspace host, bearer-authenticated, no redirect
  assert.equal(post.length, 1);
  assert.equal(post[0].url, `https://${WORKSPACE}.eu-central-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`);
  assert.equal(post[0].headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(post[0].redirect, 'error');
  // IE-2 the body: qwen-image-3.0-pro, the real bytes as a data URI plus the ephemeral prompt, one image, no prompt rewriting, no watermark
  const body = JSON.parse(post[0].body);
  assert.equal(body.model, 'qwen-image-3.0-pro');
  const [image, text] = body.input.messages[0].content;
  assert.equal(image.image, `data:image/png;base64,${Buffer.from(SOURCE).toString('base64')}`);
  assert.match(text.text, /Preserve exactly:.*printed quotation/);
  assert.deepEqual({ n: body.parameters.n, size: body.parameters.size, watermark: body.parameters.watermark, prompt_extend: body.parameters.prompt_extend }, { n: 1, size: '1080*1350', watermark: false, prompt_extend: false });
  // IE-3 provenance: provider, model, region, endpoint class, protocol, request id, latency, usage, estimated cost, input / prompt / output hashes, clearance
  assert.equal(result.provider_id, 'alibaba-cloud-model-studio');
  assert.equal(result.model, 'qwen-image-3.0-pro');
  assert.equal(result.region, 'eu-central-1');
  assert.equal(result.endpoint_class, 'WORKSPACE_DOMAIN_SYNC');
  assert.equal(result.api_protocol, 'DASHSCOPE_MULTIMODAL_GENERATION');
  assert.equal(result.request_id, 'req-edit-0001');
  assert.equal(result.latency_ms, 1234);
  assert.equal(result.attempts, 1);
  assert.equal(result.usage.output_width, 1080);
  assert.ok(result.cost_eur_estimated > 0);
  assert.equal(result.input_sha256, sha(SOURCE));
  assert.match(result.prompt_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.clearance_id, authorization.authorization_id);
  assert.equal(result.output.sha256, sha(GOOD.png));
  assert.deepEqual([result.output_info.width, result.output_info.height, result.output_info.media_type], [1080, 1350, 'image/png']);
  assert.ok(Object.isFrozen(result));
  // IE-4 the journal records reserve + success with the identifiers, never a prompt, a key, a data URI or a signed URL
  const events = input.journal.list();
  assert.deepEqual(events.map((e) => e.event), ['RESERVED', 'SUCCEEDED']);
  assert.equal(events[1].request_id, 'req-edit-0001');
  assert.equal(events[1].latency_ms, 1234);
  assert.equal(events[1].data_class, 'SCOPED_PRIVATE_MEDIA');
  for (const text of [dump(events), dump(result)]) assert.doesNotMatch(text, /NEVER-LEAK|SIGNED-URL-SECRET|base64|Signature|Preserve exactly/);
  // IE-5 the budget was settled for one image
  assert.equal(input.budget.snapshot().images, 1);
  assert.ok(input.budget.snapshot().settled_eur > 0);
});

test('Credentials are required and nothing is sent without them', async () => {
  // IE-6 a config without a key, or without a workspace, is refused before any request
  for (const env of [{ ALIBABA_MODEL_STUDIO_WORKSPACE_ID: WORKSPACE }, { ALIBABA_MODEL_STUDIO_API_KEY: API_KEY }]) {
    const input = setup({ config: loadAlibabaCreativeConfig(env) });
    assert.match(await code(editProductImage(input)), /not configured/);
    assert.equal(input.fetchImpl.calls.length, 0);
    assert.equal(input.journal.list().length, 0);
  }
  // IE-7 an invalid workspace id is refused
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: '../evil' }), /Invalid Alibaba Model Studio workspace ID/);
});

test('The region stays Frankfurt: no other region, no cross-region fallback', async () => {
  // IE-8 another region cannot even be configured, and a forged config is refused before any request
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_REGION: 'ap-southeast-1' }), /Unsupported Alibaba Model Studio region/);
  for (const region of ['ap-southeast-1', 'cn-beijing', 'us-east-1']) {
    const input = setup({ config: { ...config, region } });
    assert.ok(await code(editProductImage(input)));
    assert.equal(input.fetchImpl.calls.length, 0);
  }
  // IE-9 a failed Frankfurt call never reaches any other host
  const input = setup({ fetchImpl: fakeFetch({ status: 500, payload: { code: 'InternalError', request_id: 'req-500' } }) });
  assert.equal(await code(editProductImage(input)), 'InternalError');
  assert.ok(input.fetchImpl.calls.every((c) => new URL(c.url).hostname === `${WORKSPACE}.eu-central-1.maas.aliyuncs.com`));
});

test('The scoped clearance is required BEFORE any payload leaves, and before any money is reserved', async () => {
  const denied = [
    ['no authorization record', { authorization: null }],
    ['another asset (different bytes)', { asset: asset(new Uint8Array([...SOURCE.slice(0, SOURCE.length - 1), SOURCE[SOURCE.length - 1] ^ 1])) }],
    ['another purpose', { request: request({ purpose: 'MARKETING_CAMPAIGN' }) }],
    ['a revoked authorization', { authorization: { ...authorization, authorization: { ...authorization.authorization, revoked: true } } }],
    ['another provider', { authorization: { ...authorization, provider: { ...authorization.provider, provider_id: 'krea' } } }],
  ];
  for (const [name, over] of denied) {
    const input = setup(over);
    const failure = await code(editProductImage(input));
    // IE-10 the stable refusal code, nothing sent, nothing journaled, nothing reserved
    assert.equal(failure, 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED', name);
    assert.equal(input.fetchImpl.calls.length, 0, name);
    assert.equal(input.journal.list().length, 0, name);
    assert.equal(input.budget.snapshot().reserved_eur, 0, name);
  }
  // IE-11 the clearance is computed from the real bytes: a lying asset ref does not help
  assert.equal(await code(editProductImage(setup({ asset: { ...asset(), ref: 'asset://habb/other' } }))), 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED');
  // IE-12 the real committed record clears only the real asset: the synthetic one is not cleared by it
  assert.throws(() => assertScopedExternalMediaUse({ authorization: committed, asset: { ref: SOURCE_ASSET, sha256: sha(SOURCE) }, provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', purpose: 'C2_HABB_BENCHMARK_001', operation: 'IMAGE_EDIT' }), /EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED/);
});

test('Critical text never goes into provider pixels, and the provider prompt is ephemeral', async () => {
  // IE-13 the request must declare NO_CRITICAL_TEXT and the IMAGE_EDIT capability
  assert.match(await code(editProductImage(setup({ request: request({ text_policy: 'ALLOWED' }) }))), /NO_CRITICAL_TEXT/);
  assert.match(await code(editProductImage(setup({ request: request({ capability: 'IMAGE_GENERATE' }) }))), /IMAGE_EDIT/);
  // IE-14 the prompt forbids any added text and keeps the preservation constraints and the forbidden list
  const { prompt, negative_prompt: negative } = buildProductEditPrompt(request());
  assert.match(prompt, /Do not add any text, letters, numbers, prices, logos, labels, captions or watermarks/);
  assert.match(prompt, /The only text allowed is the text already printed on the product/);
  assert.match(prompt, /camera module and its three lens openings/);
  assert.match(prompt, /same orientation, the same viewing angle and the same proportions/);
  assert.match(negative, /hearts.*leaves.*fake gold.*extra lens.*missing lens.*added text.*watermark/);
  assert.throws(() => buildProductEditPrompt(request({ preserve: [] })), /preserve/);
  assert.throws(() => buildProductEditPrompt(request({ scene: '' })), /scene/);
  // IE-15 the prompt text is not part of what is returned or journaled (only its hash)
  const input = setup();
  const result = await editProductImage(input);
  assert.doesNotMatch(dump([result, input.journal.list()]), /Edit the referenced product photograph/);
});

test('An invalid provider response is refused, the budget is held, and nothing is accepted', async () => {
  const bad = {
    'no choice': okPayload({ output: {} }),
    'a choice that did not stop normally': okPayload({ output: { choices: [{ finish_reason: 'length', message: { content: [{ image: SIGNED }] } }] } }),
    'no image': okPayload({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ text: 'hello' }] } }] } }),
    'two images': okPayload({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: SIGNED }, { image: `${SIGNED}2` }] } }] } }),
    'a non-URL image': okPayload({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: 'not a url' }] } }] } }),
    'a plain-HTTP image URL': okPayload({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: 'http://example.com/a.png' }] } }] } }),
    'a URL with credentials': okPayload({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: 'https://user:pw@example.com/a.png' }] } }] } }),
  };
  for (const [name, payload] of Object.entries(bad)) {
    const input = setup({ fetchImpl: fakeFetch({ payload }) });
    // IE-16 a stable code, no output stored, a FAILED journal row, the reservation is not settled as a success
    assert.equal(await code(editProductImage(input)), 'INVALID_PROVIDER_RESPONSE', name);
    assert.deepEqual(input.journal.list().map((e) => e.event), ['RESERVED', 'FAILED'], name);
    assert.equal(input.budget.snapshot().settled_eur, 0, name);
  }
  // IE-17 an output that is not an image, an output download that fails
  const notImage = setup({ fetchImpl: fakeFetch({ output: new TextEncoder().encode('<html>not an image</html>') }) });
  assert.equal(await code(editProductImage(notImage)), 'INVALID_PROVIDER_RESPONSE');
  const noDownload = setup({ fetchImpl: fakeFetch({ outputStatus: 403 }) });
  assert.match(await code(editProductImage(noDownload)), /download failed/);
  // IE-18 a body that is not JSON is an error too
  const garbage = setup({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, async text() { return '<html>gateway</html>'; } }) });
  assert.equal(await code(editProductImage(garbage)), 'INVALID_PROVIDER_RESPONSE');
});

test('A timeout, a rate limit and a server error are errors: no silent retry, no silent fallback', async () => {
  // IE-19 a request that never answers is aborted at the configured timeout (TIMEOUT, transient) after ONE request
  const slow = loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: WORKSPACE, ALIBABA_MODEL_STUDIO_TIMEOUT_MS: '40' });
  let calls = 0;
  const hang = (url, init) => new Promise((resolve, reject) => {
    calls += 1;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const input = setup({ config: slow, fetchImpl: hang });
  assert.equal(await code(editProductImage(input)), 'TIMEOUT');
  assert.equal(calls, 1);
  assert.deepEqual(input.journal.list().map((e) => e.event), ['RESERVED', 'FAILED']);
  // IE-20 a 429 and a 500 are reported once, as transient, never retried automatically and never routed to another model or endpoint
  for (const status of [429, 500, 503]) {
    const fetchImpl = fakeFetch({ status, payload: { code: `E${status}`, request_id: `req-${status}` } });
    const failing = setup({ fetchImpl });
    const error = await editProductImage(failing).catch((e) => e);
    assert.equal(error.transient, true);
    assert.equal(error.requestId, `req-${status}`);
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls.every((c) => /multimodal-generation\/generation$/.test(c.url)));
  }
  // IE-21 a 401 / 400 is not transient
  const denied = await editProductImage(setup({ fetchImpl: fakeFetch({ status: 401, payload: { code: 'InvalidApiKey' } }) })).catch((e) => e);
  assert.equal(denied.transient, false);
  assert.doesNotMatch(String(denied.message), /NEVER-LEAK/);
});

test('No silent model fallback and no hidden budget: only qwen-image-3.0-pro, within the spend guard', async () => {
  // IE-22 another image model cannot be configured, and a forged config is refused before any request
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_QWEN_IMAGE_MODEL: 'qwen-image-edit' }), /Unsupported Alibaba image model/);
  const forged = setup({ config: { ...config, imageModel: 'qwen-image-edit' } });
  assert.ok(await code(editProductImage(forged)));
  assert.equal(forged.fetchImpl.calls.length, 0);
  // IE-23 the spend guard stops a call that would exceed it; a second image is refused by the one-image cap
  const tiny = setup({ budget: new SpendGuard({ maxSpendEur: 0.001, maxImages: 1, maxVideoSeconds: 0 }) });
  assert.equal(await code(editProductImage(tiny)), 'BUDGET_EXCEEDED');
  assert.equal(tiny.fetchImpl.calls.length, 0);
  const guard = new SpendGuard({ maxSpendEur: 1, maxImages: 1, maxVideoSeconds: 0 });
  await editProductImage(setup({ budget: guard }));
  assert.equal(await code(editProductImage(setup({ budget: guard, request: request() }))), 'IMAGE_LIMIT_EXCEEDED');
  // IE-24 the size is bounded by the documented limits
  assert.match(await code(editProductImage(setup({ request: request({ size: '4096*4096' }) }))), /request.size/);
});

test('The provider output is stored privately: outside the repository, never in Git', async () => {
  // IE-25 a store inside the repository is refused; a store outside holds the output and reads it back
  assert.throws(() => new FileOutputStore(path.join(process.cwd(), 'data', 'private', 'x')), /outside repository/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nordla-edit-'));
  try {
    const store = new FileOutputStore(dir);
    const result = await editProductImage(setup({ outputStore: store }));
    assert.match(result.output.ref, /^file:\/\//);
    assert.equal((await readdir(dir)).length, 1);
    assert.equal(sha(await store.readBytes(result.output)), sha(GOOD.png));
    assert.ok(!result.output.ref.startsWith(`file://${process.cwd()}`));
  } finally { await rm(dir, { recursive: true, force: true }); }
  // IE-26 the PNG / JPEG header reader
  assert.deepEqual(imageInfoOf(GOOD.png), { media_type: 'image/png', width: 1080, height: 1350 });
  assert.equal(imageInfoOf(new Uint8Array([1, 2, 3])), null);
});

test('IMAGE_EDIT output must pass IDENTITY_PRESERVE before it becomes a candidate', async () => {
  const input = setup();
  const result = await editProductImage(input);
  const outputBytes = await input.outputStore.readBytes(result.output);
  const source = { bytes: SOURCE, sha256: sha(SOURCE), origin: 'MERCHANT_PROVIDED', width_px: 600, height_px: 800 };
  const evaluate = (over = {}) => evaluateProviderEdit({
    provider: result, outputBytes, source, source_asset_ref: SOURCE_ASSET, derived_asset_ref: 'asset://test/provider-edit-1', annotations: ANNOTATIONS, ...over,
  });
  // IE-27 a faithful edit (new studio background, same product): PASS, accepted, a registered candidate that carries its provenance
  const accepted = evaluate();
  assert.equal(accepted.status, PROVIDER_OUTPUT_STATUS.PASS, JSON.stringify(accepted.failed_observations));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.candidate.preservation_mode, 'IDENTITY_PRESERVE');
  assert.equal(accepted.candidate.provider.request_id, 'req-edit-0001');
  assert.equal(isAcceptedProviderCandidate(accepted), true);
  // IE-28 a hand-made object is never an accepted candidate
  assert.equal(isAcceptedProviderCandidate({ ...accepted }), false);
  assert.equal(isAcceptedProviderCandidate({ accepted: true, status: 'PROVIDER_OUTPUT_FIDELITY_PASS' }), false);
  // IE-29 an edit that moved the camera module is FAIL with the exact failed observations, and no candidate exists
  const bad = buildCandidate({ background: 'studio', x: 300, y: 250, sx: 1.0, sy: 1.0, variant: { moduleShift: 8 } });
  const badInput = setup({ fetchImpl: fakeFetch({ output: bad.png }) });
  const badResult = await editProductImage(badInput);
  const failed = evaluate({ provider: badResult, outputBytes: await badInput.outputStore.readBytes(badResult.output) });
  assert.equal(failed.status, PROVIDER_OUTPUT_STATUS.FAIL);
  assert.equal(failed.accepted, false);
  assert.equal(failed.candidate, null);
  assert.ok(failed.failed_observations.some((o) => o.check === 'PRODUCT_GEOMETRY' && o.observation === 'CAMERA_MODULE' && o.outcome === 'FAIL'));
  assert.equal(isAcceptedProviderCandidate(failed), false);
  // IE-30 a missing lens and a different artwork fail too; nothing is "improved" afterwards
  for (const variant of [{ lensCount: 2 }, { artworkSeed: 7 }]) {
    const other = buildCandidate({ background: 'studio', x: 300, y: 250, sx: 1.0, sy: 1.0, variant });
    const otherInput = setup({ fetchImpl: fakeFetch({ output: other.png }) });
    const otherResult = await editProductImage(otherInput);
    const verdict = evaluate({ provider: otherResult, outputBytes: await otherInput.outputStore.readBytes(otherResult.output) });
    assert.equal(verdict.status, PROVIDER_OUTPUT_STATUS.FAIL);
    assert.equal(verdict.candidate, null);
  }
  // IE-31 unmeasurable evidence is BLOCKED, never a pass: no annotations, bytes that are not the recorded output
  assert.equal(evaluate({ annotations: null }).status, PROVIDER_OUTPUT_STATUS.BLOCKED);
  // a VALID image that is not the recorded output (a faithful one: it would PASS if the hash were not checked) is refused
  const otherValid = buildCandidate({ background: 'white', x: 330, y: 320, sx: 1.2, sy: 1.2 }).png;
  assert.notEqual(sha(otherValid), result.output.sha256);
  assert.equal(evaluate({ outputBytes: otherValid }).status, PROVIDER_OUTPUT_STATUS.BLOCKED);
  assert.equal(evaluate({ outputBytes: new Uint8Array(outputBytes).map((b, i) => (i === 100 ? b ^ 1 : b)) }).status, PROVIDER_OUTPUT_STATUS.BLOCKED);
  assert.equal(evaluate({ outputBytes: new TextEncoder().encode('not an image at all, not at all') }).status, PROVIDER_OUTPUT_STATUS.BLOCKED);
});

test('The controlled live-run script refuses without credentials, sends nothing in --check, and holds no secret', async () => {
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const script = fileURLToPath(new URL('scripts/run-c2-habb-edit.mjs', root));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ALIBABA_|^DASHSCOPE|^NORDLA_PRIVATE_DIR$/.test(k)));
  const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  // IE-32 no credentials: both modes stop with a stable BLOCKED status and exit 3, naming the missing variables (never a value)
  for (const flag of ['--check', '--live']) {
    const out = run([flag]);
    assert.equal(out.status, 3, flag);
    const report = JSON.parse(out.stdout);
    assert.equal(report.status, 'BLOCKED: CREDENTIALS_NOT_PROVISIONED');
    assert.deepEqual(report.checks[0].detail.missing_environment_variables, ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID']);
  }
  // IE-33 no mode: refused
  assert.equal(run([]).status, 64);
  // IE-34 --check with dummy credentials never calls the network and never creates the lock: it is READY (real asset present) or BLOCKED (absent)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nordla-live-check-'));
  try {
    const out = run(['--check'], { ALIBABA_MODEL_STUDIO_API_KEY: API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: WORKSPACE, NORDLA_PRIVATE_DIR: dir });
    const report = JSON.parse(out.stdout);
    assert.match(report.status, /^(READY_FOR_ONE_LIVE_CALL \(nothing was sent\)|BLOCKED: ASSET_PAYLOAD_UNAVAILABLE)$/);
    assert.equal(existsSync(path.join(dir, 'live-call-001.lock')), false);
    assert.doesNotMatch(out.stdout, /NEVER-LEAK/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  // IE-35 the script holds no key, token or URL of a provider; it reads credentials from the environment only
  const source = await readFile(new URL('scripts/run-c2-habb-edit.mjs', root), 'utf8');
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{8,}|https?:\/\/|fetch\(/);
  assert.match(source, /loadAlibabaCreativeConfig\(process\.env\)/);
});
