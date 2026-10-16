// File-backed Stock / Achats store: the in-memory reference store plus durable, atomic persistence to ONE JSON file. It exists for the field laptop (Yiwu): no
// database to reach, nothing shared, and a restart finds every order, quote and stock movement again.
//
//  - A transaction is "committed" only once the new state is on disk: written to a temp file, fsync'd, then renamed over the data file (atomic). If that write
//    fails the transaction is rolled back and the command fails (STORE_UNAVAILABLE) - it never reports success for data that was not saved.
//  - A corrupt or unreadable file is NEVER replaced by an empty store: opening refuses (STORE_CORRUPT) and the damaged file is left untouched for recovery.
//  - A lock file keeps two processes from writing the same data file (a stale lock from a dead process is taken over).
//  - OPT-IN `lease` (hosted servers, containers): the process id says nothing across containers (a restarted container can find the old id held by another of ITS
//    processes), so the lock becomes a LEASE: the owner refreshes the lock file's modification time every `heartbeatMs`; a lock is taken over ONLY when it has not
//    been refreshed for `staleMs` (the owner is then dead or frozen for longer than that), never because of a process id; a fresh lock is waited for (up to
//    `waitMs`: the previous container is shutting down) and then refused (STORE_LOCKED). The owner checks, before every write, that the lock is still its own and
//    refuses to write otherwise (STORE_LOCK_LOST): two writers can never both commit. Default (no `lease`): the process-id behaviour above, unchanged.
//  - Single-process by design. For several users / devices, use the PostgreSQL store.
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createMemoryProcurementStore } from './memory-store.js';
import { StoreError } from './errors.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openFileProcurementStore({ path, newId, lease = null } = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('openFileProcurementStore needs a file path');
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  // ---- lock
  const L = lease ? { heartbeatMs: 5000, staleMs: 60000, waitMs: 70000, pollMs: 500, ...(lease === true ? {} : lease) } : null;
  const instance = randomUUID(); let heartbeat = null; let lost = false;
  const stamp = () => JSON.stringify({ v: 2, instance, host: hostname(), pid: process.pid, at: new Date().toISOString() });
  const ours = async () => { try { return JSON.parse(await readFile(lockPath, 'utf8')).instance === instance; } catch { return false; } };
  if (L) {
    const deadline = Date.now() + L.waitMs;
    for (;;) {
      try { const h = await open(lockPath, 'wx'); await h.writeFile(stamp()); await h.close(); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let st; try { st = await stat(lockPath); } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2; }
        if (Date.now() - st.mtimeMs > L.staleMs) {
          // not refreshed for staleMs: take over, but only the very file judged stale (re-checked right before the atomic rename)
          let again = null; try { again = await stat(lockPath); } catch { /* gone */ }
          if (again && again.mtimeMs === st.mtimeMs && again.size === st.size) { const gone = `${lockPath}.stale.${instance}`; await rename(lockPath, gone).then(() => unlink(gone)).catch(() => {}); }
          continue;
        }
        if (Date.now() >= deadline) { const holder = await readFile(lockPath, 'utf8').then((t) => JSON.parse(t)).catch(() => ({})); throw new StoreError('STORE_LOCKED', `${path} is held by a live writer (lock refreshed ${Math.round((Date.now() - st.mtimeMs) / 1000)} s ago)`, { holder: holder.host ?? null }); }
        await sleep(L.pollMs);
      }
    }
    heartbeat = setInterval(async () => {
      if (!(await ours())) { lost = true; clearInterval(heartbeat); return; }
      const now = new Date(); await utimes(lockPath, now, now).catch(() => {});
    }, L.heartbeatMs); heartbeat.unref?.();
  } else {
    for (let attempt = 0; ; attempt += 1) {
      try { const h = await open(lockPath, 'wx'); await h.writeFile(String(process.pid)); await h.close(); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const holder = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
        if (holder && alive(holder) && holder !== process.pid) throw new StoreError('STORE_LOCKED', `${path} is in use by process ${holder}`, { holder });
        if (attempt > 2) throw new StoreError('STORE_LOCKED', `${path}: cannot take over the lock`);
        await unlink(lockPath).catch(() => {}); // stale lock from a dead process
      }
    }
  }
  const release = async () => { if (heartbeat) clearInterval(heartbeat); if (!L || (await ours())) await unlink(lockPath).catch(() => {}); };
  // ---- load
  let state = null;
  try {
    const text = await readFile(path, 'utf8');
    try { state = JSON.parse(text); } catch (e) { await release(); throw new StoreError('STORE_CORRUPT', `${path} is not valid JSON: the file was left untouched`, { path }); }
  } catch (e) {
    if (e instanceof StoreError) throw e;
    if (e.code !== 'ENOENT') { await release(); throw e; }
  }
  let closed = false;
  async function persist(s) {
    if (closed) throw new Error('the store is closed');
    if (L && (lost || !(await ours()))) { lost = true; throw new StoreError('STORE_LOCK_LOST', `${path}: the write lock is no longer ours (another process took it): nothing was written`); }
    const tmp = `${path}.${process.pid}.tmp`;
    const h = await open(tmp, 'w');
    try { await h.writeFile(JSON.stringify(s)); await h.sync(); } finally { await h.close(); }
    await rename(tmp, path);
  }
  let store;
  try { store = createMemoryProcurementStore({ newId, state, onCommit: persist }); } catch (e) { await release(); throw new StoreError('STORE_CORRUPT', `${path}: ${e.message}`, { path }); }
  if (!state) await persist(store.exportState()); // a new store exists on disk from the first moment
  return Object.assign(store, {
    path,
    /** Release the lock. The data stays. */
    async close() { if (closed) return; closed = true; await release(); },
  });
}
