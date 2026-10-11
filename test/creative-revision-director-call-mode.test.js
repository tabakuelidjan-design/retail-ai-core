import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as C from '../src/creative-critic/index.js';
import * as CI from '../src/creative-intelligence/index.js';
import {
  computeLayoutCapabilityProfile, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createRevisionDirector,
  createVisualProductionDirector, DECISION, DIRECTION_TEXT_RULE, DIRECTOR_CONSTANTS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { createQwenDirectorPort, REVISION_DIRECTOR_TIMEOUT_MS } from '../src/marketing-creative/alibaba/qwen-director-port.js';
import { SpendGuard } from '../src/marketing-creative/alibaba/budget.js';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts, GUARDIAN_PASS, IDS,
} from './runtime-world.js';

// The revision Director call mode (`// CM-N` markers): thinking mode explicitly OFF for the revision Director only; everything else about the call is unchanged. These tests prove the contract and the
// call mode, NOT that thinking-off preserves creative quality (Candidate 3 is the empirical test, with usage and latency recorded to compare).

const AT = '2026-10-11T12:00:00.000Z';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const config = { apiKey: 'sk-test-1234567890abcdef', workspaceId: 'ws0123456789abcd', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 120000 };
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
const USAGE = { prompt_tokens: 3700, completion_tokens: 410, total_tokens: 4110, completion_tokens_details: { reasoning_tokens: 0 } };

function wire(answer, { fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (fail === 'http500') return { ok: false, status: 500, text: async () => JSON.stringify({ code: 'InternalError', request_id: 'rq-1' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { content: answer } }], usage: USAGE }) };
  };
  return { calls, fetchImpl };
}
const revisionPort = (w, journal = []) => createQwenDirectorPort({
  config, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), journal: { append: async (e) => journal.push(e) }, fetchImpl: w.fetchImpl, timeoutMs: REVISION_DIRECTOR_TIMEOUT_MS, enableThinking: false,
});
const initialPort = (w, journal = []) => createQwenDirectorPort({ config, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), journal: { append: async (e) => journal.push(e) }, fetchImpl: w.fetchImpl });
function revisionAgent(complete, ledger = createDecisionLedger()) { return { ledger, agent: createRevisionDirector({ ledger, complete, constants: DIRECTOR_CONSTANTS }) }; }
const claims = ['claim://test/promise', 'claim://test/price'];
const invoke = (agent, ambition = C.CREATIVE_AMBITION) => agent.invoke({
  brief: { public_facts: {}, approved_text_roles: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], format: {}, expression: BRAND.expression },
  ids: { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, asset_refs: ['asset://test/runtime/real-case'], claim_refs: claims, evidence_refs: [] },
  revision: revision(), capability, ambition,
}, { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, claim_refs: claims });

test('CM-1 the revision Director call sends enable_thinking=false, with every other part of the call as before (model, 240 s bound, one call, no streaming)', async () => {
  const w = wire(LEAP()); const journal = [];
  const port = revisionPort(w, journal);
  assert.equal(port.thinking, 'DISABLED');
  assert.equal(port.timeout_ms, 240_000);
  const { agent } = revisionAgent(port);
  const reply = await invoke(agent);
  assert.equal(reply.directions[0].spatial_intent, 'TEXT_DOMINANT');
  assert.equal(w.calls.length, 1);
  const { url, body } = w.calls[0];
  assert.match(url, /eu-central-1\.maas\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions$/);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.model, 'qwen3.8-max');
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, 900);
  assert.ok(!('stream' in body));
  assert.deepEqual(Object.keys(body).sort(), ['enable_thinking', 'max_tokens', 'messages', 'model', 'temperature']);
  // usage and latency are journaled with the thinking mode, so thinking-on and thinking-off can be compared
  assert.deepEqual(journal.map((e) => [e.event, e.thinking]), [['RESERVED', 'DISABLED'], ['SUCCEEDED', 'DISABLED']]);
  const done = journal.find((e) => e.event === 'SUCCEEDED');
  assert.deepEqual(done.usage, USAGE);
  assert.equal(typeof done.latency_ms, 'number');
  assert.doesNotMatch(JSON.stringify(journal), /sk-test/);
});

test('CM-2 the initial Director is unchanged: no thinking parameter, the lane default timeout', async () => {
  const w = wire(directorAnswer()); const journal = [];
  const port = initialPort(w, journal);
  assert.equal(port.thinking, 'PROVIDER_DEFAULT');
  assert.equal(port.timeout_ms, 120_000);
  await port({ system: 's', user: 'u' });
  assert.ok(!('enable_thinking' in w.calls[0].body));
  assert.deepEqual(Object.keys(w.calls[0].body).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
  assert.deepEqual(journal.map((e) => e.thinking), ['PROVIDER_DEFAULT', 'PROVIDER_DEFAULT']);
  // and the scripts: only the revision script states a thinking mode, and only on the revision Director
  const strip = (s) => s.replace(/\/\/.*$/gm, '');
  const revisionScript = strip(await readFile(new URL('../scripts/run-c3-revision.mjs', import.meta.url), 'utf8'));
  const initialScript = strip(await readFile(new URL('../scripts/run-c2-habb-creative.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(initialScript, /enableThinking|enable_thinking/);
  assert.equal(revisionScript.match(/enableThinking/g).length, 1);
  assert.ok(revisionScript.includes('createRevisionDirector({ ledger, complete: createQwenDirectorPort({ config, budget, journal, timeoutMs: REVISION_DIRECTOR_TIMEOUT_MS, enableThinking: false })'));
});

test('CM-3 one call only and no retry: a failure is a single request, a second completion is refused', async () => {
  for (const fail of ['http500']) {
    const w = wire('x', { fail }); const journal = [];
    const port = revisionPort(w, journal);
    const error = await port({ system: 's', user: 'u' }).catch((e) => e);
    assert.equal(error.status, 500);
    assert.deepEqual(journal.map((e) => [e.event, e.thinking]), [['RESERVED', 'DISABLED'], ['FAILED', 'DISABLED']]);
    assert.equal(w.calls.length, 1, 'no automatic retry');
    await assert.rejects(() => port({ system: 's', user: 'u' }), /ONE completion/);
    assert.equal(w.calls.length, 1);
  }
  const w2 = wire(LEAP()); const ok = revisionPort(w2);
  await ok({ system: 's', user: 'u' });
  await assert.rejects(() => ok({ system: 's', user: 'u' }), /ONE completion/);
  assert.equal(w2.calls.length, 1);
  assert.throws(() => createQwenDirectorPort({ config, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), fetchImpl: w2.fetchImpl, enableThinking: 'no' }), TypeError);
});

test('CM-3b the text lane itself refuses a thinking mode that is not a boolean, before any request', async () => {
  const { createMarketingCopy } = await import('../src/marketing-creative/alibaba/qwen-text.js');
  const w = wire('x');
  await assert.rejects(() => createMarketingCopy({
    config, brief: 'u', dataPolicy: { classification: 'PUBLIC', contains_personal_data: false, contains_face: false, reason: 'test' }, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), fetchImpl: w.fetchImpl, enableThinking: 'no',
  }), TypeError);
  assert.equal(w.calls.length, 0);
});

test('CM-4 all canonical revision inputs are unchanged: the messages are identical with thinking off and with the provider default; only the thinking parameter differs', async () => {
  const off = wire(LEAP()); const dflt = wire(LEAP());
  await invoke(revisionAgent(revisionPort(off)).agent);
  await invoke(revisionAgent(initialPort(dflt)).agent);
  assert.deepEqual(off.calls[0].body.messages, dflt.calls[0].body.messages);
  const { enable_thinking: flag, ...rest } = off.calls[0].body;
  assert.equal(flag, false);
  assert.deepEqual(rest, dflt.calls[0].body);
  // and the Director still receives every input of the revision
  const user = JSON.parse(off.calls[0].body.messages[1].content);
  for (const key of ['brief', 'approved_text_roles', 'format', 'brand_expression', 'previous_direction', 'previous_candidate', 'critique', 'revision_intents', 'layout_capabilities', 'creative_ambition']) assert.ok(key in user, key);
  assert.deepEqual(user.layout_capabilities, JSON.parse(JSON.stringify(capability)));
  assert.deepEqual(user.revision_intents.map((i) => i.intent), revision().revision_request.intents.map((i) => i.intent));
  assert.equal(user.critique.dimensions.length, 14);
});

test('CM-5 the creative ambition, its six qualities and the 300-character rule are in the call', async () => {
  const w = wire(LEAP());
  await invoke(revisionAgent(revisionPort(w)).agent);
  const [system, user] = w.calls[0].body.messages.map((m) => m.content);
  assert.ok(system.includes(C.CREATIVE_AMBITION.instruction));
  assert.ok(system.includes(DIRECTION_TEXT_RULE));
  assert.deepEqual(JSON.parse(user).creative_ambition, JSON.parse(JSON.stringify(C.CREATIVE_AMBITION)));
  assert.deepEqual(JSON.parse(user).creative_ambition.qualities.map((q) => q.dimension), ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR']);
  assert.match(system, /ONE line of plain text of at most 300 characters/);
});

test('CM-6 the answer goes through the same direction validation, and an invalid direction still stops before the environment image', async () => {
  const oversize = `${'a pale surface, '}${'x'.repeat(300)}`;
  const e1 = await invoke(revisionAgent(revisionPort(wire(LEAP({ visual_intent: oversize })))).agent).catch((e) => e);
  assert.equal(e1.detail.cause.code, 'VISUAL_INTENT_TOO_LONG');
  const e2 = await invoke(revisionAgent(revisionPort(wire(LEAP({ spatial_intent: 'PRODUCT_START_TEXT_END' })))).agent).catch((e) => e);
  assert.equal(e2.detail.cause.code, 'REVISION_DIRECTION_NOT_EXECUTABLE');
  const e3 = await invoke(revisionAgent(revisionPort(wire(JSON.stringify({ ...JSON.parse(LEAP()), layout: 'x' })))).agent).catch((e) => e);
  assert.equal(e3.code, CI.CI_ERROR.AGENT_FAILED);
  const e4 = await invoke(revisionAgent(revisionPort(wire(directorAnswer()))).agent).catch((e) => e); // the previous direction again: not a leap
  assert.equal(e4.detail.cause.code, 'REVISED_DIRECTION_NOT_DIFFERENT');
  // through the runtime: after an invalid direction, no strategy and no environment image
  const ledger = createDecisionLedger(); const environment = fakeEnvironmentPort();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: createCreativeDirector({ ledger, complete: async () => { throw new Error('the initial Director is not used'); }, constants: DIRECTOR_CONSTANTS }),
    revision_director: createRevisionDirector({ ledger, complete: revisionPort(wire(LEAP({ visual_intent: oversize }))), constants: DIRECTOR_CONSTANTS }),
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  const error = await runProductPreservingCreative({
    at: AT, brief: buildBrief(), fonts, ledger, guardian: GUARDIAN_PASS, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, revision: revision(), ambition: C.CREATIVE_AMBITION,
  }).catch((e) => e);
  assert.equal(error.detail.cause.code, 'VISUAL_INTENT_TOO_LONG');
  assert.equal(environment.calls.length, 0);
  assert.deepEqual(ledger.entries().map((x) => x.decision), [DECISION.PRODUCT_PRESERVATION_MODE, DECISION.DIRECTION_REFUSED]);
});
