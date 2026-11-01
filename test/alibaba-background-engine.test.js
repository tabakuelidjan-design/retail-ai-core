import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlibabaBackgroundEngine, createFileAttemptClaim } from '../src/creative-autonomy/alibaba-background-engine.js';
import { MemoryOutputStore } from '../src/marketing-creative/alibaba/output-store.js';
import { priceImagesEur } from '../src/marketing-creative/alibaba/budget.js';

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const config = { imageModel: 'qwen-image-3.0-pro', region: 'eu-central-1' };
const authorization = { planId: 'visual-smoke-1', provider: 'alibaba-model-studio', model: config.imageModel,
  approved: true, maxCalls: 1, photoTransmission: 'NONE', dataScope: 'GLOBAL', crossBorderApproved: true };
const baseEngines = { name: { render: 'Blender' }, examine: async () => ({ status: 'CUT_OUT' }), compose: async () => ({}) };
const concept = { story: 'A quiet urban pause on the way through Namur', visual_metaphor: 'A wet stone reflects a passing moment' };
const artDirection = { atmosphere: 'Architectural and quiet', lighting_intent: 'Cold oblique daylight',
  material_language: 'Wet concrete and dark stone' };
const stage = { camera: { product_position: 'CENTER', framing: 'MEDIUM' } };
const canvas = { width: 1080, height: 1350 };
const root = mkdtempSync(join(tmpdir(), 'nordla-image-contract-'));

function harness(overrides = {}) {
  const called = [];
  const store = new MemoryOutputStore();
  const generate = async args => {
    called.push(args);
    const stored = await store.storeBytes({ bytes: tinyPng, contentType: 'image/png', operationId: 'mock-image' });
    return { model: config.imageModel, requestId: 'MOCK', outputs: [stored], costEur: 0 };
  };
  const engine = createAlibabaBackgroundEngine({
    baseEngines, config, planId: 'visual-smoke-1', authorization, sourcePhotoRights: 'OWNER_CONFIRMED',
    budget: { reserveImages() {} }, journal: null, outputStore: store,
    generate, prepare: async () => ({ resolution: [1080, 1350] }), claimAttempt: async () => {}, ...overrides,
  });
  const arg = { stage, concept, artDirection, canvas, stagePath: 'unused', examPath: 'unused', outPath: join(root, 'out.png') };
  return { engine, called, arg };
}

test('real Brain concept and art direction become a product-free prompt; mock PNG is locally saved', async () => {
  const { engine, called, arg } = harness();
  const info = await engine.render(arg);
  assert.equal(called.length, 1);
  assert.equal(called[0].referenceImages.length, 0);
  assert.match(called[0].prompt, /urban pause/);
  assert.match(called[0].prompt, /wet concrete/i);
  assert.match(called[0].prompt, /Do NOT draw.*product/i);
  assert.equal(called[0].n, 1);
  assert.equal(called[0].watermark, false);
  assert.match(called[0].negativePrompt, /bottles.*logos/);
  assert.equal(called[0].size, '1080x1350');
  assert.equal(called[0].dataPolicy.classification, 'PUBLIC');
  assert.equal(info.render_backend, 'GENERATIVE_BACKGROUND');
  assert.equal(info.source_photo_transmitted, false);
  assert.equal(info.request_id, 'MOCK');
  assert.deepEqual(readFileSync(arg.outPath), tinyPng);
});
test('one approval means at most one provider call; no silent retries', async () => {
  const { engine, arg, called } = harness();
  await engine.render(arg);
  await assert.rejects(() => engine.render(arg), /IMAGE_CALL_LIMIT_EXCEEDED/);
  assert.equal(called.length, 1);
});
test('missing approval or unclear supplier photo rights refuses before provider call', async () => {
  for (const override of [{ authorization: null }, { sourcePhotoRights: 'UNKNOWN' },
    { authorization: { ...authorization, crossBorderApproved: false } }]) {
    const { engine, called, arg } = harness(override);
    await assert.rejects(() => engine.render(arg), /NOT_AUTHORIZED|PHOTO_RIGHTS_UNVERIFIED|GLOBAL_SCOPE/);
    assert.equal(called.length, 0);
  }
});
test('rejects an unsupported format before contacting the image provider', async () => {
  const { engine, arg, called } = harness();
  await assert.rejects(() => engine.render({ ...arg, canvas: { width: 4000, height: 5000 } }), /UNSUPPORTED_VISUAL_CANVAS/);
  assert.equal(called.length, 0);
});
test('rejects provider-controlled URLs outside official Alibaba storage domains', async () => {
  let intercepted = false;
  const store = new MemoryOutputStore();
  const generate = async args => {
    intercepted = true;
    return args.outputStore.storeUrl({ url: 'https://127.0.0.1/admin', kind: 'image', operationId: 'unsafe' });
  };
  const { engine, arg } = harness({ outputStore: store, generate });
  await assert.rejects(() => engine.render(arg), /UNTRUSTED_GENERATED_IMAGE_URL/);
  assert.equal(intercepted, true);
});

test('durable attempt lock prevents a second execution even after a fresh engine instance', async () => {
  const claim = createFileAttemptClaim({ registryDir: mkdtempSync(join(tmpdir(), 'nordla-visual-claims-')) });
  const attempt = { planId: 'visual-smoke-1', provider: 'alibaba-model-studio', model: config.imageModel };
  const first = await claim(attempt);
  assert.ok(first.endsWith('visual-smoke-1.background.lock'));
  await assert.rejects(() => claim(attempt), /VISUAL_PLAN_ALREADY_ATTEMPTED/);
});


test('Qwen Image 3.0 prices 4:5 and 9:16 below the 2,250,000-pixel threshold', () => {
  assert.equal(priceImagesEur({ n: 1, size: '1080x1350' }), 0.03438);
  assert.equal(priceImagesEur({ n: 1, size: '1080x1920' }), 0.03438);
  assert.equal(priceImagesEur({ n: 1, size: '1536x1536' }), 0.068761);
  assert.throws(() => priceImagesEur({ size: '0x0' }), /UNPRICED_IMAGE_SIZE/);
});
