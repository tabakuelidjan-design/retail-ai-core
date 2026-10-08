import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const API_BASE = 'https://api.minimax.io';
const MODEL = 'MiniMax-H3';
const RESOLUTION = '768P';
const DURATION = 5;
const PRICE_USD_PER_SECOND = 0.08;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertPublicSource(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('source image must use credential-free HTTPS');
  }
  if (url.search || url.hash) {
    throw new Error('source image URL must not contain query or fragment');
  }
  return url.toString();
}

async function requestJson(url, { apiKey, method = 'GET', body, timeoutMs = 120000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`MiniMax returned non-JSON response: HTTP_${response.status}`);
    }

    if (!response.ok) {
      const providerMessage = payload?.error?.message || payload?.message || `HTTP_${response.status}`;
      const code = payload?.error?.type || payload?.error?.http_code || 'MINIMAX_REQUEST_FAILED';
      throw new Error(`MiniMax request failed [${code}]: ${providerMessage}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function download(url, timeoutMs = 120000) {
  const safe = new URL(url);
  if (safe.protocol !== 'https:' || safe.username || safe.password) {
    throw new Error('MiniMax output URL must be credential-free HTTPS');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(safe, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`MiniMax output download failed: HTTP_${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'video/mp4',
    };
  } finally {
    clearTimeout(timer);
  }
}

const apiKey = required('MINIMAX_API_KEY');
const sourceUrl = assertPublicSource(required('ALIBABA_SMOKE_PUBLIC_PRODUCT_URL'));

const prompt = [
  'Create a 5-second premium commercial product video for HABB from this exact real TYESO FLAIR 2.0 source image.',
  'Preserve the product exactly throughout the full video: same silhouette, proportions, open tumbler state, stainless-steel rim, ice, separated lid, straw, TYESO logo placement, printed text, pink color, materials and accessories.',
  'Do not redesign, close, relabel, recolor, deform, remove or add any part of the product.',
  'Use only subtle professional motion: a slow controlled camera push-in and very slight parallax in the environment.',
  'Keep the product itself stable and photorealistic with no morphing, no geometry drift, no logo drift, no text mutation, no disappearing or reappearing parts.',
  'Clean premium retail advertising style, realistic lighting, commercially usable for HABB.',
  'No people, no extra products, no added text overlay, no hearts, no leaves, no beige AI-look styling, no excessive glow.',
].join(' ');

const createBody = {
  model: MODEL,
  content: [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: sourceUrl }, role: 'first_frame' },
  ],
  resolution: RESOLUTION,
  duration: DURATION,
  ratio: 'adaptive',
};

const startedAt = Date.now();

const created = await requestJson(`${API_BASE}/v2/video_generation`, {
  apiKey,
  method: 'POST',
  body: createBody,
  timeoutMs: 120000,
});

const taskId = created?.task_id;
if (!taskId) throw new Error('MiniMax create response did not contain task_id');

let task = null;
const deadline = Date.now() + Number(process.env.MINIMAX_VIDEO_TIMEOUT_MS || 900000);
const pollMs = 5000;

while (Date.now() < deadline) {
  const queried = await requestJson(
    `${API_BASE}/v2/query/video_generation/${encodeURIComponent(taskId)}`,
    { apiKey, timeoutMs: 60000 },
  );

  task = queried?.task ?? null;
  const status = task?.status;

  if (status === 'succeeded') break;
  if (status === 'failed' || status === 'cancelled') {
    throw new Error(`MiniMax H3 task ended with status: ${status}`);
  }

  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

if (task?.status !== 'succeeded') {
  throw new Error('MiniMax H3 task timed out before completion');
}

const outputUrl = task?.content?.url;
if (!outputUrl) throw new Error('MiniMax H3 succeeded without output URL');

const downloaded = await download(outputUrl);
const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.join(os.tmpdir(), 'nordla-minimax-h3-benchmark', stamp);
const outputDirectory = path.join(root, 'outputs');

await mkdir(outputDirectory, { recursive: true });

const outputPath = path.join(outputDirectory, `minimax-h3-${sha256.slice(0,16)}.mp4`);
await writeFile(outputPath, downloaded.bytes, { mode: 0o600 });

const summary = {
  status: 'SUCCEEDED',
  provider: 'minimax-hosted-api',
  model: MODEL,
  task_id: taskId,
  source_url: sourceUrl,
  output: {
    ref: `file://${outputPath}`,
    sha256,
    bytes: downloaded.bytes.length,
    content_type: downloaded.contentType,
    kind: 'video',
  },
  benchmark: {
    resolution: RESOLUTION,
    duration_seconds: DURATION,
    ratio: task?.ratio ?? 'adaptive',
    first_pass_only: true,
    prompt_version: 'habb-tyeso-video-v1',
  },
  usage: task?.usage ?? null,
  cost_usd_estimate: DURATION * PRICE_USD_PER_SECOND,
  elapsed_ms: Date.now() - startedAt,
  output_directory: outputDirectory,
};

await writeFile(
  path.join(root, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
