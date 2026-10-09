// Generic helpers for a benchmark's own resources: loads a FONT resource manifest (records + bytes beside it), verifies every hash, and builds the
// ONE common resource resolver a benchmark is assessed with. Nothing here knows a merchant: the manifests and the benchmark configuration are data.
//
// The font bytes are an ephemeral payload of the resolver (hash-checked by `loadPayload`); they never enter a document or a Brand Memory.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCommonResourceResolver, createStaticResourceAdapter } from '../src/resources/index.js';

const root = new URL('../', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readBytes = (path) => new Uint8Array(readFileSync(new URL(path, root)));

/** Loads a font manifest: verifies each font file and licence file against their pinned SHA-256 and returns the FONT records and payloads. */
export function loadFontManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(new URL(manifestPath, root), 'utf8'));
  const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
  const records = [];
  const payloads = {};
  for (const font of manifest.fonts) {
    const bytes = readBytes(dir + font.file);
    if (sha256(bytes) !== font.font_sha256) throw new Error(`${font.file}: font bytes differ from the pinned SHA-256`);
    if (font.record.metadata.content_hash !== font.font_sha256) throw new Error(`${font.file}: the FONT record declares another hash`);
    const licence = readBytes(dir + font.license.file);
    if (sha256(licence) !== font.license.sha256) throw new Error(`${font.license.file}: licence text differs from the pinned SHA-256`);
    records.push(font.record);
    payloads[font.record.ref] = bytes;
  }
  return { manifest, records, payloads };
}

/** The common resolver of a benchmark: its own records (config.owned_records) and the records + payloads of its resource manifests, one owner adapter. */
export function createBenchmarkResolver(config) {
  const records = [...(config.owned_records ?? [])];
  const payloads = {};
  for (const path of config.resource_manifests ?? []) {
    const loaded = loadFontManifest(path);
    records.push(...loaded.records);
    Object.assign(payloads, loaded.payloads);
  }
  return createCommonResourceResolver({ adapters: [createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records, payloads })] });
}
