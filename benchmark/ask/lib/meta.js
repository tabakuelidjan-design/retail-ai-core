// Reproducibility metadata recorded in every result file: what was run, on which data, with which model, from which code, and when.
// Secrets NEVER enter a result: configuration is redacted by key name and by value shape, and the environment is never dumped.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCHMARK_NAME = 'nordla-ask-benchmark';
export const BENCHMARK_VERSION = '1.1.0';      // 1.0.0: 30 cases + oracle; 1.1.0: acceptable plans, repetitions, metadata (the 30 questions are unchanged)
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SECRET_KEY = /(api[_-]?key|token(?!s)|secret|password|passwd|authorization|bearer|credential)/i;   // "tokens" (a count) is not a secret
const SECRET_VALUE = /^(sk|pk|rk|xox[bap]|ghp|gho|AIza)[-_A-Za-z0-9]{12,}$|^Bearer\s+\S+/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;    // the NAME of an environment variable is not a secret ("OPENAI_KEY" tells nothing); its value is never read here

/** Deep copy with every secret replaced by "[redacted]" (by key name, or by the shape of the value). */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && (typeof v === 'string' ? v !== '' && !ENV_NAME.test(v) : v !== null && typeof v === 'object') ? '[redacted]' : redact(v)]));   // only strings/objects can be secrets: counts and flags stay
  }
  return typeof value === 'string' && SECRET_VALUE.test(value) ? '[redacted]' : value;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (args, cwd = REPO_ROOT) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

export function nordlaInfo() {
  const commit = git(['rev-parse', 'HEAD']);
  return { commit, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: commit ? git(['status', '--porcelain', '--untracked-files=no']) !== '' : null };
}

/** The adapter's own code: path, the last commit that touched it, and the hash of the file actually used (so an uncommitted edit is visible). */
export function adapterInfo(file) {
  if (!file || !existsSync(file)) return null;
  const abs = path.resolve(file); const rel = path.relative(REPO_ROOT, abs);
  const inRepo = !rel.startsWith('..');
  return { path: inRepo ? rel.replace(/\\/g, '/') : path.basename(abs), commit: inRepo ? git(['log', '-1', '--format=%H', '--', rel]) || null : null, uncommittedChanges: inRepo ? git(['status', '--porcelain', '--', rel]) !== '' : null, sha256: sha256(readFileSync(abs)) };
}

/**
 * @param {{ provider: object, config?: object, adapterFile?: string, repeats: number, only?: string[]|null, timeoutMs?: number, startedAt: Date, finishedAt: Date,
 *           casesFile: string, datasetFile?: string, referenceDate: string }} p
 */
export function collectMetadata({ provider, config = {}, adapterFile = null, repeatMetadata = [], runExtra = {}, repeats, only = null, timeoutMs = null, startedAt, finishedAt, casesFile, datasetFile = null, referenceDate }) {
  const own = redact(typeof provider.metadata === 'function' ? provider.metadata() ?? {} : {});
  const cfg = redact(config);
  return {
    benchmark: {
      name: BENCHMARK_NAME, version: BENCHMARK_VERSION, cases: 30, casesSha256: sha256(readFileSync(casesFile)),
      dataset: 'synthetic-fixed', datasetSha256: datasetFile ? sha256(readFileSync(datasetFile)) : null, referenceDate,
    },
    run: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt - startedAt, repeats, only, timeoutMs, node: process.version, platform: process.platform, ...runExtra },
    nordla: nordlaInfo(),
    provider: {
      name: provider.name,
      model: own.model ?? cfg.model ?? null,
      modelVersion: own.modelVersion ?? cfg.modelVersion ?? null,          // the exact version/snapshot the service reports, when it reports one
      temperature: own.temperature ?? cfg.temperature ?? null,             // or the equivalent sampling setting of that provider
      metadata: own,                                                       // anything else the adapter chooses to declare (already redacted)
      config: cfg,                                                         // the --config file (already redacted)
      repeatMetadata: redact(repeatMetadata),                              // metadata() of the provider instance of EACH repetition (usage totals, call counts, errors)
    },
    adapter: adapterInfo(adapterFile),
  };
}
