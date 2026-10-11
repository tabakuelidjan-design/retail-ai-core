import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveId } from '../src/creative-brain/validation.js';
import {
  buildArtDirectionInstruction, buildProblemFrame, composeScene, createArtDirector, describeZone, normalizeArtDirection, normalizeConceptSet, normalizeScene, observeBrief, projectSceneRequest, SCENE_FORBIDDEN,
} from '../src/creative-brain/index.js';
import {
  artDirectionAnswer, brief as makeBrief, CONCEPTS, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// ART DIRECTION + SCENE (`// AS-N` markers): semantic art direction argued in the concept, and a scene that may be rich but always reserves a zone for the protected product.

const concept = () => normalizeConceptSet(CONCEPTS)[0];
const frame = () => buildProblemFrame({ observation: observeBrief({ brief: makeBrief() }), model: frameAnswer() });
const code = (fn, c) => assert.throws(fn, (e) => e.code === c, c);
const ad = (over) => normalizeArtDirection(artDirectionAnswer(over), { concept: concept() });

test('AS-1 an art direction is closed, semantic, with a content-derived id and the mandatory forbidden list', () => {
  const a = ad();
  assert.match(a.art_direction_id, /^art_/);
  assert.equal(a.concept_id, concept().concept_id);
  for (const f of SCENE_FORBIDDEN) assert.ok(a.forbidden_decorative_noise.includes(f), f);
  assert.ok(a.forbidden_decorative_noise.includes('confetti and sparkles'));
  assert.equal(ad().art_direction_id, a.art_direction_id);
  assert.notEqual(ad({ atmosphere: 'A bright open workshop, calm and focused, light everywhere.' }).art_direction_id, a.art_direction_id);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.narrative_elements[0]));
  code(() => ad({ extra: 'x' }), 'BRAIN_UNKNOWN_KEY');
  code(() => ad({ depth_model: 'DEEPEST' }), 'BRAIN_ENUM_INVALID');
  code(() => ad({ realism: 'CARTOON' }), 'BRAIN_ENUM_INVALID');
  code(() => ad({ visual_tension: 7 }), 'BRAIN_NUMERIC_VALUE');
  code(() => ad({ forbidden_decorative_noise: [] }), 'BRAIN_LIST_INVALID');
  code(() => ad({ narrative_elements: Array.from({ length: 7 }, () => artDirectionAnswer().narrative_elements[0]) }), 'BRAIN_LIST_INVALID');
});

test('AS-2 no coordinate, size, colour code or unit enters the art direction', () => {
  code(() => ad({ lighting_intent: 'A light at #ff8800 from the side.' }), 'BRAIN_FORBIDDEN_CONTENT');
  code(() => ad({ atmosphere: 'A workshop with a bench 40 px wide.' }), 'BRAIN_FORBIDDEN_CONTENT');
  code(() => ad({ lighting_intent: 'A light placed at x 0.4 and y 0.6.' }), 'BRAIN_FORBIDDEN_CONTENT');
});

test('AS-3 every narrative element has a reason in the concept: arbitrary decoration is refused', () => {
  const el = { element: 'a row of glittering gems along the edge', reason: 'they simply look expensive and shiny here', zone: 'FOREGROUND' };
  const e = (() => { try { ad({ narrative_elements: [el] }); } catch (x) { return x; } return null; })();
  assert.equal(e?.code, 'BRAIN_RULE_VIOLATION');
  assert.equal(e.detail.problem, 'ELEMENT_WITHOUT_REASON_IN_THE_CONCEPT');
  assert.doesNotThrow(() => ad({ narrative_elements: [{ ...el, reason: 'they show the maker has just finished the piece with care' }] }));
  code(() => ad({ narrative_elements: [{ ...el, reason: 'the care taken', zone: 'SKY' }] }), 'BRAIN_ENUM_INVALID');
  code(() => ad({ narrative_elements: [{ element: el.element }] }), 'BRAIN_MISSING_KEY');
});

test('AS-4 nothing in the art direction may be, or stand in for, the product', () => {
  for (const element of ['a phone resting on the bench', 'a second case beside it', 'a product shot of the device', 'a brand logo on the wall', 'a text sign above the door']) {
    const e = (() => { try { ad({ narrative_elements: [{ element, reason: 'it shows the maker has just finished the piece with care', zone: 'MIDGROUND' }] }); } catch (x) { return x; } return null; })();
    assert.equal(e?.code, 'BRAIN_FORBIDDEN_CONTENT', element);
  }
  code(() => ad({ permitted_secondary_elements: ['a spare phone'] }), 'BRAIN_FORBIDDEN_CONTENT');
});

test('AS-5 the art director instruction is semantic, forbids substitutes, and a model cannot slip anything past the contract', async () => {
  const { system, user } = buildArtDirectionInstruction({ frame: frame(), concept: concept(), hints: ['let the light be more raking'] });
  assert.match(system, /never a coordinate, a size, a colour code or any number/);
  assert.match(system, /never describe the product, a phone, a case/);
  assert.match(system, /REVISION of an earlier art direction/);
  assert.match(system, /let the light be more raking/);
  assert.deepEqual(Object.keys(JSON.parse(user)), ['problem_frame', 'concept']);
  const port = scriptedPort({ art_direct: [artDirectionAnswer()] });
  const { art_direction: result, meta } = await createArtDirector({ complete: port.complete }).direct({ frame: frame(), concept: concept() });
  assert.equal(result.concept_id, concept().concept_id);
  assert.equal(meta.request_id, 'req-art_direct-1');
  const bad = await createArtDirector({ complete: async () => ({ text: JSON.stringify(artDirectionAnswer({ depth_model: 'x' })) }) }).direct({ frame: frame(), concept: concept() }).catch((x) => x);
  assert.equal(bad.code, 'BRAIN_ENUM_INVALID');
});

test('AS-6 a scene is composed from the art direction: protected product, required zone, argued layers, prohibitions, an id from its content', () => {
  const a = ad();
  const scene = composeScene({ artDirection: a, productAssetRef: 'product-asset' });
  assert.equal(scene.protected_product.mode, 'COMPOSITE_REAL_PIXELS');
  assert.equal(scene.protected_product.authority, 'MERCHANT_PIXELS');
  assert.equal(scene.integration_zone.reservation, 'REQUIRED');
  assert.equal(scene.layers[0].role, 'BACKGROUND');
  assert.equal(scene.layers.length, 1 + 2 + 1);
  assert.deepEqual(scene.layers.filter((l) => !l.optional).slice(1).map((l) => l.concept_link), a.narrative_elements.map((e) => e.reason));
  assert.ok(scene.layers.at(-1).optional);
  for (const f of SCENE_FORBIDDEN) assert.ok(scene.prohibited.includes(f));
  assert.equal(composeScene({ artDirection: a, productAssetRef: 'product-asset' }).scene_id, scene.scene_id);
  assert.notEqual(composeScene({ artDirection: a, productAssetRef: 'other-asset' }).scene_id, scene.scene_id);
  assert.match(scene.integration_zone.surface, /firm, level surface/);
  assert.match(composeScene({ artDirection: ad({ product_relationship: 'ADJACENT_TO_SCENE' }), productAssetRef: 'p' }).integration_zone.surface, /next to the scene/);
  code(() => composeScene({ artDirection: a, productAssetRef: '' }), 'BRAIN_MALFORMED');
});

test('AS-7 a scene cannot be tampered with: product, zone, substitutes, prohibitions, ids', () => {
  const scene = composeScene({ artDirection: ad(), productAssetRef: 'product-asset' });
  const edit = (fn) => { const s = structuredClone(scene); fn(s); return s; };
  code(() => normalizeScene(edit((s) => { s.protected_product.mode = 'GENERATE'; })), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeScene(edit((s) => { s.protected_product.authority = 'MODEL'; })), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeScene(edit((s) => { s.integration_zone.reservation = 'OPTIONAL'; })), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeScene(edit((s) => { s.layers[1].content = 'a phone on a stand'; })), 'BRAIN_FORBIDDEN_CONTENT');
  code(() => normalizeScene(edit((s) => { s.prohibited = ['confetti']; })), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeScene(edit((s) => { s.layers[0].role = 'FOREGROUND'; })), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeScene(edit((s) => { s.layers[1].content = 'something else entirely in the foreground'; })), 'BRAIN_RULE_VIOLATION'); // id no longer follows
  code(() => normalizeScene(edit((s) => { s.extra = 'x'; })), 'BRAIN_UNKNOWN_KEY');
  // the same defects with an id forged to match: each rule must stand on its own, not behind the id check
  const forge = (fn) => { const s = structuredClone(scene); fn(s); const { scene_id: _drop, ...body } = s; return { scene_id: deriveId('scn', body), ...body }; };
  const field = (fn) => { try { normalizeScene(forge(fn)); } catch (e) { return e.field; } return null; };
  assert.equal(field((s) => { s.integration_zone.reservation = 'OPTIONAL'; }), 'scene.integration_zone.reservation');
  assert.equal(field((s) => { s.protected_product.mode = 'GENERATE'; }), 'scene.protected_product');
  assert.equal(field((s) => { s.prohibited = ['confetti']; }), 'scene.prohibited');
  assert.equal(field((s) => { s.layers[1].content = 'a phone on a stand'; }), 'scene.layers[1].content');
  code(() => normalizeScene(edit((s) => { s.layers = []; })), 'BRAIN_LIST_INVALID');
});

test('AS-8 the zone is described in words, never in coordinates', () => {
  const canvas = { width: 1000, height: 1000 };
  assert.deepEqual({ ...describeZone({ x: 50, y: 350, width: 300, height: 300 }, canvas) }, { horizontal: 'START', vertical: 'MIDDLE', extent: 'SMALL' });
  assert.deepEqual({ ...describeZone({ x: 650, y: 700, width: 500, height: 500 }, canvas) }, { horizontal: 'END', vertical: 'LOWER', extent: 'MEDIUM' });
  assert.deepEqual({ ...describeZone({ x: 200, y: 0, width: 600, height: 700 }, canvas) }, { horizontal: 'CENTER', vertical: 'UPPER', extent: 'LARGE' });
});

test('AS-9 the provider request is an adapter projection: scene described, zone reserved, prohibitions only in the negative prompt, the product never described', () => {
  const scene = composeScene({ artDirection: ad(), productAssetRef: 'product-asset' });
  const zone = describeZone({ x: 50, y: 350, width: 300, height: 300 }, { width: 1000, height: 1000 });
  const req = projectSceneRequest({ scene, zone, canvas: { width: 1000, height: 1000 } });
  assert.equal(req.size, '1000*1000');
  assert.match(req.prompt, /^A photograph of /);
  assert.match(req.prompt, /Far behind: a soft window glow/);
  assert.match(req.prompt, /In the foreground, at the edges of the frame: a pair of worn tools/);
  assert.match(req.prompt, /small area in the middle part of the frame, on the left, completely calm and empty/);
  assert.match(req.prompt, /nothing stands on it, nothing crosses it/);
  assert.doesNotMatch(req.prompt, /confetti|phone|case|logo|product/i);
  assert.match(req.negative_prompt, /confetti and sparkles/);
  for (const f of SCENE_FORBIDDEN) assert.ok(req.negative_prompt.includes(f));
  const stylised = projectSceneRequest({ scene: composeScene({ artDirection: ad({ realism: 'EDITORIAL_STYLISED' }), productAssetRef: 'p' }), zone, canvas: { width: 1000, height: 1000 } });
  assert.match(stylised.prompt, /^A refined editorial image of /);
  code(() => projectSceneRequest({ scene, zone: {}, canvas: { width: 1000, height: 1000 } }), 'BRAIN_MALFORMED');
});
