// Durable photo storage of China Sourcing on the server. Until now a photo (product or document) lived ONLY on the phone (IndexedDB): the
// case sync carried the JSON, never the image. This store keeps each photo of a case as its own file, next to the cases of THIS server
// (one data directory per deployment = per merchant: the hosted server refuses to start without a named merchant).
//
// Rules:
//   - a photo belongs to exactly one case: its key is `photo:<caseId>.<n>` or `docphoto:<caseId>.<docId>`, the same keys the phone uses;
//   - only images (JPEG / PNG / WebP data URLs), at most MAX_PHOTO_BYTES decoded;
//   - written atomically (temp file + rename); the SHA-256 of the bytes is kept so the phone can tell what the server already has;
//   - writing the same bytes again is a no-op; different bytes under an existing key are NOT written over: the server keeps the first
//     version and answers CONFLICT with both hashes (nothing is ever lost or silently replaced);
//   - there is no delete: neither the phone nor the server removes a photo through this store.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StoreError } from './file-store.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // decoded; its base64 JSON body stays under the server's 16 MB body limit
const CASE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY = /^(photo|docphoto):([A-Za-z0-9_-]{1,80})\.([A-Za-z0-9_-]{1,80})$/;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The parts of a photo key, or null. The case id inside the key must be the case it is stored under. */
export function parsePhotoKey(key, caseId) {
  const m = KEY.exec(String(key ?? ''));
  if (!m || (caseId !== undefined && m[2] !== caseId)) return null;
  return { kind: m[1], caseId: m[2], suffix: m[3] };
}

/** Decodes and checks a photo data URL: { mime, bytes } or throws StoreError. */
export function decodePhoto(dataUrl) {
  const m = DATA_URL.exec(String(dataUrl ?? ''));
  if (!m) throw new StoreError('PHOTO_INVALID', 'a photo must be a JPEG, PNG or WebP data URL');
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) throw new StoreError('PHOTO_INVALID', 'empty photo');
  if (bytes.length > MAX_PHOTO_BYTES) throw new StoreError('PHOTO_TOO_BIG', `a photo is limited to ${MAX_PHOTO_BYTES} bytes`);
  return { mime: m[1], bytes };
}

export function createFilePhotoStore(dir) {
  const caseDir = (caseId) => { if (!CASE_ID.test(String(caseId))) throw new StoreError('CASE_ID_INVALID', 'case id must be letters, digits, - or _'); return join(dir, caseId); };
  const fileBase = (key) => key.replace(':', '__'); // a colon is not a portable file-name character (Windows)
  const readMeta = async (caseId, key) => { try { return JSON.parse(await readFile(join(caseDir(caseId), `${fileBase(key)}.json`), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

  return {
    /** Stores one photo. Returns { status: 'STORED' | 'UNCHANGED', key, sha256, size }; throws StoreError (PHOTO_KEY_INVALID, PHOTO_INVALID, PHOTO_TOO_BIG, PHOTO_CONFLICT). */
    async put(caseId, key, dataUrl) {
      if (!parsePhotoKey(key, caseId)) throw new StoreError('PHOTO_KEY_INVALID', 'the photo key does not belong to this case');
      const { mime, bytes } = decodePhoto(dataUrl);
      const hash = sha256(bytes);
      const prev = await readMeta(caseId, key);
      if (prev) {
        if (prev.sha256 === hash) return { status: 'UNCHANGED', key, sha256: hash, size: bytes.length };
        throw new StoreError('PHOTO_CONFLICT', 'a different photo is already stored under this key; it is kept', { server: { sha256: prev.sha256, size: prev.size }, sent: { sha256: hash, size: bytes.length } });
      }
      const d = caseDir(caseId); await mkdir(d, { recursive: true });
      const base = join(d, fileBase(key)); const tmp = `.${process.pid}.${Date.now()}.tmp`;
      await writeFile(`${base}.${EXT[mime]}${tmp}`, bytes); await rename(`${base}.${EXT[mime]}${tmp}`, `${base}.${EXT[mime]}`);
      const meta = { key, mime, sha256: hash, size: bytes.length, file: `${fileBase(key)}.${EXT[mime]}`, storedAt: new Date().toISOString() };
      await writeFile(`${base}.json${tmp}`, JSON.stringify(meta)); await rename(`${base}.json${tmp}`, `${base}.json`); // the meta is written LAST: a photo is listed only once its bytes are on disk
      return { status: 'STORED', key, sha256: hash, size: bytes.length };
    },
    /** What the server holds for a case: [{ key, sha256, size, mime }]. */
    async list(caseId) {
      let names; try { names = await readdir(caseDir(caseId)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const out = [];
      for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
        try { const m = JSON.parse(await readFile(join(caseDir(caseId), n), 'utf8')); if (parsePhotoKey(m.key, caseId)) out.push({ key: m.key, sha256: m.sha256, size: m.size, mime: m.mime }); } catch { /* an unreadable meta is skipped, never deleted */ }
      }
      return out;
    },
    /** One photo as a data URL, checked against its stored hash; null when absent. */
    async get(caseId, key) {
      if (!parsePhotoKey(key, caseId)) throw new StoreError('PHOTO_KEY_INVALID', 'the photo key does not belong to this case');
      const meta = await readMeta(caseId, key); if (!meta) return null;
      const bytes = await readFile(join(caseDir(caseId), meta.file));
      if (sha256(bytes) !== meta.sha256) throw new StoreError('PHOTO_CORRUPT', 'the stored photo does not match its hash');
      return { key, sha256: meta.sha256, size: meta.size, dataUrl: `data:${meta.mime};base64,${bytes.toString('base64')}` };
    },
  };
}

/** In-memory store with the same contract (tests, and a server started without a data directory). */
export function createMemoryPhotoStore() {
  const m = new Map();
  return {
    async put(caseId, key, dataUrl) {
      if (!parsePhotoKey(key, caseId)) throw new StoreError('PHOTO_KEY_INVALID', 'the photo key does not belong to this case');
      const { mime, bytes } = decodePhoto(dataUrl); const hash = sha256(bytes); const id = `${caseId}/${key}`; const prev = m.get(id);
      if (prev) { if (prev.sha256 === hash) return { status: 'UNCHANGED', key, sha256: hash, size: bytes.length }; throw new StoreError('PHOTO_CONFLICT', 'a different photo is already stored under this key; it is kept', { server: { sha256: prev.sha256, size: prev.size }, sent: { sha256: hash, size: bytes.length } }); }
      m.set(id, { key, mime, sha256: hash, size: bytes.length, bytes }); return { status: 'STORED', key, sha256: hash, size: bytes.length };
    },
    async list(caseId) { return [...m.values()].filter((p) => parsePhotoKey(p.key, caseId)).map(({ key, sha256: h, size, mime }) => ({ key, sha256: h, size, mime })).sort((a, b) => (a.key < b.key ? -1 : 1)); },
    async get(caseId, key) { if (!parsePhotoKey(key, caseId)) throw new StoreError('PHOTO_KEY_INVALID', 'the photo key does not belong to this case'); const p = m.get(`${caseId}/${key}`); return p ? { key, sha256: p.sha256, size: p.size, dataUrl: `data:${p.mime};base64,${p.bytes.toString('base64')}` } : null; },
  };
}
