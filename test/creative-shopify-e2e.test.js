// The customer workflow end to end through the production entrypoint, with REAL Python engines, the REAL critic port and the REAL scene engine,
// and SIMULATED providers (fetch double): no network, no credential, no cost. Mocked success is NOT production readiness: no real image model,
// no real Shopify call and no real visual judgement happen here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonReady = (() => { try { execFileSync(PY, ['-c', 'import numpy, PIL, scipy'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const SLOW = { skip: !pythonReady && `the local engines need Python with numpy, Pillow and scipy (NORDLA_PYTHON=${PY})`, timeout: 900_000 };
function run(scenario) {
  const w = mkdtempSync(join(tmpdir(), `shopify-e2e-${scenario}-`));
  execFileSync(PY, [join(ROOT, 'test/helpers/scene_fixtures.py'), 'photo', join(w, 'gourde.jpg')]);
  const env = { ...process.env, ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-double-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-text-eu',
    ALIBABA_MODEL_STUDIO_IMAGE_API_KEY: 'sk-test-image-0000000000', ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID: 'ws-test-image-global',
    NORDLA_FETCH_DOUBLE_LOG: join(w, 'fetch.log'), NORDLA_SCENE_DOUBLE_DIR: w, NORDLA_PYTHON: PY };
  delete env.NODE_OPTIONS; delete env.NORDLA_MEDIA_AUTHORIZATION_FILE; delete env.NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE;
  const p = spawnSync(process.execPath, ['--import', new URL('./fixtures/creative-autonomy/scene-fetch-double-preload.mjs', import.meta.url).href,
    join(ROOT, 'test/fixtures/creative-autonomy/shopify-e2e-run.mjs'), w, join(w, 'gourde.jpg'), scenario], { env, cwd: ROOT, timeout: 850_000 });
  assert.equal(p.status, 0, p.stderr.toString().slice(-800));
  const out = JSON.parse(p.stdout.toString().trim().split('\n').pop());
  const calls = existsSync(join(w, 'fetch.log')) ? readFileSync(join(w, 'fetch.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const transmissions = existsSync(join(w, 'transmissions.jsonl')) ? readFileSync(join(w, 'transmissions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { w, out, calls, transmissions, photoSha: (execFileSync(PY, ['-c', 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())', join(w, 'gourde.jpg')]).toString().trim()) };
}

test('E2E: customer picks the product -> exact variant -> verified photo -> policy -> bound providers -> scene -> real pixels kept -> checks -> result for the customer, nothing published', SLOW, () => {
  const { out, calls, transmissions, photoSha } = run('ok');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, 'PROPOSALS_READY_FOR_OWNER'); assert.equal(out.published, false);
  // the right photo, chosen through the variant link, never the 20 oz decoy nor the pink one
  assert.equal(out.media_selection.media_id, 'gid://shopify/MediaImage/1'); assert.equal(out.media_selection.sha256, photoSha);
  // both transmissions authorised by the standing policy for THESE bytes, and journaled
  assert.deepEqual(transmissions.map((t) => [t.operation, t.source_sha256]), [['VISION_CRITIQUE', photoSha], ['IMAGE_EDIT', photoSha]]);
  // the providers really ran on the simulated endpoints: one image edit (3 variants) in the GLOBAL image workspace, one EU visual critique
  const edits = calls.filter((c) => c.path === '/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(edits.length, 1); assert.equal(edits[0].host, 'ws-test-image-global.eu-central-1.maas.aliyuncs.com'); assert.equal(edits[0].n, 3);
  assert.ok(calls.filter((c) => c.path === '/compatible-mode/v1/chat/completions').every((c) => c.host === 'ws-test-text-eu.eu-central-1.maas.aliyuncs.com'));
  // real product pixels restored and checked; only a technically passing image reaches the customer
  assert.ok(out.proposals.length >= 1);
  for (const p of out.proposals.filter((x) => x.image)) { assert.equal(p.technical, 'PASS'); assert.equal(p.fidelity, true); assert.ok(p.max_visible <= 2); }
  // the customer only judges the finished result: no source-photo prompt, ever
  assert.ok(out.human_interventions.every((h) => h.when !== 'avant le passage' || !h.creative));
  assert.ok(!JSON.stringify(out.human_interventions).match(/photo|image source|confirm/i));
  assert.equal(out.facts.price, '29,90 €');
});

test('E2E: when the variant is only linked to the 20 oz image, nothing is downloaded for generation, no provider is called and no question is asked', SLOW, () => {
  const { out, calls, transmissions } = run('wrong-variant');
  assert.equal(out.ok, false); assert.equal(out.code, 'NO_VERIFIED_SOURCE_IMAGE');
  assert.equal(calls.length, 0); assert.equal(transmissions.length, 0);
});

test('E2E: the price shown is the one read now from Shopify, not a stale snapshot', SLOW, () => {
  const { out } = run('stale-price');
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.facts.price, '24,90 €');
});
