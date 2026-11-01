import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualBackgroundBrief, assertVisualProductionApproval, VISUAL_FORMATS } from '../src/creative-autonomy/visual-production-contract.js';

const concept = { story: 'A short pause in the rhythm of Namur', visual_metaphor: 'Quiet motion reflected in wet stone' };
const artDirection = { atmosphere: 'Architectural, dark and precise', lighting_intent: 'Natural raking cold light', material_language: 'Wet dark stone and brushed steel' };
const get = (o = {}) => buildVisualBackgroundBrief({ concept, artDirection, ...o });

test('brief reserves real-product space; never supplies product pixels or commercial text', () => {
  const b = get();
  assert.equal(b.contract, 'NORDLA_VISUAL_BACKGROUND_V1');
  assert.equal(b.containsProductImage, false);
  assert.equal(b.containsCommercialText, false);
  assert.deepEqual(b.dimensions, { width: 1080, height: 1350 });
  assert.match(b.prompt, /any product/i);
  assert.match(b.prompt, /No.*word.*number.*price/i);
  assert.match(b.prompt, /central third/);
  assert.match(b.prompt, /real product photograph/);
});
test('supported placements and formats reserve the right space', () => {
  assert.match(get({ productPosition: 'LEFT_THIRD' }).prompt, /left third/);
  assert.match(get({ productPosition: 'RIGHT_THIRD' }).prompt, /right third/);
  assert.deepEqual(get({ format: 'INSTAGRAM_STORY_9_16' }).dimensions, VISUAL_FORMATS.INSTAGRAM_STORY_9_16);
  assert.throws(() => get({ format: 'A4' }), /unsupported output format/);
  assert.throws(() => get({ productPosition: 'BEHIND' }), /unsupported productPosition/);
});
test('HABB visual restrictions reach the generator prompt', () => {
  const p = get().prompt;
  for (const word of ['beige', 'gold', 'hearts', 'foliage', 'leaves', 'bokeh', 'velvet', 'marble']) {
    assert.ok(p.includes(word), word);
  }
  assert.equal(p.includes('29,90'), false);
});
test('invalid creative input fails before any vendor operation', () => {
  assert.throws(() => buildVisualBackgroundBrief({ concept, artDirection: {} }), /atmosphere/);
  assert.throws(() => buildVisualBackgroundBrief({ concept: {}, artDirection }), /story/);
});
const auth = { approved: true, planId: 'trial-test', provider: 'openai', model: 'gpt-image-2.5-sunburst', maxCalls: 1, photoTransmission: 'NONE', dataScope: 'GLOBAL', crossBorderApproved: true };
const request = (o = {}) => ({ planId: 'trial-test', provider: 'openai', model: 'gpt-image-2.5-sunburst',
  sourcePhotoRights: 'OWNER_CONFIRMED', authorization: auth, ...o });
test('one-call permission is tied to exact plan, provider and model', () => {
  assert.equal(assertVisualProductionApproval(request()), true);
  for (const change of [{ planId: 'other' }, { provider: 'alibaba' }, { model: 'other' }, { authorization: null }]) {
    assert.throws(() => assertVisualProductionApproval(request(change)), /NOT_AUTHORIZED/);
  }
});
test('photo rights and photo-transmission limits fail closed', () => {
  assert.throws(() => assertVisualProductionApproval(request({ sourcePhotoRights: 'UNVERIFIED' })), /PHOTO_RIGHTS_UNVERIFIED/);
  assert.throws(() => assertVisualProductionApproval(request({ authorization: { ...auth, photoTransmission: 'SOURCE' } })), /PHOTO_TRANSMISSION_FORBIDDEN/);
  assert.throws(() => assertVisualProductionApproval(request({ authorization: { ...auth, maxCalls: 2 } })), /NOT_AUTHORIZED/);
});
