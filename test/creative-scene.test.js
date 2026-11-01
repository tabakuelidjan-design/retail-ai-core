// Creative Production V1, premium path: the scene is generated AROUND the real product, then its authentic pixels are put back.
// End to end OFFLINE with the REAL local engines (examine_product.py, scene_plate.py, scene_check.py, compose_stage.py), the REAL edit lane
// (qwen-image-edit.js: clearance, spend guard, journal, output store) and a SIMULATED provider (a fetch double). No network, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runAutonomous, RUN_STATUS, localEngines } from '../src/creative-autonomy/run.js';
import { createSceneEngine, buildSceneRequest, SCENE_PURPOSE, SCENE_ERROR, SCENE_NEGATIVE } from '../src/creative-autonomy/scene-engine.js';
import { HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { PROVIDER_STATE } from '../src/creative-autonomy/providers.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { loadAlibabaCreativeConfig } from '../src/marketing-creative/alibaba/config.js';
import { SpendGuard, ALIBABA_PRICE_USD } from '../src/marketing-creative/alibaba/budget.js';
import { MemoryOutputStore } from '../src/marketing-creative/alibaba/output-store.js';
import { buildProductEditPrompt } from '../src/marketing-creative/alibaba/qwen-image-edit.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const FIX = join(HERE, 'helpers', 'scene_fixtures.py');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pythonReady = (() => { try { execFileSync(PY, ['-c', 'import numpy, PIL, scipy'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const SKIP = !pythonReady && `the local engines need Python with numpy, Pillow and scipy (NORDLA_PYTHON=${PY})`;
const SLOW = { skip: SKIP, timeout: 300_000 };

const GOURDE = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
const ENV = { ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-scene-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-img-0001', ALIBABA_MODEL_STUDIO_REGION: 'eu-central-1' };

function syntheticPhoto() {
  const dir = mkdtempSync(join(tmpdir(), 'scene-photo-')); const p = join(dir, 'gourde.jpg');
  execFileSync(PY, [FIX, 'photo', p]);
  return { path: p, bytes: readFileSync(p) };
}
const mediaRecord = (photoSha, over = {}) => ({
  kind: 'EXTERNAL_MEDIA_AUTHORIZATION', authorization_id: 'authz://test/scene', purpose_note: 'offline scene test',
  asset: { asset_ref: 'asset://test/gourde', asset_sha256: photoSha, data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false },
  provider: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' }, purpose: SCENE_PURPOSE, allowed_operations: ['IMAGE_EDIT'],
  transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
  retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
  authorization: { revoked: false }, state: {}, global_policy: { changed_by_this_record: false }, ...over,
});

// the language port double: concept 2 is the only one that meets every criterion, so Nordla's SELECT picks it (never "the first of the list")
const stageAnswer = (c, over = {}) => ({
  backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'MIRROR',
  key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'COOL', purpose: 'test double' }, accent_lights: [],
  camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' },
  props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }],
  headline: 'Titre de test double', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'test double', ...over,
});
function textPort({ perConcept = [{ DISTINCTIVENESS: 'PARTIAL' }, {}, { CONCEPT_STRENGTH: 'PARTIAL' }], stageOver = {} } = {}) {
  const calls = []; const concepts = normalizeConceptSet(CONCEPTS);
  const complete = async ({ system, user }) => {
    const stage = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : system.includes('set designer') ? 'STAGE' : '?';
    calls.push(stage);
    let body;
    if (stage === 'FRAME') body = frameAnswer();
    else if (stage === 'IDEATE') body = { concepts: CONCEPTS };
    else if (stage === 'SELECT') body = evaluationsAnswer(concepts, perConcept);
    else if (stage === 'ART_DIRECT') { const c = JSON.parse(user).concept; body = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element of the set', reason: c.story, zone: 'FOREGROUND' }] }); }
    else if (stage === 'STAGE') { const c = JSON.parse(user).concept; body = stageAnswer(c, stageOver); } else throw new Error('unknown stage');
    return { text: JSON.stringify(body), model: 'TEST_DOUBLE', request_id: `td-${calls.length}`, cost_eur: 0 };
  };
  return { complete, calls, concepts };
}

/** The SIMULATED provider: it reads the plate Nordla really sent, builds scenes around it (helpers/scene_fixtures.py) and serves them like DashScope. */
function simulatedProvider({ workdir, answer = ['good', 'moved', 'double'] }) {
  const posts = []; const gets = []; const files = new Map();
  const find = (dir) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) { const f = find(p); if (f) return f; } else if (e === 'scene_plate.png.json') return p; } return null; };
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST' || init.body) {
      const body = JSON.parse(init.body); posts.push({ url, body });
      const metaPath = find(workdir); const platePath = metaPath.replace(/\.json$/, '');
      const sent = Buffer.from(body.input.messages[0].content[0].image.split(',')[1], 'base64');
      assert.deepEqual(sent, readFileSync(platePath), 'the request carries exactly the plate (the authorised derived image), nothing else');
      const out = mkdtempSync(join(tmpdir(), 'scene-provider-'));
      execFileSync(PY, [FIX, 'scenes', platePath, metaPath, out]);
      const urls = answer.map((name, i) => { const u = `https://dashscope-result-test.oss-eu-central-1.aliyuncs.com/scene/${i}-${name}.png`; files.set(u, readFileSync(join(out, `${name}.png`))); return u; });
      return { ok: true, status: 200, text: async () => JSON.stringify({ request_id: 'req-scene-sim-1', output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: urls.map((image) => ({ image })) } }] }, usage: { image_count: urls.length, width: 1080, height: 1350 } }) };
    }
    gets.push(url);
    const bytes = files.get(url); if (!bytes) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  return { fetchImpl, posts, gets };
}

function setup({ answer, authorization, perConcept, stageOver, variants = 3, injectDefects = null } = {}) {
  const photo = syntheticPhoto();
  const workdir = mkdtempSync(join(tmpdir(), 'scene-run-'));
  const provider = simulatedProvider({ workdir, answer });
  const budget = new SpendGuard({ maxSpendEur: 0.5, maxImages: variants, maxVideoSeconds: 0 });
  const journal = { rows: [], append: async (e) => { journal.rows.push(e); } };
  const base = localEngines({ python: PY });
  // the REAL compositor; a test may add a defect to its report for a given round, to exercise the refinement rules
  let composed = 0;
  const baseEngines = injectDefects ? { ...base, compose: async (a) => { const rep = await base.compose(a); const extra = injectDefects[composed] ?? []; composed += 1; return { ...rep, technical: { ...rep.technical, defects: [...rep.technical.defects, ...extra] } }; } } : base;
  const engines = createSceneEngine({
    baseEngines, config: loadAlibabaCreativeConfig(ENV), authorization: authorization ?? mediaRecord(sha(photo.bytes)), photoSha256: sha(photo.bytes),
    budget, journal, outputStore: new MemoryOutputStore(), fetchImpl: provider.fetchImpl, variants, python: PY,
  });
  const port = textPort({ perConcept, stageOver });
  const input = { product: GOURDE.product, variantTitle: 'Noir', readAt: GOURDE.read_at, objective: 'Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: photo.path,
    photoMeta: { media_type: 'image/jpeg', width_px: null, height_px: null, origin: 'MERCHANT_UPLOAD', rights_class: 'LICENSED' } };
  const ports = { text: port.complete, vision: null, state: { text: PROVIDER_STATE.TEST_DOUBLE, vision: PROVIDER_STATE.NOT_CONNECTED } };
  return { photo, workdir, provider, budget, journal, engines, port, input, ports };
}
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

test('end to end: Nordla produces ITS selected concept as a finished image; the scene is built around the real product and its authentic pixels are restored', SLOW, async () => {
  const s = setup();
  const r = await runAutonomous({ input: s.input, ports: s.ports, engines: s.engines, workdir: s.workdir, produce: 'SELECTED' });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error ?? r.trace.filter((t) => t.outcome === 'ERROR')));
  // SELECT chose concept 2, and only concept 2 was art-directed, staged and produced
  const second = s.port.concepts[1].concept_id;
  assert.equal(r.selection.selection.concept_id, second);
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].concept.concept_id, second); assert.equal(r.proposals[0].selected_by_nordla, true);
  assert.deepEqual(s.port.calls, ['FRAME', 'IDEATE', 'SELECT', 'ART_DIRECT', 'STAGE'], 'one art direction and one stage: the selected concept only');
  // ONE provider call, n = 3 variants, prompt_extend off, the HABB exclusions only in the negative prompt
  assert.equal(s.provider.posts.length, 1);
  const { body, url } = s.provider.posts[0];
  assert.equal(url, 'https://ws-test-img-0001.eu-central-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(body.model, 'qwen-image-3.0-pro'); assert.equal(body.parameters.n, 3); assert.equal(body.parameters.prompt_extend, false); assert.equal(body.parameters.size, '1080*1350');
  const positive = body.input.messages[0].content[1].text;
  for (const w of ['second bottle', 'gold', 'foliage', 'neon', 'beige', 'hearts']) { assert.ok(!positive.toLowerCase().includes(w), `"${w}" must not be named in the positive prompt`); assert.ok(body.parameters.negative_prompt.includes(w)); }
  assert.match(positive, /stays exactly where it stands in the reference image/);
  // each variant measured; the good one chosen, the moved and the duplicated ones refused for the right reason
  const sc = r.proposals[0].scene;
  assert.equal(sc.chosen_variant, 1);
  assert.deepEqual(sc.variants.map((v) => v.pass), [true, false, false]);
  assert.ok(sc.variants[1].rejections.includes('PRODUCT_MOVED_BEYOND_SEARCH'), JSON.stringify(sc.variants[1]));
  assert.ok(sc.variants[2].rejections.includes('DUPLICATE_PRODUCT_IN_SCENE'), JSON.stringify(sc.variants[2]));
  const v1 = sc.variants[0];
  assert.deepEqual([v1.alignment.dx, v1.alignment.dy, v1.alignment.scale], [3, -2, 1.02], 'the authentic pixels go back where the model drew the product');
  assert.equal(v1.contact_shadow.present, true); assert.equal(v1.reflection.present, true); assert.equal(v1.light.consistent, true);
  // the finished image: real file, exact format, product pixels = the photo's (fidelity proof), French text from the verified facts
  const img = readFileSync(r.proposals[0].image); assert.deepEqual(pngSize(img), { w: 1080, h: 1350 });
  const tq = r.proposals[0].technical_quality;
  assert.equal(tq.product_fidelity.pass, true, JSON.stringify(tq)); assert.ok(tq.product_fidelity.max_level_difference_after_removing_layers <= 2);
  assert.equal(r.proposals[0].text_for_owner_approval.facts_lines[1], '29,90 €');
  // money: 3 images + 1 reference image, reserved before sending and settled
  const snap = s.budget.snapshot();
  assert.equal(snap.images, 3); assert.equal(snap.reserved_eur, 0);
  assert.ok(Math.abs(snap.settled_eur - (3 * ALIBABA_PRICE_USD.image_1k + ALIBABA_PRICE_USD.image_input)) < 1e-9, JSON.stringify(snap));
  assert.equal(s.journal.rows.filter((e) => e.event === 'SUCCEEDED').length, 1);
  assert.ok(existsSync(join(dirname(r.proposals[0].image), 'scene_variants.json')));
  assert.equal(r.published, false);
  // keep the produced image for inspection when asked (never inside the repository)
  if (process.env.NORDLA_SCENE_TEST_OUT) copyFileSync(r.proposals[0].image, join(process.env.NORDLA_SCENE_TEST_OUT, 'scene-e2e-final.png'));
});

test('a text-placement refinement reuses the paid scene: no second provider call', SLOW, async () => {
  // the compositor reports the headline over the product: Nordla moves the text to the opposite column, the scene is reused, nothing is paid twice
  const s = setup({ stageOver: { text_placement: 'TOP_RIGHT' }, injectDefects: [['HEADLINE_OVERLAPS_PRODUCT']] });
  const r = await runAutonomous({ input: s.input, ports: s.ports, engines: s.engines, workdir: s.workdir, produce: 'SELECTED' });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error));
  const renders = r.trace.filter((t) => t.step === 'RENDER');
  const refine = r.trace.filter((t) => t.step === 'REFINE');
  assert.ok(refine.some((t) => t.outcome === 'FIXED_WITHIN_LIMITS' && t.detail.change.text_placement === 'RIGHT_COLUMN'), JSON.stringify(refine));
  assert.equal(renders.length, 2); assert.equal(renders[1].detail.reused_scene, true);
  assert.equal(s.provider.posts.length, 1, 'the scene is paid once');
  assert.equal(r.proposals[0].stage.text_placement, 'RIGHT_COLUMN');
  assert.equal(r.proposals[0].technical_quality.state, 'PASS');
});

test('a refinement that would change the framing is NOT applied in scene mode: reported to the owner, no new scene', SLOW, async () => {
  const s = setup({ injectDefects: [['PRODUCT_TOO_SMALL']] });
  const r = await runAutonomous({ input: s.input, ports: s.ports, engines: s.engines, workdir: s.workdir, produce: 'SELECTED' });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error));
  const refine = r.trace.filter((t) => t.step === 'REFINE');
  assert.equal(refine.length, 1); assert.equal(refine[0].outcome, 'REPORTED_TO_OWNER_NOT_APPLIED'); assert.equal(refine[0].detail.framing_change.framing, 'CLOSE');
  assert.equal(r.trace.filter((t) => t.step === 'RENDER').length, 1); assert.equal(s.provider.posts.length, 1);
  assert.equal(r.proposals[0].technical_quality.state, 'FAIL', 'the defect stays visible to the owner');
});

test('every variant refused: an honest stop with the evidence per variant, after ONE call, and nothing composed', SLOW, async () => {
  const s = setup({ answer: ['moved', 'double', 'ghost'] });
  const r = await runAutonomous({ input: s.input, ports: s.ports, engines: s.engines, workdir: s.workdir, produce: 'SELECTED' });
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.error.code, SCENE_ERROR.NO_VARIANT_PASSED);
  const render = r.trace.find((t) => t.step === 'RENDER');
  assert.deepEqual(render.detail.evidence.variants.map((v) => v.pass), [false, false, false]);
  assert.ok(render.detail.evidence.variants[2].rejections.includes('GHOST_EDGE_AROUND_PRODUCT'));
  assert.equal(s.provider.posts.length, 1); assert.equal(r.proposals.length, 0);
});

test('no concept selected by Nordla: the run stops BEFORE any image call (nothing is picked in its place)', SLOW, async () => {
  const fails = { CONCEPT_STRENGTH: 'FAILS', DISTINCTIVENESS: 'FAILS' };
  const s = setup({ perConcept: [fails, fails, fails] });
  const r = await runAutonomous({ input: s.input, ports: s.ports, engines: s.engines, workdir: s.workdir, produce: 'SELECTED' });
  assert.equal(r.status, RUN_STATUS.STOPPED_NO_CONCEPT_SELECTED);
  assert.equal(s.provider.posts.length, 0); assert.equal(s.budget.snapshot().images, 0);
  assert.deepEqual(s.port.calls, ['FRAME', 'IDEATE', 'SELECT']);
});

test('a media record for ANOTHER photo: refused before any reservation and before any byte leaves', SLOW, async () => {
  const s = setup({ authorization: mediaRecord('0'.repeat(64)) });
  const r = await runAutonomous({ input: s.input, ports: s.ports, engines: s.engines, workdir: s.workdir, produce: 'SELECTED' });
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.match(r.error.message, /EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED/);
  assert.equal(s.provider.posts.length, 0); assert.deepEqual([s.budget.snapshot().images, s.budget.snapshot().reserved_eur, s.budget.snapshot().settled_eur], [0, 0, 0]);
});

test('the plate places the product exactly where the compositor restores it (same pixels, same box)', SLOW, () => {
  const photo = syntheticPhoto(); const d = mkdtempSync(join(tmpdir(), 'scene-plate-'));
  execFileSync(PY, [join(ROOT, 'scripts/creative-autonomy/examine_product.py'), photo.path, d]);
  const stage = stageAnswer({ visual_metaphor: 'x' });
  writeFileSync(join(d, 'stage.json'), JSON.stringify(stage));
  const plate = JSON.parse(execFileSync(PY, [join(ROOT, 'scripts/creative-autonomy/scene_plate.py'), join(d, 'examen.json'), join(d, 'produit_rgba.png'), join(d, 'stage.json'), '1080', '1350', join(d, 'plate.png')]).toString().trim().split('\n').pop());
  // the plate itself as the "scene", level 1, no synthetic shadow: the compositor must put every product pixel back on itself
  copyFileSync(join(d, 'plate.png'), join(d, 'set.png'));
  writeFileSync(join(d, 'set.png.json'), JSON.stringify({ bottom_front: plate.bottom_front, top_front: plate.top_front, foreground_mask: null, slit_y: null, render_backend: 'SCENE_AROUND_PRODUCT', contact_shadow: false, product_level: 1 }));
  const facts = join(d, 'faits.json'); writeFileSync(facts, JSON.stringify({ product_title: 'Gourde de test', variant: 'Noir', price: '29,90 €', merchant: 'HABB, Namur' }));
  let report;
  try { report = JSON.parse(execFileSync(PY, [join(ROOT, 'scripts/creative-autonomy/compose_stage.py'), join(d, 'stage.json'), join(d, 'set.png'), join(d, 'produit_rgba.png'), join(d, 'examen.json'), facts, join(d, 'out.png')]).toString().trim().split('\n').pop()); } catch (e) { report = null; assert.fail(`compose failed: ${e.stderr?.toString().slice(-400)}`); }
  assert.equal(report.fidelity.max_level_difference_after_removing_layers, 0);
  // compare the product box pixel by pixel between the plate and the composed image
  const cmp = execFileSync(PY, ['-c', `import numpy as np,json,sys
from PIL import Image
a=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int); b=np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(int)
m=np.asarray(Image.open(sys.argv[3])).astype(float)/255>=0.999
print(json.dumps({'max':int(np.abs(a-b)[m].max()),'n':int(m.sum())}))`, join(d, 'plate.png'), join(d, 'out.png'), join(d, 'plate.png.mask.png')]).toString();
  const c = JSON.parse(cmp);
  assert.ok(c.n > 10000); assert.ok(c.max <= 1, `product pixels differ by ${c.max} levels between plate and composition`);
});

test('the scene request: Nordla\'s decisions in the positive prompt, HABB\'s exclusions only in the negative one', () => {
  const concept = { central_idea: 'Une idée centrale de test sur la ville le soir', visual_metaphor: 'Une rue mouillée qui renvoie la lumière', story: 's' };
  const art = artDirectionAnswer();
  const req = buildSceneRequest({ concept, artDirection: art, stage: stageAnswer(concept), width: 1080, height: 1350, n: 3 });
  assert.equal(req.capability, 'IMAGE_EDIT'); assert.equal(req.text_policy, 'NO_CRITICAL_TEXT'); assert.equal(req.purpose, SCENE_PURPOSE); assert.equal(req.n, 3);
  const { prompt, negative_prompt: negative } = buildProductEditPrompt(req);
  assert.match(prompt, /Une rue mouillée qui renvoie la lumière/); assert.match(prompt, /polished reflective surface/); assert.match(prompt, /from the left/);
  for (const w of ['second bottle', 'another product', 'gold', 'foliage', 'neon', 'beige', 'hearts', 'marble', 'velvet', 'bokeh']) {
    assert.ok(!prompt.toLowerCase().includes(w), `positive prompt names "${w}"`); assert.ok(negative.includes(w), `negative prompt lacks "${w}"`);
  }
  assert.ok(SCENE_NEGATIVE.length > 30);
});

test('trial --execute --scene end to end against a fetch double: gates, free checks, ONE image call, a finished image and the report', SLOW, async () => {
  const { spawnSync } = await import('node:child_process');
  const script = join(ROOT, 'scripts/creative-autonomy-trial.mjs');
  const preload = new URL('./fixtures/creative-autonomy/scene-fetch-double-preload.mjs', import.meta.url).href;
  const out = mkdtempSync(join(tmpdir(), 'scene-trial-'));
  const photo = syntheticPhoto();
  const log = join(out, 'fetch.log'); const registry = join(out, 'attempt-registry');
  const base = { ...process.env, ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-double-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-text-eu', ALIBABA_MODEL_STUDIO_IMAGE_API_KEY: 'sk-test-image-0000000000', ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID: 'ws-test-image-global',
    NORDLA_FETCH_DOUBLE_LOG: log, NORDLA_ATTEMPT_REGISTRY: registry, NORDLA_PHOTO_RIGHTS: 'OWNER_CONFIRMED', NORDLA_PYTHON: PY };
  delete base.NORDLA_MEDIA_AUTHORIZATION_FILE; delete base.NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE; delete base.NODE_OPTIONS;
  const planDir = join(out, 'plan');
  const plan = JSON.parse(execFileSync(process.execPath, ['--import', preload, script, '--plan', '--scene', '--out', planDir, '--product', 'gourde-noire', '--photo', photo.path], { env: base }).toString());
  assert.equal(plan.limits.mode, 'SCENE_AROUND_PRODUCT'); assert.equal(plan.limits.image.scope, 'GLOBAL'); assert.equal(plan.limits.image.variants, 3);
  assert.equal(plan.money.CEILING_application_eur, 0.5); assert.equal(plan.money.CEILING_provable_max_fits, true);
  // the template is REVOKED: as written, it authorises nothing
  const templatePath = join(planDir, 'scene-media-authorization.TEMPLATE.json');
  const run = (dir, env) => spawnSync(process.execPath, ['--import', preload, script, '--execute', '--scene', '--out', dir, '--product', 'gourde-noire', '--photo', photo.path], { env: { ...base, NORDLA_TRIAL_AUTHORIZATION: plan.plan_id, NORDLA_SCENE_DOUBLE_DIR: dir, ...env } });
  const revoked = run(join(out, 'revoked'), { NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE: templatePath });
  assert.equal(revoked.status, 2, revoked.stderr.toString()); assert.match(revoked.stderr.toString(), /AUTHORIZATION_REVOKED/);
  assert.ok(!existsSync(log), 'nothing sent'); assert.ok(!existsSync(registry), 'no attempt consumed');
  // the owner's act: reads the record and sets revoked to false
  const granted = join(out, 'scene-media-authorization.json');
  const rec = JSON.parse(readFileSync(templatePath, 'utf8')); rec.authorization.revoked = false; writeFileSync(granted, JSON.stringify(rec));
  // an image workspace that does not serve the model (an EU workspace answers 403): refused after the FREE check, attempt NOT consumed
  const forbidden = run(join(out, 'forbidden'), { NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE: granted, NORDLA_SCENE_DOUBLE_IMAGE_LIST: 'FORBIDDEN' });
  assert.equal(forbidden.status, 3, forbidden.stderr.toString()); assert.match(forbidden.stderr.toString(), /IMAGE_MODEL_NOT_CONFIRMED_BY_PROVIDER/);
  assert.ok(!existsSync(registry), 'the refused free check did not consume the attempt');
  const okDir = join(out, 'ok');
  const ok = run(okDir, { NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE: granted });
  assert.equal(ok.status, 0, ok.stderr.toString());
  assert.match(ok.stdout.toString(), /"status": "PROPOSALS_READY_FOR_OWNER"/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => !c.host.startsWith('dashscope-result-test') || true);
  const okCalls = calls.slice(calls.findLastIndex((c) => c.path === '/api/v1/models' && c.query === '?model=qwen3-vl-plus'));
  assert.deepEqual(okCalls.slice(0, 2).map((c) => `${c.host} ${c.query}`), ['ws-test-text-eu.eu-central-1.maas.aliyuncs.com ?model=qwen3-vl-plus', 'ws-test-image-global.eu-central-1.maas.aliyuncs.com ?model=qwen-image-3.0-pro']);
  assert.equal(okCalls.filter((c) => c.path === '/compatible-mode/v1/chat/completions').length, 5, 'FRAME, IDEATE, SELECT, ART_DIRECT, STAGE');
  const edits = okCalls.filter((c) => c.path === '/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(edits.length, 1); assert.equal(edits[0].host, 'ws-test-image-global.eu-central-1.maas.aliyuncs.com'); assert.equal(edits[0].n, 3);
  const props = JSON.parse(readFileSync(join(okDir, 'gourde-noire', 'propositions.json'), 'utf8'));
  assert.equal(props.length, 1); assert.equal(props[0].scene.chosen_variant, 1); assert.equal(props[0].technical_quality.product_fidelity.pass, true);
  assert.deepEqual(pngSize(readFileSync(props[0].image)), { w: 1080, h: 1350 });
  const result = JSON.parse(readFileSync(join(okDir, `${plan.plan_id}.result.json`), 'utf8'));
  assert.ok(result.money.CEILING_ledger.settled_eur <= 0.5); assert.equal(result.money.CEILING_ledger.images, 3);
  assert.ok(existsSync(join(okDir, 'gourde-noire', 'RAPPORT.md')));
  const journal = readFileSync(join(okDir, `${plan.plan_id}.calls.jsonl`), 'utf8');
  assert.ok(!journal.includes('sk-test') && !journal.includes('base64'), 'no key, no image bytes in the journal');
  // a second attempt of the same plan: refused before any request
  const before = readFileSync(log, 'utf8').trim().split('\n').length;
  const second = run(join(out, 'again'), { NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE: granted });
  assert.equal(second.status, 2); assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, before);
});
