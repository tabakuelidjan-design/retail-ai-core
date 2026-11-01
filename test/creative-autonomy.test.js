// Mechanics of the autonomous route. Every language/vision answer here comes from a TEST_DOUBLE port with GENERIC invented content (the existing
// creative-brain test world): it proves the wiring, the contracts and the honest stops, never the creative quality. Nothing here is a proposal for HABB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutonomous, RUN_STATUS, deterministicFix, localEngines } from '../src/creative-autonomy/run.js';
import { normalizeStage } from '../src/creative-autonomy/stage-contract.js';
import { verifiedFacts, HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { connectProviders, PROVIDER_STATE } from '../src/creative-autonomy/providers.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';

const snap = (name) => JSON.parse(readFileSync(new URL(`./fixtures/creative-autonomy/${name}`, import.meta.url), 'utf8'));
const GOURDE = snap('shopify-gourde-tyeso.json');
const COQUE = snap('shopify-coque-iphone12.json');
const photo = () => { const d = mkdtempSync(join(tmpdir(), 'na-')); const p = join(d, 'photo.jpg'); writeFileSync(p, Buffer.from('not-a-real-photo-for-mechanics')); return p; };
const input = (s, over = {}) => ({ product: s.product, readAt: s.read_at, objective: 'objectif de test', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: photo(),
  photoMeta: { media_type: 'image/jpeg', width_px: 1, height_px: 1, origin: 'MERCHANT_UPLOAD', rights_class: 'MERCHANT_OWNED' }, ...over });

const stageAnswer = (concept, over = {}) => ({
  backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN',
  key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'test double' }, accent_lights: [],
  camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' },
  props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: concept.visual_metaphor }],
  headline: 'Titre de test double', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'test double', ...over,
});

/** TEST_DOUBLE language port: answers by stage, records every call. */
function doublePort({ stageOver = () => ({}) } = {}) {
  const calls = [];
  const concepts = normalizeConceptSet(CONCEPTS);
  const complete = async ({ system, user }) => {
    const stage = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : system.includes('set designer') ? 'STAGE' : '?';
    calls.push({ stage, revision: system.includes('REVISION') });
    let body;
    if (stage === 'FRAME') body = frameAnswer();
    else if (stage === 'IDEATE') body = { concepts: CONCEPTS };
    else if (stage === 'SELECT') body = evaluationsAnswer(concepts, []);
    else if (stage === 'ART_DIRECT') { const c = JSON.parse(user).concept; body = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element of the set', reason: c.story, zone: 'FOREGROUND' }] }); }
    else if (stage === 'STAGE') { const c = JSON.parse(user).concept; body = stageAnswer(c, stageOver(c, calls)); } else throw new Error('unknown stage');
    return { text: JSON.stringify(body), model: 'TEST_DOUBLE', request_id: `td-${calls.length}`, cost_eur: 0 };
  };
  return { complete, calls, concepts };
}

/** Engines that do not run Blender: deterministic stand-ins with scripted defects per round. */
function fakeEngines({ examStatus = 'CUT_OUT', defectsByRound = [[]] } = {}) {
  const calls = { examine: 0, render: 0, compose: 0 }; const rounds = new Map();
  return {
    calls, name: { render: 'fake render', compose: 'fake compose' },
    async examine() { calls.examine += 1; return { status: examStatus, ...(examStatus !== 'CUT_OUT' ? { reasons: ['BACKGROUND_NOT_PLAIN_OR_GRADIENT'] } : {}) }; },
    async render({ outPath }) { calls.render += 1; writeFileSync(outPath, 'x'); return { resolution: [10, 10], foreground_props: 0 }; },
    async compose({ stagePath, outPath }) {
      calls.compose += 1; const key = stagePath.split('/').slice(-2, -1)[0]; const r = rounds.get(key) ?? 0; rounds.set(key, r + 1);
      writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      return { fidelity: { max_level_difference_after_removing_layers: 1 }, technical: { defects: defectsByRound[r] ?? [], text_contrast_ratio: 12, product_height_share: 0.5 }, text_used: { facts_lines: ['x'] } };
    },
  };
}
const noPorts = { text: null, vision: null, state: { text: PROVIDER_STATE.NOT_CONNECTED, vision: PROVIDER_STATE.NOT_CONNECTED } };
const tdPorts = (port, vision = null) => ({ text: port.complete, vision, state: { text: PROVIDER_STATE.TEST_DOUBLE, vision: vision ? PROVIDER_STATE.TEST_DOUBLE : PROVIDER_STATE.NOT_CONNECTED } });

test('no provider configured: the real environment connects nothing and says what is missing', () => {
  const p = connectProviders({ env: {} });
  assert.equal(p.text, null); assert.equal(p.vision, null);
  assert.equal(p.state.text, 'NOT_CONNECTED');
  assert.match(p.missing.join(' '), /ALIBABA_MODEL_STUDIO_API_KEY/);
});

test('without a language model the run stops honestly at FRAME, costs nothing and fakes nothing', async () => {
  const engines = fakeEngines();
  const r = await runAutonomous({ input: input(GOURDE, { variantTitle: 'Noir' }), ports: noPorts, engines, workdir: mkdtempSync(join(tmpdir(), 'na-')) });
  assert.equal(r.status, RUN_STATUS.STOPPED_PROVIDER_NOT_CONNECTED);
  assert.equal(r.stopped_at, 'FRAME');
  assert.deepEqual(r.trace.map((t) => t.step), ['BRIEF', 'EXAMINE', 'OBSERVE', 'FRAME']);
  assert.equal(r.trace.at(-1).outcome, 'PROVIDER_NOT_CONNECTED');
  assert.ok(r.trace.at(-1).detail.needed.provider);
  assert.equal(r.cost_eur.text_and_vision, 0); assert.equal(r.published, false);
  assert.equal(engines.calls.render, 0);
  assert.equal(r.proposals, undefined);
});

test('verified facts: the case offers personalisation, the bottle does not; the only claim is the Shopify price', () => {
  assert.equal(verifiedFacts({ product: COQUE.product, readAt: COQUE.read_at }).personalisation_offered, true);
  const g = verifiedFacts({ product: GOURDE.product, variantTitle: 'Noir', readAt: GOURDE.read_at });
  assert.equal(g.personalisation_offered, false); assert.equal(g.price, '29,90 €'); assert.equal(g.variant, 'Noir');
});

test('with a TEST_DOUBLE brain: 3 concepts, each art-directed, staged, rendered, checked, fixed within limits and proposed (never approved)', async () => {
  const port = doublePort({ stageOver: () => ({ text_placement: 'TOP_RIGHT' }) });
  const engines = fakeEngines({ defectsByRound: [['HEADLINE_OVERLAPS_PRODUCT'], []] });
  const r = await runAutonomous({ input: input(GOURDE, { variantTitle: 'Noir' }), ports: tdPorts(port), engines, workdir: mkdtempSync(join(tmpdir(), 'na-')) });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error ?? r.trace.at(-1)));
  assert.equal(r.proposals.length, 3);
  assert.equal(new Set(r.proposals.map((p) => p.concept.concept_id)).size, 3);
  for (const p of r.proposals) {
    assert.equal(p.status, 'PROPOSED_FOR_OWNER_VALIDATION');
    assert.equal(p.creative_quality.state, 'NOT_MEASURED'); // no vision: the creative quality is NOT claimed
    assert.equal(p.technical_quality.state, 'PASS');
  }
  // the deterministic refine only moved what it is allowed to move
  const fixes = r.trace.filter((t) => t.step === 'REFINE');
  assert.equal(fixes.length, 3);
  for (const f of fixes) { assert.equal(f.kind, 'DETERMINISTIC'); assert.deepEqual(Object.keys(f.detail.change), ['text_placement']); }
  // every brain step is labelled TEST_DOUBLE, never REAL
  assert.ok(r.trace.filter((t) => t.kind === 'LLM').every((t) => t.provider === 'TEST_DOUBLE'));
  assert.ok(r.trace.some((t) => t.step === 'CRITIC' && t.outcome === 'PROVIDER_NOT_CONNECTED'));
  assert.equal(r.human_interventions.filter((h) => h.creative).length, 1); // only the owner's final verdict
});

test('a placement defect Nordla cannot fix on its own goes back to the Brain, not to a human', async () => {
  const port = doublePort();
  const engines = fakeEngines({ defectsByRound: [['HEADLINE_OVERLAPS_PRODUCT'], []] });
  const r = await runAutonomous({ input: input(GOURDE, { variantTitle: 'Noir' }), ports: tdPorts(port), engines, workdir: mkdtempSync(join(tmpdir(), 'na-')) });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER);
  assert.ok(r.trace.filter((t) => t.step === 'REFINE').every((t) => t.kind === 'LLM' && /HEADLINE_OVERLAPS_PRODUCT/.test(t.detail.hints[0])));
});

test('a critic hint makes the Brain re-stage the concept (bounded to two rounds)', async () => {
  const port = doublePort();
  const DIMS = ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR'];
  const vision = { invoke: async () => ({ model: 'TEST_DOUBLE', cost_eur: 0, text: JSON.stringify({ dimensions: DIMS.map((dimension) => (dimension === 'WOW_FACTOR'
    ? { dimension, outcome: 'FAIL', evidence: 'The set reads as a plain product shot with nothing surprising in it.', revision_hint: 'give the prop a role that makes the idea visible at a glance' }
    : { dimension, outcome: 'PASS', evidence: 'The image carries this dimension clearly enough for a first look.' })) }) }) };
  const engines = fakeEngines();
  const r = await runAutonomous({ input: input(GOURDE, { variantTitle: 'Noir' }), ports: tdPorts(port, vision), engines, workdir: mkdtempSync(join(tmpdir(), 'na-')) });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error));
  const restaged = r.trace.filter((t) => t.step === 'REFINE' && t.kind === 'LLM');
  assert.equal(restaged.length, 6); // 3 concepts x 2 rounds max
  assert.ok(port.calls.filter((c) => c.stage === 'STAGE' && c.revision).length === 6);
  for (const p of r.proposals) assert.equal(p.creative_quality.state, 'CREATIVELY_INSUFFICIENT'); // said, not hidden
});

test('an unusable photo: concepts may still be thought, but nothing is rendered and the owner is asked for a clean asset', async () => {
  const engines = fakeEngines({ examStatus: 'NEEDS_CLEAN_ASSET' });
  const r = await runAutonomous({ input: input(COQUE), ports: tdPorts(doublePort()), engines, workdir: mkdtempSync(join(tmpdir(), 'na-')) });
  assert.equal(r.status, RUN_STATUS.CONCEPTS_ONLY_ASSET_NOT_USABLE);
  assert.equal(engines.calls.render, 0);
  assert.ok(r.proposals.every((p) => p.status === 'CONCEPT_ONLY' && p.image === null));
  assert.ok(r.human_interventions.some((h) => /photo exploitable/.test(h.what)));
});

test('stage contract: HABB rules refuse forbidden decor, invented claims and a personalisation that is not offered', () => {
  const [concept] = normalizeConceptSet(CONCEPTS);
  const ok = stageAnswer(concept);
  assert.ok(normalizeStage(ok, { concept, personalisation_offered: false }).stage_id);
  assert.throws(() => normalizeStage({ ...ok, backdrop_tone: 'WHITE', rationale: 'un fond beige chaleureux' }, { concept, personalisation_offered: false }), /forbidden decor/);
  assert.throws(() => normalizeStage({ ...ok, headline: 'La meilleure gourde' }, { concept, personalisation_offered: false }), /unverified claim/);
  assert.throws(() => normalizeStage({ ...ok, headline: 'Gardée froide 24h' }, { concept, personalisation_offered: false }), /figure/);
  assert.throws(() => normalizeStage({ ...ok, headline: 'Ton prénom dessus' }, { concept, personalisation_offered: false }), /personalisation/);
  assert.ok(normalizeStage({ ...ok, headline: 'Ton prénom dessus' }, { concept, personalisation_offered: true }));
  assert.throws(() => normalizeStage({ ...ok, props: [{ ...ok.props[0], reason: 'joli' }] }, { concept, personalisation_offered: false }), /no reason in the concept/);
  assert.throws(() => normalizeStage({ ...ok, text_placement: 'LEFT_COLUMN' }, { concept, personalisation_offered: false }), /sit on the product/);
});

test('deterministic fixes stay inside the allowed limits', () => {
  const s = { camera: { framing: 'MEDIUM', product_position: 'LEFT_THIRD', height: 'LOW' }, text_placement: 'TOP_RIGHT' };
  assert.deepEqual(deterministicFix(s, ['HEADLINE_OVERLAPS_PRODUCT']), { text_placement: 'RIGHT_COLUMN' });
  assert.equal(deterministicFix(s, ['PRODUCT_TOO_SMALL']).camera.framing, 'CLOSE');
  assert.equal(deterministicFix(s, ['LOW_TEXT_CONTRAST']), null); // that one goes back to the Brain
});

const BOTTLE = process.env.NORDLA_TEST_PRODUCT_PHOTO || '';
const BLENDER = process.env.NORDLA_BLENDER_PYTHON || '';
test('local engines really run on a real photo (examination, Blender scene, compositor, fidelity proof)', { skip: !(BOTTLE && BLENDER && existsSync(BOTTLE) && existsSync(BLENDER)) && 'set NORDLA_TEST_PRODUCT_PHOTO and NORDLA_BLENDER_PYTHON to run the real engines', timeout: 600_000 }, async () => {
  const port = doublePort();
  const r = await runAutonomous({ input: input(GOURDE, { variantTitle: 'Noir', photoPath: BOTTLE }), ports: tdPorts(port), engines: localEngines({ renderScale: 0.3, samples: 8 }), workdir: mkdtempSync(join(tmpdir(), 'na-real-')) });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER, JSON.stringify(r.error));
  for (const p of r.proposals) {
    assert.ok(existsSync(p.image));
    assert.ok(p.technical_quality.product_fidelity.max_level_difference_after_removing_layers <= 2, 'the product pixels come back intact once the light layers are removed');
  }
});

// ---- the first real trial: prepared, gated, never run by the tests
import { trialPlanId, forecastCost, modelAllowedInScope, TRIAL_LIMITS, RECOMMENDED } from '../src/creative-autonomy/trial.js';

const KEYED = { ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-0000000000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-0001' };

test('trial gate: a key alone connects nothing; the owner\'s trial authorisation is required', () => {
  const p = connectProviders({ env: { ...KEYED, NORDLA_ALIBABA_SCOPE: 'GLOBAL' } });
  assert.equal(p.text, null);
  assert.match(p.missing.join(' '), /autorisation d'essai/);
});

test('trial gate: qwen3.8-max is refused in an EU workspace (Frankfurt serves it in GLOBAL scope only)', () => {
  assert.equal(modelAllowedInScope('qwen3.8-max', 'EU'), false);
  assert.equal(modelAllowedInScope('qwen3-vl-plus', 'EU'), true);
  const p = connectProviders({ env: { ...KEYED, NORDLA_ALIBABA_SCOPE: 'EU' }, trialAuthorized: true });
  assert.equal(p.text, null);
  assert.match(p.missing.join(' '), /qwen3\.8-max n'est pas disponible en périmètre EU/);
});

test('trial gate: the recommended model connects only with an EU scope declared AND the trial authorisation', () => {
  const env = { ...KEYED, ALIBABA_QWEN_TEXT_MODEL: RECOMMENDED.model, NORDLA_ALIBABA_SCOPE: 'EU' };
  assert.equal(connectProviders({ env }).text, null);
  assert.equal(connectProviders({ env: { ...env, NORDLA_ALIBABA_SCOPE: undefined } , trialAuthorized: true }).text, null);
  const p = connectProviders({ env, trialAuthorized: true });
  assert.equal(typeof p.text, 'function');
  assert.equal(p.model.text, 'qwen3-vl-plus');
});

test('trial plan: the authorisation is bound to model, scope and limits; the forecast stays under the hard ceiling', () => {
  const a = trialPlanId({ model: 'qwen3-vl-plus', scope: 'EU' });
  assert.notEqual(a, trialPlanId({ model: 'qwen3-vl-plus', scope: 'GLOBAL' }));
  assert.notEqual(a, trialPlanId({ model: 'qwen3-vl-plus', scope: 'EU', limits: { ...TRIAL_LIMITS, max_spend_eur: 3 } }));
  const f = forecastCost({ model: 'qwen3-vl-plus', calls: [{ kind: 'TEXT', input_chars: 20000, expected_output_chars: 3000 }, { kind: 'VISION', input_chars: 4000, expected_output_chars: 2400, images: 1 }] });
  assert.ok(f.expected_eur > 0 && f.worst_case_eur >= f.expected_eur && f.spendguard_reserved_eur >= f.worst_case_eur);
  assert.ok(f.spendguard_reserved_eur * 20 < TRIAL_LIMITS.max_spend_eur * 20);
});

test('per-image critic: a render is critiqued only through a clearance built for its own bytes', async () => {
  const DIMS = ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR'];
  const asked = [];
  const visionFor = ({ ref, bytes }) => { asked.push({ ref, n: bytes.length }); return { invoke: async () => ({ model: 'TEST_DOUBLE', cost_eur: 0, text: JSON.stringify({ dimensions: DIMS.map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'The image carries this dimension clearly enough for a first look.' })) }) }) }; };
  const r = await runAutonomous({ input: input(GOURDE, { variantTitle: 'Noir' }), ports: { text: doublePort().complete, visionFor, state: { text: 'TEST_DOUBLE', vision: 'TEST_DOUBLE' } }, engines: fakeEngines(), workdir: mkdtempSync(join(tmpdir(), 'na-')) });
  assert.equal(r.status, RUN_STATUS.PROPOSALS_READY_FOR_OWNER);
  assert.equal(asked.length, 3);
  assert.ok(asked.every((a) => a.ref.startsWith('render://') && a.n > 0));
  assert.ok(r.proposals.every((p) => p.creative_quality.state === 'CREATIVELY_SUFFICIENT_AWAITING_OWNER' && p.status === 'PROPOSED_FOR_OWNER_VALIDATION'));
});
