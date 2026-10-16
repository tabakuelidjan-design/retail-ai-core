// Where the procurement server READS China Sourcing cases (and their photos) from. An interface, so the file layout of today can be replaced by the SQL table
// `sourcing_cases` of chantier A without touching the server:
//     { async list() -> { available, reason?, cases: [{ id, name, supplier, quotes, photos, updatedAt }] },
//       async get(caseId) -> case JSON | null,
//       async photo(caseId, ref) -> { mime, bytes, sha256 } | null }
// Read-only, always. The file implementation never writes and never follows a path that came from outside:
//  - case ids and photo references are matched against strict patterns before ANY file name is built;
//  - a photo is served only if its metadata says JPEG / PNG / WebP, its bytes really start like that format, and its SHA-256 equals the one recorded when it was stored
//    (a tampered or truncated file is refused, never served);
//  - the layout is the one chantier A's photo store writes (<photosDir>/<caseId>/<photo__caseId.n>.<ext> + .json metadata); this module imports nothing from it.
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const CASE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PHOTO_REF = /^(photo|docphoto)-([A-Za-z0-9_-]{1,80})$/; // what the Sourcing PWA writes in a case: photo-<n> / docphoto-<docId>
const MIME_OK = { 'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8, 'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' };

export const isCaseId = (id) => CASE_ID.test(String(id));
/** photo-3 -> { key: 'photo:<caseId>.3' } ; anything else -> null. The case id inside the key is always the case being asked for. */
export function photoKeyOf(caseId, ref) {
  const m = PHOTO_REF.exec(String(ref ?? ''));
  return isCaseId(caseId) && m ? `${m[1]}:${caseId}.${m[2]}` : null;
}

export function createFileCaseSource({ casesDir, photosDir = null }) {
  const inside = (root, p) => { const r = resolve(root) + sep; return resolve(p).startsWith(r); };
  return {
    async list() {
      if (!casesDir) return { available: false, reason: 'no Sourcing directory configured', cases: [] };
      let names; try { names = await readdir(casesDir); } catch { return { available: false, reason: 'the Sourcing directory is not readable', cases: [] }; }
      const cases = [];
      for (const f of names.filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
        try { const s = JSON.parse(await readFile(join(casesDir, f), 'utf8')); cases.push({ id: s.id, name: s.identity?.workingName ?? '', supplier: s.supplier?.name ?? null, quotes: (s.quotes ?? []).length, photos: (s.identity?.photos ?? []).length, updatedAt: s.updatedAt ?? null }); } catch { /* a corrupt case file is skipped, never fatal */ }
      }
      return { available: true, cases: cases.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
    },
    async get(caseId) {
      if (!casesDir || !isCaseId(caseId)) return null;
      try { return JSON.parse(await readFile(join(casesDir, `${caseId}.json`), 'utf8')); } catch { return null; }
    },
    async photo(caseId, ref) {
      const key = photoKeyOf(caseId, ref);
      if (!photosDir || !key) return null;
      const base = key.replace(':', '__'); const dir = join(photosDir, caseId);
      let meta; try { meta = JSON.parse(await readFile(join(dir, `${base}.json`), 'utf8')); } catch { return null; }
      if (!meta || meta.key !== key || !MIME_OK[meta.mime] || !/^[A-Za-z0-9_.-]+$/.test(String(meta.file)) || !/^[0-9a-f]{64}$/.test(String(meta.sha256))) return null;
      const file = join(dir, meta.file);
      if (!inside(photosDir, file)) return null;
      let bytes; try { bytes = await readFile(file); } catch { return null; }
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || !MIME_OK[meta.mime](bytes)) return null;
      if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) return null; // modified after it was stored: refuse
      return { mime: meta.mime, bytes, sha256: meta.sha256 };
    },
  };
}
