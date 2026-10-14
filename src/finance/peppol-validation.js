// Validation pipeline for structured invoices. The rules are the OFFICIAL ones, executed from their official artifacts, never re-implemented here:
//   layer 1  UBL_SYNTAX   secure XML checks (size, well-formed, no DOCTYPE/entities, depth) + the document is an Invoice / CreditNote of the expected type
//   layer 2  UBL_XSD      the official OASIS UBL 2.1 schema (UBL-Invoice-2.1.xsd / UBL-CreditNote-2.1.xsd), executed by libxml2 (xmllint-wasm)
//   layer 3  EN16931      the official CEN-EN16931-UBL.sch (European norm EN 16931, UBL binding), compiled to a Saxon-JS stylesheet
//   layer 4  PEPPOL       the official PEPPOL-EN16931-UBL.sch (Peppol BIS Billing 3.0 rules), idem
//   layer 5  NORDLA       business invariants Nordla adds on top (the issue snapshot), not Peppol rules
// FAIL CLOSED: before any official layer runs, every artifact (XSD, Schematron, compiled validators) is verified against the pinned SHA-256 manifest (validation-artifacts.js); a missing, modified
// or wrong-version artifact makes the result invalid with an explicit finding and NO official layer runs. An XSD failure skips the Schematron layers (they would judge a document that is not
// even valid UBL) and the document is never archived as valid, never queued, never sent.
// Every finding is a structured record (layer, ruleset + version + artifact hash, rule id, severity, message, location, timestamp, document hash). The pipeline never "fixes" a document.
// The supported release is centralised in PEPPOL_RULESETS: a historical document keeps the ruleset that validated it (see rulesetFor).

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { XmlError, parseXml } from './purchase-document.js';
import { DEFAULT_VENDOR_DIR, ValidationArtifactsError, provenanceOf, verifiedArtifacts } from './validation-artifacts.js';

const require = createRequire(import.meta.url);
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** ONE place where the supported Peppol release is declared (verified on docs.peppol.eu on 2026-10-03: "Peppol BIS Billing 3.0 - May 2026 Release", version 3.0.21; the .sch states "Last update: 2026 May release 3.0.21"). */
export const PEPPOL_RULESETS = {
  '3.0.21': { bis: 'Peppol BIS Billing 3.0', release: '2026 May release', version: '3.0.21', customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0', profileId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0', attachmentMediaTypes: ['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet'], verifiedOn: '2026-10-03', source: 'https://docs.peppol.eu/poacc/billing/3.0/' },
};
export const CURRENT_PEPPOL_VERSION = '3.0.21';
export const rulesetFor = (version) => { const r = PEPPOL_RULESETS[version]; if (!r) throw new Error(`UNKNOWN_PEPPOL_RULESET: ${version}`); return r; };

export const SEVERITIES = ['fatal', 'warning'];
export const MAX_XML_BYTES = 5 * 1024 * 1024;
const LAYERS = { EN16931: 'CEN-EN16931-UBL', PEPPOL: 'PEPPOL-EN16931-UBL' };
const cache = new Map();

/** The verified, pinned official artifacts of a release (throws ValidationArtifactsError when anything is missing or modified). Provenance and hashes come from the manifest. */
export function artifactsFor(version = CURRENT_PEPPOL_VERSION, { vendorDir = DEFAULT_VENDOR_DIR } = {}) {
  if (!PEPPOL_RULESETS[version]) return { version, available: false, meta: null, files: null, error: new ValidationArtifactsError('RELEASE_NOT_PINNED', [{ code: 'RELEASE_NOT_PINNED', path: String(version) }]) };
  try { const v = verifiedArtifacts({ vendorDir, version: rulesetFor(version).version }); return { version, available: true, meta: provenanceOf(v.manifest), files: v.files, error: null }; }
  catch (e) { if (!(e instanceof ValidationArtifactsError)) throw e; return { version, available: false, meta: null, files: null, error: e }; }
}
const parsed = new Map(); // verified SEF bytes parsed once per process
function sefOf(art, name) { const k = `${art.version}:${name}`; if (!parsed.has(k)) parsed.set(k, JSON.parse(art.files.get(`peppol-bis-${art.version}/${name}.sef.json`).toString('utf8'))); return parsed.get(k); }
// libxml2 compiled to WebAssembly (MIT): no native build, no system binary. Loaded lazily.
let xmllint = null; const xsdSchemas = new Map();
const loadXmllint = async () => (xmllint ??= await import('xmllint-wasm'));
function xsdSchemaFor(art, root) {
  const k = `${art.version}:${root}`; if (xsdSchemas.has(k)) return xsdSchemas.get(k);
  const name = `UBL-${root}-2.1.xsd`; const main = art.files.get(`ubl-2.1/xsd/maindoc/${name}`); if (!main) throw new ValidationArtifactsError('ARTIFACTS_UNVERIFIED', [{ code: 'ARTIFACT_MISSING', path: `ubl-2.1/xsd/maindoc/${name}` }]);
  const preload = [...art.files].filter(([p]) => p.startsWith('ubl-2.1/xsd/common/')).map(([p, b]) => ({ fileName: `../common/${p.split('/').pop()}`, contents: b.toString('utf8') }));
  const v = { schema: [{ fileName: name, contents: main.toString('utf8') }], preload, file: name }; xsdSchemas.set(k, v); return v;
}
/** Structured findings of the official UBL XSD for a document of root Invoice / CreditNote. */
export async function xsdFindings(art, root, xmlText) {
  const { validateXML } = await loadXmllint(); const v = xsdSchemaFor(art, root);
  const r = await validateXML({ xml: [{ fileName: 'document.xml', contents: xmlText }], schema: v.schema, preload: v.preload, maxMemoryPages: 4096 });
  if (r.valid) return [];
  return r.errors.slice(0, 50).map((e) => ({ ruleId: 'UBL-XSD', flag: 'fatal', location: e.loc?.lineNumber ? `line ${e.loc.lineNumber}` : null, message: String(e.message ?? e.rawMessage).replace(/^document\.xml:\d+: /, '').replace(/\s+/g, ' ').slice(0, 400) }));
}

// Saxon-JS is loaded lazily: nothing else in Finance pays for it.
let Saxon = null;
const saxon = () => (Saxon ??= require('saxon-js'));
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** Failed assertions of an SVRL report as structured findings. */
export function parseSvrl(svrl) {
  const out = []; const re = /<svrl:(failed-assert|successful-report)\b([^>]*)>([\s\S]*?)<\/svrl:\1>/g; let m;
  while ((m = re.exec(svrl))) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])])); const text = /<svrl:text>([\s\S]*?)<\/svrl:text>/.exec(m[3])?.[1] ?? '';
    out.push({ ruleId: attrs.id ?? null, flag: attrs.flag ?? 'fatal', location: attrs.location ?? null, message: decode(text).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

const finding = (layer, ruleset, f, ctx) => ({ layer, ruleset, ruleId: f.ruleId, severity: f.flag === 'warning' ? 'warning' : 'fatal', message: f.message, location: f.location ?? null, at: ctx.at, documentSha256: ctx.documentSha256 });

/**
 * @param {string|Buffer} xml  @param {{version?: string, at: string, expectedType?: 'Invoice'|'CreditNote', invariants?: Array<{id: string, message: string, ok: boolean}>}} o
 * @returns {{ok: boolean, documentSha256: string, ruleset: object, layers: object[], findings: object[], at: string}} ok = no fatal finding AND every required layer actually ran
 */
export async function validateStructured(xml, { version = CURRENT_PEPPOL_VERSION, at, expectedType = null, invariants = [], vendorDir = DEFAULT_VENDOR_DIR } = {}) {
  if (!at) throw new TypeError('validateStructured: an explicit timestamp is required');
  const buf = Buffer.isBuffer(xml) ? xml : Buffer.from(String(xml), 'utf8'); const documentSha256 = sha(buf); const rs = rulesetFor(version); const art = artifactsFor(version, { vendorDir });
  const ctx = { at, documentSha256 }; const findings = []; const layers = [];
  const pin = (file) => art.meta?.[file.endsWith('.xsd') ? 'xsd' : file.endsWith('.sch') ? 'schematronSources' : 'compiled']?.[file] ?? null;
  const rulesetOf = (name, kind) => ({ name, bisVersion: rs.version, release: rs.release, artifactSha256: kind === 'sch' ? pin(`${name}.sef.json`) : pin(name), sourceSha256: kind === 'sch' ? pin(`${name}.sch`) : pin(name) });
  const NO_RULESET = { UBL_SYNTAX: { name: 'nordla-secure-xml-checks', bisVersion: rs.version }, NORDLA: { name: 'nordla-business-invariants', bisVersion: rs.version } };
  const run = async (layer, ruleset, fn) => {
    let status = 'RAN'; let fs = [];
    try { fs = await fn(); } catch (e) { status = 'ERROR'; fs = [{ ruleId: 'VALIDATOR-ERROR', flag: 'fatal', message: String(e.message).slice(0, 300) }]; }
    findings.push(...fs.map((f) => finding(layer, ruleset, f, ctx))); layers.push({ layer, ruleset, status, fatal: fs.filter((f) => f.flag !== 'warning').length, warnings: fs.filter((f) => f.flag === 'warning').length });
    return status === 'RAN' && !fs.some((f) => f.flag !== 'warning');
  };
  const skipped = (layer, ruleset, status) => layers.push({ layer, ruleset, status, fatal: 0, warnings: 0 });
  let root = null;
  const syntaxOk = await run('UBL_SYNTAX', NO_RULESET.UBL_SYNTAX, () => {
    const f = [];
    if (buf.length > MAX_XML_BYTES) return [{ ruleId: 'NORDLA-SYNTAX-SIZE', flag: 'fatal', message: `document larger than ${MAX_XML_BYTES} bytes` }];
    let tree; try { tree = parseXml(buf.toString('utf8')); } catch (e) { return [{ ruleId: e instanceof XmlError ? `NORDLA-SYNTAX-${e.code}` : 'NORDLA-SYNTAX-UNREADABLE', flag: 'fatal', message: e instanceof XmlError ? `unsafe or malformed XML (${e.code})` : 'XML cannot be read' }]; }
    if (!['Invoice', 'CreditNote'].includes(tree.name)) f.push({ ruleId: 'NORDLA-SYNTAX-ROOT', flag: 'fatal', message: `unexpected root element ${tree.name}` });
    else if (expectedType && tree.name !== expectedType) f.push({ ruleId: 'NORDLA-SYNTAX-TYPE', flag: 'fatal', message: `expected ${expectedType}, got ${tree.name}` });
    else root = tree.name;
    return f;
  });
  const OFFICIAL = [['UBL_XSD', 'UBL-2.1', 'xsd'], ['EN16931', LAYERS.EN16931, 'sch'], ['PEPPOL', LAYERS.PEPPOL, 'sch']];
  if (!syntaxOk) for (const [layer, name, kind] of OFFICIAL) skipped(layer, layer === 'UBL_XSD' ? { name: `UBL-${expectedType ?? 'Invoice'}-2.1.xsd`, bisVersion: rs.version } : rulesetOf(name, kind), 'SKIPPED_SYNTAX_FAILED');
  else if (!art.available) {
    // fail closed: no official layer starts on artifacts that are not exactly the pinned ones
    findings.push(finding('ARTIFACTS', { name: 'vendor/MANIFEST.json', bisVersion: rs.version }, { ruleId: 'VALIDATION-ARTIFACTS-UNVERIFIED', flag: 'fatal', message: `${art.error.code}: ${art.error.problems.map((p) => `${p.code} ${p.path ?? ''}`.trim()).join('; ')}`.slice(0, 400) }, ctx));
    layers.push({ layer: 'ARTIFACTS', ruleset: { name: 'vendor/MANIFEST.json', bisVersion: rs.version }, status: 'FAILED', fatal: 1, warnings: 0 });
    for (const [layer, name, kind] of OFFICIAL) skipped(layer, layer === 'UBL_XSD' ? { name: `UBL-${root}-2.1.xsd`, bisVersion: rs.version } : rulesetOf(name, kind), 'NOT_RUN_ARTIFACTS_UNVERIFIED');
  } else {
    const xsdOk = await run('UBL_XSD', { name: `UBL-${root}-2.1.xsd`, bisVersion: rs.version, release: 'OASIS UBL 2.1', artifactSha256: pin(`UBL-${root}-2.1.xsd`), sourceSha256: pin(`UBL-${root}-2.1.xsd`) }, () => xsdFindings(art, root, buf.toString('utf8')));
    if (!xsdOk) for (const [layer, name, kind] of OFFICIAL.slice(1)) skipped(layer, rulesetOf(name, kind), 'SKIPPED_XSD_FAILED');
    else for (const [layer, name, kind] of OFFICIAL.slice(1)) await run(layer, rulesetOf(name, kind), () => parseSvrl(saxon().transform({ stylesheetInternal: sefOf(art, name), sourceText: buf.toString('utf8'), destination: 'serialized' }, 'sync').principalResult));
  }
  await run('NORDLA', NO_RULESET.NORDLA, () => invariants.filter((i) => !i.ok).map((i) => ({ ruleId: i.id, flag: 'fatal', message: i.message })));
  const required = ['UBL_SYNTAX', 'UBL_XSD', 'EN16931', 'PEPPOL'];
  const ok = required.every((l) => layers.find((x) => x.layer === l)?.status === 'RAN') && !findings.some((f) => f.severity === 'fatal');
  return { ok, documentSha256, ruleset: { bis: rs.bis, version: rs.version, release: rs.release, customizationId: rs.customizationId, profileId: rs.profileId }, layers, findings, at };
}
