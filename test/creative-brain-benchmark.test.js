import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { DIMENSIONS } from '../src/creative-critic/index.js';
import { CONCEPT_DIMENSIONS, normalizeConceptSet } from '../src/creative-brain/index.js';
import {
  assertFinalState, BENCHMARK_ID, BOUNDS, createFileStore, createMemoryStore, HARD_CEILING_EUR, MAX_CANDIDATES, OWNER_APPROVAL, RESULT_STATE, runCheck, runExplain, runLive, worstCase,
} from '../src/creative-brain-benchmark/index.js';
import { createQwenBrainPort, BRAIN_PORT_LIMITS, SpendGuard, MemoryCallJournal } from '../src/marketing-creative/alibaba/index.js';
import {
  BRAND, buildBrief, fakeEnvironmentPort, fonts, GUARDIAN_PASS,
} from './runtime-world.js';
import {
  artDirectionAnswer, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, OTHER_CONCEPTS, scriptedPort,
} from './creative-brain-world.js';

// THE CREATIVE BRAIN BENCHMARK RUNNER (`// BB-N` markers): fakes only, no network, no credential, no provider.

const AT = '2026-10-12T09:00:00.000Z';
const PALE = artDirectionAnswer({
  narrative_elements: [
    { element: 'a pair of worn tools laid aside at the edge of the bench', reason: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' },
    { element: 'a pale window far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' },
  ],
});
const BELOW = compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' });
const PICKS = [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }];
const selectAnswer = (list, picks = PICKS) => evaluationsAnswer(normalizeConceptSet(list), picks);

/** A complete fake world. `answers` overrides the scripted Brain answers; `execution` / `concept` set critic outcomes per candidate (arrays of outcome maps). */
function world({
  answers = {}, execution = [{}, {}], concept = [{}, {}], guardian = GUARDIAN_PASS, credentials = { present: true, valid: true, missing: [] }, store = createMemoryStore(), vlmAllowed = true, brief = buildBrief(), pixelsOf = null, hardCeilingEur,
} = {}) {
  const trace = []; const portArgs = []; const budgets = []; const instructions = []; const vlmCalls = []; const envRequests = [];
  const script = scriptedPort({
    frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [selectAnswer(CONCEPTS)], art_direct: [PALE], compose: [BELOW], ...answers,
  });
  const env = fakeEnvironmentPort({ pixelsOf });
  let candidateNo = 0;
  const deps = {
    store,
    journal: new MemoryCallJournal(),
    now: () => AT,
    ...(hardCeilingEur === undefined ? {} : { hardCeilingEur }),
    credentials: () => credentials,
    loadInputs: async () => ({ brief, fonts, expression: BRAND.expression }),
    ports: {
      brainPort: (args) => async (instruction) => {
        if (!portArgs.includes(args)) portArgs.push(args);
        const out = await script.complete(instruction);
        trace.push(script.calls.at(-1).stage); instructions.push(instruction);
        return out;
      },
      environmentPort: ({ budget }) => ({
        budget,
        async generate(input) { if (!budgets.includes(budget)) budgets.push(budget); trace.push('environment'); envRequests.push(input.request); return env.generate(input); },
      }),
      vlm: ({ candidateRef }) => {
        if (!vlmAllowed) throw Object.assign(new Error('EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED'), { code: 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED' });
        return {
          invoke: async (req) => {
            const isConcept = /concept critic/.test(req.system);
            if (!isConcept) candidateNo += 1;
            const index = Math.min(candidateNo, 2) - 1;
            const outcomes = (isConcept ? concept : execution)[index] ?? {};
            trace.push(isConcept ? 'concept_critic' : 'execution_critic'); vlmCalls.push({ candidateRef, system: req.system, user: req.user });
            const dims = isConcept ? CONCEPT_DIMENSIONS : DIMENSIONS;
            return {
              text: JSON.stringify({
                dimensions: dims.map((dimension) => {
                  const outcome = outcomes[dimension] ?? 'PASS';
                  return { dimension, outcome, evidence: 'Concrete visible evidence for this judgment.', ...(outcome === 'FAIL' || outcome === 'REVIEW_REQUIRED' ? { revision_hint: 'Give the idea more presence in plain words.' } : {}) };
                }),
              }),
              model: 'fake-vlm', request_id: `vlm-${vlmCalls.length}`,
            };
          },
        };
      },
      guardian: () => guardian,
    },
  };
  return { deps, trace, portArgs, budgets, instructions, vlmCalls, envRequests, script, env, store };
}

const live = (w) => runLive(w.deps, { confirmed: true });

test('BB-1 --check makes no network call, reports the worst case, and writes nothing but a probe', async () => {
  const w = world();
  const realFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = () => { fetched += 1; throw new Error('NETWORK_FORBIDDEN'); };
  let report;
  try { report = await runCheck(w.deps); } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0);
  assert.match(report.status, /^READY_FOR_ONE_CREATIVE_BRAIN_BENCHMARK/);
  assert.equal(w.script.calls.length, 0);
  assert.equal(w.envRequests.length, 0);
  assert.equal(w.vlmCalls.length, 0);
  assert.equal(w.store.files.size, 0);
  assert.deepEqual(report.bounds, BOUNDS);
  assert.deepEqual(report.worst_case.calls, { text: 9, image: 2, vision: 4, total: 15 });
  assert.ok(report.worst_case.cost_eur.total <= report.worst_case.max_spend_eur && report.worst_case.max_spend_eur <= HARD_CEILING_EUR);
  assert.ok(report.checks.every((c) => c.ok));
  assert.ok(report.checks.some((c) => /supported by a tool/.test(c.name)));
});

test('BB-2 --check refuses to proceed on any unmet precondition, before anything else happens', async () => {
  const status = async (over, mutate = null) => { const w = world(over); if (mutate) await mutate(w); return (await runCheck(w.deps)).status; };
  assert.equal(await status({ credentials: { present: false, valid: false, missing: ['ALIBABA_MODEL_STUDIO_API_KEY'] } }), 'BLOCKED: CREDENTIALS_NOT_PROVISIONED');
  assert.equal(await status({ credentials: { present: true, valid: false, missing: [] } }), 'BLOCKED: CONFIG_INVALID');
  assert.equal(await status({}, (w) => w.store.writeJson('summary.json', {})), 'BLOCKED: BENCHMARK_ALREADY_ATTEMPTED');
  assert.equal(await status({}, (w) => w.store.takeLock()), 'BLOCKED: BENCHMARK_ALREADY_ATTEMPTED');
  assert.equal(await status({}, (w) => w.store.setWritable(false)), 'BLOCKED: OUTPUT_DIRECTORY_NOT_WRITABLE');
  assert.equal(await status({ store: createMemoryStore('/private/c2-habb-benchmark-001/creative-run-001') }), 'BLOCKED: OUTPUT_DIRECTORY_IS_THE_EARLIER_RUN');
  const bad = buildBrief(); bad.asset = { ...bad.asset, sha256: 'f'.repeat(64) };
  assert.equal(await status({ brief: bad }), 'BLOCKED: ASSET_HASH_MISMATCH');
});

test('BB-3 the cost is bounded by construction: worst case from the bounds, a hard ceiling, a spend guard and a bounded port', async () => {
  const c = worstCase({ canvas: { width: 1080, height: 1350 }, criticChars: 20000 });
  assert.equal(c.calls.text, 1 + (2 * BOUNDS.concept_rounds) + (2 * MAX_CANDIDATES));
  assert.equal(c.calls.image, MAX_CANDIDATES);
  assert.equal(c.calls.vision, 2 * MAX_CANDIDATES);
  assert.ok(c.max_spend_eur >= c.cost_eur.total && c.max_spend_eur - c.cost_eur.total < 0.05 + 1e-9);
  assert.ok(c.max_spend_eur < HARD_CEILING_EUR);
  // the port refuses an oversized input BEFORE the network, a call beyond its count, and the guard refuses a reservation beyond its cap
  let fetched = 0;
  const config = { apiKey: 'sk-test-canary', workspaceId: 'ws-test', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 1000, baseUrl: 'https://example.invalid' };
  const fetchImpl = async () => { fetched += 1; throw new Error('NETWORK_FORBIDDEN'); };
  const port = createQwenBrainPort({ config, budget: new SpendGuard({ maxSpendEur: 5, maxImages: 0, maxVideoSeconds: 0 }), maxCalls: 2, fetchImpl });
  const tooBig = 'x'.repeat((BRAIN_PORT_LIMITS.max_input_tokens + 10) * 4);
  await assert.rejects(port({ system: tooBig, user: 'u' }), (e) => e.code === 'BRAIN_INPUT_TOO_LARGE');
  assert.equal(fetched, 0);
  await assert.rejects(port({ system: 's', user: 'u' }));
  await assert.rejects(port({ system: 's', user: 'u' }), (e) => e.code === 'BRAIN_CALL_LIMIT_REACHED');
  const tight = createQwenBrainPort({ config, budget: new SpendGuard({ maxSpendEur: 0.001, maxImages: 0, maxVideoSeconds: 0 }), maxCalls: 2, fetchImpl });
  await assert.rejects(tight({ system: 's', user: 'u' }), (e) => /BUDGET_EXCEEDED/.test(e.message));
  assert.throws(() => createQwenBrainPort({ config, budget: null }), TypeError);
});

test('BB-4 --live needs the explicit confirmation; without it nothing runs', async () => {
  const w = world();
  const r = await runLive(w.deps);
  assert.equal(r.status, 'BLOCKED: LIVE_RUN_NEEDS_EXPLICIT_CONFIRMATION');
  assert.equal(w.script.calls.length, 0);
  assert.equal(w.store.files.size, 0);
});

test('BB-5 the stages run in the Brain order, concept generation precedes art direction, art direction precedes production, and production precedes the critics', async () => {
  const w = world();
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.deepEqual(w.trace, ['frame', 'ideate', 'select', 'art_direct', 'compose', 'environment', 'execution_critic', 'concept_critic']);
  const summary = await w.store.readJson('summary.json');
  const order = summary.brain_ledger.map((e) => e.decision);
  const idx = (d) => order.indexOf(d);
  assert.ok(idx('OBSERVATION') < idx('PROBLEM_FRAME') && idx('PROBLEM_FRAME') < idx('CONCEPT_ROUND') && idx('CONCEPT_ROUND') < idx('CONCEPT_SELECTION'));
  assert.ok(idx('CONCEPT_SELECTION') < idx('ART_DIRECTION') && idx('ART_DIRECTION') < idx('COMPOSITION_PLAN') && idx('COMPOSITION_PLAN') < idx('SCENE_SPEC') && idx('SCENE_SPEC') < idx('PRODUCTION_PLAN'));
  // the Creative Director agent is never consulted: the Brain plan directs the run
  assert.equal(summary.candidates[0].runtime_ledger.filter((e) => e.decision === 'CREATIVE_DIRECTION')[0].rule, 'CREATIVE_BRAIN_PLAN_PROJECTED_TO_THE_CANONICAL_DIRECTION');
});

test('BB-6 the relational composition is tried first; the preset fallback is recorded with its reason', async () => {
  const first = await live(world());
  assert.equal(first.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  const w = world({ answers: { compose: [compositionAnswer({ overlap_permission: 'PRODUCT_OVERLAPS_TEXT_FRAME' })] } });
  await live(w);
  const summary = await w.store.readJson('summary.json');
  assert.equal(summary.candidates[0].layout.source, 'PRESET_FALLBACK');
  assert.equal(summary.candidates[0].layout.fallback_reason, 'OVERLAP_IS_NOT_GUARANTEED_BY_THE_SOLVER');
  const ok = await (async () => { const x = world(); await live(x); return x.store.readJson('summary.json'); })();
  assert.equal(ok.candidates[0].layout.source, 'SYNTHESIZED');
});

test('BB-7 a substitute product, a phone or a competing hero in the scene stops the benchmark before any image is paid for', async () => {
  const bad = artDirectionAnswer({ narrative_elements: [{ element: 'a phone resting on the bench', reason: 'it shows the maker has just finished, the care taken in the making', zone: 'FOREGROUND' }] });
  const w = world({ answers: { art_direct: [bad] } });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.BLOCKED);
  const summary = await w.store.readJson('summary.json');
  assert.equal(summary.error.code, 'BRAIN_FORBIDDEN_CONTENT');
  assert.equal(summary.error.stage, 'CREATIVE_BRAIN_PLAN');
  assert.equal(w.envRequests.length, 0);
  assert.equal(w.vlmCalls.length, 0);
});

test('BB-8 the product is preserved: the provider gets a text-only scene request, and the gates ran on the delivered image', async () => {
  const w = world();
  await live(w);
  assert.equal(w.envRequests.length, 1);
  const request = w.envRequests[0];
  assert.deepEqual(request.input_asset_refs, []);
  assert.match(request.prompt, /completely calm and empty/);
  assert.doesNotMatch(request.prompt, /phone|case|product|logo/i);
  const summary = await w.store.readJson('summary.json');
  const c = summary.candidates[0];
  assert.equal(c.preflight.status, 'PASS');
  assert.equal(c.fidelity.gate, 'PASS');
  assert.equal(c.guardian.outcome, 'PASS');
  assert.equal(c.scene.protected_product.mode, 'COMPOSITE_REAL_PIXELS');
  assert.equal(c.scene.integration_zone.reservation, 'REQUIRED');
  assert.ok(w.store.files.get('candidate-001.png') instanceof Uint8Array);
});

test('BB-9 a failed deterministic gate is a TECHNICAL_FAIL: no critic is paid for and no recovery is decided', async () => {
  const w = world({ guardian: Object.freeze({ evaluate: () => ({ report_id: 'g', outcome: 'FAIL', hard_outcome: 'FAIL', rule_results: [] }) }) });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.TECHNICAL_FAIL);
  assert.equal(w.vlmCalls.length, 0);
  assert.equal(w.envRequests.length, 1);
  const summary = await w.store.readJson('summary.json');
  assert.equal(summary.candidates.length, 1);
  assert.equal(summary.candidates[0].recovery, null);
  assert.ok(summary.candidates[0].stop);
  assert.equal(summary.error, null);
  assert.equal(summary.final.stopped_early, false);
});

test('BB-10 concept rounds are bounded: two rounds of three concepts, and nothing is produced from a round that selects nothing', async () => {
  const rejectAll = [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }];
  const w = world({ answers: { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }, { concepts: CONCEPTS }], select: [selectAnswer(CONCEPTS, rejectAll), selectAnswer(OTHER_CONCEPTS, rejectAll), selectAnswer(CONCEPTS, rejectAll)] } });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.BLOCKED);
  assert.equal(w.trace.filter((s) => s === 'ideate').length, BOUNDS.concept_rounds);
  assert.ok(!w.trace.includes('art_direct') && !w.trace.includes('environment'));
  // a model that returns more than three concepts is refused
  const four = world({ answers: { ideate: [{ concepts: [...CONCEPTS, OTHER_CONCEPTS[0]] }] } });
  const r4 = await live(four);
  assert.equal(r4.status, RESULT_STATE.BLOCKED);
  assert.equal((await four.store.readJson('summary.json')).error.code, 'BRAIN_LIST_INVALID');
  const ideate = w.instructions.find((i) => /concept director/.test(i.system));
  assert.match(ideate.system, /exactly 3 concepts/);
});

test('BB-11 recovery is bounded to ONE action; RECONCEPT restarts at the concept stage, never at layout', async () => {
  const w = world({
    answers: {
      ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS), selectAnswer(OTHER_CONCEPTS)], art_direct: [PALE, artDirectionAnswer({ narrative_elements: [] })], compose: [BELOW, BELOW],
    },
    concept: [{ CONCEPT_STRENGTH: 'FAIL', WOW_FACTOR: 'FAIL' }, { CONCEPT_STRENGTH: 'FAIL' }],
  });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT);
  assert.deepEqual(w.trace, [
    'frame', 'ideate', 'select', 'art_direct', 'compose', 'environment', 'execution_critic', 'concept_critic',
    'ideate', 'select', 'art_direct', 'compose', 'environment', 'execution_critic', 'concept_critic',
  ]);
  const summary = await w.store.readJson('summary.json');
  assert.equal(summary.candidates.length, MAX_CANDIDATES);
  assert.equal(summary.candidates[0].recovery.diagnosis.action, 'RECONCEPT');
  assert.equal(summary.candidates[0].recovery.executed, true);
  assert.notEqual(summary.candidates[0].concept_id, summary.candidates[1].concept_id);
  // the second candidate is judged, its diagnosis is recorded, and it is NOT executed: the single recovery action is spent
  assert.equal(summary.candidates[1].recovery.diagnosis.action, 'RECONCEPT');
  assert.equal(summary.candidates[1].recovery.executed, false);
  assert.match(summary.candidates[1].recovery.not_executed_reason, /RECOVERY_BOUND/);
  assert.equal(w.envRequests.length, 2);
  assert.equal(summary.recovery.action, 'RECONCEPT');
  assert.equal(summary.final.candidate, 2);
});

test('BB-12 a REFINE or RECOMPOSE decision is recorded for the owner and not executed: one production candidate per concept', async () => {
  for (const execution of [[{ PRICE_INTEGRATION: 'FAIL' }], [{ VISUAL_HIERARCHY: 'FAIL' }]]) {
    const w = world({ execution });
    const r = await live(w);
    assert.equal(r.status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT);
    const summary = await w.store.readJson('summary.json');
    assert.equal(summary.candidates.length, 1);
    assert.ok(['REFINE', 'RECOMPOSE'].includes(summary.candidates[0].recovery.diagnosis.action));
    assert.equal(summary.candidates[0].recovery.executed, false);
    assert.match(summary.candidates[0].recovery.not_executed_reason, /ONE_PRODUCTION_CANDIDATE_PER_CONCEPT/);
    assert.equal(w.envRequests.length, 1);
  }
});

test('BB-13 a re-conception with no concept round left is recorded, not attempted', async () => {
  const bad = [{ DISTINCTIVENESS: 'PARTIAL' }, { GENERIC_RISK: 'FAILS' }, { DISTINCTIVENESS: 'FAILS' }];
  const round2 = selectAnswer(OTHER_CONCEPTS);
  const w = world({ answers: { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS, bad), round2], art_direct: [artDirectionAnswer({ narrative_elements: [] })] }, concept: [{ CONCEPT_STRENGTH: 'FAIL' }] });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT);
  const summary = await w.store.readJson('summary.json');
  assert.equal(summary.candidates.length, 1);
  assert.equal(summary.candidates[0].recovery.diagnosis.action, 'RECONCEPT');
  assert.equal(summary.candidates[0].recovery.executed, false);
  assert.match(summary.candidates[0].recovery.not_executed_reason, /NO_CONCEPT_ROUND_LEFT/);
});

test('BB-14 the live lock: a second live run is refused and uses no port', async () => {
  const store = createMemoryStore();
  const first = world({ store });
  await live(first);
  const second = world({ store });
  const r = await live(second);
  assert.match(r.status, /^BLOCKED: BENCHMARK_ALREADY_ATTEMPTED/);
  assert.equal(second.script.calls.length, 0);
  assert.equal(second.envRequests.length, 0);
  // the real file store: the lock is exclusive and never released by code
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nbench-'));
  const file = createFileStore(path.join(dir, BENCHMARK_ID));
  await file.takeLock();
  await assert.rejects(file.takeLock(), (e) => e.code === 'LIVE_CALL_ALREADY_ATTEMPTED');
  assert.equal(await file.exists('live-run-001.lock'), true);
  assert.equal(await file.probeWritable(), true);
  assert.equal(await file.exists('.write-probe'), false);
  await assert.rejects(file.writeJson('../escape.json', {}), /plain file name/);
});

test('BB-15 evidence and provenance: the whole Brain ledger, the plan, the gates, both critics and the recovery are stored', async () => {
  const w = world();
  await live(w);
  const s = await w.store.readJson('summary.json');
  assert.equal(s.benchmark_id, BENCHMARK_ID);
  assert.match(s.problem_frame.frame_id, /^cpf_/);
  assert.equal(s.concept_rounds.length, 1);
  assert.equal(s.concept_rounds[0].concepts.length, 3);
  assert.equal(s.concept_rounds[0].selection.outcome, 'SELECT');
  assert.ok(s.concept_rounds[0].evaluations.every((e) => e.criteria.length === 10));
  const c = s.candidates[0];
  for (const key of ['concept', 'art_direction', 'composition', 'scene', 'production_plan', 'layout', 'critique', 'concept_critique', 'quality', 'verdict', 'recovery', 'png', 'preflight', 'fidelity', 'guardian', 'environment']) assert.ok(c[key] !== undefined && c[key] !== null, key);
  assert.equal(c.critique.dimensions.length, 14);
  assert.equal(c.concept_critique.dimensions.length, 6);
  assert.ok(s.brain_ledger.every((e) => /^nordla:/.test(e.decided_by)));
  assert.ok(s.brain_ledger.find((e) => e.decision === 'PROBLEM_FRAME').outcome.request_id);
  assert.ok(s.budget && s.worst_case && s.bounds);
  assert.equal(s.manual_creative_steering, 'NONE');
  assert.ok(c.runtime_ledger.every((e) => /^nordla:/.test(e.decided_by)));
});

test('BB-16 the final result is one of four states, never PASS, and the owner approval stays PENDING even when everything passes', async () => {
  const w = world();
  const r = await live(w);
  const s = await w.store.readJson('summary.json');
  assert.ok(Object.values(RESULT_STATE).includes(r.status));
  assert.equal(s.final.state, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal(s.final.owner_approval, 'PENDING');
  assert.equal(r.owner_approval, 'PENDING');
  assert.equal(OWNER_APPROVAL, 'PENDING');
  assert.equal(s.candidates[0].quality.owner_approval, 'PENDING');
  assert.equal(s.candidates[0].quality.premium_quality_implied, false);
  assert.doesNotMatch(JSON.stringify(s), /OWNER_APPROVED|"SHIPPABLE"|"APPROVED"/);
  assert.equal(Object.keys(RESULT_STATE).length, 4);
  // a critic that cannot judge never makes a candidate ready
  const vague = world({ execution: [{ AI_ARTIFACTS: 'NOT_MEASURABLE' }] });
  assert.equal((await live(vague)).status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT);
  // an unauthorized external-media use stops before the critics
  const noAuth = world({ vlmAllowed: false });
  const blocked = await live(noAuth);
  assert.equal(blocked.status, RESULT_STATE.BLOCKED);
  assert.equal((await noAuth.store.readJson('summary.json')).candidates[0].reason, 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED');
});

test('BB-17 no earlier candidate, critique or owner reference reaches any model: the benchmark starts from the brief', async () => {
  const w = world();
  await live(w);
  const all = [...w.instructions.map((i) => `${i.system}\n${i.user}`), ...w.vlmCalls.map((c) => `${c.system}\n${c.user}`), ...w.envRequests.map((r) => `${r.prompt}\n${r.negative_prompt}`)].join('\n');
  assert.doesNotMatch(all, /enchanted|\bbook\b|\bbird\b|\bmoon\b|OWNER_REJECTED|NOT_SHIPPABLE|Candidate [123]|creative-run-001|owner review/i);
  // the sources never read an earlier run: the only files read are the pinned inputs of the benchmark
  const sources = {};
  for (const rel of ['../src/creative-brain-benchmark/runner.js', '../src/creative-brain-benchmark/store.js', '../scripts/run-creative-brain-benchmark.mjs']) sources[rel] = (await readFile(new URL(rel, import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  for (const [rel, text] of Object.entries(sources)) {
    assert.doesNotMatch(text, /owner-review|critique-00|['"`]candidate\.png['"`]|revision-00|summary1|PINNED_SHA/, rel);
    const mentions = (text.match(/creative-run-001/g) ?? []).length;
    assert.equal(mentions, rel.endsWith('runner.js') ? 1 : 0, `${rel} mentions the earlier run only as the forbidden output directory`);
  }
  const reads = [...sources['../scripts/run-creative-brain-benchmark.mjs'].matchAll(/(?:readFile|json)\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(reads.every((r) => /payload\.path|'benchmarks\/creative-intelligence\/habb-(creative-benchmark-001|c2-brief|c2-external-media-authorization)\.json'|bench\.brand\.package_file|pkg\.inputs\.expression_file|rel/.test(r)), reads.join(' | '));
});

test('BB-18 --explain is offline: it reconstructs the chain, the calls and the stop reason from the stored evidence', async () => {
  const w = world({ answers: { art_direct: [artDirectionAnswer({ narrative_elements: [{ element: 'a spare phone', reason: 'it shows the maker has just finished, the care taken in the making', zone: 'FOREGROUND' }] })] } });
  await live(w);
  w.store.files.set('provider-calls.jsonl', [{ event: 'SUCCEEDED', operation_id: 'brain-text-01', request_id: 'req-1', latency_ms: 1200, actual_cost_eur: 0.01 }, { event: 'RESERVED', operation_id: 'brain-text-02' }]);
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  let explained;
  try { explained = await runExplain({ store: w.store }); } finally { globalThis.fetch = realFetch; }
  assert.equal(explained.status, 'EXPLAINED');
  assert.equal(explained.final.state, 'BLOCKED');
  assert.equal(explained.error.code, 'BRAIN_FORBIDDEN_CONTENT');
  assert.equal(explained.error.stage, 'CREATIVE_BRAIN_PLAN');
  assert.deepEqual(explained.brain_stages.filter((s) => s.reached).map((s) => s.stage), ['OBSERVE', 'FRAME', 'IDEATE', 'SELECT_CONCEPT']);
  assert.equal(explained.provider_call_count, 1);
  assert.equal(explained.owner_approval, 'PENDING');
  assert.equal((await runExplain({ store: createMemoryStore() })).status, 'BLOCKED: NO_BENCHMARK_RECORD');
  // a complete run is explained too
  const ok = world(); await live(ok);
  const full = await runExplain({ store: ok.store });
  assert.equal(full.brain_stages.every((s) => s.reached), true);
  assert.equal(full.candidates[0].state, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal(full.candidates[0].execution_critic.length, 14);
});

test('BB-19 the command line: no network in --check, no secret in the output, the confirmation is required, nothing is exited abruptly', async () => {
  const canary = 'sk-CANARY-SECRET-0123456789';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nbcli-'));
  const preload = path.join(dir, 'no-network.mjs');
  await (await import('node:fs/promises')).writeFile(preload, [
    "import net from 'node:net';",
    "const stop = () => { process.stderr.write('NETWORK_ATTEMPTED\\n'); throw new Error('NETWORK_FORBIDDEN'); };",
    'globalThis.fetch = stop; net.Socket.prototype.connect = stop;',
  ].join('\n'));
  const run = (args) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/run-creative-brain-benchmark.mjs', ...args], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, ALIBABA_MODEL_STUDIO_API_KEY: canary, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-canary', NORDLA_PRIVATE_DIR: dir },
  });
  const check = run(['--check']);
  assert.doesNotMatch(check.stderr, /NETWORK_ATTEMPTED/);
  assert.doesNotMatch(check.stdout + check.stderr, new RegExp(canary));
  const parsed = JSON.parse(check.stdout);
  assert.ok(parsed.checks.length > 3);
  assert.ok(String(parsed.status).startsWith('READY_FOR_ONE') || String(parsed.status).startsWith('BLOCKED'));
  const unconfirmed = run(['--live']);
  assert.equal(unconfirmed.status, 64);
  assert.match(unconfirmed.stderr, /explicit human confirmation/);
  assert.doesNotMatch(unconfirmed.stdout + unconfirmed.stderr, new RegExp(canary));
  assert.equal(run([]).status, 64);
  const explain = run(['--explain']);
  assert.equal(JSON.parse(explain.stdout).status, 'BLOCKED: NO_BENCHMARK_RECORD');
});

const noisy = (size) => new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#d8d8d8"/><circle cx="${size.width / 2}" cy="${size.height * 0.6}" r="${size.width * 0.22}" fill="#202020"/></svg>`).render().asPng()); // an object where the product is placed

test('BB-20 a candidate stopped BEFORE the image is BLOCKED; one stopped AFTER the image was paid for is a TECHNICAL_FAIL', async () => {
  const glow = artDirectionAnswer({
    narrative_elements: [{ element: 'a soft window glow far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' }],
  });
  const before = world({ answers: { art_direct: [glow] } });
  const r1 = await live(before);
  assert.equal(r1.status, RESULT_STATE.BLOCKED);
  assert.equal((await before.store.readJson('summary.json')).candidates[0].reason, 'SCENE_VIOLATES_BRAND_FORBIDDEN_VISUALS');
  assert.equal(before.envRequests.length, 0);
  const after = world({ pixelsOf: noisy });
  const r2 = await live(after);
  assert.equal(r2.status, RESULT_STATE.TECHNICAL_FAIL);
  assert.equal((await after.store.readJson('summary.json')).candidates[0].reason, 'ENVIRONMENT_NOT_EMPTY');
  assert.equal(after.vlmCalls.length, 0);
});

test('BB-21 the limits given to the ports are the benchmark limits: calls, images, spend; a ceiling and a lock race stop the run', async () => {
  const w = world();
  await live(w);
  assert.equal(w.portArgs[0].maxCalls, 9);
  assert.equal(w.budgets[0].maxImages, MAX_CANDIDATES);
  assert.equal(w.budgets[0].maxVideoSeconds, 0);
  const cost = (await runCheck(world().deps)).worst_case;
  assert.equal(w.budgets[0].maxSpendEur, cost.max_spend_eur);
  const low = await runCheck(world({ hardCeilingEur: 0.1 }).deps);
  assert.equal(low.status, 'BLOCKED: WORST_CASE_COST_ABOVE_THE_CEILING');
  const racing = createMemoryStore();
  racing.takeLock = async () => { throw Object.assign(new Error('LIVE_CALL_ALREADY_ATTEMPTED'), { code: 'LIVE_CALL_ALREADY_ATTEMPTED' }); };
  const race = world({ store: racing });
  assert.match((await live(race)).status, /BENCHMARK_ALREADY_ATTEMPTED/);
  assert.equal(race.script.calls.length, 0);
});

test('BB-22 a failure while preparing the single recovery does not hide the candidate the owner can review; no state can be a plain PASS', async () => {
  const w = world({
    answers: { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS), selectAnswer(OTHER_CONCEPTS)], art_direct: [PALE, artDirectionAnswer({ depth_model: 'NOWHERE' })] },
    concept: [{ CONCEPT_STRENGTH: 'FAIL' }],
  });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT);
  const summary = await w.store.readJson('summary.json');
  assert.equal(summary.final.stopped_early, true);
  assert.equal(summary.error.stage, 'CREATIVE_BRAIN_RECONCEPT');
  assert.equal(summary.error.code, 'BRAIN_ENUM_INVALID');
  assert.equal(summary.candidates.length, 1);
  for (const state of Object.values(RESULT_STATE)) assert.equal(assertFinalState(state), state);
  for (const bad of ['PASS', 'APPROVED', 'OWNER_APPROVED', 'SHIPPABLE', 'READY_FOR_REVIEW', undefined]) assert.throws(() => assertFinalState(bad), /four benchmark states/);
});

test('BB-23 the Brain port sends a thinking-off, bounded, text-only PUBLIC request and records the request id', async () => {
  const bodies = [];
  const config = { apiKey: 'sk-test-1234567890abcdef', workspaceId: 'ws0123456789abcd', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 120000 };
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'chatcmpl-brain-1', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 900, completion_tokens: 300 } }) };
  };
  const journal = new MemoryCallJournal();
  const port = createQwenBrainPort({ config, budget: new SpendGuard({ maxSpendEur: 1, maxImages: 0, maxVideoSeconds: 0 }), journal, maxCalls: 3, fetchImpl });
  const out = await port({ system: 'system text', user: 'user text' });
  assert.equal(out.request_id, 'chatcmpl-brain-1');
  assert.equal(bodies[0].body.enable_thinking, false);
  assert.equal(bodies[0].body.max_tokens, BRAIN_PORT_LIMITS.max_output_tokens);
  assert.equal(bodies[0].body.model, 'qwen3.8-max');
  assert.deepEqual(bodies[0].body.messages.map((m) => m.role), ['system', 'user']);
  assert.ok(!JSON.stringify(bodies[0].body).includes('image_url'));
  assert.ok(journal.list().every((e) => e.data_class === 'PUBLIC'));
  assert.deepEqual(journal.list().map((e) => e.event), ['RESERVED', 'SUCCEEDED']);
  assert.doesNotMatch(JSON.stringify(journal.list()), /sk-test/);
  assert.equal(port.calls(), 1);
});

// a rich scene: a grained, strongly textured counter everywhere, with narrative props at the bottom corners, far from the reserved product zone
const rich = (size) => new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><defs><pattern id="g" width="6" height="5" patternUnits="userSpaceOnUse"><rect width="6" height="5" fill="#8a8a8a"/><rect width="6" height="2" fill="#5c5c5c"/><rect x="3" width="2" height="5" fill="#a8a8a8"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="70" cy="${size.height - 70}" r="60" fill="#202020"/><rect x="${size.width - 150}" y="${size.height - 160}" width="130" height="140" fill="#303030"/></svg>`).render().asPng());

test('BB-24 a rich scene with a clean integration zone passes the zone gate: texture and props outside the zone are not failures', async () => {
  const w = world({ pixelsOf: rich });
  await live(w);
  const summary = await w.store.readJson('summary.json');
  const gate = summary.candidates[0].runtime_ledger.find((e) => e.decision === 'ENVIRONMENT_SUITABILITY');
  assert.ok(gate, 'the suitability gate ran');
  assert.equal(gate.outcome.suitable, true);
  assert.ok(gate.outcome.measured.strong_edge_share > gate.outcome.limit.max_strong_edge_share, 'the surface IS edge-rich at pixel scale');
  assert.ok(gate.outcome.measured.structure_share <= gate.outcome.limit.max_structure_share);
  assert.notEqual(summary.candidates[0].reason, 'ENVIRONMENT_NOT_EMPTY');
});
