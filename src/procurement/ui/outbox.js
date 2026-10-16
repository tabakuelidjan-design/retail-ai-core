// The phone's send queue. Anything the person captures (a product with its photos and price, a draft purchase) is first SAVED ON THE PHONE (photos in IndexedDB,
// the request in localStorage) and then sent. If the connection is bad nothing is lost and nothing is sent twice: every request carries one Idempotency-Key created
// when it was queued and reused for every retry, so the server answers a repeat with the original result.
//
// What this is NOT: an offline mode. Starting a visit, reading data and every engaging step (approve, order) need the server. This queue only protects what was
// captured on the spot. Engaging steps are never queued.
import { request } from './api.js';
import { classifyHttp, backoffMs } from './logic.js';

const QKEY = 'nordla.proc.outbox';
const DB = 'nordla-proc'; const STORE = 'photos';
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const safeAsync = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

let listeners = [];
export const onOutboxChange = (fn) => { listeners.push(fn); };
const emit = () => listeners.forEach((fn) => safe(fn));

const read = () => safe(() => JSON.parse(localStorage.getItem(QKEY) ?? '[]'), []);
const write = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { throw new Error('Le téléphone n’a plus de place pour garder cette saisie : libérez de l’espace.'); } emit(); };

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
const tx = async (mode, fn) => { const db = await idb(); return new Promise((resolve, reject) => { const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => resolve(out?.result); t.onerror = () => reject(t.error); }); };
export const putPhoto = (id, blob) => tx('readwrite', (s) => s.put({ id, blob }));
export const getPhoto = (id) => tx('readonly', (s) => s.get(id)).then((r) => r?.blob ?? null);
export const delPhoto = (id) => tx('readwrite', (s) => s.delete(id));

export const list = () => read();
export const pending = () => read().filter((x) => x.state === 'PENDING');
export const rejected = () => read().filter((x) => x.state === 'REJECTED');
export function enqueue({ label, method, path, body, photoIds = [], photosInto = null, meta = {} }) {
  const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  write([...read(), { id, key: `${id}${Math.random().toString(36).slice(2, 8)}`.slice(0, 60), label, method, path, body, photoIds, photosInto, uploaded: [], state: 'PENDING', attempts: 0, error: null, createdAt: new Date().toISOString(), nextAt: 0, meta }]);
  return id;
}
export async function remove(id) { const q = read(); const it = q.find((x) => x.id === id); write(q.filter((x) => x.id !== id)); for (const p of it?.photoIds ?? []) await safeAsync(() => delPhoto(p)); }
export function retryRejected(id) { write(read().map((x) => (x.id === id ? { ...x, state: 'PENDING', error: null, nextAt: 0 } : x))); }
const patch = (id, p) => write(read().map((x) => (x.id === id ? { ...x, ...p } : x)));

let flushing = null;
/** Send what is waiting, in order. Stops at the first connection problem (order matters: a visit before its products). Single-flight. */
export function flush({ force = false, onSent = () => {} } = {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const it of read().filter((x) => x.state === 'PENDING')) {
      if (!force && it.nextAt > Date.now()) break;
      // 1. photos: uploaded once each (the server stores them under their own hash, so a repeat is harmless)
      let uploaded = it.uploaded ?? [];
      for (const pid of it.photoIds.slice(uploaded.length)) {
        const blob = await safeAsync(() => getPhoto(pid));
        if (!blob) { uploaded = [...uploaded, null]; continue; }
        const r = await request('POST', '/api/uploads', { raw: blob, contentType: blob.type || 'image/jpeg' });
        if (classifyHttp(r.status) !== 'DONE') {
          const cls = classifyHttp(r.status);
          patch(it.id, cls === 'RETRY' ? { attempts: it.attempts + 1, nextAt: Date.now() + backoffMs(it.attempts + 1), error: 'Connexion indisponible' } : { state: 'REJECTED', error: r.json?.message ?? 'Photo refusée par le serveur' });
          if (cls === 'RETRY') return sent; else break;
        }
        uploaded = [...uploaded, { kind: 'PHOTO', ref: r.json.ref, sha256: r.json.sha256 }];
        patch(it.id, { uploaded });
      }
      if (read().find((x) => x.id === it.id)?.state === 'REJECTED') continue;
      // 2. the request itself
      const body = it.photosInto ? setPath(structuredClone(it.body), it.photosInto, [...(getPath(it.body, it.photosInto) ?? []), ...uploaded.filter(Boolean)]) : it.body;
      const r = await request(it.method, it.path, { body, key: it.key });
      const cls = classifyHttp(r.status);
      if (cls === 'DONE') { await remove(it.id); sent++; onSent(it, r.json); continue; }
      if (cls === 'RETRY') { patch(it.id, { attempts: it.attempts + 1, nextAt: Date.now() + backoffMs(it.attempts + 1), error: r.status === 0 ? 'Connexion indisponible' : `Serveur indisponible (${r.status})` }); return sent; }
      patch(it.id, { state: 'REJECTED', error: r.json?.message ?? r.json?.error ?? `Refusé (${r.status})` });
    }
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}
function getPath(o, path) { return path.split('.').reduce((a, k) => a?.[k], o); }
function setPath(o, path, v) { const ks = path.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k] ??= {}; a[ks.at(-1)] = v; return o; }
