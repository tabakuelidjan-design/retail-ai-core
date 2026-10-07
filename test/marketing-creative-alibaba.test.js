import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alibabaCreativeEndpoints,
  createMarketingCopy,
  createWan3VideoTask,
  generateMarketingImage,
  getWan3VideoTask,
  loadAlibabaCreativeConfig,
} from '../src/marketing-creative/alibaba/index.js';

const config = loadAlibabaCreativeConfig({
  ALIBABA_MODEL_STUDIO_API_KEY: 'secret-key',
  ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'workspace-123',
});

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() {
    return JSON.stringify(payload);
  },
});

test('Frankfurt is pinned by default', () => {
  const endpoints = alibabaCreativeEndpoints(config);
  assert.match(endpoints.root, /workspace-123\.eu-central-1\.maas\.aliyuncs\.com/);
});

test('unsupported region is rejected', () => {
  assert.throws(
    () => loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_REGION: 'cn-beijing' }),
    /Unsupported/,
  );
});

test('marketing copy uses qwen3.8-max and does not expose key in output', async () => {
  let call;
  const fetchImpl = async (url, options) => {
    call = { url, options };
    return jsonResponse({ choices: [{ message: { content: 'Premium copy' } }] });
  };

  const output = await createMarketingCopy({
    config,
    brief: 'Launch this bottle',
    fetchImpl,
  });

  assert.equal(output.text, 'Premium copy');
  assert.equal(JSON.parse(call.options.body).model, 'qwen3.8-max');
  assert.equal(output.raw.secret_key, undefined);
});

test('image generation uses qwen-image-3.0-pro', async () => {
  let body;
  const fetchImpl = async (url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ data: [{ url: 'https://example.test/result.png' }] });
  };

  const output = await generateMarketingImage({
    config,
    prompt: 'premium product photo',
    fetchImpl,
  });

  assert.equal(body.model, 'qwen-image-3.0-pro');
  assert.equal(output.outputs[0], 'https://example.test/result.png');
});

test('Wan media requires explicit external sharing permission', async () => {
  await assert.rejects(
    () => createWan3VideoTask({
      config,
      media: [{ type: 'first_frame', url: 'https://example.test/p.png' }],
      fetchImpl: async () => jsonResponse({}),
    }),
    /external_share_allowed/,
  );
});

test('Wan task uses async header and wan3.0-video', async () => {
  let call;
  const fetchImpl = async (url, options) => {
    call = { url, options };
    return jsonResponse({ output: { task_id: 'task-1' }, request_id: 'req-1' });
  };

  const output = await createWan3VideoTask({
    config,
    prompt: 'cinematic bottle ad',
    duration: 5,
    fetchImpl,
  });

  const body = JSON.parse(call.options.body);
  assert.equal(call.options.headers['X-DashScope-Async'], 'enable');
  assert.equal(body.model, 'wan3.0-video');
  assert.equal(body.parameters.watermark, false);
  assert.equal(output.taskId, 'task-1');
});

test('Wan task status reads provider result', async () => {
  const fetchImpl = async () => jsonResponse({
    output: {
      task_id: 'task-1',
      task_status: 'SUCCEEDED',
      video_url: 'https://example.test/v.mp4',
    },
    usage: { output_video_duration: 5 },
  });

  const output = await getWan3VideoTask({ config, taskId: 'task-1', fetchImpl });
  assert.equal(output.status, 'SUCCEEDED');
  assert.equal(output.videoUrl, 'https://example.test/v.mp4');
});

test('provider error sanitizes secret', async () => {
  const fetchImpl = async () => jsonResponse({
    code: 'InvalidApiKey',
    message: 'secret-key',
  }, 401);

  await assert.rejects(
    () => generateMarketingImage({ config, prompt: 'x', fetchImpl }),
    (error) => {
      assert.equal(error.message, 'Alibaba Model Studio request failed: InvalidApiKey');
      assert.equal(error.message.includes('secret-key'), false);
      return true;
    },
  );
});
