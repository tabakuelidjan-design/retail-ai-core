import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as C from '../src/creative-critic/index.js';
import * as CI from '../src/creative-intelligence/index.js';
import {
  computeLayoutCapabilityProfile, createDecisionLedger, createRevisionDirector, directionDelta, DIRECTOR_CONSTANTS,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, directorAnswer, fonts, IDS,
} from './runtime-world.js';

// The creative ambition of a revision (`// CA-N` markers): a conceptual leap, six generic qualities, no reference content, and a stricter difference from the previous direction.

const sha = (s) => createHash('sha256').update(s).digest('hex');
const previous = JSON.parse(directorAnswer());
const critique = C.normalizeCritique({
  dimensions: C.DIMENSIONS.map((dimension) => (dimension === 'TEMPLATE_LIKE_APPEARANCE'
    ? { dimension, outcome: 'REVIEW_REQUIRED', evidence: 'The layout follows a very standard product-then-text structure.', revision_hint: 'Vary the layout structure so it feels more bespoke.' }
    : { dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' })),
}, { candidate_ref: 'candidate:test', candidate_sha256: sha('png') });
const revision = () => ({
  previous_direction: previous,
  candidate_evidence: { candidate_sha256: sha('png'), recipe_id: 'PRODUCT_HERO', spatial_intent: previous.spatial_intent, text_roles: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], plate_used: false, preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' },
  critique,
  revision_request: C.buildRevisionRequest({ critique, iteration: 2 }),
});
const capability = computeLayoutCapabilityProfile({ at: '2026-10-11T12:00:00.000Z', brief: buildBrief(), fonts });
const LEAP = (over = {}) => directorAnswer({
  concept: 'A quiet evening ritual: the case is the keepsake at the centre of a small story told by light and space.', copy_intent: 'The headline names the offer, the claim and the price stay discreet.',
  visual_intent: 'a pale mineral surface under a long low raking light, a deep soft backdrop, restrained and cool', spatial_intent: 'TEXT_DOMINANT', negative_space_intent: 'SURROUNDING', hierarchy: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'], ...over,
});
function director(answer) {
  const prompts = [];
  const agent = createRevisionDirector({ ledger: createDecisionLedger(), complete: async (p) => { prompts.push(p); return { text: answer }; }, constants: DIRECTOR_CONSTANTS });
  const claims = ['claim://test/promise', 'claim://test/price'];
  const invoke = (ambition) => agent.invoke({
    brief: { public_facts: {}, approved_text_roles: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], format: {}, expression: BRAND.expression },
    ids: { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, asset_refs: ['asset://test/runtime/real-case'], claim_refs: claims, evidence_refs: [] },
    revision: revision(), capability, ...(ambition === undefined ? {} : { ambition }),
  }, { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, claim_refs: claims });
  return { invoke, prompts };
}

test('CA-1 the ambition names the six generic qualities and asks for a conceptual leap, not a clean-up', () => {
  assert.deepEqual(C.CREATIVE_AMBITION.qualities.map((q) => q.dimension), ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR']);
  for (const q of C.CREATIVE_AMBITION.qualities) assert.equal(q.question, C.AMBITION_QUESTIONS[q.dimension]);
  assert.match(C.CREATIVE_AMBITION.instruction, /Do not merely clean it up: attempt a conceptual leap/);
  assert.match(C.CREATIVE_AMBITION.instruction, /Invent the concept yourself.*copy nothing from any reference/);
  assert.match(C.CREATIVE_AMBITION.instruction, /real product and the approved texts are fixed/);
  assert.ok(Object.isFrozen(C.CREATIVE_AMBITION) && Object.isFrozen(C.CREATIVE_AMBITION.qualities[0]));
  // the critic's closed vocabulary is unchanged: these are reasoning targets of the Director, not critic dimensions
  assert.equal(C.DIMENSIONS.length, 14);
  for (const d of Object.values(C.AMBITION_DIMENSION)) assert.ok(!C.DIMENSIONS.includes(d), d);
});

test('CA-2 the ambition is generic: no subject, motif, colour, typeface, product, occasion or reference content', async () => {
  const text = JSON.stringify(C.CREATIVE_AMBITION);
  assert.doesNotMatch(text, /\b(book|bird|moon|star|foliage|fern|moss|mushroom|leaf|leaves|flower|baby|birth|naissance|welcome|calligraph|script|serif|blue|green|navy|gold|HABB|Samsung|phone|case|coque|Namur)\b/i);
  assert.doesNotMatch(text, /\d/); // no size, no count, no coordinate
  const source = await readFile(new URL('../src/creative-critic/ambition.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /\b(book|bird|moon|foliage|mushroom|HABB|Samsung)\b/i);
});

test('CA-3 the revision Director receives the ambition (instruction and qualities) only when it is asked for, and only as the canonical object', async () => {
  const withAmbition = director(LEAP());
  const reply = await withAmbition.invoke(C.CREATIVE_AMBITION);
  assert.equal(reply.directions[0].spatial_intent, 'TEXT_DOMINANT');
  const wire = JSON.parse(withAmbition.prompts[0].user);
  assert.deepEqual(wire.creative_ambition, JSON.parse(JSON.stringify(C.CREATIVE_AMBITION)));
  assert.ok(withAmbition.prompts[0].system.includes(C.CREATIVE_AMBITION.instruction));
  // the layout capabilities, the intents and the critique are still there
  for (const key of ['layout_capabilities', 'revision_intents', 'critique', 'previous_direction', 'previous_candidate']) assert.ok(key in wire, key);
  // without it, nothing of it is sent
  const plain = director(LEAP());
  await plain.invoke(undefined);
  assert.ok(!('creative_ambition' in JSON.parse(plain.prompts[0].user)));
  assert.ok(!plain.prompts[0].system.includes('conceptual leap'));
  // anything else is refused before the model is consulted: a reference description, a motif, a changed instruction
  for (const forged of [
    { ...C.CREATIVE_AMBITION, instruction: `${C.CREATIVE_AMBITION.instruction} Draw an open book with a bird.` },
    { ...C.CREATIVE_AMBITION, reference: 'the attached image' },
    { kind: 'CREATIVE_AMBITION', instruction: 'be amazing', qualities: [] },
    'free text', { qualities: C.CREATIVE_AMBITION.qualities },
  ]) {
    const d = director(LEAP());
    const error = await d.invoke(forged).catch((e) => e);
    assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
    assert.equal(error.detail.cause.code, 'REVISION_AMBITION_NOT_CANONICAL');
    assert.equal(d.prompts.length, 0);
  }
});

test('CA-4 an ambitious revision is a leap, not a clean-up: it needs a structural change AND a rewritten idea', async () => {
  const same = JSON.parse(directorAnswer());
  const reword = { ...same, concept: 'An entirely different idea about another subject and composition.', visual_intent: 'a warm wooden counter in raking late light with grain' };
  assert.equal(directionDelta(same, reword).meaningful, true); // enough for an ordinary revision
  assert.equal(directionDelta(same, reword, { ambitious: true }).meaningful, false); // not for an ambitious one: nothing structural changed
  const moved = { ...reword, spatial_intent: 'TEXT_DOMINANT' };
  assert.equal(directionDelta(same, moved, { ambitious: true }).meaningful, true);
  assert.equal(directionDelta(same, { ...same, spatial_intent: 'TEXT_DOMINANT' }, { ambitious: true }).meaningful, false); // a structural change alone is not a new idea
  // through the agent
  const clean = await director(directorAnswer({ ...reword, spatial_intent: same.spatial_intent, hierarchy: same.hierarchy })).invoke(C.CREATIVE_AMBITION).catch((e) => e);
  assert.equal(clean.detail.cause.code, 'REVISED_DIRECTION_NOT_DIFFERENT');
  const leap = await director(LEAP()).invoke(C.CREATIVE_AMBITION);
  assert.equal(leap.directions.length, 1);
  // and the ordinary path is unchanged
  assert.equal((await director(directorAnswer({ ...reword, spatial_intent: same.spatial_intent, hierarchy: same.hierarchy })).invoke(undefined)).directions.length, 1);
});

test('CA-5 only cycle 2 carries the ambition; the runtime passes it through the revision path only', async () => {
  const script = (await readFile(new URL('../scripts/run-c3-revision.mjs', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.ok(script.includes('...(CYCLE === 2 ? { ambition: CREATIVE_AMBITION } : {})'));
  assert.ok(script.includes('ambition: CYCLE === 2 ? CREATIVE_AMBITION : null'));
  const runtime = (await readFile(new URL('../src/creative-runtime/runtime.js', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.ok(runtime.includes('agents.revision_director.invoke({ ...directorInput, revision, capability, ...(ambition ? { ambition } : {}) }, directorContext)'));
  assert.ok(runtime.includes(': await agents.director.invoke(directorInput, directorContext);')); // the initial Director never receives it
  const ambition = await readFile(new URL('../src/creative-critic/ambition.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ambition.replace(/\/\/.*$/gm, ''), /owner-review|import /); // no import at all, the owner review least of all
});
