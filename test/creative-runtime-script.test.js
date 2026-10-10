import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The autonomous-run script (`// RS-N` markers): it refuses without credentials, sends nothing in --check, and makes no creative decision itself.

const root = new URL('../', import.meta.url);
const script = fileURLToPath(new URL('scripts/run-c2-habb-creative.mjs', root));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ALIBABA_|^DASHSCOPE|^NORDLA_PRIVATE_DIR$/.test(k)));
const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

test('No credentials or a malformed key: both modes stop, name the problem and never take the lock', async () => {
  // RS-1 no credentials: a stable BLOCKED status, the missing variable names only
  for (const flag of ['--check', '--live']) {
    const out = run([flag]);
    assert.equal(out.status, 3, flag);
    const report = JSON.parse(out.stdout);
    assert.equal(report.status, 'BLOCKED: CREDENTIALS_NOT_PROVISIONED');
    assert.deepEqual(report.checks[0].detail.missing_environment_variables, ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID']);
  }
  assert.equal(run([]).status, 64);
  // RS-2 a malformed key (command text, spaces, line breaks) is refused before the lock, without being printed
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nordla-c2c-badkey-'));
  try {
    for (const flag of ['--check', '--live']) {
      const out = run([flag], { ALIBABA_MODEL_STUDIO_API_KEY: '$env:K = (Get-Clipboard).Trim()\nClear-Clipboard', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test', NORDLA_PRIVATE_DIR: dir });
      assert.equal(out.status, 3, flag);
      assert.equal(JSON.parse(out.stdout).status, 'BLOCKED: API_KEY_FORMAT_INVALID');
      assert.doesNotMatch(out.stdout, /Get-Clipboard|Clear-Clipboard/);
    }
    assert.equal((await readdir(dir)).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--check with dummy credentials sends nothing and takes no lock: READY (real asset present) or BLOCKED (absent)', async () => {
  // RS-3 only local steps run (the brief, the fonts, a local segmentation dry-run); no network, no lock, no private output
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nordla-c2c-check-'));
  try {
    const out = run(['--check'], { ALIBABA_MODEL_STUDIO_API_KEY: 'dummy-credential-0123456789', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test', NORDLA_PRIVATE_DIR: dir });
    const report = JSON.parse(out.stdout);
    assert.match(report.status, /^(READY_FOR_ONE_AUTONOMOUS_RUN \(nothing was sent\)|BLOCKED: ASSET_PAYLOAD_UNAVAILABLE)$/);
    assert.equal(existsSync(path.join(dir, 'creative-run-001', 'live-run-001.lock')), false);
    assert.equal((await readdir(dir)).length, 0);
    assert.doesNotMatch(out.stdout, /dummy-credential/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('The script maps configuration only: no composition, no prompt, no colour, no font size, no secret', async () => {
  const source = await readFile(new URL('scripts/run-c2-habb-creative.mjs', root), 'utf8');
  const brief = await readFile(new URL('benchmarks/creative-intelligence/habb-c2-brief.json', root), 'utf8');
  // RS-4 no hand-authored creative content in the script: no layout recipe, no scene or prompt wording, no hex colour, no pixel size, no URL, no key
  assert.doesNotMatch(source, /PRODUCT_HERO|PRODUCT_DOMINANT|EDITORIAL_SPLIT|TEXT_LED|studio|seamless|gradient|prompt|#[0-9a-fA-F]{6}\b|font_size|https?:\/\/|sk-[A-Za-z0-9]{8,}|fetch\(/);
  // RS-5 the Brief is data: approved text, claim roles and public facts, with no composition at all
  const data = JSON.parse(brief);
  assert.deepEqual(Object.keys(data).sort(), ['approved_copy', 'benchmark_id', 'brief_ref', 'claim_roles', 'data_class', 'kind', 'note', 'public_facts', 'purpose']);
  assert.deepEqual(Object.keys(data.approved_copy[0]).sort(), ['approval_ref', 'content', 'note', 'ref', 'role']);
  assert.deepEqual(Object.keys(data.claim_roles.price).sort(), ['text_role', 'why']);
  assert.deepEqual(Object.keys(data.public_facts).sort(), ['deliverable', 'language', 'merchant', 'product']);
  assert.equal(data.data_class, 'PUBLIC');
  // RS-6 the script takes its lock through the helper before any provider call, and two calls are all it can make
  assert.ok(source.indexOf('takeLiveCallLock(path.join(privateDir') > 0 && source.indexOf('takeLiveCallLock(path.join(privateDir') < source.indexOf('runProductPreservingCreative({'));
  assert.match(source, /maxSpendEur: 0\.3, maxImages: 1/);
});
