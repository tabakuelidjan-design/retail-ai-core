import { randomUUID } from 'node:crypto';

import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest } from './http.js';
import { assertAlibabaExternalUse, assertHttpsPublicUrl } from './policy.js';
import { priceVideoEur } from './budget.js';

const RESOLUTIONS = new Set(['480P', '720P', '1080P']);
const RATIOS = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const MEDIA_TYPES = new Set([
  'reference_image',
  'first_frame',
  'last_frame',
  'reference_video',
  'reference_audio',
  'file',
  'link',
]);

function normalizeMedia(media = []) {
  return media.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new TypeError('media item must be an object');
    }
    if (!MEDIA_TYPES.has(item.type)) {
      throw new Error(`unsupported Wan media type: ${item.type}`);
    }

    return Object.freeze({
      type: item.type,
      url: assertHttpsPublicUrl(item.url, `media[${index}].url`),
    });
  });
}

export async function createWan3VideoTask({
  config,
  prompt = null,
  media = [],
  dataPolicy,
  budget,
  journal = null,
  operationId = randomUUID(),
  resolution = '720P',
  ratio = 'adaptive',
  duration = 5,
  audio = false,
  seed = -1,
  promptExtend = true,
  watermark = false,
  fetchImpl,
}) {
  requireAlibabaCreativeConfig(config);
  const policy = assertAlibabaExternalUse(dataPolicy);

  if (!budget?.reserveVideo) throw new TypeError('budget is required');

  const cleanMedia = normalizeMedia(media);
  if ((!prompt || !String(prompt).trim()) && cleanMedia.length === 0) {
    throw new TypeError('prompt or media is required');
  }
  if (!RESOLUTIONS.has(resolution)) {
    throw new RangeError('unsupported Wan 3.0 resolution');
  }
  if (!RATIOS.has(ratio)) {
    throw new RangeError('unsupported Wan 3.0 ratio');
  }
  if (!Number.isInteger(duration) || duration < 2 || duration > 30) {
    throw new RangeError('duration must be an integer between 2 and 30 seconds');
  }

  const reservation = budget.reserveVideo({
    id: operationId,
    duration,
    resolution,
  });

  await journal?.append({
    event: 'RESERVED',
    operation_id: operationId,
    provider: 'alibaba-model-studio',
    model: config.videoModel,
    region: config.region,
    estimated_cost_eur: reservation.reserved_eur,
    data_class: policy.classification,
  });

  const input = {};
  if (prompt && String(prompt).trim()) input.prompt = String(prompt).trim();
  if (cleanMedia.length) input.media = cleanMedia;

  try {
    const payload = await alibabaJsonRequest({
      url: alibabaCreativeEndpoints(config).videoSynthesis,
      apiKey: config.apiKey,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
      asyncTask: true,
      body: {
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
      },
    });

    const taskId = payload?.output?.task_id;
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('Wan 3.0 response did not contain task_id');
    }

    await journal?.append({
      event: 'TASK_CREATED',
      operation_id: operationId,
      provider: 'alibaba-model-studio',
      model: config.videoModel,
      region: config.region,
      request_id: payload?.request_id ?? null,
      task_id: taskId,
      status: 'PENDING',
      estimated_cost_eur: reservation.reserved_eur,
      data_class: policy.classification,
    });

    return Object.freeze({
      model: config.videoModel,
      taskId,
      requestId: payload?.request_id ?? null,
      operationId,
      reservation,
    });
  } catch (error) {
    budget.hold(reservation);
    await journal?.append({
      event: 'CREATE_OUTCOME_UNKNOWN',
      operation_id: operationId,
      provider: 'alibaba-model-studio',
      model: config.videoModel,
      region: config.region,
      request_id: error?.requestId ?? null,
      status: 'UNKNOWN',
      estimated_cost_eur: reservation.reserved_eur,
      data_class: policy.classification,
      reason: error?.code ?? 'CREATE_FAILED',
    });
    throw error;
  }
}

export async function getWan3VideoTask({ config, taskId, fetchImpl }) {
  requireAlibabaCreativeConfig(config);
  if (typeof taskId !== 'string' || !taskId) {
    throw new TypeError('taskId is required');
  }

  const payload = await alibabaJsonRequest({
    url: alibabaCreativeEndpoints(config).task(taskId),
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
  });
}

export async function waitForWan3Video({
  config,
  taskId,
  operationId,
  reservation,
  budget,
  journal = null,
  outputStore,
  resolution = '720P',
  pollIntervalMs = 15000,
  maxWaitMs = 10 * 60 * 1000,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!outputStore?.storeUrl) throw new TypeError('outputStore is required');

  const started = Date.now();

  while (true) {
    let result;

    try {
      result = await getWan3VideoTask({ config, taskId, fetchImpl });
    } catch (error) {
      if (error?.transient === true) {
        if (Date.now() - started >= maxWaitMs) {
          await journal?.append({
            event: 'POLL_TIMEOUT',
            operation_id: operationId,
            provider: 'alibaba-model-studio',
            model: config.videoModel,
            region: config.region,
            task_id: taskId,
            status: 'ACTIVE_UNKNOWN',
            reason: 'TRANSIENT_PROVIDER_ERRORS',
          });
          return Object.freeze({
            taskId,
            status: 'TIMED_OUT_ACTIVE',
            outputRef: null,
            usage: null,
          });
        }
        await sleep(pollIntervalMs);
        continue;
      }
      throw error;
    }

    if (result.status === 'SUCCEEDED') {
      if (!result.videoUrl) {
        throw new Error('Wan 3.0 task succeeded without video_url');
      }

      const stored = await outputStore.storeUrl({
        url: result.videoUrl,
        kind: 'video',
        operationId,
        fetchImpl,
      });

      const duration = (
        result.usage?.output_video_duration
        ?? reservation?.video_seconds
        ?? 0
      );
      const actualEur = priceVideoEur({
        duration,
        resolution,
        usdToEur: budget.usdToEur,
      });
      if (reservation) budget.settle(reservation, actualEur);

      await journal?.append({
        event: 'SUCCEEDED',
        operation_id: operationId,
        provider: 'alibaba-model-studio',
        model: config.videoModel,
        region: config.region,
        request_id: result.requestId,
        task_id: taskId,
        status: 'SUCCEEDED',
        actual_cost_eur: actualEur,
        output_sha256: stored.sha256,
      });

      return Object.freeze({
        taskId: result.taskId,
        status: result.status,
        usage: result.usage,
        requestId: result.requestId,
        outputRef: stored.ref,
        outputSha256: stored.sha256,
        costEur: actualEur,
      });
    }

    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(result.status)) {
      if (reservation) budget.hold(reservation);
      await journal?.append({
        event: 'FAILED',
        operation_id: operationId,
        provider: 'alibaba-model-studio',
        model: config.videoModel,
        region: config.region,
        request_id: result.requestId,
        task_id: taskId,
        status: result.status,
        estimated_cost_eur: reservation?.reserved_eur ?? null,
      });
      throw new Error(`Wan 3.0 task ended with status ${result.status}`);
    }

    if (Date.now() - started >= maxWaitMs) {
      await journal?.append({
        event: 'POLL_TIMEOUT',
        operation_id: operationId,
        provider: 'alibaba-model-studio',
        model: config.videoModel,
        region: config.region,
        task_id: taskId,
        status: 'ACTIVE_UNKNOWN',
      });
      return Object.freeze({
        taskId,
        status: 'TIMED_OUT_ACTIVE',
        outputRef: null,
        usage: result.usage ?? null,
      });
    }

    await sleep(pollIntervalMs);
  }
}
