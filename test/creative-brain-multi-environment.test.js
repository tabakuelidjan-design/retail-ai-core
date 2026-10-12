import test from 'node:test';
import assert from 'node:assert/strict';

import { Resvg } from '@resvg/resvg-js';

import { BOUNDS, HARD_CEILING_EUR, RESULT_STATE, runCheck, worstCase } from '../src/creative-brain-benchmark/index.js';
import { describeStop, MAX_ENVIRONMENT_CANDIDATES, ROOT_CAUSE } from '../src/creative-runtime/index.js';
import { SpendGuard } from '../src/marketing-creative/alibaba/index.js';
import { live, world } from './creative-brain-benchmark-world.js';

// BOUNDED MULTI-ENVIRONMENT GENERATION (`// ME-N` markers). The provider is text-only and may draw an object in the product zone although it was asked not to (three live attempts, three scenes). For ONE fixed scene up to
// three environment images are generated; each is judged alone by the deterministic product-zone gate; the FIRST that passes wins (no ranking, no hand-picking); if none passes the run stops with a precise provider
// limitation. Reliability recovery, not creative steering. Fakes only: no network, no credential, no provider.

const noisy = (size) => new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#d8d8d8"/><circle cx="${size.width / 2}" cy="${size.height * 0.6}" r="${size.width * 0.22}" fill="#202020"/></svg>`).render().asPng()); // an object where the product is placed
const calmExcept = (badOn) => (size, { candidate_index: index }) => (badOn.includes(index) ? noisy(size) : null); // null: the default calm environment

const summaryOf = async (w) => w.store.readJson('summary.json');
const candidateEntries = (s) => s.candidates[0].runtime_ledger.filter((e) => e.decision === 'ENVIRONMENT_CANDIDATE');

test('ME-1 one valid image: it is selected, exactly one image is paid for, and the gate record shows it', async () => {
  const w = world({ pixelsOf: calmExcept([]) });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal(w.envRequests.length, 1);
  const s = await summaryOf(w);
  assert.equal(s.provider_calls.image, 1);
  assert.deepEqual(candidateEntries(s).map((e) => [e.outcome.candidate, e.outcome.suitable, e.outcome.selected]), [[1, true, true]]);
});

test('ME-2 first invalid, second valid: the SECOND is selected; first two invalid, third valid: the THIRD is selected; the gate is applied to each image on its own', async () => {
  for (const [bad, winner] of [[[1], 2], [[1, 2], 3]]) {
    const w = world({ pixelsOf: calmExcept(bad) });
    const r = await live(w);
    assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW, `bad ${bad}`);
    assert.equal(w.envRequests.length, winner);
    const s = await summaryOf(w);
    const entries = candidateEntries(s);
    assert.deepEqual(entries.map((e) => e.outcome.selected), Array.from({ length: winner }, (_, i) => i + 1 === winner));
    assert.deepEqual(entries.filter((e) => !e.outcome.suitable).map((e) => e.outcome.rejection), bad.map(() => 'ENVIRONMENT_NOT_EMPTY'));
    assert.ok(entries.filter((e) => !e.outcome.suitable).every((e) => e.outcome.measured.structure_share > e.outcome.limit.max_structure_share)); // the measurement that rejected it is kept
    assert.equal(s.provider_calls.image, winner);
    // the delivered candidate is the selected image: its provenance and hash are the winner's
    assert.equal(s.candidates[0].environment.request_id, `env-req-${winner}`);
    assert.equal(s.candidates[0].environment_candidates.length, winner);
    assert.deepEqual(s.candidates[0].environment_candidates.map((c) => c.index), Array.from({ length: winner }, (_, i) => i + 1));
  }
});

test('ME-3 all invalid: a clean PROVIDER_ENVIRONMENT_LIMITATION stop after exactly three images, no fourth call, no critic, no render, no PNG', async () => {
  const w = world({ pixelsOf: calmExcept([1, 2, 3, 4, 5]) });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.TECHNICAL_FAIL); // an image was paid for
  assert.equal(w.envRequests.length, 3);
  assert.equal(w.envRequests.length, MAX_ENVIRONMENT_CANDIDATES);
  assert.equal(w.vlmCalls.length, 0); // no critic before a suitable environment exists
  assert.ok(!w.trace.includes('execution_critic') && !w.trace.includes('concept_critic'));
  const s = await summaryOf(w);
  const c = s.candidates[0];
  assert.equal(c.reason, 'PROVIDER_ENVIRONMENT_LIMITATION');
  assert.equal(c.png, null);
  assert.equal(c.stop.cause, ROOT_CAUSE.PROVIDER_ENVIRONMENT_LIMITATION);
  assert.equal(c.stop.stage, 'ENVIRONMENT_SUITABILITY_GATE');
  assert.equal(s.provider_calls.image, 3);
  assert.equal(s.final.state, RESULT_STATE.TECHNICAL_FAIL);
  assert.equal(candidateEntries(s).length, 3);
  const final = c.runtime_ledger.filter((e) => e.decision === 'ENVIRONMENT_SUITABILITY');
  assert.equal(final.length, 1); // the gate's final decision is recorded, so the record is complete
  assert.deepEqual([final[0].outcome.suitable, final[0].outcome.candidates], [false, 3]);
  assert.ok(describeStop({ result: { status: 'BLOCKED', reason: 'PROVIDER_ENVIRONMENT_LIMITATION', ledger: c.runtime_ledger } }).cause === ROOT_CAUSE.PROVIDER_ENVIRONMENT_LIMITATION);
});

test('ME-4 the scene never changes between candidates: the same request text, no concept, art direction or composition call in between', async () => {
  const w = world({ pixelsOf: calmExcept([1, 2]) });
  await live(w);
  assert.equal(w.envRequests.length, 3);
  assert.deepEqual(w.envRequests.map((q) => [q.prompt, q.negative_prompt, q.size]), Array.from({ length: 3 }, () => [w.envRequests[0].prompt, w.envRequests[0].negative_prompt, w.envRequests[0].size]));
  const first = w.trace.indexOf('environment');
  assert.deepEqual(w.trace.slice(first, first + 3), ['environment', 'environment', 'environment']); // nothing is asked of any Brain stage between two images
  assert.equal(w.trace.filter((x) => x === 'frame' || x === 'ideate' || x === 'select' || x === 'art_direct' || x === 'compose').length, 5); // the plan was made once
  assert.ok(w.trace.indexOf('execution_critic') > first + 2); // critics only after the environment was chosen
  const s = await summaryOf(w);
  const entries = candidateEntries(s);
  assert.equal(new Set(entries.map((e) => e.outcome.request_sha256)).size, 1); // one request, three images
  assert.equal(new Set(entries.map((e) => e.basis[0])).size, 1); // one scene
  assert.equal(entries[0].basis[0], s.candidates[0].scene.scene_id);
});

test('ME-5 every candidate is journaled with its request hash, request id, image hash, measurement and rejection reason; no ranking is applied', async () => {
  const w = world({ pixelsOf: calmExcept([1]) });
  await live(w);
  const s = await summaryOf(w);
  for (const e of candidateEntries(s)) {
    assert.match(e.outcome.request_sha256, /^[0-9a-f]{64}$/);
    assert.match(e.outcome.output_sha256, /^[0-9a-f]{64}$/);
    assert.match(e.outcome.request_id, /^env-req-\d$/);
    assert.ok(e.outcome.measured && e.outcome.limit && e.outcome.zone);
    assert.equal(e.rule, 'THE_FIRST_ENVIRONMENT_THAT_PASSES_THE_PRODUCT_ZONE_GATE_WINS_WITH_NO_RANKING');
    assert.equal(e.decided_by, 'nordla:environment-suitability-gate@1');
  }
  assert.notEqual(candidateEntries(s)[0].outcome.output_sha256, candidateEntries(s)[1].outcome.output_sha256); // two different images
  assert.equal(s.final.owner_approval, 'PENDING');
});

test('ME-6 an image that is not a decodable PNG or has the wrong size is rejected with its own reason, and the next one is tried', async () => {
  const w = world({ pixelsOf: (size, { candidate_index: i }) => (i === 1 ? new Uint8Array([1, 2, 3]) : (i === 2 ? new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="100%" height="100%" fill="#ddd"/></svg>`).render().asPng()) : null)) });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  const s = await summaryOf(w);
  assert.deepEqual(candidateEntries(s).map((e) => e.outcome.rejection), ['THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG', 'THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS', null]);
  assert.equal(w.envRequests.length, 3);
});

test('ME-7 the cost is bounded by construction and recalculated: three images per run, strictly under the hard ceiling, a fourth image is refused by the budget itself', async () => {
  const c = worstCase({ canvas: { width: 1080, height: 1350 }, criticChars: 6000 });
  assert.equal(c.calls.image, BOUNDS.environment_images_per_run);
  assert.equal(BOUNDS.environment_images_per_run, MAX_ENVIRONMENT_CANDIDATES);
  const w = world();
  const checked = (await runCheck(w.deps)).worst_case; // with the real critic instructions
  for (const x of [c, checked]) { assert.ok(x.max_spend_eur < HARD_CEILING_EUR, `${x.max_spend_eur}`); assert.ok(x.max_spend_eur >= x.cost_eur.total); assert.equal(x.calls.image, 3); }
  const budget = new SpendGuard({ maxSpendEur: 5, maxImages: BOUNDS.environment_images_per_run, maxVideoSeconds: 0 });
  for (let i = 1; i <= 3; i += 1) budget.reserveImages({ id: `img-${i}`, n: 1, size: '1080x1350' });
  assert.throws(() => budget.reserveImages({ id: 'img-4', n: 1, size: '1080x1350' }), /IMAGE|BUDGET|limit/i);
});

test('ME-8 the images of the run are SHARED: a recovery candidate gets only what the first one left, and never a fourth image in the whole run', async () => {
  // the first candidate uses ONE image; the concept critic then fails it, a new concept is produced and its environment may use at most the two that are left
  const w = world({
    pixelsOf: (size, { candidate_index: i }) => (w2Calls.n++ >= 1 ? noisy(size) : null),
    concept: [{ CONCEPT_STRENGTH: 'FAIL', WOW_FACTOR: 'FAIL' }, {}],
    answers: recoveryAnswers(),
  });
  const w2Calls = { n: 0 };
  await live(w);
  const s = await summaryOf(w);
  assert.equal(s.candidates.length, 2);
  assert.ok(w.envRequests.length <= BOUNDS.environment_images_per_run, `${w.envRequests.length} images`);
  assert.equal(w.envRequests.length, 3); // one for the first candidate, the two that were left for the second (both unsuitable)
  assert.equal(s.provider_calls.image, 3);
  assert.equal(s.candidates[1].reason, 'PROVIDER_ENVIRONMENT_LIMITATION');
  assert.equal(candidateEntries({ candidates: [s.candidates[1]] }).length, 2);
  // when the first candidate used all three, no recovery candidate is produced: the reason is recorded
  const w3 = world({ pixelsOf: calmExcept([1, 2]), concept: [{ CONCEPT_STRENGTH: 'FAIL', WOW_FACTOR: 'FAIL' }, {}], answers: recoveryAnswers() });
  await live(w3);
  const s3 = await summaryOf(w3);
  assert.equal(w3.envRequests.length, 3);
  assert.equal(s3.candidates.length, 1);
  assert.equal(s3.candidates[0].recovery.executed, false);
  assert.equal(s3.candidates[0].recovery.not_executed_reason, 'NO_ENVIRONMENT_IMAGE_LEFT_IN_THE_RUN_BUDGET');
});

test('ME-9 the single-image runtime default is unchanged: without the bounded set, one unsuitable image is ENVIRONMENT_NOT_EMPTY, exactly as before', async () => {
  const { runProductPreservingCreative } = await import('../src/creative-runtime/index.js');
  assert.equal(typeof runProductPreservingCreative, 'function');
  assert.equal(MAX_ENVIRONMENT_CANDIDATES, 3);
  // (the runtime tests of the single-image path are in the runtime and benchmark suites; here: the bound itself cannot be raised from outside)
  const { BOUNDS: bounds } = await import('../src/creative-brain-benchmark/index.js');
  assert.equal(bounds.environment_candidates_per_scene, 3);
  assert.ok(Object.isFrozen(bounds));
});

import { artDirectionAnswer, CONCEPTS, OTHER_CONCEPTS } from './creative-brain-world.js';
import { PALE, BELOW, selectAnswer } from './creative-brain-benchmark-world.js';
function recoveryAnswers() {
  return { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS), selectAnswer(OTHER_CONCEPTS)], art_direct: [PALE, artDirectionAnswer({ narrative_elements: [] })], compose: [BELOW, BELOW] };
}

// ---- the live port: three images of ONE scene through the real provider adapter (fake fetch), with the real budget and journal
import { generateEnvironmentBackground, loadAlibabaCreativeConfig, MemoryCallJournal, MemoryOutputStore } from '../src/marketing-creative/alibaba/index.js';
import { environmentOperationId } from '../src/creative-brain-benchmark/index.js';

test('ME-10 the provider adapter generates up to three images of one scene under distinct operation ids with one shared budget; a fourth is refused by the budget before any network call', async () => {
  const config = loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-0123456789abcdef-NEVER-LEAK', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test123' });
  const png = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="#e8ecef"/></svg>').render().asPng());
  let posts = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') { posts += 1; return { ok: true, status: 200, headers: { get: () => 'application/json' }, async text() { return JSON.stringify({ output: { choices: [{ finish_reason: 'stop', message: { content: [{ image: `https://dashscope-result-eu.example.com/out/env-${posts}.png?Signature=S` }] } }] }, usage: { output_width: 1080, output_height: 1350 }, request_id: `req-${posts}` }); } }; }
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, async arrayBuffer() { return new Uint8Array(png).buffer; } };
  };
  const budget = new SpendGuard({ maxSpendEur: 0.5, maxImages: BOUNDS.environment_images_per_run, maxVideoSeconds: 0 });
  const journal = new MemoryCallJournal(); const outputStore = new MemoryOutputStore();
  const request = { capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [], prompt: 'A photograph of an empty scene: a pale studio surface.', negative_prompt: 'a product', size: '1080*1350' };
  const base = 'creative-brain-benchmark-001-environment-001';
  assert.deepEqual([1, 2, 3].map((i) => environmentOperationId(base, i)), [base, `${base}-c2`, `${base}-c3`]);
  for (const i of [1, 2, 3]) await generateEnvironmentBackground({ config, request, budget, journal, outputStore, fetchImpl, operationId: environmentOperationId(base, i) });
  assert.equal(posts, 3);
  assert.equal(new Set(journal.list().filter((e) => e.event === 'SUCCEEDED').map((e) => e.operation_id)).size, 3);
  await assert.rejects(generateEnvironmentBackground({ config, request, budget, journal, outputStore, fetchImpl, operationId: environmentOperationId(base, 4) }), /IMAGE_LIMIT_EXCEEDED/);
  assert.equal(posts, 3); // the refusal happened BEFORE any network call
  // each image keeps its own journal rows and its own stored output (the id names the stored file): none overwrites another
  assert.equal(new Set(journal.list().filter((e) => e.event === 'RESERVED').map((e) => e.operation_id)).size, 3);
});

// ---- the runtime itself (the cap does not depend on the caller)
import {
  createApprovedCopyAgent, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { createCreativeBrain, normalizeConceptSet } from '../src/creative-brain/index.js';
import { BRAND, buildBrief, fakeEnvironmentPort, fonts, GUARDIAN_PASS } from './runtime-world.js';
import { compositionAnswer, evaluationsAnswer, frameAnswer, scriptedPort } from './creative-brain-world.js';

test('ME-11 the runtime caps the bounded set at three whatever the caller asks, and an absent or invalid request means ONE image with the historical stop', async () => {
  const port = scriptedPort({ frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [evaluationsAnswer(normalizeConceptSet(CONCEPTS), [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }])], art_direct: [PALE], compose: [BELOW] });
  const plan = (await createCreativeBrain({ complete: port.complete }).plan({ brief: buildBrief() })).plan;
  const run = async (environmentCandidates, pixelsOf) => {
    const ledger = createDecisionLedger(); const environment = fakeEnvironmentPort({ pixelsOf });
    const agents = { analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }), director: { invoke: async () => { throw new Error('no director'); } }, copy: createApprovedCopyAgent({ ledger }), visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }) };
    const result = await runProductPreservingCreative({ at: '2026-10-12T09:00:00.000Z', brief: buildBrief(), fonts, ledger, guardian: GUARDIAN_PASS, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, creativePlan: plan, ...(environmentCandidates === undefined ? {} : { environmentCandidates }) });
    return { result, images: environment.calls.length };
  };
  const allNoisy = (size) => noisy(size);
  for (const [asked, images, reason] of [[undefined, 1, 'ENVIRONMENT_NOT_EMPTY'], [1, 1, 'ENVIRONMENT_NOT_EMPTY'], [0, 1, 'ENVIRONMENT_NOT_EMPTY'], [-4, 1, 'ENVIRONMENT_NOT_EMPTY'], ['3', 1, 'ENVIRONMENT_NOT_EMPTY'], [2.5, 1, 'ENVIRONMENT_NOT_EMPTY'], [2, 2, 'PROVIDER_ENVIRONMENT_LIMITATION'], [3, 3, 'PROVIDER_ENVIRONMENT_LIMITATION'], [4, 3, 'PROVIDER_ENVIRONMENT_LIMITATION'], [50, 3, 'PROVIDER_ENVIRONMENT_LIMITATION']]) {
    const { result, images: n } = await run(asked, allNoisy);
    assert.equal(n, images, `asked ${asked}`);
    assert.equal(result.reason, reason, `asked ${asked}`);
    assert.equal(result.status, 'BLOCKED');
  }
});

test('ME-12 the live script wires the bounded set: the port accepts the candidate index and derives each operation id with the shared helper (the script cannot run in a test, so its wiring is checked in its source)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/run-creative-brain-benchmark.mjs', import.meta.url), 'utf8');
  assert.match(source, /async generate\(\{ request, candidate_index: candidateIndex = 1 \}\)/);
  assert.match(source, /operationId: environmentOperationId\(operationId, candidateIndex\)/);
  assert.match(source, /import \{ environmentOperationId \} from '\.\.\/src\/creative-brain-benchmark\/runner\.js'/);
});
