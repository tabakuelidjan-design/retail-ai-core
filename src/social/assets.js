// Assets as the owner sees them and as the platforms fetch them.
//
//   createAssetLibrary(dir)        local folder of final assets delivered by chantier D: index.json + files. Reads are fingerprint-checked,
//                                  so a file swapped after approval is refused instead of shown / sent as if it were the approved one.
//   createPublicMediaResolver(..)  turns an approved asset into the PUBLIC https URL a platform will fetch, from a content-addressed
//                                  location (<base>/<sha256>.<ext>). It DOWNLOADS what is served and re-hashes it: the publisher only
//                                  proceeds if the bytes served are the bytes approved. Hosting that location is an open decision.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4', 'video/quicktime': '.mov' };
const TYPE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

export function createAssetLibrary(dir) {
  const indexFile = join(dir, 'index.json');
  const load = async () => { try { return JSON.parse(await readFile(indexFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { assets: [] }; throw e; } };
  return {
    dir,
    async list() { return (await load()).assets; },
    /** Register a delivered file under (ref, version). Immutable: the same (ref, version) with other bytes is refused. */
    async register({ ref, version, file, bytes }) {
      const content = bytes ?? await readFile(file);
      const digest = sha256(content);
      const contentType = TYPE[extname(file ?? '').toLowerCase()] ?? 'application/octet-stream';
      const index = await load();
      const found = index.assets.find((a) => a.ref === ref && a.version === version);
      if (found) {
        if (found.sha256 !== digest) throw new Error(`asset ${ref} v${version} already exists with different bytes: deliver a new version`);
        return found;
      }
      await mkdir(join(dir, 'files'), { recursive: true });
      const name = `${digest}${EXT[contentType] ?? ''}`;
      await writeFile(join(dir, 'files', name), content);
      const entry = { ref, version, sha256: digest, content_type: contentType, file: name, bytes: content.length };
      index.assets.push(entry);
      await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
      return entry;
    },
    /** The exact approved bytes, or throws when the file no longer matches the fingerprint the owner approved. */
    async read({ ref, version, sha256: expected }) {
      const entry = (await load()).assets.find((a) => a.ref === ref && a.version === version);
      if (!entry) return null;
      if (expected && entry.sha256 !== expected) throw new Error('ASSET_FINGERPRINT_MISMATCH');
      const bytes = await readFile(join(dir, 'files', entry.file));
      if (sha256(bytes) !== entry.sha256) throw new Error('ASSET_FILE_CORRUPTED');
      return { bytes, content_type: entry.content_type };
    },
  };
}

export function createPublicMediaResolver({ baseUrl, fetch: fetchFn = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!/^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(baseUrl ?? '')) throw new TypeError('the public media base must be a plain https URL (no query, no credentials)');
  const base = baseUrl.replace(/\/$/, '');
  return {
    async resolve(asset) {
      const url = `${base}/${asset.sha256}${EXT[asset.content_type] ?? ''}`;
      const res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw Object.assign(new Error('MEDIA_NOT_REACHABLE'), { code: 'MEDIA_NOT_REACHABLE' });
      const bytes = Buffer.from(await res.arrayBuffer());
      return { url, content_type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() || asset.content_type, sha256: sha256(bytes) };
    },
  };
}
