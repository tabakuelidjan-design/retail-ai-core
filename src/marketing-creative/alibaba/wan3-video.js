import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest } from './http.js';

const RESOLUTIONS = new Set(['480P', '720P', '1080P']);
const RATIOS = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

function assertExternalMedia(media = []) {
  for (const item of media) {
    if (!item || typeof item !== 'object') throw new TypeError('media item must be an object');
    if (item.external_share_allowed !== true) {
      throw new Error('external_share_allowed must be true for every Wan 3.0 media input');
    }
    if (typeof item.url !== 'string' || !item.url) throw new TypeError('media.url is required');
    if (typeof item.type !== 'string' || !item.type) throw new TypeError('media.type is required');
  }
}

export async function createWan3VideoTask({
  config,
  prompt = null,
  media = [],
  resolution = '720P',
  ratio = 'adaptive',
  duration = 5,
  audio = true,
  seed = -1,
  promptExtend = true,
  watermark = false,
  fetchImpl,
}) {
  requireAlibabaCreativeConfig(config);
  assertExternalMedia(media);

  if ((!prompt || !String(prompt).trim()) && media.length === 0) {
    throw new TypeError('prompt or media is required');
  }
  if (!RESOLUTIONS.has(resolution)) throw new RangeError('unsupported Wan 3.0 resolution');
  if (!RATIOS.has(ratio)) throw new RangeError('unsupported Wan 3.0 ratio');
  if (!(duration === -1 || (Number.isInteger(duration) && duration >= 2 && duration <= 30))) {
    throw new RangeError('duration must be -1 or an integer between 2 and 30 seconds');
  }

  const endpoints = alibabaCreativeEndpoints(config);
  const input = {};
  if (prompt && String(prompt).trim()) input.prompt = String(prompt).trim();
  if (media.length) {
    input.media = media.map(({ external_share_allowed, ...providerMedia }) => providerMedia);
  }

  const body = {
    model: config.videoModel,
    input,
    parameters: {
      resolution,
      ratio,
      duration,
      audio,
      seed,
      prompt_extend: promptExtend,
      watermark,
    },
  };

  const payload = await alibabaJsonRequest({
    url: endpoints.videoSynthesis,
    apiKey: config.apiKey,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
    asyncTask: true,
    body,
  });

  const taskId = payload?.output?.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('Wan 3.0 response did not contain task_id');
  }

  return Object.freeze({
    model: config.videoModel,
    taskId,
    requestId: payload?.request_id ?? null,
    raw: payload,
  });
}

export async function getWan3VideoTask({ config, taskId, fetchImpl }) {
  requireAlibabaCreativeConfig(config);
  if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required');

  const endpoints = alibabaCreativeEndpoints(config);
  const payload = await alibabaJsonRequest({
    url: endpoints.task(taskId),
    apiKey: config.apiKey,
    method: 'GET',
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
  });

  const output = payload?.output || {};
  return Object.freeze({
    taskId,
    status: output.task_status ?? 'UNKNOWN',
    videoUrl: output.video_url ?? null,
    usage: payload?.usage ?? null,
    requestId: payload?.request_id ?? null,
    raw: payload,
  });
}

export async function waitForWan3Video({
  config,
  taskId,
  pollIntervalMs = 15000,
  maxWaitMs = 10 * 60 * 1000,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const started = Date.now();

  while (true) {
    const result = await getWan3VideoTask({ config, taskId, fetchImpl });
    if (result.status === 'SUCCEEDED') return result;
    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(result.status)) {
      throw new Error(`Wan 3.0 task ended with status ${result.status}`);
    }
    if (Date.now() - started >= maxWaitMs) {
      throw new Error('Wan 3.0 task polling timed out');
    }
    await sleep(pollIntervalMs);
  }
}
