import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codePoints, firstSentence, groupSlices, measure, sliceText, stripSpace, textOf, verifyVerbatim,
} from '../src/creative-planning/index.js';

// TEXT UNITS (`// TU-N` markers): measurement and verbatim segmentation. A locked text is only ever cut: the slices hold exactly its words, in order.

const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (r, list) => list[Math.floor(r() * list.length)];

const FR = 'Notre atelier de Namur imprime vos photos sur des coques personnalisées. Chaque pièce est vérifiée à la main ; rien ne part sans contrôle. Venez nous voir !';
const NL = 'Ons atelier in Namen drukt uw foto’s op gepersonaliseerde hoesjes. Elk stuk wordt met de hand gecontroleerd.';
const ZH = '我们的工坊位于那慕尔。我们把您的照片印在定制手机壳上。每件产品都经过人工检查。';
const AR = 'ورشتنا في نامور تطبع صورك على أغطية الهواتف المخصصة. يتم فحص كل قطعة يدويا.';
const EMOJI = 'Offrez un souvenir 🎁✨ à ceux que vous aimez 👨‍👩‍👧‍👦. Prêt en 5 minutes !';

test('TU-1 measurement: characters are code points, words follow the script, sentences and paragraphs are counted', () => {
  assert.deepEqual(measure(''), { chars: 0, words: 0, sentences: 0, paragraphs: 0 });
  const fr = measure(FR, 'fr-BE');
  assert.equal(fr.sentences, 3); assert.equal(fr.paragraphs, 1); assert.ok(fr.words >= 25 && fr.words <= 28);
  assert.equal(measure('Un.\n\nDeux.\n\nTrois.', 'fr').paragraphs, 3);
  assert.equal(codePoints('🎁a'), 2);
  assert.ok(measure(ZH, 'zh').words >= 8, 'a script without spaces is still segmented into words');
  assert.ok(measure(AR, 'ar').words >= 10);
});

test('TU-2 slices hold exactly the words of the text, in order, each within the limit, for every script', () => {
  for (const [name, text] of Object.entries({ FR, NL, ZH, AR, EMOJI })) {
    for (const max of [12, 25, 40, 80, 300]) {
      const slices = sliceText(text, max, name === 'ZH' ? 'zh' : 'fr');
      assert.ok(verifyVerbatim(text, slices), `${name}/${max}: verbatim`);
      for (const s of slices) assert.ok(codePoints(text.slice(s.start, s.end)) <= max, `${name}/${max}: within the limit`);
    }
  }
});

test('TU-3 the strongest boundary wins: paragraphs, then sentences, then clauses, then words', () => {
  const text = 'Premier paragraphe court.\n\nDeuxième paragraphe un peu plus long que le premier, avec une virgule. Une seconde phrase pour finir.';
  const slices = sliceText(text, 60, 'fr');
  assert.equal(text.slice(slices[0].start, slices[0].end), 'Premier paragraphe court.');
  assert.ok(slices.every((s) => /[.!?]$/.test(text.slice(s.start, s.end)) || text.slice(s.start, s.end).endsWith(',')));
});

test('TU-4 a word longer than the limit is cut hard, never lost', () => {
  const text = `${'a'.repeat(95)} b`;
  const slices = sliceText(text, 40, 'en');
  assert.ok(verifyVerbatim(text, slices));
  assert.ok(slices.every((s) => codePoints(text.slice(s.start, s.end)) <= 40));
  assert.throws(() => sliceText('x', 0), RangeError);
});

test('TU-5 FUZZ: random texts in mixed scripts keep every character, in order, within every limit', () => {
  const r = mulberry(20261012);
  const atoms = ['alpha', 'bravo', 'naïve', 'café', 'Zürich', '你好世界', '日本語', 'שלום', 'مرحبا', '🎁', '👨‍👩‍👧', '12,50', '€', '3.5%', 'https://exemple.be/x'];
  const seps = [' ', ' ', ' ', ', ', '; ', '. ', '! ', '? ', '\n\n', '\n', ' — ', ': '];
  for (let n = 0; n < 250; n += 1) {
    let text = '';
    const len = 1 + Math.floor(r() * 120);
    for (let i = 0; i < len; i += 1) text += pick(r, atoms) + pick(r, seps);
    text = text.trim();
    const max = 5 + Math.floor(r() * 300);
    const slices = sliceText(text, max, pick(r, ['fr', 'en', 'zh', 'ar']));
    assert.ok(verifyVerbatim(text, slices), `fuzz ${n}: verbatim`);
    for (const s of slices) assert.ok(codePoints(text.slice(s.start, s.end)) <= max, `fuzz ${n}: limit`);
    for (let i = 1; i < slices.length; i += 1) assert.ok(slices[i].start >= slices[i - 1].end, 'ordered and disjoint');
  }
});

test('TU-6 verifyVerbatim refuses an added, removed, reordered or overlapping slice', () => {
  const text = 'Alpha beta. Gamma delta. Epsilon.';
  const good = sliceText(text, 14, 'en');
  assert.ok(verifyVerbatim(text, good));
  assert.ok(!verifyVerbatim(text, good.slice(1)), 'a removed slice');
  assert.ok(!verifyVerbatim(text, [...good].reverse()), 'a reordered slice');
  assert.ok(!verifyVerbatim(text, [good[0], { start: good[0].start, end: good[0].end }, ...good.slice(1)]), 'an overlapping slice');
  assert.ok(!verifyVerbatim(`${text} extra`, good), 'a text with more words');
  assert.equal(stripSpace(textOf(text, good)), stripSpace(text));
});

test('TU-7 firstSentence and groupSlices keep the order and never cut a slice', () => {
  const fs = firstSentence(FR, 'fr');
  assert.equal(FR.slice(fs.start, fs.end), 'Notre atelier de Namur imprime vos photos sur des coques personnalisées.');
  assert.equal(firstSentence('   ', 'fr'), null);
  const slices = sliceText(FR, 60, 'fr');
  const groups = groupSlices(FR, slices, 90);
  assert.deepEqual(groups.flatMap((g) => g.slices), slices);
  for (const g of groups) assert.ok(g.chars <= 90 || g.slices.length === 1);
});
