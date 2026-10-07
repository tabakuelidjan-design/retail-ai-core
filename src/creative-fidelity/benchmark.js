import {
  BENCHMARK_TASK,
  BENCHMARK_VERDICT,
  FIDELITY_GATE_OUTCOME,
} from './constants.js';
import {
  evaluateHardFidelityGate,
  normalizeQualityAxes,
  requiredChecksFromInvariants,
} from './fidelity-gates.js';
import { summarizeCosts } from './provenance.js';

export function createBenchmarkCase(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('benchmark case must be an object');
  }
  if (!Object.values(BENCHMARK_TASK).includes(input.task)) {
    throw new TypeError(`unsupported task: ${input.task}`);
  }
  if (typeof input.id !== 'string' || !input.id) {
    throw new TypeError('id is required');
  }
  if (!Array.isArray(input.source_refs) || !input.source_refs.length) {
    throw new TypeError(
      'source_refs must contain at least one source asset',
    );
  }

  return Object.freeze({
    id: input.id,
    product_id: input.product_id ?? null,
    task: input.task,
    source_refs: Object.freeze([...input.source_refs]),
    instruction: input.instruction ?? null,
    expected_invariants: Object.freeze([
      ...(input.expected_invariants ?? []),
    ]),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export function recordBenchmarkJudgement({
  run,
  benchmarkCase,
  observations = [],
  quality_axes = {},
}) {
  if (!benchmarkCase) throw new TypeError('benchmarkCase is required');

  const requiredChecks = requiredChecksFromInvariants(
    benchmarkCase.expected_invariants,
  );
  const hard = evaluateHardFidelityGate({
    observations,
    requiredChecks,
  });

  const verdict = hard.outcome === FIDELITY_GATE_OUTCOME.PASS
    ? BENCHMARK_VERDICT.ACCEPTED
    : hard.outcome === FIDELITY_GATE_OUTCOME.FAIL
      ? BENCHMARK_VERDICT.REJECTED
      : BENCHMARK_VERDICT.UNDETERMINED;

  return Object.freeze({
    run_id: run.run_id,
    benchmark_case_id: run.benchmark_case_id,
    model_id: run.model_id,
    verdict,
    accepted: verdict === BENCHMARK_VERDICT.ACCEPTED,
    hard_gate: hard,
    quality_axes: normalizeQualityAxes(quality_axes),
    direct_cost_eur: run.direct_cost_eur ?? null,
    duration_ms: run.duration_ms ?? null,
  });
}

export function summarizeBenchmark(judgements) {
  const rows = [...judgements];
  const byModel = new Map();

  for (const row of rows) {
    if (!byModel.has(row.model_id)) byModel.set(row.model_id, []);
    byModel.get(row.model_id).push(row);
  }

  return [...byModel.entries()]
    .map(([modelId, modelRows]) => {
      const accepted = modelRows
        .filter((x) => x.verdict === BENCHMARK_VERDICT.ACCEPTED)
        .length;
      const rejected = modelRows
        .filter((x) => x.verdict === BENCHMARK_VERDICT.REJECTED)
        .length;
      const undetermined = modelRows
        .filter((x) => x.verdict === BENCHMARK_VERDICT.UNDETERMINED)
        .length;
      const measurable = accepted + rejected;

      return Object.freeze({
        model_id: modelId,
        runs: modelRows.length,
        accepted,
        rejected,
        undetermined,
        measurable_runs: measurable,
        accepted_rate: measurable ? accepted / measurable : null,
        undetermined_rate: modelRows.length
          ? undetermined / modelRows.length
          : null,
        cost: summarizeCosts(
          modelRows.map((x) => ({
            verdict: x.verdict,
            direct_cost_eur: x.direct_cost_eur,
          })),
        ),
        note: (
          'No universal winner is selected automatically; compare hard '
          + 'gates, visible quality axes, latency and cost.'
        ),
      });
    })
    .sort((a, b) => a.model_id.localeCompare(b.model_id));
}
