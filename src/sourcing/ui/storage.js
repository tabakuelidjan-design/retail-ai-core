// On-phone storage. Small JSON (cases, token, flags) stays in localStorage; everything LARGE (product / document photos, the Safety Gate copy) goes to IndexedDB, whose quota is
// far bigger than localStorage's ~5 MB (26 weeks of Safety Gate alerts plus a few phone photos would otherwise fill it and silently lose a case).
// A synchronous in-memory mirror (loaded once at start by `initStorage`) lets the UI render without awaiting. If IndexedDB is unavailable (private mode) it falls back to localStorage
// for the large items and reports it. Only what the field application needs is stored: no analytics, no tracking, nothing about other merchants.
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  keys() { try { return Object.keys(localStorage).filter((k) => k.startsWith('nordla.sourcing.')); } catch { return []; } },
};

const DB = 'nordla-sourcing'; const STORE = 'blobs'; const mem = new Map(); let dbp = null; let idbOk = true;
const open = () => (dbp ??= new Promise((resolve, reject) => {
  try { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); } catch (e) { reject(e); }
}));
const tx = async (mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(STORE, mode); const req = fn(t.objectStore(STORE)); t.oncomplete = () => resolve(req?.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); }); };

/** Loads every stored blob into memory and migrates the large items an earlier version kept in localStorage. Call once before the first render. */
export async function initStorage() {
  try {
    await open();
    const keys = await tx('readonly', (s) => s.getAllKeys()); const vals = await Promise.all(keys.map((k) => tx('readonly', (s) => s.get(k))));
    keys.forEach((k, i) => mem.set(k, vals[i]));
  } catch { idbOk = false; }
  for (const k of ls.keys()) { const f = /^nordla\.sourcing\.blob\.(.+)$/.exec(k); if (f && !mem.has(f[1])) mem.set(f[1], ls.get(k, null)); } // fallback copies
  for (const k of ls.keys()) { // migration from the localStorage layout
    const m = /^nordla\.sourcing\.(photo|docphoto)\.(.+)$/.exec(k); const isSafety = k === 'nordla.sourcing.safety';
    if (!m && !isSafety) continue; const key = isSafety ? 'safety' : `${m[1]}:${m[2]}`; const v = ls.get(k, null); if (v === null) continue;
    if (await putBlob(key, v)) ls.del(k);
  }
  return { indexedDb: idbOk };
}
export const getBlob = (key) => mem.get(key) ?? null;
export async function putBlob(key, value) {
  mem.set(key, value);
  if (idbOk) { try { await tx('readwrite', (s) => s.put(value, key)); return true; } catch { idbOk = false; } }
  return ls.set(`nordla.sourcing.blob.${key}`, value); // fallback: may fail when the quota is full
}
export async function delBlob(key) { mem.delete(key); if (idbOk) { try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ } } ls.del(`nordla.sourcing.blob.${key}`); }
export const storageInfo = () => ({ indexedDb: idbOk, blobs: mem.size, localKeys: ls.keys().length });
/** Estimated usage / quota when the browser can tell (navigator.storage.estimate). */
export async function storageEstimate() { try { const e = await navigator.storage.estimate(); return { usageMB: Math.round((e.usage ?? 0) / 1e5) / 10, quotaMB: Math.round((e.quota ?? 0) / 1e5) / 10 }; } catch { return null; } }
