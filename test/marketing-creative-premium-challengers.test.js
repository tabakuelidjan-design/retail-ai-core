import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { loadOpenAICreativeConfig } from '../src/marketing-creative/openai/config.js';
import { OpenAIImageSpendGuard } from '../src/marketing-creative/openai/budget.js';
import { createOpenAIProductCampaignImage } from '../src/marketing-creative/openai/gpt-image.js';
import { loadRunwayCreativeConfig } from '../src/marketing-creative/runway/config.js';
import { RunwayCreditGuard, productAdCredits } from '../src/marketing-creative/runway/budget.js';
import { createRunwayProductAd, createRunwayProductCampaign } from '../src/marketing-creative/runway/recipes.js';
import { FileArtifactStore } from '../src/marketing-creative/shared/artifact-store.js';

const jsonResponse = (payload, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  async text() { return JSON.stringify(payload); },
});
const binaryResponse = (bytes, type) => ({
  ok: true,
  status: 200,
  headers: { get: (name) => name === 'content-type' ? type : null },
  async arrayBuffer() { return Buffer.from(bytes); },
});

test('OpenAI config pins GPT Image 2.5 Sunburst dated snapshot', () => {
  const config = loadOpenAICreativeConfig({ OPENAI_API_KEY: 'secret' });
  assert.equal(config.model, 'gpt-image-2.5-sunburst-2026-09-08');
});

test('OpenAI product edit uses image URL and stores base64 output', async () => {
  const config = loadOpenAICreativeConfig({ OPENAI_API_KEY: 'secret' });
  const store = new FileArtifactStore(path.join(os.tmpdir(), 'nordla-openai-test'));
  let body;
  const result = await createOpenAIProductCampaignImage({
    config,
    productImageUrl: 'https://habb.be/product.webp',
    prompt: 'premium ad',
    dataPolicy: { classification: 'PUBLIC' },
    budget: new OpenAIImageSpendGuard({ maxSpendUsd: 1 }),
    outputStore: store,
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({
        data: [{ b64_json: Buffer.from('pngdata').toString('base64') }],
        usage: {
          input_tokens_details: { text_tokens: 10, image_tokens: 100 },
          output_tokens: 200,
        },
      }, 200, { 'x-request-id': 'req-openai' });
    },
  });
  assert.equal(body.model, 'gpt-image-2.5-sunburst-2026-09-08');
  assert.equal(body.images[0].image_url, 'https://habb.be/product.webp');
  assert.equal(body.input_fidelity, 'high');
  assert.equal(result.output.sha256.length, 64);
  assert.ok(result.costUsd > 0);
});

test('Runway recipe credit math is bounded', () => {
  assert.equal(productAdCredits({ duration: 5, resolution: '720p' }), 236);
  const guard = new RunwayCreditGuard({ maxCredits: 379 });
  guard.reserve('campaign', 144);
  assert.throws(() => guard.reserve('video', 236), /RUNWAY_CREDIT_LIMIT_EXCEEDED/);
});

test('Runway Product Campaign uses pinned recipe and downloads four outputs', async () => {
  const config = loadRunwayCreativeConfig({ RUNWAYML_API_SECRET: 'secret' });
  const store = new FileArtifactStore(path.join(os.tmpdir(), 'nordla-runway-image-test'));
  const budget = new RunwayCreditGuard({ maxCredits: 400 });
  let createBody;
  const result = await createRunwayProductCampaign({
    config,
    productImageUrl: 'https://habb.be/product.webp',
    prompt: 'premium',
    dataPolicy: { classification: 'PUBLIC' },
    budget,
    outputStore: store,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      if (url.endsWith('/recipes/product_campaign_image')) {
        createBody = JSON.parse(options.body);
        return jsonResponse({ id: 'task-image' });
      }
      if (url.endsWith('/tasks/task-image')) {
        return jsonResponse({ status: 'SUCCEEDED', output: [
          'https://cdn.test/1.png','https://cdn.test/2.png','https://cdn.test/3.png','https://cdn.test/4.png'
        ]});
      }
      if (url.startsWith('https://cdn.test/')) return binaryResponse('img', 'image/png');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(createBody.version, '2026-06');
  assert.equal(result.outputs.length, 4);
  assert.equal(result.credits, 144);
});

test('Runway Product Ad uses 2026-07 and 5 second 720p cost', async () => {
  const config = loadRunwayCreativeConfig({ RUNWAYML_API_SECRET: 'secret' });
  const store = new FileArtifactStore(path.join(os.tmpdir(), 'nordla-runway-video-test'));
  const budget = new RunwayCreditGuard({ maxCredits: 400 });
  let createBody;
  const result = await createRunwayProductAd({
    config,
    productImageUrls: ['https://habb.be/product.webp'],
    dataPolicy: { classification: 'PUBLIC' },
    budget,
    outputStore: store,
    duration: 5,
    ratio: '1280:720',
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      if (url.endsWith('/recipes/product_ad')) {
        createBody = JSON.parse(options.body);
        return jsonResponse({ id: 'task-video' });
      }
      if (url.endsWith('/tasks/task-video')) {
        return jsonResponse({ status: 'SUCCEEDED', output: ['https://cdn.test/ad.mp4'] });
      }
      if (url === 'https://cdn.test/ad.mp4') return binaryResponse('video', 'video/mp4');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(createBody.version, '2026-07');
  assert.equal(createBody.duration, 5);
  assert.equal(result.credits, 236);
  assert.equal(result.outputs[0].sha256.length, 64);
});
