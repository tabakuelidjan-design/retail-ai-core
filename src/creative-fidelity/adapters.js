export const ADAPTER_RESULT_STATUS = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

export function assertBenchmarkAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('adapter must be an object');
  }
  if (typeof adapter.id !== 'string' || !adapter.id) {
    throw new TypeError('adapter.id is required');
  }
  if (typeof adapter.model_id !== 'string' || !adapter.model_id) {
    throw new TypeError('adapter.model_id is required');
  }
  if (typeof adapter.canRun !== 'function') {
    throw new TypeError('adapter.canRun must be a function');
  }
  if (typeof adapter.run !== 'function') {
    throw new TypeError('adapter.run must be a function');
  }
  return adapter;
}

export async function executeBenchmarkAdapter(adapter, request) {
  assertBenchmarkAdapter(adapter);

  const gate = await adapter.canRun(request);
  if (!gate || gate.allowed !== true) {
    return Object.freeze({
      status: ADAPTER_RESULT_STATUS.SKIPPED,
      model_id: adapter.model_id,
      reason: gate?.reason ?? 'ADAPTER_NOT_ALLOWED',
    });
  }

  const started = Date.now();

  try {
    const result = await adapter.run(Object.freeze({ ...request }));
    if (
      !result
      || typeof result.output_ref !== 'string'
      || !result.output_ref
    ) {
      throw new TypeError('adapter result.output_ref is required');
    }

    return Object.freeze({
      status: ADAPTER_RESULT_STATUS.SUCCEEDED,
      model_id: adapter.model_id,
      output_ref: result.output_ref,
      duration_ms: result.duration_ms ?? (Date.now() - started),
      direct_cost_eur: result.direct_cost_eur ?? null,
      compute_seconds: result.compute_seconds ?? null,
      metadata: Object.freeze({ ...(result.metadata ?? {}) }),
    });
  } catch (error) {
    return Object.freeze({
      status: ADAPTER_RESULT_STATUS.FAILED,
      model_id: adapter.model_id,
      reason: error instanceof Error ? error.message : String(error),
      direct_cost_eur: error?.direct_cost_eur ?? null,
      metadata: Object.freeze({ ...(error?.metadata ?? {}) }),
    });
  }
}
