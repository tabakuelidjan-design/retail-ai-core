// Durable, line-oriented, append-only file primitives shared by the Core journals (decision journal, campaigns, creations).
//
//  - appendLineDurably: ONE open in append mode, the whole line (with its newline) written in as few write() calls as the OS needs, then datasync on the SAME
//    handle, then close. Append mode is what makes datasync legal on Windows (a read-only handle gets EPERM) and keeps Linux behaviour unchanged.
//  - withWriteLock: a lock FILE (`<file>.lock`, created exclusively) held for the duration of one check-and-append. It serialises the processes that use
//    it. It is a cooperative, lease-based lock, NOT a kernel lock: a writer that ignores it is only DETECTED (size check), and a lock left by a crashed
//    process is taken over after STALE_LOCK_MS. See docs/integration/core-journal-reliability.md for the exact guarantee.
//  - readJsonlStrict: a missing file is an empty history; anything else that is not a clean journal is an explicit, typed error (never an empty list).
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A typed error: `code` is stable (tests and the UI branch on it), `status` is the HTTP status the server returns, `details` is evidence for the operator. */
export class DurableFileError extends Error {
  constructor(code, message, { status = 503, details = null } = {}) { super(`${code}: ${message}`); this.name = 'DurableFileError'; this.code = code; this.status = status; this.details = details; }
}

export const STALE_LOCK_MS = 15_000; // a lock older than this is a crashed writer's (a check-and-append takes milliseconds)
export const LOCK_WAIT_MS = 4_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Appends `line` + "\n" and makes it durable. Returns the number of bytes written. Throws on ANY short or failed write: the caller must treat the file as uncertain. */
export async function appendLineDurably(file, line, { mode = 0o600, openFile = open } = {}) {
  if (line.includes('\n')) throw new DurableFileError('APPEND_LINE_HAS_NEWLINE', 'a journal line is one line', { status: 500 });
  await mkdir(dirname(file), { recursive: true });
  const buf = Buffer.from(`${line}\n`, 'utf8');
  const h = await openFile(file, 'a', mode); // `openFile` is injectable only so a test can simulate short and failed writes
  try {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await h.write(buf, off, buf.length - off);
      if (!bytesWritten) throw new DurableFileError('APPEND_SHORT_WRITE', `the write stopped after ${off} of ${buf.length} bytes`, { status: 503, details: { written: off, expected: buf.length } });
      off += bytesWritten;
    }
    await h.datasync();
  } finally { await h.close(); }
  return buf.length;
}

export async function fileSize(file) {
  try { return (await stat(file)).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
}

/**
 * Runs `fn` while holding `<file>.lock`. The lock is released in `finally` only if it is still ours (a taken-over lock is never removed by its old owner).
 * Throws DurableFileError JOURNAL_LOCKED (503, transient: nothing was written) when the lock cannot be taken within `waitMs`.
 */
// Creating the lock file can fail for two very different reasons that Windows reports with the same codes:
//   contention  : EEXIST (a writer holds it), or - on Windows - EPERM / EBUSY / EACCES while a just-removed lock file is still "delete pending" for a few milliseconds;
//   permission  : the data directory really refuses us (EACCES / EPERM on a read-only or foreign-owned directory, a volume mounted without write access).
// EEXIST is always contention. EPERM / EBUSY / EACCES are contention when the lock file exists, or when they clear within AMBIGUOUS_LOCK_MS; if they persist that long
// with NO lock file in sight they are a permission problem and are reported as JOURNAL_LOCK_PERMISSION (not transient: it protects the journal), with the OS code,
// instead of being mistaken for "another writer holds the journal" until the deadline.
const LOCK_AMBIGUOUS = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const AMBIGUOUS_LOCK_MS = 1_500;

export async function withWriteLock(file, fn, { waitMs = LOCK_WAIT_MS, staleMs = STALE_LOCK_MS, ambiguousMs = AMBIGUOUS_LOCK_MS, now = Date.now, openFile = open } = {}) {
  const lock = `${file}.lock`; const token = randomUUID();
  await mkdir(dirname(file), { recursive: true });
  const deadline = now() + waitMs; let lastBusy = null; let ambiguousSince = null;
  for (;;) {
    try {
      const h = await openFile(lock, 'wx', 0o600);
      // the lock file is OURS from here: if its content cannot be written (disk full, read-only), remove it before failing, so a full disk does
      // not leave an empty lock that blocks every writer until it turns stale (found on a real full tmpfs: test/core-storage-realfs.test.js)
      try { try { await h.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date(now()).toISOString() })); } finally { await h.close(); } } catch (e) { await unlink(lock).catch(() => {}); throw e; }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && !LOCK_AMBIGUOUS.has(e.code)) throw e;
      lastBusy = e.code;
      let st = null; try { st = await stat(lock); } catch { /* released meanwhile, or delete pending, or not readable */ }
      if (e.code === 'EEXIST' || st) ambiguousSince = null; // a lock file is there: this is contention
      else {
        ambiguousSince ??= now();
        if (now() - ambiguousSince > ambiguousMs) throw new DurableFileError('JOURNAL_LOCK_PERMISSION', `cannot create ${lock} (${e.code}) and no writer holds it: the data directory refuses writes (permission), this is not contention; nothing was written`, { status: 503, details: { cause_code: e.code, directory: dirname(file) } });
      }
      if (st && now() - st.mtimeMs > staleMs) { await unlink(lock).catch(() => {}); continue; } // a crashed writer's lock
      if (now() > deadline) throw new DurableFileError('JOURNAL_LOCKED', 'another writer holds the journal; nothing was written, try again', { status: 503, details: { last_busy_code: lastBusy } });
      await sleep(15 + Math.floor(Math.random() * 20));
    }
  }
  try { return await fn(); } finally {
    try { const mine = JSON.parse(await readFile(lock, 'utf8')).token === token; if (mine) await unlink(lock); } catch { /* already gone or taken over */ }
  }
}

/**
 * Reads a JSONL file for a service whose entries are plain objects. ENOENT -> []. A damaged or unreadable file is NEVER an empty history:
 *   unreadable (permission, I/O)         -> `${label}_UNREADABLE`
 *   last line cut short (no newline)     -> `${label}_TORN_TAIL`   (what an interrupted append leaves)
 *   any other line that is not JSON      -> `${label}_CORRUPT`     (names the line)
 */
export async function readJsonlStrict(file, label) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new DurableFileError(`${label}_UNREADABLE`, `${file} cannot be read (${e.code ?? e.message}); the history is NOT empty, it is unavailable`, { status: 503, details: { cause: e.code ?? String(e.message) } });
  }
  const parts = raw.split('\n'); const terminated = parts.at(-1) === ''; if (terminated) parts.pop();
  return parts.map((l, i) => {
    try { return JSON.parse(l); } catch {
      const last = i === parts.length - 1;
      if (last && !terminated) throw new DurableFileError(`${label}_TORN_TAIL`, `line ${i + 1} is incomplete (an interrupted write); the file was not modified and needs a controlled recovery`, { status: 503, details: { line: i + 1 } });
      throw new DurableFileError(`${label}_CORRUPT`, `line ${i + 1} is not valid JSON; the history before and after it is not trustworthy until it is examined`, { status: 503, details: { line: i + 1 } });
    }
  });
}

/** One queue per owner: operations run one after the other, a failed one never blocks the next. */
export function createSerial() {
  let tail = Promise.resolve();
  return (fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };
}

/** Writes a whole file durably and atomically: temp file in the same directory, datasync, rename over the target. */
export async function writeFileDurably(file, bytes, { mode = 0o600 } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const h = await open(tmp, 'w', mode);
  try { await h.writeFile(bytes); await h.datasync(); } finally { await h.close(); }
  await rename(tmp, file);
}
