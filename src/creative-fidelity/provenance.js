import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const sha256 = (value) => createHash('sha256')
  .update(String(value), 'utf8')
  .digest('hex');

const nn = (value, field) => {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `${field} must be a finite non-negative number or null`,
    );
  }
  return value;
};

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function buildRunRecord(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('run must be an object');
  }

  const accepted = input.verdict === 'ACCEPTED' || input.accepted === true;

  return Object.freeze({
    event_id: input.event_id ?? randomUUID(),
    run_id: input.run_id ?? randomUUID(),
    merchant_id: input.merchant_id ?? null,
    benchmark_case_id: input.benchmark_case_id ?? null,
    model_id: input.model_id ?? null,
    model_version: input.model_version ?? null,
    model_version_hash: input.model_version_hash ?? null,
    source_refs: Object.freeze([...(input.source_refs ?? [])]),
    prompt_sha256: input.prompt == null ? null : sha256(input.prompt),
    parameters_sha256: input.parameters == null
      ? null
      : sha256(stableStringify(input.parameters)),
    seed: input.seed ?? null,
    output_ref: input.output_ref ?? null,
    output_sha256: input.output_sha256 ?? null,
    result_status: input.result_status ?? null,
    verdict: input.verdict ?? (accepted ? 'ACCEPTED' : null),
    accepted,
    rejection_reasons: Object.freeze([...(input.rejection_reasons ?? [])]),
    duration_ms: nn(input.duration_ms, 'duration_ms'),
    direct_cost_eur: nn(input.direct_cost_eur, 'direct_cost_eur'),
    compute_seconds: nn(input.compute_seconds, 'compute_seconds'),
    retry_index: Number.isInteger(input.retry_index) && input.retry_index >= 0
      ? input.retry_index
      : 0,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export class ProvenanceLedger {
  #events = [];

  appendRun(input) {
    const event = buildRunRecord(input);
    this.#events.push(event);
    return event;
  }

  list() {
    return [...this.#events];
  }
}

export class JsonlProvenanceLedger {
  constructor(filePath) {
    if (!path.isAbsolute(filePath)) {
      throw new Error('ledger path must be absolute');
    }

    const cwd = path.resolve(process.cwd());
    const resolved = path.resolve(filePath);
    if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
      throw new Error('ledger path must be outside repository');
    }
    this.filePath = resolved;
  }

  async appendRun(input) {
    const event = buildRunRecord(input);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(
      this.filePath,
      `${JSON.stringify(event)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return event;
  }
}

export function summarizeCosts(events) {
  const rows = [...events];
  let known = 0;
  let accepted = 0;
  let unknown = 0;

  for (const row of rows) {
    if (row.verdict === 'ACCEPTED' || row.accepted === true) accepted += 1;
    if (row.direct_cost_eur == null) {
      unknown += 1;
      continue;
    }
    known += row.direct_cost_eur;
  }

  return Object.freeze({
    runs: rows.length,
    accepted,
    known_cost_eur: Number(known.toFixed(6)),
    unknown_cost_runs: unknown,
    cost_complete: unknown === 0,
    cost_per_accepted_output_eur: accepted > 0 && unknown === 0
      ? Number((known / accepted).toFixed(6))
      : null,
  });
}
