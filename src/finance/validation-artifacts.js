// Integrity of the OFFICIAL validation artifacts (UBL 2.1 XSD, EN 16931 and Peppol Schematron, the ISO Schematron implementation and the compiled validators).
// vendor/MANIFEST.json is the single immutable record (source, version, retrieval date, SHA-256, size); its own SHA-256 is pinned below, so neither a file nor the manifest can change silently.
// FAIL CLOSED: a missing, modified, unlisted-version or wrong-manifest artifact makes validation refuse to start, with an explicit error code. The bytes that are verified are the very
// bytes that are used (read once, hashed, kept): there is no window between "checked" and "used".
//
// Adopting a new official release is a deliberate act: scripts/pin-validation-artifacts.mjs rewrites the manifest and this constant is updated in the same commit.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PINNED_MANIFEST_SHA256 = '7eef9d66aea8f94c0fbe9ecad7b94396b1432319a27e8b52df78f3c00910076b';
export const DEFAULT_VENDOR_DIR = fileURLToPath(new URL('../../vendor/', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

export class ValidationArtifactsError extends Error {
  constructor(code, problems = []) { super(`${code}${problems.length ? `: ${problems.map((p) => `${p.code} ${p.path ?? ''}`.trim()).join('; ')}` : ''}`); this.code = code; this.problems = problems; }
}

const cache = new Map(); // `${dir}|${version}` -> { manifest, files: Map(path -> Buffer) }
export const resetArtifactVerification = () => cache.clear();

/**
 * Verify the manifest and every artifact of a release against their pinned hashes, and keep the verified bytes.
 * @returns {{manifest: object, files: Map<string, Buffer>}}  @throws ValidationArtifactsError (code MANIFEST_MISSING | MANIFEST_MODIFIED | RELEASE_NOT_PINNED | ARTIFACTS_UNVERIFIED)
 */
export function verifiedArtifacts({ vendorDir = DEFAULT_VENDOR_DIR, version, expectedManifestSha256 = PINNED_MANIFEST_SHA256 }) {
  const key = `${vendorDir}|${version}|${expectedManifestSha256}`; if (cache.has(key)) return cache.get(key);
  const manifestPath = `${vendorDir}MANIFEST.json`; if (!existsSync(manifestPath)) throw new ValidationArtifactsError('MANIFEST_MISSING', [{ code: 'MANIFEST_MISSING', path: 'vendor/MANIFEST.json' }]);
  const raw = readFileSync(manifestPath); if (sha(raw) !== expectedManifestSha256) throw new ValidationArtifactsError('MANIFEST_MODIFIED', [{ code: 'MANIFEST_MODIFIED', path: 'vendor/MANIFEST.json' }]);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.bisVersion !== version) throw new ValidationArtifactsError('RELEASE_NOT_PINNED', [{ code: 'RELEASE_NOT_PINNED', path: `requested ${version}, pinned ${manifest.bisVersion}` }]);
  const files = new Map(); const problems = [];
  for (const a of manifest.artifacts) {
    const p = `${vendorDir}${a.path}`;
    if (!existsSync(p)) { problems.push({ code: 'ARTIFACT_MISSING', path: a.path }); continue; }
    const b = readFileSync(p); if (b.length !== a.bytes || sha(b) !== a.sha256) { problems.push({ code: 'ARTIFACT_MODIFIED', path: a.path }); continue; }
    files.set(a.path, b);
  }
  if (problems.length) throw new ValidationArtifactsError('ARTIFACTS_UNVERIFIED', problems);
  const out = { manifest, files }; cache.set(key, out); return out;
}
/** Same check without throwing: { ok, code, problems }. */
export function checkArtifacts(o) { try { verifiedArtifacts(o); return { ok: true, code: null, problems: [] }; } catch (e) { if (e instanceof ValidationArtifactsError) return { ok: false, code: e.code, problems: e.problems }; throw e; } }
/** The provenance of a release as recorded in the manifest: what the structured original's evidence quotes. */
export function provenanceOf(manifest) {
  const by = (role, ext) => Object.fromEntries(manifest.artifacts.filter((a) => a.role === role && a.path.endsWith(ext)).map((a) => [a.path.split('/').pop(), a.sha256]));
  return { manifestVersion: manifest.manifestVersion, bisVersion: manifest.bisVersion, schematronSources: by('SOURCE', '.sch'), compiled: by('DERIVED', '.sef.json'), xsd: by('SOURCE', '.xsd'), engines: manifest.engines };
}
