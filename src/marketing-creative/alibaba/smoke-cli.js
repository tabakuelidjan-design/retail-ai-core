import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadAlibabaCreativeConfig } from './config.js';
import { runAlibabaCreativeSmoke } from './smoke.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.join(
  os.tmpdir(),
  'nordla-alibaba-smoke',
  stamp,
);
const journalPath = path.join(root, 'provider-calls.jsonl');
const outputDirectory = path.join(root, 'outputs');

const allowedHosts = required('ALIBABA_SMOKE_ALLOWED_HOSTS')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const config = loadAlibabaCreativeConfig(process.env);
const publicProductUrl = required('ALIBABA_SMOKE_PUBLIC_PRODUCT_URL');

await mkdir(root, { recursive: true });

const result = await runAlibabaCreativeSmoke({
  config,
  publicProductUrl,
  allowedHosts,
  outputDirectory,
  journalPath,
});

const summary = {
  status: result.status,
  text: result.text,
  image: result.image,
  video: result.video,
  budget: result.budget,
  journal_path: journalPath,
  output_directory: outputDirectory,
};

await writeFile(
  path.join(root, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(
  `${JSON.stringify(summary, null, 2)}\n`,
);
