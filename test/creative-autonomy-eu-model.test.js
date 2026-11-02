// qwen3-vl-plus in the Alibaba lane: (1) non-regression of the allow-list change, (2) proof, on the wire, that the WHOLE autonomous route (Brain stages,
// STAGE, critic) sends exactly this model, to the Frankfurt workspace host, with only the API features documented for it. Network: a recording fetch DOUBLE;
// nothing leaves this machine, nothing is billed. The answers are generic test content (the creative-brain test world), never proposals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadAlibabaCreativeConfig, alibabaCreativeEndpoints } from '../src/marketing-creative/alibaba/config.js';
import { ALIBABA_PRICE_USD } from '../src/marketing-creative/alibaba/budget.js';
import { runAutonomous, RUN_STATUS } from '../src/creative-autonomy/run.js';
import { connectProviders, VISION_PURPOSE } from '../src/creative-autonomy/providers.js';
import { HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';
import { normalizeConceptSet as ncs } from '../src/creative-brain/concept.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------------- (1) non-regression of the allow-list
test('allow-list: the default text model is unchanged (qwen3.8-max)', () => {
  assert.equal(loadAlibabaCreativeConfig({}).textModel, 'qwen3.8-max');
});
test('allow-list: qwen3-vl-plus is now accepted, and only it was added', () => {
  assert.equal(loadAlibabaCreativeConfig({ ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus' }).textModel, 'qwen3-vl-plus');
  for (const other of ['qwen3.7-plus', 'qwen-plus', 'qwen3-vl-flash', 'qwen3.8-flash', 'qwen3-vl-plus-latest', 'QWEN3-VL-PLUS']) {
    assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_QWEN_TEXT_MODEL: other }), /Unsupported Alibaba text model/, other);
  }
});
test('allow-list: image, video, region and the SpendGuard price table are untouched', () => {
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_QWEN_IMAGE_MODEL: 'qwen3-vl-plus' }), /Unsupported Alibaba image model/);
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_WAN_VIDEO_MODEL: 'qwen3-vl-plus' }), /Unsupported Alibaba video model/);
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_REGION: 'ap-southeast-1' }), /Unsupported Alibaba Model Studio region/);
  assert.equal(ALIBABA_PRICE_USD.text_input_per_million, 1.65);
  assert.equal(ALIBABA_PRICE_USD.text_output_per_million, 4.951);
});

// ---------------- (2) on the wire
const ENV = { ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-0123456789abcdef', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-eu-0001', ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus', NORDLA_ALIBABA_SCOPE: 'EU' };
const DIMS = ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR'];

function recordingFetch() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const userContent = body.messages[1].content;
    const isVision = Array.isArray(userContent);
    const stage = isVision ? 'CRITIC' : system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : system.includes('set designer') ? 'STAGE' : '?';
    requests.push({ url, stage, body, auth: init.headers.Authorization });
    let answer;
    if (stage === 'FRAME') answer = frameAnswer();
    else if (stage === 'IDEATE') answer = { concepts: CONCEPTS };
    else if (stage === 'SELECT') answer = evaluationsAnswer(ncs(CONCEPTS), []);
    else if (stage === 'ART_DIRECT') { const c = JSON.parse(userContent).concept; answer = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }); }
    else if (stage === 'STAGE') { const c = JSON.parse(userContent).concept; answer = { backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'wire test' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Titre de test', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'wire test' }; }
    else answer = { dimensions: DIMS.map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'The image carries this dimension clearly enough for a first look.' })) };
    const text = JSON.stringify(answer);
    return new Response(JSON.stringify({ id: `req-${requests.length}`, model: body.model, choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}

function fakeEngines() {
  return {
    name: { render: 'fake render', compose: 'fake compose' },
    examine: async () => ({ status: 'CUT_OUT' }),
    render: async ({ outPath }) => { writeFileSync(outPath, 'x'); return { resolution: [10, 10], foreground_props: 0 }; },
    compose: async ({ outPath, stagePath }) => { writeFileSync(outPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(stagePath)])); return { fidelity: { max_level_difference_after_removing_layers: 1, checked_pixels: 5000, minimum_checked_pixels: 100, scene_mode: false }, technical: { defects: [], text_contrast_ratio: 12, product_height_share: 0.5 }, text_used: { facts_lines: ['x'] } }; },
  };
}

test('on the wire: Brain, STAGE and critic all call qwen3-vl-plus on the Frankfurt workspace, thinking off, JSON mode, base64 PNG only for the critic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eu-'));
  const photo = Buffer.from('bottle-photo-bytes-for-the-wire-test');
  const photoPath = join(dir, 'gourde.jpg'); writeFileSync(photoPath, photo);
  const authPath = join(dir, 'media-authorization.json');
  writeFileSync(authPath, JSON.stringify({
    kind: 'EXTERNAL_MEDIA_AUTHORIZATION', authorization_id: 'authz://test', purpose_note: 'wire test',
    asset: { asset_ref: 'asset://test/gourde', asset_sha256: sha(photo), data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false },
    provider: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' }, purpose: VISION_PURPOSE, allowed_operations: ['VISION_CRITIQUE'],
    transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
    retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
    authorization: { revoked: false }, state: {}, global_policy: { changed_by_this_record: false },
  }));
  const { fetchImpl, requests } = recordingFetch();
  const journal = { rows: [], append: async (e) => { journal.rows.push(e); } };
  const ports = connectProviders({ env: { ...ENV, NORDLA_MEDIA_AUTHORIZATION_FILE: authPath }, trialAuthorized: true, sourcePhotoBytes: photo, fetchImpl, journal });
  assert.deepEqual(ports.missing, []);
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  const r = await runAutonomous({
    input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'objectif de test', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath, photoMeta: { media_type: 'image/jpeg', width_px: 1, height_px: 1, origin: 'MERCHANT_UPLOAD', rights_class: 'UNKNOWN' } },
    ports, engines: fakeEngines(), workdir: join(dir, 'run'),
  });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error ?? r.trace.at(-1)));

  const expectedUrl = alibabaCreativeEndpoints(loadAlibabaCreativeConfig(ENV)).chatCompletions;
  assert.equal(expectedUrl, 'https://ws-test-eu-0001.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  const stages = requests.map((q) => q.stage);
  assert.deepEqual([...new Set(stages)].sort(), ['ART_DIRECT', 'CRITIC', 'FRAME', 'IDEATE', 'SELECT', 'STAGE']);
  for (const q of requests) {
    assert.equal(q.url, expectedUrl, 'only the Frankfurt workspace host');
    assert.equal(q.body.model, 'qwen3-vl-plus', `${q.stage} uses the chosen model`);
    assert.equal(q.body.enable_thinking, false, `${q.stage}: thinking off`);
    assert.ok(q.body.max_tokens <= 4000);
    assert.equal(q.body.stream, undefined, 'no streaming');
    assert.equal(q.body.tools, undefined, 'no tool calling');
    const allowed = q.stage === 'CRITIC' ? ['model', 'messages', 'temperature', 'max_tokens', 'enable_thinking'] : ['model', 'messages', 'temperature', 'max_tokens', 'enable_thinking', 'response_format'];
    assert.deepEqual(Object.keys(q.body).filter((k) => !allowed.includes(k)), [], `${q.stage}: only documented parameters`);
    if (q.stage === 'CRITIC') {
      const images = q.body.messages[1].content.filter((p) => p.type === 'image_url');
      assert.equal(images.length, 1);
      assert.match(images[0].image_url.url, /^data:image\/png;base64,/, 'the render goes inline, never by public URL');
    } else {
      assert.equal(typeof q.body.messages[1].content, 'string', `${q.stage}: text only, no image`);
      assert.deepEqual(q.body.response_format, { type: 'json_object' });
      assert.ok(!JSON.stringify(q.body).includes(photo.toString('base64')), 'the product photo never travels with a text stage');
    }
  }
  assert.equal(stages.filter((s) => s === 'CRITIC').length, 3);
  // the key travels only in the Authorization header, and never in the journal
  assert.ok(requests.every((q) => q.auth === `Bearer ${ENV.ALIBABA_MODEL_STUDIO_API_KEY}`));
  assert.ok(!JSON.stringify(journal.rows).includes(ENV.ALIBABA_MODEL_STUDIO_API_KEY));
  assert.ok(journal.rows.some((e) => e.model === 'qwen3-vl-plus'));
});

test('on the wire: without the media record the critic sends nothing (no image leaves the machine)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eu-'));
  const photoPath = join(dir, 'gourde.jpg'); writeFileSync(photoPath, 'bytes');
  const { fetchImpl, requests } = recordingFetch();
  const ports = connectProviders({ env: ENV, trialAuthorized: true, sourcePhotoBytes: readFileSync(photoPath), fetchImpl });
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  const r = await runAutonomous({ input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'x', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath, photoMeta: { media_type: 'image/jpeg', width_px: 1, height_px: 1, origin: 'MERCHANT_UPLOAD', rights_class: 'UNKNOWN' } }, ports, engines: fakeEngines(), workdir: join(dir, 'run') });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER);
  assert.equal(requests.filter((q) => q.stage === 'CRITIC').length, 0);
  assert.ok(requests.every((q) => !JSON.stringify(q.body).includes('image_url')));
  assert.ok(r.proposals.every((p) => p.creative_quality.state === 'NOT_MEASURED'));
});

test('ideation only, on the wire: 9 text calls (FRAME, IDEATE, SELECT, 3 ART_DIRECT, 3 STAGE), no image anywhere, no engine, every Brain request and raw answer kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eu-id-'));
  const { fetchImpl, requests } = recordingFetch();
  const ports = { ...connectProviders({ env: ENV, trialAuthorized: true, fetchImpl }), visionFor: null };
  const engines = { examine: async () => { throw new Error('no examination in ideation'); }, render: async () => { throw new Error('no render in ideation'); }, compose: async () => { throw new Error('no compose in ideation'); } };
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  const r = await runAutonomous({ mode: 'IDEATION_ONLY', input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'x', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports, engines, workdir: join(dir, 'run') });
  assert.equal(r.status, RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL, JSON.stringify(r.error ?? null));
  assert.deepEqual(requests.map((q) => q.stage), ['FRAME', 'IDEATE', 'SELECT', 'ART_DIRECT', 'STAGE', 'ART_DIRECT', 'STAGE', 'ART_DIRECT', 'STAGE']);
  assert.ok(requests.every((q) => q.body.model === 'qwen3-vl-plus' && !JSON.stringify(q.body).includes('image_url')));
  assert.ok(r.proposals.every((p) => p.status === 'IDEATION_ONLY_NOT_A_VISUAL' && p.image === null && Array.isArray(p.grammar_gap.wanted_but_not_available)));
  assert.ok(!r.trace.some((t) => ['EXAMINE', 'RENDER', 'COMPOSE+CHECK', 'CRITIC'].includes(t.step)));
  const files = (await import('node:fs')).readdirSync(r.brain_calls_dir);
  assert.equal(files.filter((f) => f.endsWith('.request.json')).length, 9);
  assert.equal(files.filter((f) => f.endsWith('.response.txt')).length, 9);
  assert.ok(r.selection.evaluations.length === 3, 'Nordla judged its own three concepts');
  assert.ok(files.some((f) => f.startsWith('01-FRAME')) && files.some((f) => /^0[4-9]-STAGE-cnc_/.test(f)));
});

test('stage contract: the model may report what the vocabulary could not express (optional, bounded, not rendered)', async () => {
  const { normalizeStage } = await import('../src/creative-autonomy/stage-contract.js');
  const { normalizeConceptSet } = await import('../src/creative-brain/concept.js');
  const [concept] = normalizeConceptSet(CONCEPTS);
  const base = { backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 't' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [], headline: 'Titre', text_placement: 'RIGHT_COLUMN', show_price: 'NO', rationale: 't' };
  assert.ok(normalizeStage(base, { concept, personalisation_offered: false }));
  const s = normalizeStage({ ...base, wanted_but_not_available: ['wet stone surface with water droplets', 'morning fog'] }, { concept, personalisation_offered: false });
  assert.equal(s.wanted_but_not_available.length, 2);
  assert.throws(() => normalizeStage({ ...base, wanted_but_not_available: ['a', 'b', 'c', 'd', 'e', 'f'] }, { concept, personalisation_offered: false }));
});

test('plan id: changing only the objective changes the plan id (what Nordla is asked is authorised too)', async () => {
  const { trialPlanId, TRIAL_LIMITS } = await import('../src/creative-autonomy/trial.js');
  const base = { ...TRIAL_LIMITS, brief: { objective: 'A' } };
  assert.notEqual(trialPlanId({ model: 'qwen3-vl-plus', scope: 'EU', limits: base }), trialPlanId({ model: 'qwen3-vl-plus', scope: 'EU', limits: { ...base, brief: { objective: 'B' } } }));
});

test('report: built from the trace only, five sections, no visual claim for an ideation run', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'eu-rep-'));
  const { fetchImpl } = recordingFetch();
  const ports = { ...connectProviders({ env: ENV, trialAuthorized: true, fetchImpl }), visionFor: null };
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  await runAutonomous({ mode: 'IDEATION_ONLY', input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'x', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports, engines: {}, workdir: join(dir, 'gourde-noire') });
  const { fileURLToPath } = await import('node:url');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/creative-autonomy-report.mjs', import.meta.url)), dir, 'gourde-noire', 'none']).toString().trim();
  const md = readFileSync(out, 'utf8');
  for (const h of ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.']) assert.ok(md.includes(h), h);
  assert.match(md, /IDÉATION SEULE/);
  assert.match(md, /images envoyées : 0/);
  assert.ok(md.includes(CONCEPTS[0].central_idea), 'the concept is quoted as the model wrote it');
});

test('plan id: the SHA-256 of the full Shopify snapshot is bound; a change of price or of description invalidates the old id', async () => {
  const { trialPlanId, TRIAL_LIMITS, briefBinding } = await import('../src/creative-autonomy/trial.js');
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  const idFor = (s) => trialPlanId({ model: 'qwen3-vl-plus', scope: 'EU', limits: { ...TRIAL_LIMITS, brief: briefBinding({ snapshot: s, variant: 'Noir', objective: 'O', format: 'INSTAGRAM_FEED_4_5', brand: HABB_BRAND }) } });
  const original = idFor(snap);
  assert.equal(idFor(structuredClone(snap)), original, 'same content, same id');
  // key order does not matter, content does
  const reordered = { read_at: snap.read_at, product: Object.fromEntries(Object.entries(snap.product).reverse()) };
  assert.equal(idFor(reordered), original);
  const pricier = structuredClone(snap); pricier.product.variants.nodes.find((v) => v.title === 'Noir').price = '31.90';
  assert.notEqual(idFor(pricier), original, 'a price change invalidates the plan');
  const otherPrice = structuredClone(snap); otherPrice.product.variants.nodes.find((v) => v.title === 'Rose').price = '27.90';
  assert.notEqual(idFor(otherPrice), original, 'any variant of the snapshot counts');
  const reworded = structuredClone(snap); reworded.product.description = `${snap.product.description} `;
  assert.notEqual(idFor(reworded), original, 'a description change, even one space, invalidates the plan');
  const restocked = structuredClone(snap); restocked.product.variants.nodes[0].inventoryQuantity += 1;
  assert.notEqual(idFor(restocked), original);
});

// ---- the provider's model-list confirmation (false negative of 2026-11-01: the list is paginated, the model was not on page 1)
test('model list: the owner\'s real Alibaba answer is accepted; other answers are not', async () => {
  const { providerConfirmsModel, modelListUrl } = await import('../src/creative-autonomy/trial.js');
  const owner = { success: true, output: { total: 1, models: [{ model: 'qwen3-vl-plus' }] }, request_id: '6864af00-406c-95e9-997e-79cf755985ac' };
  assert.deepEqual(providerConfirmsModel(owner, 'qwen3-vl-plus'), { confirmed: true, request_id: '6864af00-406c-95e9-997e-79cf755985ac', total: 1, success: true });
  assert.equal(providerConfirmsModel({ ...owner, success: false }, 'qwen3-vl-plus').confirmed, false);
  assert.equal(providerConfirmsModel({ ...owner, success: 'true' }, 'qwen3-vl-plus').confirmed, false);
  assert.equal(providerConfirmsModel({ success: true, output: { total: 168, models: [{ model: 'qwen3.8-max' }] } }, 'qwen3-vl-plus').confirmed, false, 'a page without the model');
  assert.equal(providerConfirmsModel({ success: true, output: { total: 1, models: [{ model: 'QWEN3-VL-PLUS' }] } }, 'qwen3-vl-plus').confirmed, false, 'exact id only');
  assert.equal(providerConfirmsModel({ success: true, output: { models: [{ name: 'qwen3-vl-plus' }] } }, 'qwen3-vl-plus').confirmed, false, 'the display name is not the id');
  assert.equal(providerConfirmsModel(null, 'qwen3-vl-plus').confirmed, false);
  assert.equal(modelListUrl('ws-1', 'qwen3-vl-plus'), 'https://ws-1.eu-central-1.maas.aliyuncs.com/api/v1/models?model=qwen3-vl-plus');
});

test('trial --execute end to end against a fetch double: the owner\'s answer passes, 9 calls, report written; a refusal does not consume the attempt', { timeout: 120_000 }, async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/creative-autonomy-trial.mjs', import.meta.url));
  // --import takes a module SPECIFIER, not a path: a bare Windows path "C:\\..." is read as a URL of scheme "c:" (ERR_UNSUPPORTED_ESM_URL_SCHEME, exit 1,
  // before the script even starts). A file: URL is valid on every platform.
  const preload = new URL('./fixtures/creative-autonomy/fetch-double-preload.mjs', import.meta.url).href;
  const out = mkdtempSync(join(tmpdir(), 'trial-e2e-'));
  const log = join(out, 'fetch.log');
  // the attempt registry of THIS test (never the real ~/.nordla registry of the machine running the tests)
  const registry = join(out, 'attempt-registry');
  const base = { ...process.env, ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-double-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-double', NORDLA_FETCH_DOUBLE_LOG: log, NORDLA_ATTEMPT_REGISTRY: registry };
  // the plan the test may run is computed WITH the same preload and the same registry: both are part of the plan
  const planOf = (args, env) => JSON.parse(execFileSync(process.execPath, [...args, script, '--plan', '--ideation', '--out', join(out, `p-${Math.random()}`), '--product', 'gourde-noire'], { env }).toString()).plan_id;
  const planId = planOf(['--import', preload], base);
  assert.equal(planOf(['--import', preload], base), planId, 'same inputs, same code, same plan');
  // the REAL plan (no preload, default registry) is a different id: a test, or anything injected with --import, can never use the owner's authorisation
  const realEnv = { ...base }; delete realEnv.NORDLA_ATTEMPT_REGISTRY;
  const realPlan = planOf([], realEnv);
  assert.notEqual(planOf([], base), realPlan, 'overriding the attempt registry changes the plan');
  assert.notEqual(planId, planOf([], base), 'a runtime preload changes the plan');
  const run = (dir, mode, auth = planId) => spawnSync(process.execPath, ['--import', preload, script, '--execute', '--ideation', '--out', dir, '--product', 'gourde-noire'], { env: { ...base, NORDLA_TRIAL_AUTHORIZATION: auth, NORDLA_FETCH_DOUBLE_MODEL_LIST: mode } });
  // NO or WRONG authorisation (including the real plan's id, used with injected code): refused at preflight, nothing sent, no lock
  for (const [name, auth] of [['none', ''], ['wrong', 'trial-0000000000000000'], ['real plan id under a preload', realPlan]]) {
    const r0 = run(join(out, `auth-${name.replace(/\W/g, '')}`), 'OWNER_PROOF', auth);
    assert.equal(r0.status, 2, `${name}: ${r0.stderr}`);
    assert.match(r0.stderr.toString(), /PREFLIGHT_FAILED/);
    assert.ok(!existsSync(log), `${name}: no request at all`);
    assert.ok(!existsSync(registry), `${name}: no lock`);
  }
  // a paginated list without the model: refused, and NO lock taken
  const refused = run(join(out, 'r'), 'PAGE_WITHOUT_MODEL');
  assert.equal(refused.status, 3, refused.stderr.toString());
  assert.match(refused.stderr.toString(), /MODEL_NOT_CONFIRMED_BY_PROVIDER/);
  // the fetch double really was in place: the refused check went to it, never to the network
  assert.match(readFileSync(log, 'utf8'), /"path":"\/api\/v1\/models"/);
  assert.equal(readdirSync(join(out, 'r')).some((f) => f.endsWith('.lock')), false);
  const refusedFalse = run(join(out, 'f'), 'SUCCESS_FALSE');
  assert.equal(refusedFalse.status, 3, refusedFalse.stderr.toString());
  // the owner's real answer: accepted, then the 9 planned calls, the report
  const ok = run(join(out, 'ok'), 'OWNER_PROOF');
  assert.equal(ok.status, 0, ok.stderr.toString());
  assert.match(ok.stdout.toString(), /"confirmed":true/);
  assert.match(ok.stdout.toString(), /6864af00-406c-95e9-997e-79cf755985ac/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const okCalls = calls.slice(-10);
  assert.equal(okCalls[0].path, '/api/v1/models'); assert.equal(okCalls[0].query, '?model=qwen3-vl-plus');
  assert.equal(okCalls.slice(1).length, 9);
  assert.ok(okCalls.slice(1).every((c) => c.host === 'ws-test-double.eu-central-1.maas.aliyuncs.com' && c.path === '/compatible-mode/v1/chat/completions' && c.model === 'qwen3-vl-plus'));
  assert.ok(readdirSync(join(out, 'ok')).some((f) => f.endsWith('.lock')));
  assert.ok(readdirSync(registry).includes(`${planId}.lock`), 'the machine-wide attempt lock is taken');
  // a SECOND attempt of the same plan in ANOTHER output folder: refused before any network call (the old per-folder lock allowed it)
  const callsBefore = readFileSync(log, 'utf8').trim().split('\n').length;
  const second = run(join(out, 'other-folder'), 'OWNER_PROOF');
  assert.equal(second.status, 2, second.stderr.toString());
  assert.match(second.stderr.toString(), /aucune tentative antérieure de ce plan/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, callsBefore, 'no request at all for the refused second attempt');
  const report = readFileSync(join(out, 'ok', 'gourde-noire', 'RAPPORT.md'), 'utf8');
  assert.match(report, /IDÉATION SEULE/); assert.match(report, /test double gap/);
  assert.ok(!report.includes('sk-test-double') && !readFileSync(join(out, 'ok', `${planId}.calls.jsonl`), 'utf8').includes('sk-test-double'));
});
