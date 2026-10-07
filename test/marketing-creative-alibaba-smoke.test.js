import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedSmokeAssetUrl,
  loadAlibabaCreativeConfig,
  MemoryCallJournal,
  MemoryOutputStore,
  runAlibabaCreativeSmoke,
  SpendGuard,
} from '../src/marketing-creative/alibaba/index.js';

const config = loadAlibabaCreativeConfig({
  ALIBABA_MODEL_STUDIO_API_KEY: 'secret-key',
  ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'workspace-123',
});

const publicUrl = 'https://habb.be/products/test.png';

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  async text() {
    return JSON.stringify(payload);
  },
});

const binaryResponse = (
  bytes = 'abc',
  contentType = 'application/octet-stream',
) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name) => (name === 'content-type' ? contentType : null),
  },
  async arrayBuffer() {
    return Buffer.from(bytes);
  },
});

test('smoke asset requires exact allowlisted HTTPS host', () => {
  assert.equal(
    assertAllowedSmokeAssetUrl(publicUrl, ['habb.be']),
    publicUrl,
  );
  assert.throws(
    () => assertAllowedSmokeAssetUrl(
      'https://cdn.example.test/product.png',
      ['habb.be'],
    ),
    /not allowlisted/,
  );
  assert.throws(
    () => assertAllowedSmokeAssetUrl(
      'https://habb.be/product.png?signature=secret',
      ['habb.be'],
    ),
    /query or fragment/,
  );
});

test('smoke refuses budget larger than the approved ceiling', async () => {
  await assert.rejects(
    () => runAlibabaCreativeSmoke({
      config,
      publicProductUrl: publicUrl,
      allowedHosts: ['habb.be'],
      budget: new SpendGuard({
        maxSpendEur: 2,
        maxImages: 1,
        maxVideoSeconds: 5,
      }),
      journal: new MemoryCallJournal(),
      outputStore: new MemoryOutputStore(),
      fetchImpl: async () => {
        throw new Error('must not call provider');
      },
    }),
    /max_spend_eur/,
  );
});

test('smoke runs text then image then one Wan task and stays bounded', async () => {
  const calls = [];
  let polls = 0;

  const result = await runAlibabaCreativeSmoke({
    config,
    publicProductUrl: publicUrl,
    allowedHosts: ['habb.be'],
    journal: new MemoryCallJournal(),
    outputStore: new MemoryOutputStore(),
    budget: new SpendGuard({
      maxSpendEur: 1.5,
      maxImages: 1,
      maxVideoSeconds: 5,
    }),
    sleep: async () => {},
    fetchImpl: async (url) => {
      calls.push(url);

      if (url.includes('/chat/completions')) {
        return jsonResponse({
          choices: [{ message: { content: 'Campaign copy' } }],
          usage: { prompt_tokens: 20, completion_tokens: 20 },
          id: 'text-req',
        });
      }

      if (url.includes('/multimodal-generation/')) {
        return jsonResponse({
          output: {
            choices: [{
              message: {
                content: [{ image: 'https://cdn.test/image.png' }],
              },
            }],
          },
          usage: { image_count: 1 },
          request_id: 'image-req',
        });
      }

      if (url === 'https://cdn.test/image.png') {
        return binaryResponse('image', 'image/png');
      }

      if (url.includes('/video-generation/video-synthesis')) {
        return jsonResponse({
          output: { task_id: 'wan-task-1' },
          request_id: 'wan-create',
        });
      }

      if (url.includes('/api/v1/tasks/wan-task-1')) {
        polls += 1;
        return jsonResponse({
          output: {
            task_status: 'SUCCEEDED',
            video_url: 'https://cdn.test/video.mp4',
          },
          usage: { output_video_duration: 5 },
          request_id: 'wan-poll',
        });
      }

      if (url === 'https://cdn.test/video.mp4') {
        return binaryResponse('video', 'video/mp4');
      }

      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(polls, 1);
  assert.equal(
    calls.filter(
      (url) => url.includes('/video-generation/video-synthesis'),
    ).length,
    1,
  );
  assert.ok(result.budget.settled_eur < 1.5);
  assert.equal(result.budget.images, 1);
  assert.equal(result.budget.video_seconds, 5);
});

test('smoke stops after text failure and never starts image/video', async () => {
  const calls = [];

  await assert.rejects(
    () => runAlibabaCreativeSmoke({
      config,
      publicProductUrl: publicUrl,
      allowedHosts: ['habb.be'],
      journal: new MemoryCallJournal(),
      outputStore: new MemoryOutputStore(),
      budget: new SpendGuard({
        maxSpendEur: 1.5,
        maxImages: 1,
        maxVideoSeconds: 5,
      }),
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse(
          { code: 'ProviderFailure', request_id: 'req-fail' },
          500,
        );
      },
    }),
    /ProviderFailure/,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /chat\/completions/);
});
