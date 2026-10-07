import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENCHMARK_TASK,
  BENCHMARK_VERDICT,
  CapabilityRegistry,
  CREATIVE_FIDELITY_CANDIDATES,
  EXECUTION_MODE,
  FIDELITY_CHECK,
  FIDELITY_GATE_OUTCOME,
  LICENSE_STATUS,
  MODEL_STATUS,
  ProvenanceLedger,
  QUALITY_RATING,
  buildSandwichPlan,
  createBenchmarkCase,
  evaluateHardFidelityGate,
  evaluateModelExecutionGate,
  recordBenchmarkJudgement,
  summarizeBenchmark,
  summarizeCosts,
  assertBenchmarkAdapter,
  executeBenchmarkAdapter,
  normalizeBenchmarkManifest,
  runBenchmarkMatrix,
} from '../src/creative-fidelity/index.js';

const baseEntry = (overrides = {}) => ({
  id: 'model-a',
  name: 'Model A',
  provider: 'Provider',
  kind: 'IMAGE_MODEL',
  version: '1',
  version_hash: 'sha-test',
  execution_mode: EXECUTION_MODE.SELF_HOST,
  capabilities: ['IMAGE_GENERATION'],
  status: MODEL_STATUS.BENCHMARK,
  license_status: LICENSE_STATUS.VERIFIED,
  license_name: 'Apache-2.0',
  license_source: 'LICENSE',
  commercial_use: true,
  eu_allowed: true,
  self_hostable: true,
  hardware: {},
  pricing: {},
  ...overrides,
});

const benchmarkCase = createBenchmarkCase({
  id: 'c',
  task: BENCHMARK_TASK.BACKGROUND_SWAP,
  source_refs: ['private-asset://x'],
  expected_invariants: [
    'PRESERVE_PRODUCT_GEOMETRY',
    'PRESERVE_PIECE_COUNT',
    'PRESERVE_PRODUCT_COLOR',
  ],
});

const passingObservations = [
  FIDELITY_CHECK.PRODUCT_IDENTITY,
  FIDELITY_CHECK.PRODUCT_GEOMETRY,
  FIDELITY_CHECK.PIECE_COUNT,
  FIDELITY_CHECK.PRODUCT_COLOR,
].map((code) => ({
  code,
  outcome: FIDELITY_GATE_OUTCOME.PASS,
}));

test('registry rejects duplicate ids', () => {
  const registry = new CapabilityRegistry([baseEntry()]);
  assert.throws(
    () => registry.add(baseEntry()),
    /duplicate capability id/,
  );
});

test('single execution gate blocks unverified license', () => {
  assert.equal(
    evaluateModelExecutionGate(
      baseEntry({ license_status: LICENSE_STATUS.NEEDS_REVIEW }),
    ).reason,
    'LICENSE_NOT_VERIFIED',
  );
});

test('single execution gate blocks self-host model without artifact hash', () => {
  assert.equal(
    evaluateModelExecutionGate(baseEntry({ version_hash: null })).reason,
    'ARTIFACT_HASH_MISSING',
  );
});

test('eligible uses the same execution gate', () => {
  const registry = new CapabilityRegistry([
    baseEntry(),
    baseEntry({ id: 'no-hash', version_hash: null }),
  ]);
  assert.deepEqual(
    registry.eligible({ capability: 'IMAGE_GENERATION' }).map((x) => x.id),
    ['model-a'],
  );
});

test('self-host candidates are blocked until exact artifact hash', () => {
  const registry = new CapabilityRegistry(CREATIVE_FIDELITY_CANDIDATES);
  assert.equal(
    evaluateModelExecutionGate(registry.get('hidream-o1')).reason,
    'ARTIFACT_HASH_MISSING',
  );
  assert.equal(
    evaluateModelExecutionGate(registry.get('flux2-klein-4b')).reason,
    'ARTIFACT_HASH_MISSING',
  );
});

test('provenance hashes prompts and parameters instead of storing raw', () => {
  const ledger = new ProvenanceLedger();
  const event = ledger.appendRun({
    run_id: 'r',
    benchmark_case_id: 'c',
    model_id: 'm',
    source_refs: ['asset://1'],
    prompt: 'secret',
    parameters: { seed: 1 },
    direct_cost_eur: 0.12,
  });

  assert.equal(event.prompt_sha256.length, 64);
  assert.equal(event.parameters_sha256.length, 64);
  assert.equal('prompt' in event, false);
});

test('unknown cost is never zero', () => {
  const summary = summarizeCosts([
    { verdict: 'ACCEPTED', direct_cost_eur: 0.2 },
    { verdict: 'REJECTED', direct_cost_eur: null },
  ]);
  assert.equal(summary.cost_complete, false);
  assert.equal(summary.cost_per_accepted_output_eur, null);
});

test('hard gate is NOT_MEASURABLE when required checks are missing', () => {
  const gate = evaluateHardFidelityGate({
    observations: [],
    requiredChecks: [FIDELITY_CHECK.PRODUCT_IDENTITY],
  });
  assert.equal(gate.outcome, FIDELITY_GATE_OUTCOME.NOT_MEASURABLE);
});

test('hard gate rejects unknown observation code instead of typo ignore', () => {
  assert.throws(
    () => evaluateHardFidelityGate({
      observations: [{ code: 'GEOMTRY', outcome: 'PASS' }],
      requiredChecks: [FIDELITY_CHECK.PRODUCT_GEOMETRY],
    }),
    /unknown fidelity observation code/,
  );
});

test('hard gate fails an explicit failed required check', () => {
  const gate = evaluateHardFidelityGate({
    observations: [{
      code: FIDELITY_CHECK.PRODUCT_IDENTITY,
      outcome: FIDELITY_GATE_OUTCOME.FAIL,
    }],
    requiredChecks: [FIDELITY_CHECK.PRODUCT_IDENTITY],
  });
  assert.equal(gate.outcome, FIDELITY_GATE_OUTCOME.FAIL);
});

test('hard gate passes only when every required check passes', () => {
  const gate = evaluateHardFidelityGate({
    observations: passingObservations,
    requiredChecks: passingObservations.map((x) => x.code),
  });
  assert.equal(gate.outcome, FIDELITY_GATE_OUTCOME.PASS);
});

test('judgement with no observations is UNDETERMINED', () => {
  const judgement = recordBenchmarkJudgement({
    run: {
      run_id: 'r',
      benchmark_case_id: 'c',
      model_id: 'm',
      direct_cost_eur: 0.05,
    },
    benchmarkCase,
    observations: [],
    quality_axes: { creative_quality: QUALITY_RATING.STRONG },
  });
  assert.equal(judgement.verdict, BENCHMARK_VERDICT.UNDETERMINED);
  assert.equal(judgement.accepted, false);
});

test('judgement becomes ACCEPTED only after required checks pass', () => {
  const judgement = recordBenchmarkJudgement({
    run: {
      run_id: 'r',
      benchmark_case_id: 'c',
      model_id: 'm',
      direct_cost_eur: 0.05,
    },
    benchmarkCase,
    observations: passingObservations,
    quality_axes: { creative_quality: QUALITY_RATING.STRONG },
  });
  assert.equal(judgement.verdict, BENCHMARK_VERDICT.ACCEPTED);
});

test('quality axes reject opaque numeric scoring', () => {
  assert.throws(
    () => recordBenchmarkJudgement({
      run: {
        run_id: 'r',
        benchmark_case_id: 'c',
        model_id: 'm',
      },
      benchmarkCase,
      observations: passingObservations,
      quality_axes: { creative_quality: 92 },
    }),
    /QUALITY_RATING/,
  );
});

test('summary excludes undetermined from accepted-rate denominator', () => {
  const summary = summarizeBenchmark([
    { model_id: 'a', verdict: 'ACCEPTED', direct_cost_eur: 0.1 },
    { model_id: 'a', verdict: 'REJECTED', direct_cost_eur: 0.1 },
    { model_id: 'a', verdict: 'UNDETERMINED', direct_cost_eur: 0.1 },
  ]);
  assert.equal(summary[0].accepted_rate, 0.5);
  assert.equal(summary[0].undetermined, 1);
});

test('sandwich preserves product pixels and deterministic overlays', () => {
  const plan = buildSandwichPlan({
    source_product_ref: 'asset://real.png',
    overlay_specs: [{ kind: 'PRICE', value: '24,90 €' }],
  });
  assert.ok(
    plan.invariants.includes('PRODUCT_PIXELS_ARE_NOT_REGENERATED'),
  );
  assert.ok(
    plan.steps.includes('DRAW_TEXT_PRICE_LOGO_DETERMINISTICALLY'),
  );
});

test('adapter contract rejects missing run method', () => {
  assert.throws(
    () => assertBenchmarkAdapter({
      id: 'a',
      model_id: 'm',
      canRun() {
        return { allowed: true };
      },
    }),
    /adapter.run/,
  );
});

test('adapter execution can be skipped before provider call', async () => {
  const result = await executeBenchmarkAdapter({
    id: 'a',
    model_id: 'm',
    async canRun() {
      return { allowed: false, reason: 'LICENSE_NOT_VERIFIED' };
    },
    async run() {
      throw new Error('must not run');
    },
  }, { case_id: 'c' });

  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.reason, 'LICENSE_NOT_VERIFIED');
});

test('adapter execution keeps unknown direct cost unknown', async () => {
  const result = await executeBenchmarkAdapter({
    id: 'a',
    model_id: 'm',
    async canRun() {
      return { allowed: true };
    },
    async run() {
      return { output_ref: 'artifact://x' };
    },
  }, { case_id: 'c' });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.direct_cost_eur, null);
});

test('manifest rejects duplicate case ids', () => {
  assert.throws(
    () => normalizeBenchmarkManifest({
      benchmark_id: 'b',
      merchant_id: 'm',
      cases: [
        {
          id: 'c',
          task: BENCHMARK_TASK.BACKGROUND_SWAP,
          source_refs: ['asset://x'],
        },
        {
          id: 'c',
          task: BENCHMARK_TASK.PREMIUM_AD,
          source_refs: ['asset://y'],
        },
      ],
    }),
    /duplicate benchmark case id/,
  );
});

test('matrix blocks missing artifact hash before adapter execution', async () => {
  const manifest = normalizeBenchmarkManifest({
    benchmark_id: 'b',
    merchant_id: 'm',
    cases: [{
      id: 'c',
      task: BENCHMARK_TASK.BACKGROUND_SWAP,
      source_refs: ['asset://x'],
    }],
  });
  const registry = new CapabilityRegistry([
    baseEntry({ version_hash: null }),
  ]);
  let called = false;

  const rows = await runBenchmarkMatrix({
    manifest,
    registry,
    adapters: [{
      id: 'a',
      model_id: 'model-a',
      async canRun() {
        return { allowed: true };
      },
      async run() {
        called = true;
        return { output_ref: 'artifact://x' };
      },
    }],
  });

  assert.equal(called, false);
  assert.equal(rows[0].reason, 'ARTIFACT_HASH_MISSING');
});

test('matrix writes success to provenance ledger', async () => {
  const manifest = normalizeBenchmarkManifest({
    benchmark_id: 'b',
    merchant_id: 'merchant',
    cases: [{
      id: 'c',
      task: BENCHMARK_TASK.BACKGROUND_SWAP,
      source_refs: ['asset://x'],
    }],
  });
  const registry = new CapabilityRegistry([baseEntry()]);
  const ledger = new ProvenanceLedger();

  const rows = await runBenchmarkMatrix({
    manifest,
    registry,
    ledger,
    adapters: [{
      id: 'a',
      model_id: 'model-a',
      async canRun() {
        return { allowed: true };
      },
      async run() {
        return {
          output_ref: 'artifact://out',
          direct_cost_eur: 0.04,
          compute_seconds: 2,
          metadata: { seed: 7, retry_index: 0 },
        };
      },
    }],
  });

  assert.equal(rows[0].status, 'SUCCEEDED');
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.list()[0].result_status, 'SUCCEEDED');
});

test('matrix records failed attempts so cost completeness is visible', async () => {
  const manifest = normalizeBenchmarkManifest({
    benchmark_id: 'b',
    merchant_id: 'merchant',
    cases: [{
      id: 'c',
      task: BENCHMARK_TASK.BACKGROUND_SWAP,
      source_refs: ['asset://x'],
    }],
  });
  const registry = new CapabilityRegistry([baseEntry()]);
  const ledger = new ProvenanceLedger();

  await runBenchmarkMatrix({
    manifest,
    registry,
    ledger,
    adapters: [{
      id: 'a',
      model_id: 'model-a',
      async canRun() {
        return { allowed: true };
      },
      async run() {
        const error = new Error('provider failed');
        error.direct_cost_eur = 0.02;
        throw error;
      },
    }],
  });

  assert.equal(ledger.list()[0].result_status, 'FAILED');
  assert.equal(ledger.list()[0].direct_cost_eur, 0.02);
});
