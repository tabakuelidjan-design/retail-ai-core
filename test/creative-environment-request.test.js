import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildEnvironmentRequest, createDecisionLedger } from '../src/creative-runtime/index.js';
import { PLAIN_SCENE, sceneWordingOf } from '../src/creative-runtime/scene-wording.js';
import { BRAND, directorAnswer } from './runtime-world.js';

// The environment request (`// ER-N` markers): it describes an EMPTY, product-free, text-free surface and backdrop. A direction may speak about the product, a contact shadow or a focal point; the
// provider request never does (the third live revision run returned a stone bowl after such a direction).

const canvas = { width: 1080, height: 1350 };
const direction = (visual_intent, extra = {}) => ({ ...JSON.parse(directorAnswer()), direction_id: 'cdr_0'.padEnd(36, '0'), visual_intent, ...extra });
const request = (visualIntent, extra) => buildEnvironmentRequest({ direction: direction(visualIntent, extra), expression: BRAND.expression, canvas });
// the visual intent a real revision Director returned, and generic English equivalents of its three kinds of subject-bearing wording
const OBSERVED = 'Surface en pierre minérale gris froid, matière réelle et sobre, lumière douce directionnelle, ombre de contact précise et crédible au contact du produit, atmosphère premium retenue, palette neutre désaturée, contraste suffisant pour détacher la coque.';
const SUBJECT_CLAUSES = [
  'a crisp contact shadow under the product', 'ombre de contact précise au contact du produit', 'strong contrast to set the case apart', 'contraste suffisant pour détacher la coque',
  'a hero object on the surface', 'un objet posé au centre', 'a clear focal point in the middle', 'un point focal net', 'the subject is grounded naturally', 'le téléphone bien ancré',
  'the phone sits on a slab-free surface', 'un sujet principal éclairé',
  'a strong hero presence', 'une présence de héros', 'looks naturally grounded', 'subtle grounding', 'un rendu bien ancré',
];
const SCENE_CLAUSES = ['cool grey honed stone surface', 'soft directional light', 'lumière douce directionnelle', 'palette neutre désaturée', 'a plain pale backdrop', 'matière réelle et sobre'];

test('ER-1 the scene wording drops every clause about the product, an object, a contact effect or a focal point (English and French), and keeps the scene', () => {
  for (const clause of SUBJECT_CLAUSES) {
    const out = sceneWordingOf(`${SCENE_CLAUSES[0]}, ${clause}, ${SCENE_CLAUSES[1]}`);
    assert.equal(out.dropped, 1, clause);
    assert.equal(out.text, `${SCENE_CLAUSES[0]}, ${SCENE_CLAUSES[1]}`, clause);
  }
  for (const clause of SCENE_CLAUSES) assert.equal(sceneWordingOf(clause).dropped, 0, clause);
  const observed = sceneWordingOf(OBSERVED);
  assert.equal(observed.dropped, 2);
  assert.doesNotMatch(observed.text, /produit|coque|contact/i);
  assert.match(observed.text, /pierre minérale gris froid.*lumière douce directionnelle.*palette neutre désaturée/);
  // never empty: a direction that is only about the product still yields a plain scene
  assert.deepEqual(sceneWordingOf('the product, a contact shadow, a focal point'), { text: PLAIN_SCENE, dropped: 3 });
  assert.deepEqual(sceneWordingOf(''), { text: PLAIN_SCENE, dropped: 0 });
  // different separators
  assert.equal(sceneWordingOf('calm grey surface; soft light - a hero product. plain backdrop').text, 'calm grey surface, soft light, plain backdrop');
});

test('ER-2 the request for the observed direction is product-free and subject-free, and the direction itself is untouched', () => {
  const d = direction(OBSERVED);
  const frozen = JSON.stringify(d);
  const built = buildEnvironmentRequest({ direction: d, expression: BRAND.expression, canvas });
  assert.equal(JSON.stringify(d), frozen);
  assert.doesNotMatch(built.prompt, /produit|coque|contact|focal|subject|sujet|hero|\b(phone|product|case|camera|text|letters|logo|watermark|pedestal|plinth|slab|shadows?)\b/i);
  assert.match(built.prompt, /^A photograph of Surface en pierre minérale gris froid/);
  assert.match(built.prompt, /quiet and empty/);
  assert.match(built.prompt, /nothing placed on it/);
  // the brand's own statements about a focal point or shadows are not forwarded either
  assert.doesNotMatch(built.prompt, /focal point|natural shadows/);
});

test('ER-3 the surface is asked to be even, matte and finely grained, and objects a stone surface invites are named in the NEGATIVE prompt only', () => {
  const built = request(OBSERVED);
  assert.match(built.prompt, /The surface is even, matte and finely grained, without veining, cracks or relief\./);
  for (const word of ['bowl', 'vase', 'vessel', 'container', 'sculpture', 'rock', 'boulder', 'ornament', 'decorative object', 'furniture', 'veining', 'cracks', 'rough relief']) {
    assert.ok(built.negative_prompt.split(', ').includes(word), word);
  }
  // the original negatives are still there, in order
  assert.match(built.negative_prompt, /product.*phone.*pedestal.*plinth.*slab.*text.*letters.*logo.*watermark/);
  // and no object class is named in the positive prompt (naming it primes the generator to draw it)
  assert.doesNotMatch(built.prompt, /\b(bowl|vase|vessel|container|sculpture|rock|boulder|ornament|furniture|object|device)\b/i);
});

test('ER-4 the construction is recorded with the number of subject clauses dropped; the brand and display-structure refusals still apply', () => {
  const ledger = createDecisionLedger();
  buildEnvironmentRequest({ direction: direction(OBSERVED), expression: BRAND.expression, canvas, ledger });
  const row = ledger.entries().find((e) => e.decision === 'PROVIDER_REQUEST_CONSTRUCTION');
  assert.equal(row.outcome.subject_clauses_dropped, 2);
  assert.equal(row.outcome.forbidden_objects_only_in_the_negative_prompt, true);
  assert.equal(row.outcome.carries_input_asset, false);
  assert.throws(() => request('warm gradient background, golden light'), (e) => e.code === 'DIRECTION_VIOLATES_BRAND_FORBIDDEN_VISUALS');
  assert.throws(() => request('a pale stone podium and a plain backdrop'), (e) => e.code === 'DIRECTION_ASKS_FOR_A_DISPLAY_STRUCTURE');
});

test('ER-5 the scene wording module is generic: no brand, merchant, product or provider name', async () => {
  for (const file of ['scene-wording.js', 'request-builder.js']) {
    const source = (await readFile(new URL(`../src/creative-runtime/${file}`, import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(source, /HABB|Namur|Samsung|qwen|alibaba|Galaxy/i, file);
  }
});
