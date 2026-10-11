import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREATIVE_KNOWLEDGE, KNOWLEDGE_DOMAIN, principleById, principlesAsText, principlesFor, REASONING_STAGE, validateKnowledge,
} from '../src/creative-brain/index.js';

// The Creative Knowledge (`// CK-N` markers): principles with purpose and failure modes, covering the required domains, free of motifs, brands, figures and shortcuts.

const MOTIFS = /\b(book|bird|moon|star|stars|foliage|fern|moss|mushroom|flower|flowers|stork|crib|cradle|balloon|ribbon|heart|hearts|rose|roses|candle|cake|ring|rings|wedding|birth|baby|newborn|funeral|memorial|teacher|christmas|birthday)\b/i;

test('CK-1 the knowledge covers every required domain, with enough principles to reason with', () => {
  const byDomain = Object.fromEntries(Object.values(KNOWLEDGE_DOMAIN).map((d) => [d, CREATIVE_KNOWLEDGE.filter((p) => p.domain === d)]));
  assert.deepEqual(Object.keys(byDomain), ['ATTENTION', 'HIERARCHY', 'COMPOSITION', 'STORYTELLING', 'PREMIUM_CRAFT', 'COMMERCIAL_COMMUNICATION', 'DISTINCTIVENESS', 'OCCASION_INTELLIGENCE']);
  for (const [domain, list] of Object.entries(byDomain)) assert.ok(list.length >= 3, `${domain} has ${list.length}`);
  // the topics named in the mandate are each represented
  const text = JSON.stringify(CREATIVE_KNOWLEDGE).toLowerCase();
  for (const topic of ['focal point', 'entry point', 'eye path', 'salience', 'visual weight', 'dominance is contextual', 'intentional asymmetry', 'negative space', 'foreground', 'grouping', 'alignment', 'scale',
    'central idea', 'visual metaphor', 'narrative', 'emotional payoff', 'restraint', 'material', 'light', 'typography', 'micro', 'product recognition', 'claim', 'price', 'generic', 'reason for every', 'occasion']) {
    assert.ok(text.includes(topic) || text.includes(topic.replace('micro', 'detail')), topic);
  }
});

test('CK-2 every principle teaches WHY and how it FAILS, with real tensions and stages (not a bare rule)', () => {
  const ids = new Set(CREATIVE_KNOWLEDGE.map((p) => p.id));
  assert.equal(ids.size, CREATIVE_KNOWLEDGE.length);
  for (const p of CREATIVE_KNOWLEDGE) {
    assert.ok(p.purpose.length > 20 && p.principle.length > 30, p.id);
    assert.ok(p.failure_modes.length >= 2, `${p.id} has failure modes`);
    assert.ok(p.failure_modes.every((m) => m.length > 12));
    assert.ok(p.tensions.every((t) => ids.has(t) && t !== p.id), `${p.id} tensions`);
    assert.ok(p.stages.length >= 1 && p.stages.every((s) => Object.values(REASONING_STAGE).includes(s)));
  }
  assert.ok(CREATIVE_KNOWLEDGE.some((p) => p.tensions.length > 0));
  assert.ok(Object.isFrozen(CREATIVE_KNOWLEDGE) && Object.isFrozen(CREATIVE_KNOWLEDGE[0]) && Object.isFrozen(CREATIVE_KNOWLEDGE[0].failure_modes));
});

test('CK-3 dominance is contextual: the principle states both cases and the way back to the product', () => {
  const p = principleById('HIE-CONTEXTUAL');
  assert.match(p.principle, /product hero usually needs immediate recognition/);
  assert.match(p.principle, /emotional idea may attract attention first/);
  assert.match(p.principle, /resolves back to the product/);
  assert.ok(p.failure_modes.some((m) => /never resolves to the product/.test(m)));
  assert.ok(p.failure_modes.some((m) => /dominates by habit/.test(m)));
  assert.ok(principleById('HIE-PROPORTION').failure_modes.some((m) => /overpowers the subject/.test(m)));
  assert.ok(principleById('ATT-WEIGHT').failure_modes.some((m) => /rigid, mechanical stack/.test(m)));
});

test('CK-4 occasion intelligence teaches how to reason, never what an occasion looks like: no motif, no occasion-to-image shortcut', () => {
  const occasion = CREATIVE_KNOWLEDGE.filter((p) => p.domain === 'OCCASION_INTELLIGENCE');
  assert.ok(occasion.length >= 4);
  assert.ok(occasion.some((p) => /register/i.test(p.principle)));
  assert.ok(occasion.some((p) => /who gives|giv/i.test(p.name + p.principle)));
  assert.ok(occasion.some((p) => /moment/i.test(p.principle)));
  const shortcut = principleById('OCC-NO-SHORTCUT');
  assert.match(shortcut.principle, /shortcut, not a concept/);
  assert.ok(shortcut.failure_modes.some((m) => /familiar image is used without being argued/.test(m)));
  // nothing in the whole knowledge names a motif, an occasion or an image that goes with one
  assert.doesNotMatch(JSON.stringify(CREATIVE_KNOWLEDGE), MOTIFS);
});

test('CK-5 the knowledge is generic: no figure, coordinate, colour code, brand, product, merchant or provider', () => {
  const text = JSON.stringify(CREATIVE_KNOWLEDGE.map((p) => ({ ...p, id: '' })));
  assert.doesNotMatch(text, /[0-9]/);
  assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b|\b(px|pt|em|rem)\b/i);
  assert.doesNotMatch(text, /\b(HABB|Samsung|Galaxy|Namur|qwen|alibaba|openai|claude|krea|gemini)\b/i);
});

test('CK-6 knowledge is projected by stage and domain for a model instruction, compactly and without private reasoning', () => {
  const ideate = principlesFor({ stage: REASONING_STAGE.IDEATE });
  assert.ok(ideate.some((p) => p.id === 'STO-IDEA') && ideate.some((p) => p.id === 'OCC-NO-SHORTCUT'));
  assert.ok(!ideate.some((p) => p.id === 'COM-SCALE'));
  const only = principlesFor({ domains: [KNOWLEDGE_DOMAIN.ATTENTION] });
  assert.ok(only.length >= 3 && only.every((p) => p.domain === 'ATTENTION'));
  const text = principlesAsText(ideate);
  assert.match(text, /STO-IDEA A central idea:/);
  assert.match(text, /Fails when:/);
  assert.equal(text.split('\n').length, ideate.length);
  assert.equal(principleById('NOPE'), null);
});

test('CK-7 the knowledge validator refuses an incomplete or dishonest principle', () => {
  const good = CREATIVE_KNOWLEDGE.map((p) => structuredClone(p));
  assert.doesNotThrow(() => validateKnowledge(good));
  const mutate = (fn) => { const copy = good.map((p) => structuredClone(p)); fn(copy); return copy; };
  assert.throws(() => validateKnowledge(mutate((c) => { c[0].failure_modes = []; })), /no failure mode/);
  assert.throws(() => validateKnowledge(mutate((c) => { c[0].tensions = ['UNKNOWN']; })), /unknown tension/);
  assert.throws(() => validateKnowledge(mutate((c) => { c[0].stages = ['NOPE']; })), (e) => e.code === 'BRAIN_ENUM_INVALID');
  assert.throws(() => validateKnowledge(mutate((c) => { c[0].domain = 'NOPE'; })), (e) => e.code === 'BRAIN_ENUM_INVALID');
  assert.throws(() => validateKnowledge(mutate((c) => { c[1].id = c[0].id; })), /repeated/);
  assert.throws(() => validateKnowledge(mutate((c) => { c[0].purpose = 'ok'; })), (e) => e.code === 'BRAIN_TEXT_INVALID');
  assert.throws(() => validateKnowledge(mutate((c) => { delete c[0].purpose; })), (e) => e.code === 'BRAIN_MISSING_KEY');
  assert.throws(() => validateKnowledge(mutate((c) => { c[0].principle += ' at 42 percent'; })), (e) => e.code === 'BRAIN_NUMERIC_VALUE');
});
