import test from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  ART_LIMITS, buildArtDirectionInstruction, createCreativeBrain, FORBIDDEN_SCENE_WORDS, normalizeArtDirection, normalizeConceptSet, substituteWordsIn, SUBSTITUTE_LEXICON,
} from '../src/creative-brain/index.js';
import {
  artDirectionAnswer, brief as makeBrief, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// THE ART DIRECTION CONTRACT AGAINST A LIVE ANSWER (`// AC-N` markers). Regression of the fifth live attempt: the art director answered a well-formed art direction in which ONE narrative element
// said "a flat luminous surface suggesting a screen left behind"; the word "screen" is on the list of words the scene may not carry (a device-like object near the product zone), the whole answer
// was refused, and the instruction had never listed that word. The structure below is that answer's; the words are the test world's.

const concept = normalizeConceptSet(CONCEPTS)[0];
const ad = (over) => artDirectionAnswer(over);
const code = (answer) => { try { normalizeArtDirection(answer, { concept }); return null; } catch (e) { return `${e.code}${e.detail?.problem ? `/${e.detail.problem}` : ''}@${e.field}`; } };
const element = (text, reason = 'they show the maker has just finished, the care taken in the making') => ({ element: text, reason, zone: 'BACKGROUND' });

test('AC-1 the failed structure: one forbidden word in one element refuses the answer, with the field, the problem and the word; the same answer without the word is valid', () => {
  const failed = ad({ narrative_elements: [element('A flat luminous surface suggesting a screen left behind'), element('A worn pair of tools laid aside at the edge of the bench')] });
  assert.equal(code(failed), 'BRAIN_FORBIDDEN_CONTENT/SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT@art_direction.narrative_elements[0].element');
  const error = (() => { try { normalizeArtDirection(failed, { concept }); } catch (e) { return e; } return null; })();
  assert.deepEqual(error.detail.words, ['screen']);
  assert.equal(code({ ...failed, narrative_elements: [element('A flat luminous surface suggesting a glow left behind'), failed.narrative_elements[1]] }), null);
});

test('AC-2 the instruction prints EXACTLY the forbidden words the validator refuses: nothing hidden, nothing extra', () => {
  const { system } = buildArtDirectionInstruction({ frame: { f: 1 }, concept: { c: 1 } });
  const printed = system.split('\n').find((l) => l.startsWith('Nordla REFUSES'));
  assert.ok(printed);
  for (const word of FORBIDDEN_SCENE_WORDS) assert.ok(printed.includes(word), `the instruction lists "${word}"`);
  for (const [group, words] of Object.entries(SUBSTITUTE_LEXICON)) assert.ok(words.length > 0 && Object.isFrozen(words), group);
  // every listed word is refused in a narrative element AND in a permitted secondary element; and no unlisted common word is
  for (const word of FORBIDDEN_SCENE_WORDS) {
    assert.match(code(ad({ narrative_elements: [element(`a quiet ${word} in the corner`)] })) ?? '', /BRAIN_FORBIDDEN_CONTENT/, `${word} (element)`);
    assert.match(code(ad({ permitted_secondary_elements: [`a faint ${word} at the edge`] })) ?? '', /BRAIN_FORBIDDEN_CONTENT/, `${word} (secondary)`);
  }
  assert.deepEqual(substituteWordsIn('a calm wooden bench with warm light, a pair of hands and some fabric'), []);
  // a plural, a French word and a phrase are caught; forbidden_decorative_noise may name anything
  assert.deepEqual(substituteWordsIn('two screens and an écran'), ['screens', 'écran']);
  assert.deepEqual(substituteWordsIn('the main subject of the frame'), ['main subject']);
  assert.equal(code(ad({ forbidden_decorative_noise: ['a screen', 'a phone', 'a logo'] })), null);
  assert.match(system, /even in a metaphor \("suggesting a screen" is refused\)/);
  assert.match(system, /express it WITHOUT naming it/);
});

test('AC-3 every limit of the contract is stated in the instruction and enforced at its boundary', () => {
  // the contract's numbers, pinned: a change of the contract is a deliberate act, never a side effect
  assert.deepEqual({ ...ART_LIMITS }, { text_max: 300, element_max: 140, reason_min: 12, reason_max: 220, secondary_max_items: 5, secondary_item_max: 140, noise_min_items: 1, noise_max_items: 8, noise_item_max: 140 });
  const { system } = buildArtDirectionInstruction({ frame: { f: 1 }, concept: { c: 1 } });
  for (const text of [String(ART_LIMITS.text_max), String(ART_LIMITS.element_max), `${ART_LIMITS.reason_min} to ${ART_LIMITS.reason_max}`, `0 to ${ART_LIMITS.secondary_max_items}`, `${ART_LIMITS.noise_min_items} to ${ART_LIMITS.noise_max_items}`, 'no digit at all']) {
    assert.ok(system.includes(text), text);
  }
  assert.match(system, /at least one significant word that also appears in the concept's central_idea, visual_metaphor, story or emotional_intent/);
  const pad = (n) => 'a'.repeat(n);
  // element length, reason length, secondary count and length, noise count and length
  assert.equal(code(ad({ narrative_elements: [element(`calm ${pad(ART_LIMITS.element_max - 5)}`)] })), null);
  assert.match(code(ad({ narrative_elements: [element(`calm ${pad(ART_LIMITS.element_max - 4)}`)] })) ?? '', /BRAIN_TEXT_INVALID@art_direction.narrative_elements\[0\].element/);
  const reason = (n) => `care ${pad(n - 5)}`;
  assert.equal(code(ad({ narrative_elements: [element('worn tools', reason(ART_LIMITS.reason_min))] })), null);
  assert.equal(code(ad({ narrative_elements: [element('worn tools', reason(ART_LIMITS.reason_max))] })), null);
  assert.match(code(ad({ narrative_elements: [element('worn tools', reason(ART_LIMITS.reason_min - 1))] })) ?? '', /BRAIN_TEXT_INVALID/);
  assert.match(code(ad({ narrative_elements: [element('worn tools', reason(ART_LIMITS.reason_max + 1))] })) ?? '', /BRAIN_TEXT_INVALID/);
  const items = (n) => Array.from({ length: n }, (_, i) => `item ${String.fromCharCode(97 + i)}`);
  assert.equal(code(ad({ permitted_secondary_elements: items(ART_LIMITS.secondary_max_items) })), null);
  assert.match(code(ad({ permitted_secondary_elements: items(ART_LIMITS.secondary_max_items + 1) })) ?? '', /BRAIN_LIST_INVALID/);
  assert.equal(code(ad({ forbidden_decorative_noise: items(ART_LIMITS.noise_max_items) })), null);
  assert.match(code(ad({ forbidden_decorative_noise: items(ART_LIMITS.noise_max_items + 1) })) ?? '', /BRAIN_LIST_INVALID/);
  assert.match(code(ad({ forbidden_decorative_noise: [] })) ?? '', /BRAIN_LIST_INVALID/);
  assert.match(code(ad({ forbidden_decorative_noise: [pad(ART_LIMITS.noise_item_max + 1)] })) ?? '', /BRAIN_TEXT_INVALID/);
  assert.match(code(ad({ atmosphere: pad(ART_LIMITS.text_max + 1) })) ?? '', /BRAIN_TEXT_INVALID/);
  // a digit anywhere in the four semantic lines, as the instruction says
  for (const field of ['atmosphere', 'material_language', 'lighting_intent', 'rationale']) assert.match(code(ad({ [field]: 'a quiet room lit at 5 pm' })) ?? '', /BRAIN_FORBIDDEN_CONTENT/, field);
});

const PICKS = [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }];
const script = (art) => scriptedPort({
  frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [evaluationsAnswer(normalizeConceptSet(CONCEPTS), PICKS)], art_direct: [art], compose: [compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' })],
});

test('AC-4 a refused art direction keeps the SELECTED concept in the record of the stopped plan, and calls ART_DIRECT once', async () => {
  const failed = ad({ narrative_elements: [element('A flat luminous surface suggesting a screen left behind')] });
  const port = script(failed);
  const brain = createCreativeBrain({ complete: port.complete, ledger: createDecisionLedger(), bounds: { concept_rounds: 2, concepts_per_round: 3 } });
  const error = await brain.plan({ brief: makeBrief() }).catch((e) => e);
  assert.equal(error.brain_stage, 'ART_DIRECT');
  assert.equal(error.detail.problem, 'SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT');
  assert.equal(error.evidence.raw_answer, JSON.stringify(failed));
  assert.equal(port.calls.filter((c) => c.stage === 'art_direct').length, 1, 'no automatic second art direction');
  const progress = brain.progress();
  assert.equal(progress.concept.concept_id, progress.rounds[0].selection.concept_id);
  assert.ok(progress.concept.central_idea && progress.concept.visual_metaphor);
  assert.equal(progress.art_direction, undefined);
});

test('AC-5 a near-miss key of the art direction answer, also inside a narrative element, is repaired and recorded; a forbidden word is still refused', async () => {
  const typo = { ...artDirectionAnswer({ narrative_elements: [{ element: 'worn tools laid aside', reasn: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' }] }) };
  typo.visual_tension_ = typo.visual_tension; delete typo.visual_tension;
  const ledger = createDecisionLedger();
  const out = await createCreativeBrain({ complete: script(typo).complete, ledger }).plan({ brief: makeBrief() });
  assert.equal(out.status, 'PLANNED');
  assert.deepEqual(ledger.of('ART_DIRECTION')[0].outcome.key_repairs, [{ path: 'ART_DIRECT', from: 'visual_tension_', to: 'visual_tension' }, { path: 'ART_DIRECT.narrative_elements[0]', from: 'reasn', to: 'reason' }]);
  const bad = { ...typo, narrative_elements: [{ element: 'a flat luminous screen', reasn: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' }] };
  const e = await createCreativeBrain({ complete: script(bad).complete }).plan({ brief: makeBrief() }).catch((x) => x);
  assert.equal(e.detail.problem, 'SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT');
  assert.deepEqual(e.evidence.key_repairs.map((r) => r.to), ['visual_tension', 'reason']);
});
