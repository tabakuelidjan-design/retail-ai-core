// qwen3-vl-plus in the Alibaba lane: (1) non-regression of the allow-list change, (2) proof, on the wire, that the WHOLE autonomous route (Brain stages,
// STAGE, critic) sends exactly this model, to the Frankfurt workspace host, with only the API features documented for it. Network: a recording fetch DOUBLE;
// nothing leaves this machine, nothing is billed. The answers are generic test content (the creative-brain test world), never proposals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadAlibabaCreativeConfig, alibabaCreativeEndpoints } from '../src/marketing-creative/alibaba/config.js';
import { ALIBABA_PRICE_USD } from '../src/marketing-creative/alibaba/budget.js';
import { runAutonomous, RUN_STATUS } from '../src/creative-autonomy/run.js';
import { connectProviders, VISION_PURPOSE } from '../src/creative-autonomy/providers.js';
import { HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer } from './creative-brain-world.js';

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
    const stage = isVision ? 'CRITIC' : system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('art director') ? 'ART_DIRECT' : system.includes('set designer') ? 'STAGE' : '?';
    requests.push({ url, stage, body, auth: init.headers.Authorization });
    let answer;
    if (stage === 'FRAME') answer = frameAnswer();
    else if (stage === 'IDEATE') answer = { concepts: CONCEPTS };
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
    compose: async ({ outPath, stagePath }) => { writeFileSync(outPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(stagePath)])); return { fidelity: { max_level_difference_after_removing_layers: 1 }, technical: { defects: [], text_contrast_ratio: 12, product_height_share: 0.5 }, text_used: { facts_lines: ['x'] } }; },
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
  assert.deepEqual([...new Set(stages)].sort(), ['ART_DIRECT', 'CRITIC', 'FRAME', 'IDEATE', 'STAGE']);
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
