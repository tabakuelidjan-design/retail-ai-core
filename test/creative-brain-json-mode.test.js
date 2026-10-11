import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProtocolRepairInstruction } from '../src/creative-brain/index.js';
import { STAGE_CONTRACTS } from '../src/creative-brain/parity.js';
import { RESULT_STATE, worstCase } from '../src/creative-brain-benchmark/index.js';
import { BRAIN_PORT_LIMITS, createQwenBrainPort, MemoryCallJournal, SpendGuard } from '../src/marketing-creative/alibaba/index.js';
import { createMarketingCopy } from '../src/marketing-creative/alibaba/qwen-text.js';
import { artDirectionAnswer, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer } from './creative-brain-world.js';
import { live, PALE, selectAnswer, world } from './creative-brain-benchmark-world.js';

// GENERATION-TIME JSON MODE (`// JM-N` markers): every structured Creative Brain text call asks the provider for response_format json_object. That guarantees SYNTAX only; the canonical validators, the near-miss layer,
// the semantic and cross-field rules and the bounded protocol repair are unchanged. Fakes only: the fetch is a fake that records the exact outgoing request. No network, no credential, no provider.

const config = { apiKey: 'sk-test-1234567890abcdef', workspaceId: 'ws0123456789abcd', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 120000 };
const budget = () => new SpendGuard({ maxSpendEur: 5, maxImages: 0, maxVideoSeconds: 0 });
const STAGE_NEEDLES = [['problem framer', 'frame'], ['concept director', 'ideate'], ['concept selector', 'select'], ['art director', 'art_direct'], ['composition planner', 'compose']];

/** A fake provider: answers per stage from a script (strings are sent as they are), records every outgoing body, and fails on demand. */
function provider(answers, { failOn = null } = {}) {
  const requests = []; const queue = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const stage = STAGE_NEEDLES.find(([needle]) => system.includes(`Nordla ${needle}`))?.[1] ?? 'unknown';
    requests.push({ url, body, stage });
    if (failOn === stage) return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'server error' } }) };
    const next = queue[stage]?.shift();
    if (next === undefined) throw new Error(`no scripted answer for ${stage}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: `chatcmpl-${stage}-${requests.length}`, choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }], usage: { prompt_tokens: 1200, completion_tokens: 400 } }) };
  };
  return { requests, fetchImpl };
}
const viaPort = (p) => (args) => createQwenBrainPort({ config, budget: args.budget, journal: args.journal, maxCalls: args.maxCalls, fetchImpl: p.fetchImpl });
const scripted = (over = {}) => ({ frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [selectAnswer(CONCEPTS)], art_direct: [PALE], compose: [compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' })], ...over });
const brainWorld = (answers, opts) => { const p = provider(answers, opts); const w = world(); w.deps.ports.brainPort = viaPort(p); return { w, p }; };

test('JM-1 the exact outgoing request of the Brain port: json_object, and nothing else about the request changed', async () => {
  const p = provider({ frame: ['{}'] });
  const journal = new MemoryCallJournal();
  const port = createQwenBrainPort({ config, budget: budget(), journal, maxCalls: 2, fetchImpl: p.fetchImpl });
  await port({ system: 'Nordla problem framer. Return ONLY one JSON object.', user: 'the user text' });
  const { body } = p.requests[0];
  assert.deepEqual(Object.keys(body).sort(), ['enable_thinking', 'max_tokens', 'messages', 'model', 'response_format', 'temperature']);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.model, 'qwen3.8-max');
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, BRAIN_PORT_LIMITS.max_output_tokens);
  assert.equal(body.enable_thinking, false);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'Nordla problem framer. Return ONLY one JSON object.' }, { role: 'user', content: 'the user text' }]);
  assert.equal(journal.list()[0].response_format, 'json_object'); // the journal records that the call was made in JSON mode
});

test('JM-2 every Brain text stage mentions JSON in its own instruction, so the provider requirement holds mechanically, including for the protocol-repair instruction', () => {
  assert.equal(STAGE_CONTRACTS.length, 5);
  for (const c of STAGE_CONTRACTS) {
    const i = c.instruction();
    assert.match(`${i.system}\n${i.user}`, /json/i, c.stage);
    assert.match(`${buildProtocolRepairInstruction(i, '{"broken"').system}\n${buildProtocolRepairInstruction(i, '{"broken"').user}`, /json/i, `${c.stage} repair`);
  }
});

test('JM-3 a prompt without the word JSON is refused before anything is reserved or sent (the provider would refuse it), and only json_object is accepted as a format', async () => {
  const p = provider({ frame: ['{}'] });
  const journal = new MemoryCallJournal();
  const port = createQwenBrainPort({ config, budget: budget(), journal, maxCalls: 2, fetchImpl: p.fetchImpl });
  await assert.rejects(port({ system: 'no format named here', user: 'u' }), /needs the word JSON/);
  assert.equal(p.requests.length, 0);
  assert.equal(journal.list().length, 0);
  // the word may stand in the system text OR in the user text: either satisfies the provider
  const q = provider({ frame: ['{}', '{}'] });
  const lenient = createQwenBrainPort({ config, budget: budget(), maxCalls: 3, fetchImpl: q.fetchImpl });
  await lenient({ system: 'Nordla problem framer, plain system text', user: 'the user text asks for JSON' });
  await lenient({ system: 'Nordla problem framer asks for json', user: 'plain' });
  assert.equal(q.requests.length, 2);
  await assert.rejects(createMarketingCopy({ config, brief: 'JSON please', dataPolicy: { classification: 'PUBLIC', contains_personal_data: false, contains_face: false, reason: 'test' }, budget: budget(), fetchImpl: p.fetchImpl, responseFormat: 'json_schema' }), /responseFormat must be 'json_object'/);
  assert.equal(p.requests.length, 0);
});

test('JM-4 a whole Brain run through the port: every call of every stage sends json_object, and the run still ends in READY_FOR_OWNER_REVIEW with the same bounds', async () => {
  const { w, p } = brainWorld(scripted());
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.deepEqual(p.requests.map((x) => x.stage), ['frame', 'ideate', 'select', 'art_direct', 'compose']);
  for (const x of p.requests) {
    assert.deepEqual(x.body.response_format, { type: 'json_object' }, x.stage);
    assert.match(x.body.messages[0].content + x.body.messages[1].content, /json/i, x.stage);
    assert.equal(x.body.enable_thinking, false);
    assert.equal(x.body.temperature, 0.5);
  }
  const s = await w.store.readJson('summary.json');
  assert.equal(s.provider_calls.text, 5);
  assert.equal(worstCase({ canvas: { width: 1080, height: 1350 }, criticChars: 6000 }).calls.text, 18); // the bounds did not move
});

test('JM-5 json_object does not bypass the validators: valid JSON with wrong keys, wrong enums or contradictory relations is still refused, each with its own cause', async () => {
  const cases = [
    ['wrong keys', { frame: [{ ...frameAnswer(), surprise: 'x' }] }, 'FRAME', 'PROBLEM_FRAME_INVALID', 'BRAIN_UNKNOWN_KEY'],
    ['wrong enum', { art_direct: [{ ...PALE, depth_model: 'EXTRA_DEEP' }] }, 'ART_DIRECT', 'ART_DIRECTION_INVALID', 'BRAIN_ENUM_INVALID'],
    ['contradictory relations', { compose: [{ ...compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' } }), hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE', visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRICE: 'QUIET', PRODUCT: 'DOMINANT' } }] }, 'COMPOSE', 'COMPOSITION_RELATIONS_CONTRADICTORY', 'BRAIN_RULE_VIOLATION'],
    ['wrong concept count', { ideate: [{ concepts: CONCEPTS.slice(0, 2) }] }, 'IDEATE', 'CONCEPT_OUTPUT_INVALID', 'BRAIN_LIST_INVALID'],
    ['an evaluation for nothing', { select: [{ evaluations: [] }] }, 'SELECT_CONCEPT', null, null],
  ];
  for (const [name, over, stage, cause, code] of cases) {
    const { w, p } = brainWorld(scripted(over));
    const r = await live(w);
    assert.equal(r.status, RESULT_STATE.BLOCKED, name);
    const s = await w.store.readJson('summary.json');
    assert.equal(s.error.brain_stage, stage, name);
    if (cause) assert.equal(s.error.cause, cause, name);
    if (code) assert.equal(s.error.code, code, name);
    assert.equal(s.error.evidence.protocol_repair, null, `${name}: parseable output is never re-asked`);
    assert.ok(p.requests.every((x) => x.body.response_format?.type === 'json_object'), name);
    assert.equal(p.requests.filter((x) => x.stage === stage.toLowerCase().replace('select_concept', 'select')).length, 1, `${name}: one call for the refused stage`);
  }
});

test('JM-6 the protocol repair stays bounded to ONE re-ask even in JSON mode, and both requests are in JSON mode', async () => {
  const broken = '{"concepts": [{"central_idea": "x"';
  const twice = brainWorld(scripted({ ideate: [broken, broken, { concepts: CONCEPTS }] }));
  const r = await live(twice.w);
  assert.equal(r.status, RESULT_STATE.BLOCKED);
  const ideate = twice.p.requests.filter((x) => x.stage === 'ideate');
  assert.equal(ideate.length, 2);
  assert.ok(ideate.every((x) => x.body.response_format.type === 'json_object'));
  assert.match(ideate[1].body.messages[1].content, /PROTOCOL REPAIR/);
  assert.equal((await twice.w.store.readJson('summary.json')).error.evidence.protocol_repair.outcome, 'STILL_MALFORMED');
  const once = brainWorld(scripted({ ideate: [broken, { concepts: CONCEPTS }] }));
  assert.equal((await live(once.w)).status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal(once.p.requests.filter((x) => x.stage === 'ideate').length, 2);
});

test('JM-7 a provider failure still does not retry, and valid output passes the full normalization (a near-miss key is still repaired and journaled)', async () => {
  const down = brainWorld(scripted(), { failOn: 'ideate' });
  const r = await live(down.w);
  assert.equal(r.status, RESULT_STATE.BLOCKED);
  assert.equal(down.p.requests.filter((x) => x.stage === 'ideate').length, 1);
  const s = await down.w.store.readJson('summary.json');
  assert.equal(s.error.code, 'BRAIN_PORT_FAILED');
  assert.equal(s.provider_calls.text, 2);
  // a misspelled key in a syntactically valid answer is repaired exactly as before
  const typo = { ...frameAnswer() }; typo.felat = typo.felt; delete typo.felt;
  const fixed = brainWorld(scripted({ frame: [typo] }));
  assert.equal((await live(fixed.w)).status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  const ledger = (await fixed.w.store.readJson('summary.json')).brain_ledger;
  assert.match(JSON.stringify(ledger), /felat/);
});
