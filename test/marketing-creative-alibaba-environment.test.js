import test from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';

import {
  createQwenDirectorPort,
  generateEnvironmentBackground,
  loadAlibabaCreativeConfig,
  MemoryCallJournal,
  MemoryOutputStore,
  SpendGuard,
} from '../src/marketing-creative/alibaba/index.js';

// The ENVIRONMENT lane and the Director port on the Frankfurt lane, with FAKE provider responses only (`// EN-N` markers): CI holds no credential and sends nothing.

const API_KEY = 'sk-test-0123456789abcdef-NEVER-LEAK';
const WORKSPACE = 'ws-test123';
const config = loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: WORKSPACE });
const SIGNED = 'https://dashscope-result-eu.example.com/out/env-1.png?Expires=1&Signature=SIGNED-URL-SECRET';
const ENV_PNG = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="#e8ecef"/></svg>').render().asPng());
const request = (over = {}) => ({ capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [], prompt: 'A photograph of an empty scene: a pale studio surface.', negative_prompt: 'product, phone', size: '1080*1350', ...over });

const response = (payload, status = 200) => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(payload); } });
const okImage = () => ({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: SIGNED }] } }] }, usage: { output_width: 1080, output_height: 1350 }, request_id: 'req-env-1' });
function fakeFetch({ payload = okImage(), status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'POST') return response(payload, status);
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, async arrayBuffer() { return new Uint8Array(ENV_PNG).buffer; } };
  };
  fn.calls = calls;
  return fn;
}
const setup = (over = {}) => ({
  config, request: request(), budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 1, maxVideoSeconds: 0 }), journal: new MemoryCallJournal(), outputStore: new MemoryOutputStore(), fetchImpl: fakeFetch(),
  now: (() => { let t = 0; return () => { t += 500; return t; }; })(), ...over,
});
const code = async (promise) => promise.then(() => null, (error) => error.code ?? error.message);

test('The environment request is TEXT ONLY: no image, no merchant media, no product ever reaches the provider', async () => {
  const input = setup();
  const result = await generateEnvironmentBackground(input);
  const post = input.fetchImpl.calls.filter((c) => c.method === 'POST');
  // EN-1 one request to the Frankfurt workspace endpoint, qwen-image-3.0-pro, and the ONLY content part is the text
  assert.equal(post.length, 1);
  assert.equal(post[0].url, `https://${WORKSPACE}.eu-central-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`);
  const body = JSON.parse(post[0].body);
  assert.equal(body.model, 'qwen-image-3.0-pro');
  assert.deepEqual(Object.keys(body.input.messages[0].content[0]), ['text']);
  assert.equal(body.input.messages[0].content.length, 1);
  assert.doesNotMatch(post[0].body, /data:image|base64|"image"/);
  assert.deepEqual({ n: body.parameters.n, size: body.parameters.size, watermark: body.parameters.watermark, prompt_extend: body.parameters.prompt_extend }, { n: 1, size: '1080*1350', watermark: false, prompt_extend: false });
  // EN-2 provenance: lane, model, region, request id, latency, usage, cost, prompt hash, "carries no input asset"; the journal never holds the prompt, key or signed URL
  assert.equal(result.lane, 'ENVIRONMENT');
  assert.equal(result.carries_input_asset, false);
  assert.equal(result.request_id, 'req-env-1');
  assert.equal(result.latency_ms, 500);
  assert.equal(result.region, 'eu-central-1');
  assert.match(result.prompt_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([result.output_info.width, result.output_info.height], [1080, 1350]);
  const text = JSON.stringify([result, input.journal.list()]);
  assert.doesNotMatch(text, /NEVER-LEAK|SIGNED-URL-SECRET|base64|Signature|empty scene/);
  assert.equal(input.journal.list().find((e) => e.event === 'SUCCEEDED').data_class, 'PUBLIC');
});

test('The environment lane refuses anything that could carry a product, and stays inside the Frankfurt lane rules', async () => {
  // EN-3 an input asset, another capability / purpose, no prompt, a bad size, a malformed key
  for (const [name, over, expected] of [
    ['an input asset', { request: request({ input_asset_refs: ['asset://habb/real'] }) }, /no input asset/],
    ['another capability', { request: request({ capability: 'IMAGE_EDIT' }) }, /IMAGE_GENERATE/],
    ['another purpose', { request: request({ purpose: 'REFERENCE' }) }, /BACKGROUND/],
    ['no prompt', { request: request({ prompt: '' }) }, /prompt/],
    ['a size over the limit', { request: request({ size: '4096*4096' }) }, /request.size/],
  ]) {
    const input = setup(over);
    assert.match(String(await code(generateEnvironmentBackground(input))), expected, name);
    assert.equal(input.fetchImpl.calls.length, 0, name);
    assert.equal(input.budget.snapshot().reserved_eur, 0, name);
  }
  assert.equal(await code(generateEnvironmentBackground(setup({ config: { ...config, apiKey: 'a b' } }))), 'INVALID_API_KEY_FORMAT');
  // EN-4 no credentials, another region, another model: refused before any request
  for (const bad of [loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_WORKSPACE_ID: WORKSPACE }), { ...config, region: 'ap-southeast-1' }, { ...config, imageModel: 'qwen-image-edit' }]) {
    const input = setup({ config: bad });
    assert.ok(await code(generateEnvironmentBackground(input)));
    assert.equal(input.fetchImpl.calls.length, 0);
  }
});

test('Invalid responses and provider failures are errors: one request, no retry, no fallback, the budget is held', async () => {
  // EN-5 no choice, no image, two images, a non-HTTPS URL
  const bad = {
    'no choice': { output: {}, request_id: 'r' },
    'no image': { output: { choices: [{ finish_reason: 'stop', message: { content: [{ text: 'hi' }] } }] } },
    'two images': { output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: SIGNED }, { image: `${SIGNED}2` }] } }] } },
    'a plain-HTTP URL': { output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: 'http://example.com/a.png' }] } }] } },
  };
  for (const [name, payload] of Object.entries(bad)) {
    const input = setup({ fetchImpl: fakeFetch({ payload }) });
    assert.equal(await code(generateEnvironmentBackground(input)), 'INVALID_PROVIDER_RESPONSE', name);
    assert.deepEqual(input.journal.list().map((e) => e.event), ['RESERVED', 'FAILED'], name);
    assert.equal(input.budget.snapshot().settled_eur, 0, name);
  }
  // EN-6 a 403 / 429 / 500 is reported once with its request id, never retried
  for (const status of [403, 429, 500]) {
    const fetchImpl = fakeFetch({ status, payload: { code: `E${status}`, request_id: `req-${status}` } });
    const input = setup({ fetchImpl });
    const error = await generateEnvironmentBackground(input).catch((e) => e);
    assert.equal(error.requestId, `req-${status}`);
    assert.equal(fetchImpl.calls.length, 1);
  }
  // EN-7 a fetch error that quotes the Authorization header cannot leak the key
  const quoting = async (url, init) => { throw new TypeError(`bad header "${init.headers.Authorization}"`); };
  const input = setup({ fetchImpl: quoting });
  const error = await generateEnvironmentBackground(input).catch((e) => e);
  assert.doesNotMatch(`${error.message} ${JSON.stringify(input.journal.list())}`, /NEVER-LEAK/);
});

test('The Creative Director port makes one public chat completion and returns text only', async () => {
  const completions = [];
  const fetchImpl = async (url, init) => {
    completions.push({ url, body: JSON.parse(init.body) });
    return response({ id: 'chat-1', choices: [{ message: { content: '{"concept":"x"}' } }], usage: { prompt_tokens: 120, completion_tokens: 60 } });
  };
  const journal = new MemoryCallJournal();
  const port = createQwenDirectorPort({ config, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0, maxVideoSeconds: 0 }), journal, fetchImpl });
  // EN-8 the chat endpoint of the Frankfurt workspace, the configured text model, system + user messages, PUBLIC data
  const reply = await port({ system: 'You are the Nordla Creative Director.', user: '{"brief":"public"}' });
  assert.equal(completions[0].url, `https://${WORKSPACE}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`);
  assert.equal(completions[0].body.model, 'qwen3.8-max');
  assert.deepEqual(completions[0].body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(reply.text, '{"concept":"x"}');
  assert.equal(reply.request_id, 'chat-1');
  assert.equal(journal.list().find((e) => e.event === 'SUCCEEDED').data_class, 'PUBLIC');
  // EN-9 one completion per run: a second call is refused without a request
  await assert.rejects(port({ system: 's', user: 'u' }), /ONE completion/);
  assert.equal(completions.length, 1);
});
