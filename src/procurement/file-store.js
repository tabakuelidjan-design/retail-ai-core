// File-backed Stock / Achats store: the in-memory reference store plus durable, atomic persistence to ONE JSON file. It exists for the field laptop (Yiwu): no
// database to reach, nothing shared, and a restart finds every order, quote and stock movement again.
//
//  - A transaction is "committed" only once the new state is on disk: written to a temp file, fsync'd, then renamed over the data file (atomic). If that write
//    fails the transaction is rolled back and the command fails (STORE_UNAVAILABLE) - it never reports success for data that was not saved.
//  - A corrupt or unreadable file is NEVER replaced by an empty store: opening refuses (STORE_CORRUPT) and the damaged file is left untouched for recovery.
//  - A lock file keeps two processes from writing the same data file (a stale lock from a dead process is taken over).
//  - Single-process by design. For several users / devices, use the PostgreSQL store.
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMemoryProcurementStore } from './memory-store.js';
import { StoreError } from './errors.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export async function openFileProcurementStore({ path, newId } = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('openFileProcurementStore needs a file path');
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  // ---- lock
  for (let attempt = 0; ; attempt += 1) {
    try { const h = await open(lockPath, 'wx'); await h.writeFile(String(process.pid)); await h.close(); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
      if (holder && alive(holder) && holder !== process.pid) throw new StoreError('STORE_LOCKED', `${path} is in use by process ${holder}`, { holder });
      if (attempt > 2) throw new StoreError('STORE_LOCKED', `${path}: cannot take over the lock`);
      await unlink(lockPath).catch(() => {}); // stale lock from a dead process
    }
  }
  // ---- load
  let state = null;
  try {
    const text = await readFile(path, 'utf8');
    try { state = JSON.parse(text); } catch (e) { await unlink(lockPath).catch(() => {}); throw new StoreError('STORE_CORRUPT', `${path} is not valid JSON: the file was left untouched`, { path }); }
  } catch (e) {
    if (e instanceof StoreError) throw e;
    if (e.code !== 'ENOENT') { await unlink(lockPath).catch(() => {}); throw e; }
  }
  let closed = false;
  async function persist(s) {
    if (closed) throw new Error('the store is closed');
    const tmp = `${path}.${process.pid}.tmp`;
    const h = await open(tmp, 'w');
    try { await h.writeFile(JSON.stringify(s)); await h.sync(); } finally { await h.close(); }
    await rename(tmp, path);
  }
  let store;
  try { store = createMemoryProcurementStore({ newId, state, onCommit: persist }); } catch (e) { await unlink(lockPath).catch(() => {}); throw new StoreError('STORE_CORRUPT', `${path}: ${e.message}`, { path }); }
  if (!state) await persist(store.exportState()); // a new store exists on disk from the first moment
  return Object.assign(store, {
    path,
    /** Release the lock. The data stays. */
    async close() { if (closed) return; closed = true; await unlink(lockPath).catch(() => {}); },
  });
}
