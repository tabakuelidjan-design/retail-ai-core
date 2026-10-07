import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertPublicHttpsUrl } from './external-policy.js';

function extension(contentType, kind) {
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('mp4')) return '.mp4';
  return kind === 'video' ? '.mp4' : '.bin';
}

function ensureOutsideRepo(directory) {
  if (!path.isAbsolute(directory)) throw new Error('artifact directory must be absolute');
  const cwd = path.resolve(process.cwd());
  const resolved = path.resolve(directory);
  if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
    throw new Error('artifact directory must be outside repository');
  }
  return resolved;
}

export class FileArtifactStore {
  constructor(directory) {
    this.directory = ensureOutsideRepo(directory);
  }

  async storeBytes({ bytes, kind = 'image', operationId, contentType = null }) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await mkdir(this.directory, { recursive: true });
    const target = path.join(
      this.directory,
      `${operationId}-${sha256.slice(0, 16)}${extension(contentType, kind)}`,
    );
    await writeFile(target, buffer, { mode: 0o600 });
    return Object.freeze({
      ref: `file://${target}`,
      sha256,
      bytes: buffer.length,
      content_type: contentType,
      kind,
    });
  }

  async storeBase64({ base64, kind = 'image', operationId, contentType = 'image/png' }) {
    if (typeof base64 !== 'string' || !base64) throw new TypeError('base64 is required');
    return this.storeBytes({
      bytes: Buffer.from(base64, 'base64'),
      kind,
      operationId,
      contentType,
    });
  }

  async storeUrl({ url, kind = 'image', operationId, fetchImpl = globalThis.fetch }) {
    const safeUrl = assertPublicHttpsUrl(url, 'provider output URL');
    const response = await fetchImpl(safeUrl, { method: 'GET', redirect: 'error' });
    if (!response.ok) throw new Error(`provider output download failed: HTTP_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 150 * 1024 * 1024) throw new Error('provider output exceeds size limit');
    return this.storeBytes({
      bytes,
      kind,
      operationId,
      contentType: response.headers?.get?.('content-type') ?? null,
    });
  }
}
