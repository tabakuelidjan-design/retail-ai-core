import { executeBenchmarkAdapter } from './adapters.js';
import { evaluateModelExecutionGate } from './registry.js';

export async function runBenchmarkMatrix({
  manifest,
  registry,
  adapters,
  ledger,
}) {
  const rows = [];
  const adapterMap = new Map(
    adapters.map((adapter) => [adapter.model_id, adapter]),
  );

  for (const model of registry.list()) {
    const gate = evaluateModelExecutionGate(model);
    const adapter = adapterMap.get(model.id) ?? null;

    for (const benchmarkCase of manifest.cases) {
      if (!gate.allowed) {
        rows.push(Object.freeze({
          benchmark_case_id: benchmarkCase.id,
          model_id: model.id,
          status: 'SKIPPED',
          reason: gate.reason,
        }));
        continue;
      }

      if (!adapter) {
        rows.push(Object.freeze({
          benchmark_case_id: benchmarkCase.id,
          model_id: model.id,
          status: 'SKIPPED',
          reason: 'ADAPTER_NOT_CONFIGURED',
        }));
        continue;
      }

      const request = Object.freeze({
        benchmark_id: manifest.benchmark_id,
        merchant_id: manifest.merchant_id,
        case: benchmarkCase,
        model,
      });

      const result = await executeBenchmarkAdapter(adapter, request);
      const row = Object.freeze({
        benchmark_case_id: benchmarkCase.id,
        model_id: model.id,
        ...result,
      });
      rows.push(row);

      if (ledger) {
        await ledger.appendRun({
          benchmark_case_id: benchmarkCase.id,
          merchant_id: manifest.merchant_id,
          model_id: model.id,
          model_version: model.version,
          model_version_hash: model.version_hash,
          source_refs: benchmarkCase.source_refs,
          output_ref: result.output_ref ?? null,
          output_sha256: result.metadata?.output_sha256 ?? null,
          duration_ms: result.duration_ms ?? null,
          direct_cost_eur: result.direct_cost_eur ?? null,
          compute_seconds: result.compute_seconds ?? null,
          result_status: result.status,
          parameters: result.metadata?.parameters ?? null,
          seed: result.metadata?.seed ?? null,
          retry_index: result.metadata?.retry_index ?? 0,
          metadata: {
            benchmark_id: manifest.benchmark_id,
            adapter_id: adapter.id,
            reason: result.reason ?? null,
          },
        });
      }
    }
  }

  return Object.freeze(rows);
}
