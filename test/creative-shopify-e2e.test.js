// The customer workflow end to end through the INTEGRATION HUB (CREATIVE.produce_product_visual), with REAL Python engines, the REAL critic port
// and the REAL scene engine, and SIMULATED providers (fetch double): no network, no credential, no cost. A clearly labelled TEST product is used
// (the TYESO photo stays blocked). Simulated success is NOT production readiness: no real image model, Shopify call or visual judgement runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
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
  const photoSha = execFileSync(PY, ['-c', 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())', join(w, 'gourde.jpg')]).toString().trim();
  return { out, calls, photoSha };
}
const providerCalls = (calls) => calls.filter((c) => c.path === '/compatible-mode/v1/chat/completions' || c.path === '/api/v1/services/aigc/multimodal-generation/generation');

test('E2E hub: customer picks a variant -> verified photo -> accepted policy -> reserved ceiling -> bound providers -> concept, scene, real pixels kept, checks -> result for the customer; nothing published', SLOW, () => {
  const { out, calls, photoSha } = run('ok');
  assert.equal(out.hub.ok, true, JSON.stringify(out.hub)); assert.equal(out.hub.status, 'REVIEW_REQUIRED', 'the customer reviews the finished result');
  const r = out.result;
  assert.equal(r.status, 'PROPOSALS_READY_FOR_OWNER'); assert.equal(r.published, false); assert.equal(r.customer_review, 'PENDING'); assert.equal(r.live_provider, false);
  assert.equal(r.media_id, 'gid://shopify/MediaImage/991', 'the 500 ml black image linked to the variant, never the 350 ml or the white one'); assert.equal(r.source_sha256, photoSha);
  assert.ok(r.results.length >= 1 && r.results.every((x) => x.technical === 'PASS'));
  // the audit trail is made of execution evidence: SENT only with the provider's request id, for the SAME source SHA
  const byOp = (op) => out.events.filter((e) => e.op === op).map((e) => e.event);
  assert.deepEqual(byOp('IMAGE_EDIT'), ['AUTHORIZED', 'RESERVED', 'ATTEMPTED', 'SENT', 'SUCCEEDED']);
  assert.deepEqual(byOp('VISION_CRITIQUE'), ['AUTHORIZED', 'RESERVED', 'ATTEMPTED', 'SENT', 'SUCCEEDED']);
  assert.ok(out.events.filter((e) => e.event === 'SENT').every((e) => e.req && e.sha === photoSha));
  assert.equal(out.reservations.length, 1); assert.equal(out.reservations[0].status, 'SETTLED'); assert.ok(out.reservations[0].settled_eur <= 0.5);
  // the simulated providers really ran: one image edit (3 variants) in the GLOBAL image workspace, text and critique in the EU one
  const edits = calls.filter((c) => c.path === '/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(edits.length, 1); assert.equal(edits[0].host, 'ws-test-image-global.eu-central-1.maas.aliyuncs.com'); assert.equal(edits[0].n, 3);
  assert.equal(out.facts.price, '19,90 €');
  assert.ok(!JSON.stringify(out).match(/confirm(er)? la photo|which photograph|choisir la photo/i));
});

test('E2E hub: a variant only linked to a 350 ml image is refused before any reservation, download for generation or provider call; no question is asked', SLOW, () => {
  const { out, calls } = run('wrong-variant');
  assert.equal(out.hub.ok, false); assert.match(out.hub.reason, /NO_VERIFIED_SOURCE_IMAGE/);
  assert.equal(providerCalls(calls).length, 0); assert.equal(out.events.length, 0); assert.equal(out.reservations.length, 0);
});

test('E2E hub: a revoked tenant policy blocks every transmission (no reservation, no provider call)', SLOW, () => {
  const { out, calls } = run('revoked');
  assert.equal(out.hub.ok, false); assert.match(out.hub.reason, /PROCESSING_NOT_AUTHORIZED.*NO_ACCEPTED_POLICY/);
  assert.equal(providerCalls(calls).length, 0); assert.equal(out.reservations.length, 0);
});

test('E2E hub: live (non-simulated) providers are refused under NDR-D02', SLOW, () => {
  const { out, calls } = run('live-provider');
  assert.equal(out.hub.ok, false); assert.equal(out.hub.code, 'PROVIDER_CALL_REFUSED'); assert.match(out.hub.reason, /NDR-D02/);
  assert.equal(calls.length, 0);
});

test('E2E hub: the price shown is the one read now from Shopify, not a stale snapshot', SLOW, () => {
  const { out } = run('stale-price');
  assert.equal(out.hub.ok, true, JSON.stringify(out.hub)); assert.equal(out.facts.price, '17,90 €');
});
