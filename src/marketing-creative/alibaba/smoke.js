import { SpendGuard } from './budget.js';
import { JsonlCallJournal } from './journal.js';
import { FileOutputStore } from './output-store.js';
import { createMarketingCopy } from './qwen-text.js';
import { generateMarketingImage } from './qwen-image.js';
import { createWan3VideoTask, waitForWan3Video } from './wan3-video.js';

export function assertAllowedSmokeAssetUrl(value, allowedHosts = []) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError('publicProductUrl is required');
  }

  const allowed = new Set(
    allowedHosts
      .map((host) => String(host).trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowed.size) {
    throw new Error('at least one smoke-test host must be explicitly allowed');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('publicProductUrl must be a valid URL');
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('smoke-test asset must use credential-free HTTPS');
  }
  if (url.search || url.hash) {
    throw new Error('smoke-test asset URL must not contain query or fragment');
  }
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new Error(
      `smoke-test asset host is not allowlisted: ${url.hostname}`,
    );
  }

  return url.toString();
}

function assertSmokeBudget(budget) {
  if (!budget?.snapshot) throw new TypeError('smoke budget is required');
  const snapshot = budget.snapshot();

  if (snapshot.max_spend_eur > 1.5) {
    throw new Error('smoke max_spend_eur must be <= 1.50');
  }
  if (budget.maxImages > 1) {
    throw new Error('smoke maxImages must be <= 1');
  }
  if (budget.maxVideoSeconds > 5) {
    throw new Error('smoke maxVideoSeconds must be <= 5');
  }

  return budget;
}

export async function runAlibabaCreativeSmoke({
  config,
  publicProductUrl,
  allowedHosts,
  outputDirectory = null,
  journalPath = null,
  budget = new SpendGuard({
    maxSpendEur: 1.5,
    maxImages: 1,
    maxVideoSeconds: 5,
  }),
  journal = null,
  outputStore = null,
  fetchImpl = globalThis.fetch,
  sleep,
}) {
  const sourceUrl = assertAllowedSmokeAssetUrl(
    publicProductUrl,
    allowedHosts,
  );
  assertSmokeBudget(budget);

  const callJournal = journal ?? new JsonlCallJournal(journalPath);
  const store = outputStore ?? new FileOutputStore(outputDirectory);
  const dataPolicy = Object.freeze({
    classification: 'PUBLIC',
    contains_personal_data: false,
    contains_face: false,
    reason: 'Nordla Alibaba pre-smoke public product only',
  });

  const copy = await createMarketingCopy({
    config,
    brief: [
      'Create one concise premium social-media campaign concept for this',
      'public retail product.',
      'Return a headline, one short caption and one visual direction.',
      `Public product source: ${sourceUrl}`,
    ].join(' '),
    dataPolicy,
    budget,
    journal: callJournal,
    maxTokens: 600,
    fetchImpl,
  });

  const image = await generateMarketingImage({
    config,
    prompt: [
      'Create a premium commercial product advertisement.',
      'Preserve the referenced product identity exactly.',
      'Do not invent text, logos, labels or product geometry.',
      'Natural professional retail photography, no artificial AI look.',
    ].join(' '),
    referenceImages: [sourceUrl],
    dataPolicy,
    budget,
    journal: callJournal,
    outputStore: store,
    size: '1024x1024',
    n: 1,
    watermark: false,
    fetchImpl,
  });

  const videoStart = await createWan3VideoTask({
    config,
    prompt: [
      'Create a natural premium retail product video.',
      'Keep the product identity, geometry, labels and colors unchanged.',
      'Subtle camera movement, realistic lighting, professional marketing.',
    ].join(' '),
    media: [{ type: 'first_frame', url: sourceUrl }],
    dataPolicy,
    budget,
    journal: callJournal,
    resolution: '720P',
    ratio: 'adaptive',
    duration: 5,
    audio: false,
    watermark: false,
    fetchImpl,
  });

  const video = await waitForWan3Video({
    config,
    taskId: videoStart.taskId,
    operationId: videoStart.operationId,
    reservation: videoStart.reservation,
    budget,
    journal: callJournal,
    outputStore: store,
    resolution: '720P',
    fetchImpl,
    sleep,
  });

  return Object.freeze({
    status: 'SUCCEEDED',
    text: Object.freeze({
      model: copy.model,
      request_id: copy.requestId,
      cost_eur: copy.costEur,
    }),
    image: Object.freeze({
      model: image.model,
      request_id: image.requestId,
      outputs: image.outputs,
      cost_eur: image.costEur,
    }),
    video: Object.freeze({
      model: videoStart.model,
      request_id: video.requestId,
      task_id: video.taskId,
      output_ref: video.outputRef,
      output_sha256: video.outputSha256,
      cost_eur: video.costEur,
    }),
    budget: budget.snapshot(),
  });
}
