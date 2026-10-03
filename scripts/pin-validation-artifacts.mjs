// Writes vendor/MANIFEST.json: the ONE immutable, centralized record of every official validation artifact (source, version, retrieval date, SHA-256, size).
// Run it deliberately, only when an official release is adopted; the validators refuse to start if any listed file differs from this manifest, and the manifest's own hash is pinned in
// src/finance/validation-artifacts.js (PINNED_MANIFEST_SHA256), so neither a file nor the manifest can change silently.
//   node scripts/pin-validation-artifacts.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); const vendor = join(root, 'vendor');
const sha = (b) => createHash('sha256').update(b).digest('hex'); const RETRIEVED = '2026-10-03';
const entry = (path, role, source) => { const b = readFileSync(join(vendor, path)); return { id: path, role, path, sha256: sha(b), bytes: b.length, source }; };
const list = (dir, ext) => readdirSync(join(vendor, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => `${dir}/${f}`);
const PEPPOL = { version: '3.0.21', release: 'Peppol BIS Billing 3.0, 2026 May release', url: 'https://docs.peppol.eu/poacc/billing/3.0/files/', retrievedOn: RETRIEVED };
const ISO = { version: 'ISO Schematron reference implementation (Schematron/schematron, branch master: unversioned upstream, pinned by hash)', url: 'https://raw.githubusercontent.com/Schematron/schematron/master/trunk/schematron/code/', retrievedOn: RETRIEVED };
const UBL = { version: 'OASIS UBL 2.1 (os-UBL-2.1)', url: 'https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip', archiveSha256: '60b80d76394a8a2add90723ecb8e0e2e9d826775de9749df37a72d60703f86ed', retrievedOn: RETRIEVED, note: 'xsd/common/* and xsd/maindoc/UBL-Invoice-2.1.xsd, UBL-CreditNote-2.1.xsd extracted unchanged' };
const DERIVED = { version: '3.0.21', builtWith: 'scripts/build-peppol-validators.mjs (ISO Schematron -> XSLT -> Saxon-JS SEF); deterministic: the build must reproduce these hashes', retrievedOn: RETRIEVED };
const artifacts = [
  ...list('peppol-bis-3.0.21/src', '.sch').map((p) => entry(p, 'SOURCE', PEPPOL)),
  ...list('iso-schematron', '.xsl').map((p) => entry(p, 'SOURCE', ISO)),
  ...list('ubl-2.1/xsd/common', '.xsd').map((p) => entry(p, 'SOURCE', UBL)), ...list('ubl-2.1/xsd/maindoc', '.xsd').map((p) => entry(p, 'SOURCE', UBL)),
  ...list('peppol-bis-3.0.21', '.sef.json').map((p) => entry(p, 'DERIVED', DERIVED)),
];
const manifest = { manifestVersion: 1, purpose: 'pinned official validation artifacts for Peppol BIS Billing 3.0.21 (UBL 2.1 XSD, EN 16931 and Peppol Schematron)', bisVersion: '3.0.21', engines: { xsd: 'xmllint-wasm (libxml2)', schematron: 'saxon-js' }, artifacts };
void statSync; void relative;
writeFileSync(join(vendor, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`pinned ${artifacts.length} artifacts; manifest sha256 = ${sha(readFileSync(join(vendor, 'MANIFEST.json')))}`);
