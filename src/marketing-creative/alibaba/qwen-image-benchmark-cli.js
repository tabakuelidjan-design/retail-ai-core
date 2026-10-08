import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SpendGuard } from './budget.js';
import { loadAlibabaCreativeConfig } from './config.js';
import { JsonlCallJournal } from './journal.js';
import { FileOutputStore } from './output-store.js';
import { generateMarketingImage } from './qwen-image.js';
import { assertAllowedSmokeAssetUrl } from './smoke.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.join(os.tmpdir(), 'nordla-qwen-image-benchmark', stamp);
const outputDirectory = path.join(root, 'outputs');
const journalPath = path.join(root, 'provider-calls.jsonl');

const config = loadAlibabaCreativeConfig(process.env);
const allowedHosts = required('ALIBABA_SMOKE_ALLOWED_HOSTS')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const sourceUrl = assertAllowedSmokeAssetUrl(
  required('ALIBABA_SMOKE_PUBLIC_PRODUCT_URL'),
  allowedHosts,
);

await mkdir(root, { recursive: true });

const budget = new SpendGuard({
  maxSpendEur: 0.15,
  maxImages: 1,
  maxVideoSeconds: 0,
});

const journal = new JsonlCallJournal(journalPath);
const outputStore = new FileOutputStore(outputDirectory);

const prompt = [
  'Create one premium commercial advertising image for HABB using the referenced real TYESO FLAIR 2.0 product photo.',
  'Preserve the real product exactly: same silhouette, proportions, lid system, top loop tab, stainless-steel rim, TYESO logo placement, printed text, colors and materials.',
  'Do not redesign, simplify, relabel, recolor or alter any part of the product.',
  'Improve only the scene around it with refined professional retail lighting, clean realistic shadows and a minimal high-end composition.',
  'Use a clean white or very light neutral studio environment with restrained stone or glass styling only.',
  'No beige palette, no warm AI-style gradient, no leaves, no hearts, no fake luxury, no excessive glow, no clutter and no added promotional text.',
  'The product must remain the central hero object, fully visible, sharp, photorealistic and commercially usable.',
].join(' ');

const result = await generateMarketingImage({
  config,
  prompt,
  referenceImages: [sourceUrl],
  dataPolicy: {
    classification: 'PUBLIC',
    contains_personal_data: false,
    contains_face: false,
    reason: 'Nordla HABB Qwen image benchmark — public product only',
  },
  budget,
  journal,
  outputStore,
  size: '1024x1024',
  n: 1,
  watermark: false,
});

const summary = {
  status: 'SUCCEEDED',
  provider: 'alibaba-model-studio',
  model: result.model,
  request_id: result.requestId,
  source_url: sourceUrl,
  output: result.outputs[0],
  cost_eur: result.costEur,
  budget: budget.snapshot(),
  output_directory: outputDirectory,
  journal_path: journalPath,
};

await writeFile(
  path.join(root, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
