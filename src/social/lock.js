// A cross-process lock for the file store: the thing that makes "read the post, decide, write it back" ATOMIC between processes (two servers, a server and a CLI, a restart
// after a crash), where the in-process serializer of the store only protects one process.
//
//   - The lock is a FILE created with the exclusive flag (`wx`: atomic, create-or-fail). Its content says who holds it: pid, host, a random token, when.
//     (A file, not a directory: on Windows a directory cannot be renamed or removed while another process has a file of it open.)
//   - A lock whose owner is DEAD (same host, pid gone) is recovered at once. A lock held for longer than the lease (`staleMs`, far longer than any store operation: a read, a check and
//     one file replacement) is broken as well, whoever holds it: a hung process must not freeze publishing for ever.
//   - Breaking is SERIALIZED by a second, short-lived lock (`.break`): only the process holding it may remove the stale lock, and it re-reads the lock first. Two processes that find
//     the same dead lock at the same moment can therefore never remove each other's fresh lock.
//   - Release only removes a lock that still carries our token.
//   - Waiting is bounded: after `waitMs` the caller gets SOCIAL_STORE_LOCKED instead of writing over the holder.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  open, readFile, stat, unlink,
} from 'node:fs/promises';
import { SOCIAL_ERROR as E, fail } from './constants.js';

export const LOCK_DEFAULTS = Object.freeze({ staleMs: 60_000, waitMs: 15_000, pollMs: 20, breakStaleMs: 10_000 });

// Windows reports a file that another process is deleting (or has open) as EPERM / EACCES / EBUSY instead of EEXIST / ENOENT: for a lock or a read, that is contention, to be retried.
export const TRANSIENT_FS = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
export async function retryTransient(task, { tries = 50, delayMs = 10 } = {}) {
  for (let i = 1; ; i += 1) {
    try { return await task(); } catch (e) {
      if (!TRANSIENT_FS.includes(e.code) || i >= tries) throw e;
      await sleep(delayMs);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // ESRCH: no such process
}

async function readOwner(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** Is this lock abandoned? (its owner is gone, or it is older than the lease). A lock whose card is not written yet is judged by the file's age. */
async function isStale(path, { staleMs, host }) {
  const owner = await readOwner(path);
  let at = owner?.at ? Date.parse(owner.at) : NaN;
  if (Number.isNaN(at)) { try { at = (await stat(path)).mtimeMs; } catch { return false; } }
  if (owner?.pid && owner.host === host && !processIsAlive(owner.pid)) return true;
  return Date.now() - at > staleMs;
}

async function createExclusive(path, content) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(content); } finally { await handle.close(); }
}

/** Try to remove a stale lock. Returns true when the lock is gone (removed here, or by someone else), false when it is not stale or someone else is breaking it. */
async function breakIfStale(path, opts) {
  const breakPath = `${path}.break`;
  if (!(await isStale(path, opts))) return false;
  const decidedOn = (await readOwner(path))?.token ?? null;
  try { await createExclusive(breakPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch (e) {
    if (e.code !== 'EEXIST' && !TRANSIENT_FS.includes(e.code)) throw e;
    if (await isStale(breakPath, { staleMs: opts.breakStaleMs, host: opts.host })) { try { await unlink(breakPath); } catch { /* someone else did */ } }
    return false;
  }
  try {
    // re-read INSIDE the break lock: if the lock changed hands since we judged it, leave it alone
    if (await isStale(path, opts) && ((await readOwner(path))?.token ?? null) === decidedOn) { try { await unlink(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    return true;
  } finally {
    try { await unlink(breakPath); } catch { /* already gone */ }
  }
}

export async function withDirLock(lockPath, fn, options = {}) {
  const opts = { ...LOCK_DEFAULTS, ...options, host: options.host ?? hostname() };
  const token = randomUUID();
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    try {
      await createExclusive(lockPath, JSON.stringify({ pid: process.pid, host: opts.host, token, at: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && !TRANSIENT_FS.includes(e.code)) throw e;
      if (await breakIfStale(lockPath, opts)) continue;
      if (Date.now() >= deadline) fail(E.STORE_LOCKED, 'the data folder is locked by another Nordla process; try again in a moment', { lock: lockPath });
      await sleep(opts.pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    if ((await readOwner(lockPath))?.token === token) { try { await unlink(lockPath); } catch { /* already gone */ } }
  }
}
