import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertHttpsPublicUrl } from './policy.js';

function extensionFor(contentType, kind) {
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('mp4')) return '.mp4';
  return kind === 'video' ? '.mp4' : '.bin';
}

async function download(url, {
  fetchImpl = globalThis.fetch,
  maxBytes = 100 * 1024 * 1024,
} = {}) {
  const safeUrl = assertHttpsPublicUrl(url, 'provider output URL');
  const response = await fetchImpl(safeUrl, { method: 'GET', redirect: 'error' });

  if (!response.ok) {
    throw new Error(`provider output download failed: HTTP_${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error('provider output exceeds size limit');
  }

  const bytes = Buffer.from(arrayBuffer);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: response.headers?.get?.('content-type') ?? null,
  };
}

export class MemoryOutputStore {
  async storeUrl({ url, kind = 'image', operationId, fetchImpl }) {
    const downloaded = await download(url, { fetchImpl });
    return Object.freeze({
      ref: `memory://${operationId}/${downloaded.sha256}`,
      sha256: downloaded.sha256,
      bytes: downloaded.bytes.length,
      content_type: downloaded.contentType,
      kind,
    });
  }
}

export class FileOutputStore {
  constructor(directory) {
    if (!path.isAbsolute(directory)) {
      throw new Error('output directory must be absolute');
    }

    const cwd = path.resolve(process.cwd());
    const resolved = path.resolve(directory);
    if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
      throw new Error('output directory must be outside repository');
    }
    this.directory = resolved;
  }

  async storeUrl({ url, kind = 'image', operationId, fetchImpl }) {
    const downloaded = await download(url, { fetchImpl });

    await mkdir(this.directory, { recursive: true });
    const filename = (
      `${operationId}-${downloaded.sha256.slice(0, 16)}`
      + extensionFor(downloaded.contentType, kind)
    );
    const target = path.join(this.directory, filename);
    await writeFile(target, downloaded.bytes, { mode: 0o600 });

    return Object.freeze({
      ref: `file://${target}`,
      sha256: downloaded.sha256,
      bytes: downloaded.bytes.length,
      content_type: downloaded.contentType,
      kind,
    });
  }
}
