import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODEL = 'gemini-nano-banana-2.1';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OUTPUT_PRICE_USD_1K = 0.0336;
const MAX_OUTPUTS = 1;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function findImage(payload) {
  if (payload?.output_image?.data) return payload.output_image;

  for (const step of payload?.steps ?? []) {
    if (step?.type !== 'model_output') continue;
    for (const content of step?.content ?? []) {
      if (content?.type === 'image' && content?.data) return content;
    }
  }

  return null;
}

const apiKey = required('GEMINI_API_KEY');
const sourceUrl = assertPublicSource(required('ALIBABA_SMOKE_PUBLIC_PRODUCT_URL'));

const sourceResponse = await fetchWithTimeout(sourceUrl, {
  method: 'GET',
  redirect: 'error',
}, 120000);

if (!sourceResponse.ok) {
  throw new Error(`source image download failed: HTTP_${sourceResponse.status}`);
}

const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
const sourceMime = sourceResponse.headers.get('content-type')?.split(';')[0] || 'image/webp';

if (!sourceMime.startsWith('image/')) {
  throw new Error(`source URL did not return an image: ${sourceMime}`);
}

const prompt = [
  'Create one premium commercial advertising image for HABB using the referenced real TYESO FLAIR 2.0 product photo.',
  'Preserve the real product exactly: same silhouette, proportions, lid system, top loop tab, stainless-steel rim, TYESO logo placement, printed text, colors and materials.',
  'Do not redesign, simplify, relabel, recolor or alter any part of the product.',
  'Improve only the scene around it with refined professional retail lighting, clean realistic shadows and a minimal high-end composition.',
  'Use a clean white or very light neutral studio environment with restrained stone or glass styling only.',
  'No beige palette, no warm AI-style gradient, no leaves, no hearts, no fake luxury, no excessive glow, no clutter and no added promotional text.',
  'The product must remain the central hero object, fully visible, sharp, photorealistic and commercially usable.',
].join(' ');

const body = {
  model: MODEL,
  input: [
    { type: 'text', text: prompt },
    {
      type: 'image',
      mime_type: sourceMime,
      data: sourceBytes.toString('base64'),
    },
  ],
  response_format: {
    type: 'image',
    mime_type: 'image/png',
    aspect_ratio: '1:1',
    image_size: '1K',
    delivery: 'inline',
  },
  generation_config: {
    thinking_level: 'minimal',
  },
};

const startedAt = Date.now();
const response = await fetchWithTimeout(ENDPOINT, {
  method: 'POST',
  redirect: 'error',
  headers: {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  },
  body: JSON.stringify(body),
}, Number(process.env.GEMINI_IMAGE_TIMEOUT_MS || 300000));

const raw = await response.text();
let payload;
try {
  payload = raw ? JSON.parse(raw) : {};
} catch {
  throw new Error(`Gemini returned non-JSON response: HTTP_${response.status}`);
}

if (!response.ok) {
  const providerMessage = payload?.error?.message || payload?.message || `HTTP_${response.status}`;
  const code = payload?.error?.status || payload?.error?.code || 'GEMINI_REQUEST_FAILED';
  throw new Error(`Gemini image request failed [${code}]: ${providerMessage}`);
}

const image = findImage(payload);
if (!image?.data) {
  throw new Error('Gemini response did not contain an image');
}

if (MAX_OUTPUTS !== 1) throw new Error('benchmark output limit violated');

const outputBytes = Buffer.from(image.data, 'base64');
const outputMime = image.mime_type || 'image/png';
const sha256 = createHash('sha256').update(outputBytes).digest('hex');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.join(os.tmpdir(), 'nordla-gemini-image-benchmark', stamp);
const outputDirectory = path.join(root, 'outputs');
await mkdir(outputDirectory, { recursive: true });

const extension = outputMime.includes('jpeg') || outputMime.includes('jpg') ? '.jpg' : '.png';
const outputPath = path.join(outputDirectory, `nano-banana-2.1-${sha256.slice(0,16)}${extension}`);
await writeFile(outputPath, outputBytes, { mode: 0o600 });

const summary = {
  status: 'SUCCEEDED',
  provider: 'google-gemini-api',
  model: MODEL,
  interaction_id: payload?.id ?? null,
  source_url: sourceUrl,
  output: {
    ref: `file://${outputPath}`,
    sha256,
    bytes: outputBytes.length,
    content_type: outputMime,
    kind: 'image',
  },
  benchmark: {
    aspect_ratio: '1:1',
    image_size: '1K',
    outputs: 1,
    prompt_version: 'habb-tyeso-flair2-v1',
  },
  cost_usd_estimate: OUTPUT_PRICE_USD_1K,
  elapsed_ms: Date.now() - startedAt,
  output_directory: outputDirectory,
};

await writeFile(
  path.join(root, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
