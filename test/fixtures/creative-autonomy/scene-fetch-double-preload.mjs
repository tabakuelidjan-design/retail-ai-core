// TEST ONLY (loaded with --import): replaces globalThis.fetch so that `creative-autonomy-trial.mjs --execute --scene` runs end to end with NO network and NO cost.
//   model lists      answer that the asked model is served (NORDLA_SCENE_DOUBLE_IMAGE_LIST=FORBIDDEN: the image workspace answers 403, as an EU workspace does)
//   chat completions the generic test world; SELECT makes concept 2 the only one that meets every criterion
//   image edit       reads the plate Nordla really sent and answers three SIMULATED scenes built around it (test/helpers/scene_fixtures.py)
//   downloads        serve those scenes
import { appendFileSync, readdirSync, statSync, readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from '../../creative-brain-world.js';
// the decor-first route requires every concept to state its composition and its value lever (2026-11-07): the simulated model answers with them (mechanical placeholders, not ideas)
const SET_WITH_COMPOSITION = CONCEPTS.map((c, i) => ({ ...c, composition: `Simulated composition ${i + 1}: the weight sits low, the light leads the eye to the empty place of the product, depth recedes in three planes`, value_lever: `Simulated value lever ${i + 1}: the set stages the product and lets the light reveal its matter` }));
import { normalizeConceptSet } from '../../../src/creative-brain/concept.js';
import { adAnswerFor } from './ad-text-double.mjs';
import { CONCEPT_DIMENSIONS } from '../../../src/creative-brain/concept-critic.js';

const LOG = process.env.NORDLA_FETCH_DOUBLE_LOG;
const OUT = process.env.NORDLA_SCENE_DOUBLE_DIR;
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const FIX = fileURLToPath(new URL('../../helpers/scene_fixtures.py', import.meta.url));
const files = new Map();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The plate of the run being produced = the NEWEST one (a long-lived demo server runs several productions in one process, one at a time).
const plates = (dir) => readdirSync(dir).flatMap((e) => { const p = join(dir, e); return statSync(p).isDirectory() ? plates(p) : e === 'scene_plate.png.json' ? [p] : []; });
const find = (dir) => plates(dir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;

globalThis.__realFetch = globalThis.fetch; // kept ONLY so a simulation can read the real Shopify catalog (read-only) while every provider call stays on this double
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const body = init.body ? JSON.parse(init.body) : null;
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ method: init.method ?? 'GET', host: u.host, path: u.pathname, query: u.search, model: body?.model ?? null, n: body?.parameters?.n ?? null })}\n`);
  if (u.pathname === '/api/v1/models') {
    const model = u.searchParams.get('model');
    if (model === 'qwen-image-3.0-pro' && process.env.NORDLA_SCENE_DOUBLE_IMAGE_LIST === 'FORBIDDEN') return json({ code: 'Endpoint.AccessDenied', message: 'Workspace endpoint access denied', request_id: 'r-403' }, 403);
    return json({ success: true, output: { total: 1, page_no: 1, page_size: 20, models: [{ model }] }, request_id: `list-${model}` });
  }
  if (u.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
    // the free INVOCATION probe (n = 99, no image): a workspace that serves the model rejects the parameter; one that does not says Model.Unsupported FIRST (as the real service does)
    if (body?.parameters?.n === 99) return process.env.NORDLA_SCENE_DOUBLE_IMAGE_SITE === 'UNSUPPORTED' ? json({ code: 'Model.Unsupported', message: 'Model is not supported in current workspace service site', request_id: 'r-unsupported' }, 400) : json({ code: 'InvalidParameter', message: 'Range of n should be [1, 6]', request_id: 'r-probe' }, 400);
    const metaPath = find(OUT); const platePath = metaPath.replace(/\.json$/, '');
    const sent = Buffer.from(body.input.messages[0].content[0].image.split(',')[1], 'base64');
    if (!sent.equals(readFileSync(platePath))) return json({ code: 'TEST_DOUBLE', message: 'not the plate' }, 400);
    const out = mkdtempSync(join(tmpdir(), 'scene-double-'));
    const productless = JSON.parse(readFileSync(metaPath, 'utf8')).productless === true;
    execFileSync(PY, [FIX, productless ? 'envs' : 'scenes', platePath, metaPath, out]);
    const urls = (productless ? ['clean', 'occupied'] : ['good', 'moved', 'double']).slice(0, body?.parameters?.n ?? 3).map((name, i) => { const x = `https://dashscope-result-test.oss-eu-central-1.aliyuncs.com/scene/${i}-${name}.png`; files.set(x, readFileSync(join(out, `${name}.png`))); return x; });
    return json({ request_id: 'req-scene-double', output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: urls.map((image) => ({ image })) } }] }, usage: { image_count: urls.length, width: 1080, height: 1350 } });
  }
  if (u.host === 'dashscope-result-test.oss-eu-central-1.aliyuncs.com') {
    const b = files.get(String(url));
    return b ? new Response(b, { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 });
  }
  const system = body.messages[0].content; const user = body.messages[1].content;
  let answer;
  const adHit = typeof user === 'string' ? adAnswerFor(system, JSON.parse(user)) : null; // the advertisement route (AD_V1): a valid placeholder per stage
  if (adHit) answer = adHit.body;
  else if (Array.isArray(user) && String(system).includes('review your OWN finished advertisement')) answer = { // the FINAL REVIEW (final-review.js): a SIMULATED answer of the test double, mechanical, never a judgment
    product_fidelity: { verdict: 'OK', evidence: 'SIMULATION (test double): no real model looked at the image.' }, decor: { verdict: 'FITS', evidence: 'SIMULATION (test double).' }, headline_image: { verdict: 'AGREES', evidence: 'SIMULATION (test double).' }, phone_legibility: { verdict: 'LEGIBLE', evidence: 'SIMULATION (test double).' },
    reason_to_buy: { concrete: 'YES', seen_in_the_picture: 'SIMULATION: an element of the test scene', what_it_gives_the_customer: 'SIMULATION (test double).' }, verdict: 'PUBLISHABLE', why: 'SIMULATION (test double): the wiring is tested, not the judgment.' };
  else if (Array.isArray(user)) answer = { dimensions: CONCEPT_DIMENSIONS.map((dimension) => ({
    dimension, outcome: 'PASS', evidence: 'The real product is the focus of a cohesive editorial composition with clear space and considered lighting.'
  })) };
  else if (system.includes('problem framer')) answer = frameAnswer();
  else if (system.includes('concept director')) answer = { concepts: SET_WITH_COMPOSITION };
  else if (system.includes('concept selector')) answer = evaluationsAnswer(normalizeConceptSet(SET_WITH_COMPOSITION), [{ DISTINCTIVENESS: 'PARTIAL' }, {}, { CONCEPT_STRENGTH: 'PARTIAL' }]);
  else if (system.includes('art director')) { const c = JSON.parse(user).concept; answer = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }); }
  else { const c = JSON.parse(user).concept; answer = { backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'MIRROR', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'COOL', purpose: 'double' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Le noir, sans détour', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'double' }; }
  return json({ id: `req-double-${Date.now()}`, model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550 } });
};
