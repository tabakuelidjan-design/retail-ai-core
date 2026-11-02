// Tenant creative brand profile: HABB's rules are HABB's CONFIGURATION, enforced for HABB and never applied to another merchant; universal truth rules
// apply to everyone. Also: placeholder headlines, the art direction's narrative layers reaching the image request, and the judge's honesty rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadMerchantCreativeBrand, resolveBrandProfile, artDirectionHintFor } from '../src/creative-autonomy/brand-profile.js';
import { normalizeStage, hasForbidden, buildStageInstruction } from '../src/creative-autonomy/stage-contract.js';
import { assertStageGuard, commercialBrief, brandBriefFacts } from '../src/creative-autonomy/brand-guard.js';
import { buildSceneRequest, SCENE_NEGATIVE } from '../src/creative-autonomy/scene-engine.js';
import { buildAutonomousBrief } from '../src/creative-autonomy/brief.js';
import { judgeProposal } from '../src/creative-autonomy/run.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { CONCEPTS } from './creative-brain-world.js';

const HABB_BRAND = loadMerchantCreativeBrand('habb');
const HABB = resolveBrandProfile(HABB_BRAND);
const OTHER_BRAND = { merchant_id: '00000000-0000-4000-8000-0000000000b2', brand_id: '00000000-0000-4000-8000-0000000000b3', merchant_name: 'Atelier Verre, Liège' };
const OTHER = resolveBrandProfile(OTHER_BRAND);
const [concept] = normalizeConceptSet(CONCEPTS);
const stage = (over = {}) => ({ backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'COOL', purpose: 'sculpt the object' },
  accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [], headline: 'Le noir, sans détour', text_placement: 'RIGHT_COLUMN', show_price: 'YES',
  rationale: 'A quiet set that lets the real object carry the idea of the concept.', ...over });

test('HABB is configuration: its profile comes from config/merchants/habb/creative-brand.json and keeps every HABB prohibition', () => {
  assert.equal(HABB.kind, 'TENANT'); assert.equal(HABB.merchant_display, 'HABB, Namur'); assert.equal(HABB.brand_name, 'HABB');
  for (const w of ['beige', 'gold', 'heart', 'foliage', 'marble', 'velvet', 'bokeh']) assert.ok(HABB.forbidden_decor.includes(w), w);
  assert.throws(() => normalizeStage(stage({ rationale: 'un fond beige chaleureux autour de l\'objet' }), { concept, personalisation_offered: false, profile: HABB }), /forbidden decor/);
  assert.equal(hasForbidden('a golden halo', HABB.forbidden_decor), 'golden');
  assert.match(artDirectionHintFor(HABB), /^HABB's hard visual rules/);
});

test('another merchant gets NONE of HABB\'s taste rules, its own name, and no HABB default anywhere', () => {
  assert.equal(OTHER.kind, 'GENERIC'); assert.equal(OTHER.merchant_display, 'Atelier Verre, Liège'); assert.deepEqual(OTHER.forbidden_decor, []);
  assert.ok(normalizeStage(stage({ rationale: 'un fond beige chaleureux autour de l\'objet, comme du sable' }), { concept, personalisation_offered: false, profile: OTHER }), 'beige is HABB\'s rule, not a universal one');
  assert.equal(hasForbidden('a golden halo', OTHER.forbidden_decor), null);
  assert.equal(artDirectionHintFor(OTHER), null);
  const cb = commercialBrief({ product_title: 'Carafe', description: 'Carafe en verre soufflé.', price: '45,00 €' }, OTHER);
  assert.ok(cb.verified_selling_points.includes('Vendu par Atelier Verre, Liège.'));
  assert.ok(!JSON.stringify(cb).match(/HABB|gourde|paille|couvercle|Namur/i), 'no HABB requirement for another merchant');
  assert.ok(!JSON.stringify(brandBriefFacts({ ...OTHER_BRAND, expression: { identity: 'Atelier de verre' } }, OTHER)).match(/beige|HABB/i));
  const req = buildSceneRequest({ concept, artDirection: { realism: 'PHOTOREALISTIC', atmosphere: 'a', material_language: 'm', lighting_intent: 'l' }, stage: stage(), width: 1080, height: 1350, n: 3, profile: OTHER });
  assert.ok(!req.forbid.includes('beige') && !req.forbid.includes('hearts'), 'HABB exclusions are not sent for another merchant');
  assert.ok(SCENE_NEGATIVE.includes('a second copy of the product') && !SCENE_NEGATIVE.some((w) => /bottle|beige|gold/.test(w)), 'universal negatives hold no product type and no merchant taste');
  // the HABB palette words are HABB's: another merchant may not use BRAND_* tones
  assert.throws(() => normalizeStage(stage({ backdrop_tone: 'BRAND_NAVY' }), { concept, personalisation_offered: false, profile: OTHER }), /not a colour of this merchant/);
  assert.ok(normalizeStage(stage({ backdrop_tone: 'BRAND_NAVY' }), { concept, personalisation_offered: false, profile: HABB }));
  assert.match(buildStageInstruction({ frame: {}, concept, artDirection: {}, facts: {}, profile: OTHER }).system, /none \(do not use BRAND_\* tones or materials\)/);
});

test('the merchant on the image is the ACTIVE tenant\'s; no merchant name is a default', () => {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  const photo = { bytes: Buffer.from('x'), media_type: 'image/jpeg', width_px: 1, height_px: 1, origin: 'MERCHANT_UPLOAD', rights_class: 'UNKNOWN' };
  const other = buildAutonomousBrief({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: OTHER_BRAND, format: 'INSTAGRAM_FEED_4_5', photo });
  assert.equal(other.brief.public_facts.merchant, 'Atelier Verre, Liège');
  const anon = buildAutonomousBrief({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: { merchant_id: 'm', brand_id: 'b' }, format: 'INSTAGRAM_FEED_4_5', photo });
  assert.equal(anon.brief.public_facts.merchant, undefined, 'unknown merchant: no name rather than someone else\'s');
  const habb = buildAutonomousBrief({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photo });
  assert.equal(habb.brief.public_facts.merchant, 'HABB, Namur');
});

test('shared creative code holds no merchant\'s rules: no "HABB, Namur" default, no HABB word list, no product-specific negative', () => {
  const dir = new URL('../src/creative-autonomy/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'trial.js')) { // trial.js IS the HABB/TYESO trial plan (HABB tenant data by design)
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/HABB, Namur|'beige'|'eucalyptus'|second bottle|tyeso|ts-8771c/i.test(code), `${f} carries a merchant-specific rule`);
  }
  const py = readFileSync(new URL('../scripts/creative-autonomy/compose_stage.py', import.meta.url), 'utf8');
  assert.ok(!/HABB, Namur/.test(py));
});

test('universal truth rules hold for EVERY tenant: invented capability, figure, placeholder headline', () => {
  const facts = { product_title: 'Carafe', variant: null, description: 'Carafe en verre soufflé.' };
  for (const p of [HABB, OTHER]) {
    assert.throws(() => assertStageGuard(normalizeStage(stage({ rationale: 'Cette carafe garde ton eau froide toute la journée, posée sur le set.' }), { concept, personalisation_offered: false, profile: p }), facts, p), /capability/);
    assert.throws(() => normalizeStage(stage({ headline: 'Fraîche 24h' }), { concept, personalisation_offered: false, profile: p }), /figure/);
    for (const h of ['Titre de test', 'Headline', 'Lorem ipsum dolor', 'Votre texte ici', 'TBD', 'Titre']) assert.throws(() => normalizeStage(stage({ headline: h }), { concept, personalisation_offered: false, profile: p }), /placeholder/, h);
    for (const h of ['Le noir, sans détour', 'Un titre qui tient la nuit', 'Testé à Namur, porté partout']) assert.ok(normalizeStage(stage({ headline: h }), { concept, personalisation_offered: false, profile: p }), h);
  }
});

test('the art direction\'s story reaches the image model: narrative elements by plane, depth, space; requested, never claimed as drawn', () => {
  const art = { realism: 'PHOTOREALISTIC', atmosphere: 'a quiet blue hour', material_language: 'wet stone', lighting_intent: 'cold side light', depth_model: 'LAYERED_DEPTH', negative_space_strategy: 'ASYMMETRIC_RESERVE',
    narrative_elements: [{ element: 'a wet stone step', zone: 'FOREGROUND', reason: 'the walk' }, { element: 'morning fog over a river', zone: 'BACKGROUND', reason: 'the hour' }], forbidden_decorative_noise: ['floating particles'] };
  const req = buildSceneRequest({ concept, artDirection: art, stage: stage({ wanted_but_not_available: ['dew on the step'] }), width: 1080, height: 1350, n: 3, profile: HABB });
  assert.match(req.scene, /In the foreground: a wet stone step/); assert.match(req.scene, /In the background: morning fog over a river/);
  assert.match(req.scene, /a clear foreground, middle ground and background/); assert.match(req.scene, /The scene also needs: dew on the step/);
  assert.match(req.scene, /in charcoal grey/);
  assert.ok(req.forbid.includes('floating particles'), 'the art direction\'s own exclusions reach the negative prompt');
  assert.equal(req.execution.verified_in_image, false); assert.equal(req.execution.narrative_elements_requested.length, 2);
});

test('the judge: seven axes from real evidence; a partly measured critique is NOT_MEASURABLE; premium is never implied', () => {
  const technical = { defects: [], product_fidelity: { pass: true, max_level_difference_after_removing_layers: 0 } };
  const dims = (o = {}) => ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR'].map((d) => ({ dimension: d, outcome: o[d] ?? 'PASS', evidence: `seen on the image: ${d}` }));
  const all = judgeProposal({ technical, critique: { dimensions: dims() } });
  assert.equal(all.technical_correctness.verdict, 'PASS'); assert.equal(all.product_fidelity.verdict, 'PASS'); assert.equal(all.creative_originality.verdict, 'PASS');
  assert.match(all.creative_originality.evidence, /seen on the image/);
  assert.equal(all.brand_relevance.verdict, 'NOT_MEASURABLE'); assert.equal(all.commercial_effectiveness.verdict, 'NOT_MEASURABLE'); assert.equal(all.premium_quality_implied, false);
  const partial = judgeProposal({ technical, critique: { dimensions: dims({ WOW_FACTOR: 'NOT_MEASURABLE' }) } });
  assert.equal(partial.creative_originality.verdict, 'NOT_MEASURABLE', 'one unmeasured dimension: no pass on that axis');
  const noEvidence = judgeProposal({ technical, critique: { dimensions: dims().map((d) => ({ ...d, evidence: '' })) } });
  assert.equal(noEvidence.storytelling_coherence.verdict, 'NOT_MEASURABLE', 'a verdict without visual evidence is not a verdict');
  const none = judgeProposal({ technical, critique: null });
  for (const k of ['creative_originality', 'storytelling_coherence', 'premium_artistic_execution']) assert.equal(none[k].verdict, 'NOT_MEASURABLE', k);
  const weak = judgeProposal({ technical, critique: { dimensions: dims({ WOW_FACTOR: 'FAIL' }) } });
  assert.equal(weak.creative_originality.verdict, 'FAIL'); assert.equal(weak.technical_correctness.verdict, 'PASS', 'clean execution, weak idea: said separately');
});
