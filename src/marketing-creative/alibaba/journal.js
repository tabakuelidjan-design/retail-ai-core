import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

function sanitizeEvent(event) {
  const allowed = [
    'event',
    'operation_id',
    'provider',
    'model',
    'region',
    'request_id',
    'task_id',
    'status',
    'estimated_cost_eur',
    'actual_cost_eur',
    'data_class',
    'source_hashes',
    'output_sha256',
    'created_at',
    'reason',
  ];
  const output = {};
  for (const key of allowed) {
    if (event[key] !== undefined) output[key] = event[key];
  }
  return Object.freeze(output);
}

export class MemoryCallJournal {
  #events = [];

  async append(event) {
    const row = sanitizeEvent({
      ...event,
      created_at: event.created_at ?? new Date().toISOString(),
    });
    this.#events.push(row);
    return row;
  }

  list() {
    return [...this.#events];
  }
}

export class JsonlCallJournal {
  constructor(filePath) {
    if (!path.isAbsolute(filePath)) throw new Error('journal path must be absolute');

    const cwd = path.resolve(process.cwd());
    const resolved = path.resolve(filePath);
    if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
      throw new Error('journal path must be outside repository');
    }
    this.filePath = resolved;
  }

  async append(event) {
    const row = sanitizeEvent({
      ...event,
      created_at: event.created_at ?? new Date().toISOString(),
    });

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(
      this.filePath,
      `${JSON.stringify(row)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return row;
  }
}
