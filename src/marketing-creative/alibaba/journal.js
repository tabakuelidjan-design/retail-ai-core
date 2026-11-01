import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository that holds THIS code: the nearest ancestor of this module's folder containing `.git` (a folder in a clone, a FILE in a git worktree).
 * Not process.cwd(): the working directory says where a command was typed, not where the repository is (on Windows a trial is typically launched from a
 * parent folder or the user's home, which made every journal under it look "inside the repository"). Null when the code does not run from a repository.
 */
export function repositoryRootOf(startDir = path.dirname(fileURLToPath(import.meta.url))) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when `target` is `root` or below it. Case-insensitive on Windows (C:\\Repo and c:\\repo are the same folder there). */
export function isInside(root, target, platformPath = path) {
  const rel = platformPath.relative(platformPath.resolve(root), platformPath.resolve(target));
  const norm = platformPath === path.win32 ? rel.toLowerCase() : rel;
  return norm === '' || (!norm.startsWith('..') && !platformPath.isAbsolute(norm));
}

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
    'operation',
    'latency_ms',
    'usage',
    'input_sha256',
    'prompt_sha256',
    'clearance_id',
    'response_format',
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
  /**
   * @param {string} filePath absolute path of the JSONL journal; refused inside the repository
   * @param {object} [o] { repositoryRoot } the repository to keep the journal out of (default: the one holding this code; if the code does not run from a
   *   repository, the working directory, as before: fail-closed)
   */
  constructor(filePath, { repositoryRoot = repositoryRootOf() ?? process.cwd() } = {}) {
    if (!path.isAbsolute(filePath)) throw new Error('journal path must be absolute');

    const resolved = path.resolve(filePath);
    if (isInside(repositoryRoot, resolved, path)) {
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
