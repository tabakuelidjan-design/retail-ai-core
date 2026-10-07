import { randomUUID } from 'node:crypto';

import { assertPublicCreativeInput, assertPublicHttpsUrl } from '../shared/external-policy.js';
import { RUNWAY_RECIPE_CREDITS, productAdCredits } from './budget.js';
import { runwayRequest } from './http.js';

async function waitForTask({
  config,
  taskId,
  outputStore,
  kind,
  operationId,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 10000,
  maxWaitMs = 12 * 60 * 1000,
}) {
  const started = Date.now();
  while (true) {
    const task = await runwayRequest({
      config,
      path: `/tasks/${encodeURIComponent(taskId)}`,
      method: 'GET',
      fetchImpl,
    });
    if (task.status === 'SUCCEEDED') {
      const urls = Array.isArray(task.output) ? task.output : [];
      if (!urls.length) throw new Error('Runway task succeeded without output');
      const outputs = [];
      for (const url of urls) {
        outputs.push(await outputStore.storeUrl({
          url,
          kind,
          operationId,
          fetchImpl,
        }));
      }
      return Object.freeze({ task, outputs: Object.freeze(outputs) });
    }
    if (['FAILED', 'CANCELED'].includes(task.status)) {
      throw new Error(`Runway task ended with status ${task.status}`);
    }
    if (Date.now() - started >= maxWaitMs) {
      throw new Error('Runway task polling timed out');
    }
    await sleep(pollIntervalMs);
  }
}

export async function createRunwayProductCampaign({
  config,
  productImageUrl,
  prompt,
  dataPolicy,
  budget,
  outputStore,
  journal = null,
  operationId = randomUUID(),
  fetchImpl,
  sleep,
}) {
  const policy = assertPublicCreativeInput(dataPolicy);
  const image = assertPublicHttpsUrl(productImageUrl, 'productImageUrl');
  if (!budget?.reserve || !budget?.settle) throw new TypeError('Runway budget is required');
  if (!outputStore?.storeUrl) throw new TypeError('outputStore is required');

  const credits = RUNWAY_RECIPE_CREDITS.product_campaign_image;
  const reservation = budget.reserve(operationId, credits);
  const created = await runwayRequest({
    config,
    path: '/recipes/product_campaign_image',
    fetchImpl,
    body: {
      version: config.campaignVersion,
      image: { uri: image },
      prompt,
    },
  });
  const taskId = created?.id;
  if (!taskId) throw new Error('Runway Product Campaign did not return task id');

  await journal?.append({
    event: 'TASK_CREATED',
    operation_id: operationId,
    provider: 'runway',
    model: 'product_campaign_image',
    task_id: taskId,
    status: 'PENDING',
    data_class: policy.classification,
  });

  const result = await waitForTask({
    config,
    taskId,
    outputStore,
    kind: 'image',
    operationId,
    fetchImpl,
    sleep,
  });
  budget.settle(reservation);

  return Object.freeze({
    provider: 'runway',
    recipe: 'product_campaign_image',
    taskId,
    outputs: result.outputs,
    credits,
    costUsd: credits * 0.01,
  });
}

export async function createRunwayProductAd({
  config,
  productImageUrls,
  productInfo = null,
  userConcept = null,
  dataPolicy,
  budget,
  outputStore,
  duration = 5,
  ratio = '1280:720',
  audio = false,
  journal = null,
  operationId = randomUUID(),
  fetchImpl,
  sleep,
}) {
  const policy = assertPublicCreativeInput(dataPolicy);
  if (!Array.isArray(productImageUrls) || productImageUrls.length < 1 || productImageUrls.length > 10) {
    throw new RangeError('productImageUrls must contain 1-10 images');
  }
  const images = productImageUrls.map((url, i) => ({
    uri: assertPublicHttpsUrl(url, `productImageUrls[${i}]`),
  }));
  if (!outputStore?.storeUrl) throw new TypeError('outputStore is required');

  const resolution = ratio === '1920:1080' || ratio === '1080:1920' ? '1080p' : '720p';
  const credits = productAdCredits({ duration, resolution });
  const reservation = budget.reserve(operationId, credits);

  const created = await runwayRequest({
    config,
    path: '/recipes/product_ad',
    fetchImpl,
    body: {
      version: config.productAdVersion,
      productImages: images,
      productInfo: productInfo ?? undefined,
      userConcept: userConcept ?? undefined,
      ratio,
      duration,
      audio,
    },
  });
  const taskId = created?.id;
  if (!taskId) throw new Error('Runway Product Ad did not return task id');

  await journal?.append({
    event: 'TASK_CREATED',
    operation_id: operationId,
    provider: 'runway',
    model: 'product_ad',
    task_id: taskId,
    status: 'PENDING',
    data_class: policy.classification,
  });

  const result = await waitForTask({
    config,
    taskId,
    outputStore,
    kind: 'video',
    operationId,
    fetchImpl,
    sleep,
  });
  budget.settle(reservation);

  return Object.freeze({
    provider: 'runway',
    recipe: 'product_ad',
    taskId,
    outputs: result.outputs,
    credits,
    costUsd: credits * 0.01,
  });
}
