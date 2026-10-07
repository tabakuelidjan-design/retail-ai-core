import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alibabaCreativeEndpoints,
  createMarketingCopy,
  createWan3VideoTask,
  generateMarketingImage,
  getWan3VideoTask,
  loadAlibabaCreativeConfig,
  MemoryCallJournal,
  MemoryOutputStore,
  SpendGuard,
  waitForWan3Video,
} from '../src/marketing-creative/alibaba/index.js';

const config = loadAlibabaCreativeConfig({
  ALIBABA_MODEL_STUDIO_API_KEY: 'secret-key',
  ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'workspace-123',
});

const policy = { classification: 'PUBLIC' };

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

test('Frankfurt endpoint and workspace are hardened', () => {
  assert.match(
    alibabaCreativeEndpoints(config).chatCompletions,
    /workspace-123\.eu-central-1\.maas\.aliyuncs\.com/,
  );
  assert.throws(
    () => loadAlibabaCreativeConfig({
      ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'evil.example.com/path',
    }),
    /Invalid/,
  );
});

test('DASHSCOPE fallback is not accepted', () => {
  const c = loadAlibabaCreativeConfig({
    DASHSCOPE_API_KEY: 'legacy',
    ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'workspace-123',
  });
  assert.equal(c.apiKey, null);
});

test('unknown model override is rejected', () => {
  assert.throws(
    () => loadAlibabaCreativeConfig({ ALIBABA_QWEN_TEXT_MODEL: 'other' }),
    /Unsupported Alibaba text model/,
  );
});

test('text requires PUBLIC data, budget, max_tokens and captures usage', async () => {
  const budget = new SpendGuard({ maxSpendEur: 1 });
  let request;

  const output = await createMarketingCopy({
    config,
    brief: 'Launch bottle',
    dataPolicy: policy,
    budget,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        choices: [{ message: { content: 'Premium copy' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        id: 'req-1',
      });
    },
  });

  const body = JSON.parse(request.options.body);
  assert.equal(body.max_tokens, 600);
  assert.equal(request.options.headers.Authorization, 'Bearer secret-key');
  assert.equal(request.options.redirect, 'error');
  assert.equal(output.text, 'Premium copy');
  assert.ok(output.costEur > 0);
});

test('private text is blocked before provider call', async () => {
  let called = false;
  const budget = new SpendGuard({ maxSpendEur: 1 });

  await assert.rejects(
    () => createMarketingCopy({
      config,
      brief: 'margin secret',
      dataPolicy: { classification: 'LOCAL_ONLY' },
      budget,
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    }),
    /only accepts PUBLIC/,
  );
  assert.equal(called, false);
});

test('budget blocks image before provider call', async () => {
  let called = false;
  const budget = new SpendGuard({ maxSpendEur: 0.01, maxImages: 1 });

  await assert.rejects(
    () => generateMarketingImage({
      config,
      prompt: 'x',
      dataPolicy: policy,
      budget,
      outputStore: new MemoryOutputStore(),
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    }),
    /BUDGET_EXCEEDED/,
  );
  assert.equal(called, false);
});

test('text-to-image supports Frankfurt compatible endpoint and stores output', async () => {
  const budget = new SpendGuard({ maxSpendEur: 1 });
  const outputStore = new MemoryOutputStore();
  let providerCall = null;

  const output = await generateMarketingImage({
    config,
    prompt: 'premium product photo',
    dataPolicy: policy,
    budget,
    outputStore,
    fetchImpl: async (url, options) => {
      if (url.includes('images/generations')) {
        providerCall = { url, options };
        return jsonResponse({
          data: [{ url: 'https://cdn.example.test/result.png' }],
          usage: { image_count: 1 },
          request_id: 'img-1',
        });
      }
      if (url === 'https://cdn.example.test/result.png') {
        return binaryResponse('image-bytes', 'image/png');
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.match(
    providerCall.url,
    /compatible-mode\/v1\/images\/generations/,
  );
  assert.equal(output.outputs[0].sha256.length, 64);
  assert.match(output.outputs[0].ref, /^memory:/);
});

test('image edit uses native multimodal schema for public HTTPS references', async () => {
  const budget = new SpendGuard({ maxSpendEur: 1 });
  const outputStore = new MemoryOutputStore();
  let body;

  const output = await generateMarketingImage({
    config,
    prompt: 'change only the background',
    referenceImages: ['https://public.example.test/product.png'],
    dataPolicy: policy,
    budget,
    outputStore,
    fetchImpl: async (url, options) => {
      if (url.includes('multimodal-generation')) {
        body = JSON.parse(options.body);
        return jsonResponse({
          output: {
            choices: [{
              message: {
                content: [{ image: 'https://cdn.example.test/edit.png' }],
              },
            }],
          },
          usage: { image_count: 1 },
          request_id: 'img-2',
        });
      }
      if (url === 'https://cdn.example.test/edit.png') {
        return binaryResponse('edited', 'image/png');
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(
    body.input.messages[0].content[0].image,
    'https://public.example.test/product.png',
  );
  assert.equal(output.outputs[0].sha256.length, 64);
});

test('Wan rejects non-HTTPS media and unpredictable duration', async () => {
  const budget = new SpendGuard({ maxSpendEur: 2, maxVideoSeconds: 30 });

  await assert.rejects(
    () => createWan3VideoTask({
      config,
      media: [{ type: 'first_frame', url: 'file:///private.png' }],
      dataPolicy: policy,
      budget,
    }),
    /HTTPS/,
  );

  await assert.rejects(
    () => createWan3VideoTask({
      config,
      prompt: 'x',
      duration: -1,
      dataPolicy: policy,
      budget,
    }),
    /duration/,
  );
});

test('Wan creation is journaled and status uses GET', async () => {
  const budget = new SpendGuard({ maxSpendEur: 1, maxVideoSeconds: 5 });
  const journal = new MemoryCallJournal();
  let statusMethod;

  const start = await createWan3VideoTask({
    config,
    prompt: 'cinematic bottle ad',
    dataPolicy: policy,
    budget,
    journal,
    fetchImpl: async () => jsonResponse({
      output: { task_id: 'task-1' },
      request_id: 'req-create',
    }),
  });

  assert.ok(
    journal.list().some(
      (event) => event.event === 'TASK_CREATED' && event.task_id === 'task-1',
    ),
  );

  await getWan3VideoTask({
    config,
    taskId: start.taskId,
    fetchImpl: async (url, options) => {
      statusMethod = options.method;
      return jsonResponse({
        output: { task_status: 'PENDING' },
        request_id: 'req-poll',
      });
    },
  });
  assert.equal(statusMethod, 'GET');
});

test('Wan polling survives transient 503 and stores output before success', async () => {
  const budget = new SpendGuard({ maxSpendEur: 1, maxVideoSeconds: 5 });
  const journal = new MemoryCallJournal();
  const outputStore = new MemoryOutputStore();

  const start = await createWan3VideoTask({
    config,
    prompt: 'cinematic bottle ad',
    dataPolicy: policy,
    budget,
    journal,
    fetchImpl: async () => jsonResponse({
      output: { task_id: 'task-1' },
      request_id: 'req-create',
    }),
  });

  let polls = 0;
  const output = await waitForWan3Video({
    config,
    taskId: start.taskId,
    operationId: start.operationId,
    reservation: start.reservation,
    budget,
    journal,
    outputStore,
    pollIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.includes('/api/v1/tasks/')) {
        polls += 1;
        if (polls === 1) {
          return jsonResponse(
            { code: 'ServiceUnavailable', request_id: 'req-503' },
            503,
          );
        }
        return jsonResponse({
          output: {
            task_status: 'SUCCEEDED',
            video_url: 'https://cdn.example.test/v.mp4',
          },
          usage: { output_video_duration: 5 },
          request_id: 'req-ok',
        });
      }
      if (url === 'https://cdn.example.test/v.mp4') {
        return binaryResponse('video-bytes', 'video/mp4');
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(polls, 2);
  assert.equal(output.status, 'SUCCEEDED');
  assert.equal(output.outputSha256.length, 64);
});

test('provider error keeps request id but not provider secret', async () => {
  const budget = new SpendGuard({ maxSpendEur: 1 });

  await assert.rejects(
    () => createMarketingCopy({
      config,
      brief: 'x',
      dataPolicy: policy,
      budget,
      fetchImpl: async () => jsonResponse({
        code: 'InvalidApiKey',
        message: 'secret-key',
        request_id: 'req-error',
      }, 401),
    }),
    (error) => {
      assert.equal(
        error.message,
        'Alibaba Model Studio request failed: InvalidApiKey',
      );
      assert.equal(error.message.includes('secret-key'), false);
      assert.equal(error.requestId, 'req-error');
      return true;
    },
  );
});
