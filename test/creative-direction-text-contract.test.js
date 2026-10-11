import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as C from '../src/creative-critic/index.js';
import * as CI from '../src/creative-intelligence/index.js';
import {
  buildExecutionChain, classifyRuntimeError, computeLayoutCapabilityProfile, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst,
  createRevisionDirector, createVisualProductionDirector, DECISION, describeStop, DIRECTION_TEXT_MAX_CHARS, DIRECTION_TEXT_RULE, directionTextProblems, DIRECTOR_CONSTANTS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts, GUARDIAN_PASS, IDS,
} from './runtime-world.js';

// The text contract of a Creative Direction, enforced before acceptance (`// TC-N` markers): 300 characters accepted, 301 refused with a precise code, never truncated; classified at the revised-direction stage.

const AT = '2026-10-11T12:00:00.000Z';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pad = (text, length) => `${text}${'x'.repeat(length - text.length)}`;
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
const capability = computeLayoutCapabilityProfile({ at: AT, brief: buildBrief(), fonts });
const LEAP = (over = {}) => directorAnswer({
  concept: 'A quiet evening ritual: the keepsake rests at the centre of a small story told by light and space.', copy_intent: 'The headline names the offer; the claim and the price stay discreet.',
  visual_intent: 'a pale mineral surface under a long low raking light, a deep soft backdrop, restrained and cool', spatial_intent: 'TEXT_DOMINANT', negative_space_intent: 'SURROUNDING', hierarchy: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'], ...over,
});
function revisionDirector(answer) {
  const prompts = []; const ledger = createDecisionLedger();
  const agent = createRevisionDirector({ ledger, complete: async (p) => { prompts.push(p); return { text: answer }; }, constants: DIRECTOR_CONSTANTS });
  const claims = ['claim://test/promise', 'claim://test/price'];
  const invoke = (ambition) => agent.invoke({
    brief: { public_facts: {}, approved_text_roles: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], format: {}, expression: BRAND.expression },
    ids: { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, asset_refs: ['asset://test/runtime/real-case'], claim_refs: claims, evidence_refs: [] },
    revision: revision(), capability, ...(ambition === undefined ? {} : { ambition }),
  }, { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, claim_refs: claims });
  return { invoke, prompts, ledger };
}

test('TC-1 exactly 300 characters are accepted (unchanged), 301 are refused with a precise code', async () => {
  assert.equal(DIRECTION_TEXT_MAX_CHARS, 300);
  const at300 = pad('a pale mineral surface under a long low raking light, ', 300);
  const at301 = pad('a pale mineral surface under a long low raking light, ', 301);
  assert.equal(at300.length, 300);
  const ok = revisionDirector(LEAP({ visual_intent: at300 }));
  const accepted = await ok.invoke(C.CREATIVE_AMBITION);
  assert.equal(accepted.directions[0].visual_intent, at300); // not trimmed, not rewritten
  const bad = revisionDirector(LEAP({ visual_intent: at301 }));
  const error = await bad.invoke(C.CREATIVE_AMBITION).catch((e) => e);
  assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
  assert.equal(error.detail.cause.code, 'VISUAL_INTENT_TOO_LONG');
  // the other two descriptive fields obey the same limit, with their own codes
  for (const [field, code] of [['concept', 'CONCEPT_TOO_LONG'], ['copy_intent', 'COPY_INTENT_TOO_LONG']]) {
    const e = await revisionDirector(LEAP({ [field]: pad('An idea. ', 301) })).invoke(C.CREATIVE_AMBITION).catch((x) => x);
    assert.equal(e.detail.cause.code, code);
    assert.equal((await revisionDirector(LEAP({ [field]: pad('An idea. ', 300) })).invoke(C.CREATIVE_AMBITION)).directions.length, 1);
  }
  // the canonical Creative Direction contract has the very same limit
  const base = { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, concept: 'c', copy_intent: 'c', product_role: 'HERO', spatial_intent: 'TEXT_DOMINANT', negative_space_intent: 'TOP', hierarchy: ['HEADLINE', 'PRODUCT'], required_asset_refs: [], claim_refs: [], forbidden_transformations: [], evidence_refs: [] };
  assert.equal(CI.normalizeCreativeDirection({ ...base, visual_intent: at300 }).visual_intent, at300);
  assert.throws(() => CI.normalizeCreativeDirection({ ...base, visual_intent: at301 }), (e) => e.code === 'CI_INVALID_FIELD');
});

test('TC-2 nothing is silently shortened: an oversized answer yields no direction, no revised-direction record, and a measurement in the ledger (never the text)', async () => {
  const text = pad('a pale mineral surface under a long low raking light, ', 412);
  const d = revisionDirector(LEAP({ visual_intent: text }));
  const error = await d.invoke(C.CREATIVE_AMBITION).catch((e) => e);
  assert.equal(error.detail.cause.code, 'VISUAL_INTENT_TOO_LONG');
  const rows = d.ledger.entries();
  assert.deepEqual(rows.map((r) => r.decision), [DECISION.DIRECTION_REFUSED]);
  assert.deepEqual(rows[0].outcome.refused, [{ field: 'visual_intent', problem: 'TOO_LONG', length: 412, limit: 300 }]);
  assert.ok(!JSON.stringify(rows).includes('raking light')); // the creative text itself is not copied into the record
  assert.ok(!rows.some((r) => [DECISION.REVISION_DIRECTION, DECISION.CREATIVE_DIRECTION].includes(r.decision)));
  // other violations are refused as well, with their own codes
  assert.deepEqual(directionTextProblems({ concept: 'ok', copy_intent: 'ok', visual_intent: 'line one\nline two' }).map((p) => p.problem), ['NOT_SINGLE_LINE']);
  assert.deepEqual(directionTextProblems({ concept: 'ok', copy_intent: 'ok', visual_intent: 'bell\u0007' }).map((p) => p.problem), ['NOT_SINGLE_LINE']);
  assert.deepEqual(directionTextProblems({ concept: 'ok', copy_intent: '   ', visual_intent: 'ok' }).map((p) => p.problem), ['EMPTY']);
  assert.deepEqual(directionTextProblems({ concept: 'ok', copy_intent: 'ok' }).map((p) => p.problem), ['MISSING']);
  assert.deepEqual(directionTextProblems({ concept: 'ok', copy_intent: 'ok', visual_intent: 'ok' }), []);
});

test('TC-3 both Directors state the limit in their instruction, and the conceptual-leap requirement is still there', async () => {
  const rev = revisionDirector(LEAP());
  await rev.invoke(C.CREATIVE_AMBITION);
  assert.ok(rev.prompts[0].system.includes(DIRECTION_TEXT_RULE));
  assert.ok(rev.prompts[0].system.includes(C.CREATIVE_AMBITION.instruction));
  assert.match(DIRECTION_TEXT_RULE, /ONE line of plain text of at most 300 characters/);
  assert.doesNotMatch(DIRECTION_TEXT_RULE, /\b(HABB|Samsung|phone|case|book|bird)\b/i);
  // the initial Director builds on the same instruction and refuses the same way
  const prompts = [];
  const ledger = createDecisionLedger();
  const initial = createCreativeDirector({ ledger, complete: async (p) => { prompts.push(p); return { text: directorAnswer({ visual_intent: pad('a calm surface, ', 301) }) }; }, constants: DIRECTOR_CONSTANTS });
  const error = await initial.invoke({
    brief: { public_facts: {}, approved_text_roles: ['HEADLINE'], format: {}, expression: BRAND.expression },
    ids: { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, asset_refs: ['asset://test/runtime/real-case'], claim_refs: [], evidence_refs: [] },
  }, { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, claim_refs: [] }).catch((e) => e);
  assert.ok(prompts[0].system.includes(DIRECTION_TEXT_RULE));
  assert.equal(error.detail.cause.code, 'VISUAL_INTENT_TOO_LONG');
  assert.deepEqual(ledger.entries().map((r) => [r.decision, r.decided_by]), [[DECISION.DIRECTION_REFUSED, 'nordla:creative-director@1']]);
  // and a rich, narrative idea fits the contract: the ambition is not weakened by it
  const rich = LEAP({
    concept: pad('A slow evening ritual: the keepsake becomes the quiet centre of a small story told only through light, material and space, so the gift feels already lived in. ', 300),
    visual_intent: pad('a cool honed mineral surface under a long low raking light, a deep soft backdrop fading to shadow, restrained palette, calm and unhurried, with generous empty space around the centre. ', 300),
  });
  const reply = await revisionDirector(rich).invoke(C.CREATIVE_AMBITION);
  assert.equal(reply.directions[0].concept.length, 300);
  assert.equal(reply.directions[0].visual_intent.length, 300);
  assert.equal(reply.directions[0].spatial_intent, 'TEXT_DOMINANT'); // still a structural leap
});

test('TC-4 a provider success followed by an invalid direction is classified at the revised-direction stage, never as a reporting defect', async () => {
  const d = revisionDirector(LEAP({ visual_intent: pad('a pale surface, ', 301) }));
  const error = await d.invoke(C.CREATIVE_AMBITION).catch((e) => e);
  assert.equal(classifyRuntimeError(error), 'REVISION_DIRECTION_INVALID');
  const stop = describeStop({ error });
  assert.equal(stop.cause, 'REVISION_DIRECTION_INVALID');
  assert.equal(stop.stage, 'REVISED_CREATIVE_DIRECTION');
  assert.equal(stop.detail, 'VISUAL_INTENT_TOO_LONG');
  assert.match(stop.status, /^STOPPED_AT_REVISED_CREATIVE_DIRECTION: REVISION_DIRECTION_INVALID \(VISUAL_INTENT_TOO_LONG\); no candidate reached/);
  // the shape the failed live attempt had: the canonical contract refusing the field outside the agent's failure channel
  const contract = Object.assign(new Error('direction.visual_intent must be 1..300 printable characters'), { code: 'CI_INVALID_FIELD', detail: { field: 'direction.visual_intent' } });
  assert.equal(classifyRuntimeError(contract), 'REVISION_DIRECTION_INVALID');
  const old = describeStop({ error: contract });
  assert.match(old.status, /^STOPPED_AT_REVISED_CREATIVE_DIRECTION: REVISION_DIRECTION_INVALID \(CI_INVALID_FIELD:direction\.visual_intent\)/);
  // another contract error outside the direction stays unclassified
  assert.equal(classifyRuntimeError(Object.assign(new Error('x'), { code: 'CI_INVALID_FIELD', detail: { field: 'layer.color' } })), 'RUNTIME_REPORTING_DEFECT');
  // the execution chain: the provider answered, the revised direction was REJECTED, nothing after it ran or was sent
  const events = [{ event: 'RESERVED', operation_id: 'op-1', model: 'm' }, { event: 'SUCCEEDED', operation_id: 'op-1', model: 'm', request_id: 'chatcmpl-x' }];
  const chain = Object.fromEntries(buildExecutionChain({ result: { ledger: d.ledger.entries() }, error, events }).map((c) => [c.step, c.state]));
  assert.equal(chain['Revision Director call'], 'SENT');
  assert.equal(chain['Revision Director provider result'], 'SUCCESS');
  assert.equal(chain['Revised Creative Direction'], 'REJECTED');
  for (const step of ['Meaningful-difference check', 'Visual Production Director', 'Environment suitability gate', 'Layout plan', 'Render', 'Preflight', 'Fidelity', 'Brand Guardian']) assert.equal(chain[step], 'NOT RUN', step);
  assert.equal(chain['Environment image call'], 'NOT SENT');
});

test('TC-5 through the runtime: after an invalid direction no strategy runs, no environment image is requested and nothing is composed', async () => {
  const ledger = createDecisionLedger(); const environment = fakeEnvironmentPort();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: createCreativeDirector({ ledger, complete: async () => { throw new Error('the initial Director is not used'); }, constants: DIRECTOR_CONSTANTS }),
    revision_director: createRevisionDirector({ ledger, complete: async () => ({ text: LEAP({ visual_intent: pad('a pale surface, ', 301) }) }), constants: DIRECTOR_CONSTANTS }),
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  const error = await runProductPreservingCreative({
    at: AT, brief: buildBrief(), fonts, ledger, guardian: GUARDIAN_PASS, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, revision: revision(), ambition: C.CREATIVE_AMBITION,
  }).catch((e) => e);
  assert.equal(error.detail.cause.code, 'VISUAL_INTENT_TOO_LONG');
  assert.equal(environment.calls.length, 0);
  const seen = ledger.entries().map((e) => e.decision);
  assert.deepEqual(seen, [DECISION.PRODUCT_PRESERVATION_MODE, DECISION.DIRECTION_REFUSED]);
  assert.equal(describeStop({ error }).stage, 'REVISED_CREATIVE_DIRECTION');
});
