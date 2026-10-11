import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertConceptsDistinct, buildConceptInstruction, buildFramerInstruction, buildProblemFrame, conceptualWords, CONCEPT_COUNT, createConceptDirector, createProblemFramer, FIXED_KIND, MAY_CHANGE,
  normalizeConcept, normalizeConceptSet, normalizeProblemFrame, observeBrief,
} from '../src/creative-brain/index.js';
import {
  brief as makeBrief, CONCEPTS, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// OBSERVE, FRAME and IDEATE (`// FC-N` markers).

const observation = () => observeBrief({ brief: makeBrief() });
const code = (fn, c) => assert.throws(fn, (e) => e.code === c, c);
const MOTIF_OR_BRAND = /\b(HABB|Samsung|Galaxy|Namur|qwen|alibaba|book|bird|moon|foliage|mushroom|birth|wedding|baby)\b/i;

test('FC-1 the observation is a deterministic reading of the brief: references and words, never pixels', () => {
  const o = observation();
  assert.deepEqual(o.approved_text_roles, ['HEADLINE', 'PRICE', 'SUBHEADLINE']);
  assert.deepEqual(o.claim_refs, ['claim://test/price', 'claim://test/promise']);
  assert.equal(o.asset_origin, 'MERCHANT_PROVIDED');
  assert.equal(o.format.aspect_ratio, '4:5');
  assert.deepEqual(o, observation());
  assert.ok(Object.isFrozen(o));
  assert.doesNotMatch(JSON.stringify(o), /bytes|pixels/i);
});

test('FC-2 the frame answers the questions; what is fixed and what may change are Nordla\'s, never the model\'s', () => {
  const frame = buildProblemFrame({ observation: observation(), model: frameAnswer() });
  for (const key of ['what_we_show', 'audience', 'understood_immediately', 'felt', 'remembered', 'commercial_objective', 'occasion_context', 'generic_risks', 'distinctive_levers']) assert.ok(frame[key].length > 0, key);
  assert.match(frame.frame_id, /^cpf_[0-9a-f]{32}$/);
  // fixed: from the observation, always the product pixels, fidelity, the format, the brand rules, every approved text and claim
  const kinds = frame.fixed.map((f) => f.kind);
  for (const k of [FIXED_KIND.PRODUCT_PIXELS, FIXED_KIND.PRODUCT_FIDELITY, FIXED_KIND.FORMAT, FIXED_KIND.BRAND_HARD_RULES]) assert.ok(kinds.includes(k), k);
  assert.equal(kinds.filter((k) => k === FIXED_KIND.APPROVED_TEXT).length, 3);
  assert.equal(kinds.filter((k) => k === FIXED_KIND.APPROVED_CLAIM).length, 2);
  assert.deepEqual(frame.may_change, Object.values(MAY_CHANGE));
  // the model cannot fix or free anything: those keys are not part of its answer
  code(() => buildProblemFrame({ observation: observation(), model: frameAnswer({ fixed: [] }) }), 'BRAIN_UNKNOWN_KEY');
  code(() => buildProblemFrame({ observation: observation(), model: frameAnswer({ may_change: ['EVERYTHING'] }) }), 'BRAIN_UNKNOWN_KEY');
  assert.deepEqual(frame.fixed, buildProblemFrame({ observation: observation(), model: frameAnswer({ felt: 'Something else entirely.' }) }).fixed);
  assert.ok(Object.isFrozen(frame) && Object.isFrozen(frame.fixed[0]));
});

test('FC-3 the frame contract is closed: no figure, one-line texts, bounded lists, a content-derived id', () => {
  const build = (over) => buildProblemFrame({ observation: observation(), model: frameAnswer(over) });
  code(() => build({ felt: 7 }), 'BRAIN_NUMERIC_VALUE');
  code(() => build({ generic_risks: ['a risk', 3] }), 'BRAIN_NUMERIC_VALUE');
  code(() => build({ felt: 'two\nlines' }), 'BRAIN_TEXT_INVALID');
  code(() => build({ felt: 'x'.repeat(301) }), 'BRAIN_TEXT_INVALID');
  code(() => build({ felt: '' }), 'BRAIN_TEXT_INVALID');
  code(() => build({ generic_risks: [] }), 'BRAIN_LIST_INVALID');
  code(() => build({ generic_risks: ['a', 'b', 'c', 'd', 'e', 'f'] }), 'BRAIN_LIST_INVALID');
  code(() => buildProblemFrame({ observation: observation(), model: (({ rationale, ...rest }) => rest)(frameAnswer()) }), 'BRAIN_MISSING_KEY');
  const frame = build({});
  assert.equal(frame.frame_id, build({}).frame_id);
  assert.notEqual(frame.frame_id, build({ felt: 'A different feeling.' }).frame_id);
  assert.doesNotThrow(() => normalizeProblemFrame(structuredClone(frame)));
  code(() => normalizeProblemFrame({ ...structuredClone(frame), felt: 'tampered' }), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeProblemFrame({ ...structuredClone(frame), fixed: frame.fixed.filter((f) => f.kind !== 'PRODUCT_PIXELS') }), 'BRAIN_RULE_VIOLATION');
});

test('FC-4 the framer instruction projects the principles and the observation, asks for no reasoning log, and names no brand, motif or provider', async () => {
  const { system, user } = buildFramerInstruction({ observation: observation() });
  assert.match(system, /ATT-FOCAL/);
  assert.match(system, /OCC-REGISTER/);
  assert.match(system, /You do not propose a concept, a layout or a scene here/);
  assert.match(system, /it is not a reasoning log/);
  assert.doesNotMatch(system, MOTIF_OR_BRAND);
  assert.deepEqual(Object.keys(JSON.parse(user)), ['observation']);
  const port = scriptedPort({ frame: [frameAnswer()] });
  const { frame, meta } = await createProblemFramer({ complete: port.complete }).frame({ observation: observation() });
  assert.equal(port.calls.length, 1);
  assert.equal(meta.model, 'fake-model');
  assert.equal(frame.rationale.length > 0, true);
});

test('FC-5 a failing, empty or malformed model port is a classified error with only safe diagnostics', async () => {
  const boom = createProblemFramer({ complete: async () => { throw Object.assign(new Error('secret sk-123 in message'), { code: 'Throttling', status: 429, requestId: 'rq-1' }); } });
  const error = await boom.frame({ observation: observation() }).catch((e) => e);
  assert.equal(error.code, 'BRAIN_PORT_FAILED');
  assert.deepEqual(error.detail, { name: 'Error', code: 'Throttling', status: 429, request_id: 'rq-1' });
  assert.doesNotMatch(JSON.stringify([error.message, error.detail]), /sk-123/);
  for (const text of ['not json', '[1,2]', '{"what_we_show": "x"}']) {
    const e = await createProblemFramer({ complete: async () => ({ text }) }).frame({ observation: observation() }).catch((x) => x);
    assert.ok(['BRAIN_MALFORMED', 'BRAIN_UNKNOWN_KEY', 'BRAIN_MISSING_KEY'].includes(e.code), `${text} -> ${e.code}`);
  }
  await assert.rejects(() => createProblemFramer({ complete: null }).frame({ observation: observation() }), TypeError);
});

test('FC-6 a concept has every field of its contract, closed vocabularies and an id derived from its content', () => {
  const c = normalizeConcept(CONCEPTS[0]);
  for (const key of ['concept_id', 'central_idea', 'visual_metaphor', 'story', 'emotional_intent', 'product_role', 'message_role', 'memory_hook', 'distinctiveness_reason', 'risks']) assert.ok(key in c, key);
  assert.match(c.concept_id, /^cnc_[0-9a-f]{32}$/);
  assert.equal(normalizeConcept(CONCEPTS[0]).concept_id, c.concept_id);
  code(() => normalizeConcept({ ...CONCEPTS[0], product_role: 'STAR' }), 'BRAIN_ENUM_INVALID');
  code(() => normalizeConcept({ ...CONCEPTS[0], message_role: 'SHOUTS' }), 'BRAIN_ENUM_INVALID');
  code(() => normalizeConcept({ ...CONCEPTS[0], risks: [] }), 'BRAIN_LIST_INVALID');
  code(() => normalizeConcept({ ...CONCEPTS[0], story: 'x\ny' }), 'BRAIN_TEXT_INVALID');
  code(() => normalizeConcept({ ...CONCEPTS[0], score: 9 }), 'BRAIN_NUMERIC_VALUE');
  code(() => normalizeConcept({ ...CONCEPTS[0], extra: 'x' }), 'BRAIN_UNKNOWN_KEY');
  code(() => normalizeConcept((({ memory_hook, ...rest }) => rest)(CONCEPTS[0])), 'BRAIN_MISSING_KEY');
  code(() => normalizeConcept({ ...CONCEPTS[0], concept_id: 'cnc_wrong' }), 'BRAIN_RULE_VIOLATION');
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.risks));
});

test('FC-7 a "concept" that is only a background, a colour, an alignment or a camera angle is a layout variant and is refused', () => {
  const variant = {
    ...CONCEPTS[0],
    central_idea: 'A darker background with the product centred and the text aligned to the left, shot from a lower camera angle.',
    visual_metaphor: 'A blue gradient background with a larger product, a bigger font and a cream border at the top.',
  };
  assert.throws(() => normalizeConcept(variant), (e) => e.code === 'BRAIN_NOT_DISTINCT' && e.detail.problem === 'CONCEPT_IS_A_LAYOUT_VARIANT');
  // the same idea as a real concept passes: the words that remain after removing execution vocabulary are conceptual
  assert.ok(conceptualWords(CONCEPTS[0].central_idea).length >= 6);
  assert.deepEqual(conceptualWords('The BACKGROUND, the colour and the camera angle'), []);
});

test('FC-8 concepts must differ conceptually from each other, however different their execution words', () => {
  const set = normalizeConceptSet(CONCEPTS);
  assert.equal(set.length, 3);
  assert.ok(set.length >= CONCEPT_COUNT.min && set.length <= CONCEPT_COUNT.max);
  // a second concept that restates the first with other colours, background and alignment words is not distinct
  const reworded = {
    ...CONCEPTS[0],
    central_idea: `${CONCEPTS[0].central_idea} Shown on a dark background in blue and cream tones, aligned to the left.`,
    visual_metaphor: `${CONCEPTS[0].visual_metaphor} In a cooler colour palette with a centred crop.`,
  };
  code(() => normalizeConceptSet([CONCEPTS[0], reworded, CONCEPTS[2]]), 'BRAIN_NOT_DISTINCT');
  // the same metaphor twice is not distinct either
  code(() => normalizeConceptSet([CONCEPTS[0], { ...CONCEPTS[1], visual_metaphor: CONCEPTS[0].visual_metaphor }, CONCEPTS[2]]), 'BRAIN_NOT_DISTINCT');
  // the same idea, story and intent under a brand-new metaphor is the same concept: the overlap of substance alone refuses it
  const newMetaphor = {
    ...CONCEPTS[0],
    visual_metaphor: 'A lighthouse keeper trimming the lamp before the first ship of the morning rounds the headland.',
    memory_hook: 'The lamp trimmed just in time for the ship.',
  };
  const refused = (() => { try { normalizeConceptSet([CONCEPTS[0], newMetaphor, CONCEPTS[2]]); } catch (e) { return e; } return null; })();
  assert.equal(refused?.code, 'BRAIN_NOT_DISTINCT');
  // a concept already rejected may not come back in other words
  const rejected = [normalizeConcept(CONCEPTS[1])];
  code(() => normalizeConceptSet([CONCEPTS[0], { ...CONCEPTS[1], story: `${CONCEPTS[1].story} Told differently.` }, CONCEPTS[2]], { rejected }), 'BRAIN_NOT_DISTINCT');
  assert.doesNotThrow(() => assertConceptsDistinct(set, { against: [] }));
  // bounded round
  code(() => normalizeConceptSet([CONCEPTS[0], CONCEPTS[1]]), 'BRAIN_LIST_INVALID');
  code(() => normalizeConceptSet([...CONCEPTS, ...CONCEPTS]), 'BRAIN_LIST_INVALID');
});

test('FC-9 the concept director asks for distinct concepts before layout, with the knowledge, the rejected ideas and no motif shortcut', async () => {
  const frame = buildProblemFrame({ observation: observation(), model: frameAnswer() });
  const rejected = [normalizeConcept(CONCEPTS[2])];
  const { system, user } = buildConceptInstruction({ frame, rejected });
  assert.match(system, /GENUINELY DIFFERENT concepts before any layout, scene or colour is chosen/);
  assert.match(system, /a variation of layout is not a concept and will be refused/);
  assert.match(system, /Do not reach for the image that usually comes with an occasion/);
  assert.match(system, /already rejected/);
  assert.ok(system.includes(CONCEPTS[2].central_idea));
  assert.match(system, /OCC-NO-SHORTCUT/);
  assert.doesNotMatch(system, MOTIF_OR_BRAND);
  assert.deepEqual(Object.keys(JSON.parse(user)), ['problem_frame']);
  const port = scriptedPort({ ideate: [{ concepts: CONCEPTS }] });
  const { concepts } = await createConceptDirector({ complete: port.complete }).ideate({ frame, rejected: [] });
  assert.equal(concepts.length, 3);
  // a refinement round keeps the concept to refine out of the "rejected" set
  const refine = buildConceptInstruction({ frame, refine: { concept: concepts[0], refinements: ['Make the story easier to see'] } });
  assert.match(refine.system, /REFINED, not replaced/);
  assert.match(refine.system, /improve: Make the story easier to see/);
  // a model that returns layout variants or too few concepts is refused, and a stray key too
  const bad = (answer) => createConceptDirector({ complete: async () => ({ text: JSON.stringify(answer) }) }).ideate({ frame }).catch((e) => e);
  assert.equal((await bad({ concepts: CONCEPTS.slice(0, 2) })).code, 'BRAIN_LIST_INVALID');
  assert.equal((await bad({ concepts: CONCEPTS, winner: 'x' })).code, 'BRAIN_UNKNOWN_KEY');
});
