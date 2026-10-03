// Validation pipeline for structured invoices. The business rules are the OFFICIAL ones, executed from their official artifacts, never re-implemented here:
//   layer 1  UBL_SYNTAX     secure, well-formed UBL document of the expected type (Nordla structural check: the official XSD is NOT executed, Saxon-JS is not schema-aware)
//   layer 2  EN16931        CEN-EN16931-UBL.sch   (European norm EN 16931, UBL binding)           compiled with Saxon-JS from the official Schematron
//   layer 3  PEPPOL         PEPPOL-EN16931-UBL.sch (Peppol BIS Billing 3.0 rules)                    idem
//   layer 4  NORDLA         business invariants Nordla adds on top (documents the issue snapshot, not Peppol rules)
// Every finding is a structured record (layer, ruleset + version + artifact hash, rule id, severity, message, location, timestamp, document hash). The pipeline never "fixes" a document.
// The supported release is centralised in PEPPOL_RULESET: a historical document keeps the ruleset that validated it (see rulesetFor).

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { XmlError, parseXml } from './purchase-document.js';

const require = createRequire(import.meta.url);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const vendor = (...p) => fileURLToPath(new URL(['..', '..', 'vendor', ...p].join('/'), import.meta.url));

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

/** Official validators compiled from the official Schematron (see scripts/build-peppol-validators.mjs). Loaded once per process. */
export function artifactsFor(version = CURRENT_PEPPOL_VERSION) {
  const key = `art:${version}`; if (cache.has(key)) return cache.get(key);
  const dir = vendor(`peppol-bis-${version}`); const meta = existsSync(`${dir}/ARTIFACTS.json`) ? JSON.parse(readFileSync(`${dir}/ARTIFACTS.json`, 'utf8')) : null;
  const a = { version, available: !!meta, meta, dir }; cache.set(key, a); return a;
}
function sefOf(version, name) { const k = `sef:${version}:${name}`; if (!cache.has(k)) cache.set(k, JSON.parse(readFileSync(`${artifactsFor(version).dir}/${name}.sef.json`, 'utf8'))); return cache.get(k); }

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
export function validateStructured(xml, { version = CURRENT_PEPPOL_VERSION, at, expectedType = null, invariants = [] } = {}) {
  if (!at) throw new TypeError('validateStructured: an explicit timestamp is required');
  const buf = Buffer.isBuffer(xml) ? xml : Buffer.from(String(xml), 'utf8'); const documentSha256 = sha(buf); const rs = rulesetFor(version); const art = artifactsFor(version);
  const ctx = { at, documentSha256 }; const findings = []; const layers = [];
  const rulesetOf = (name) => ({ name, bisVersion: rs.version, release: rs.release, artifactSha256: art.meta?.compiled?.[`${name}.sef.json`] ?? null, sourceSha256: art.meta?.schematronSources?.[`${name}.sch`] ?? null });
  const run = (layer, name, fn) => { const ruleset = layer === 'UBL_SYNTAX' || layer === 'NORDLA' ? { name: layer === 'NORDLA' ? 'nordla-business-invariants' : 'nordla-ubl-structure', bisVersion: rs.version } : rulesetOf(name); let status = 'RAN'; let fs = [];
    try { fs = fn(ruleset); } catch (e) { status = 'ERROR'; fs = [{ ruleId: 'VALIDATOR-ERROR', flag: 'fatal', message: String(e.message).slice(0, 300) }]; }
    findings.push(...fs.map((f) => finding(layer, ruleset, f, ctx))); layers.push({ layer, ruleset, status, fatal: fs.filter((f) => f.flag !== 'warning').length, warnings: fs.filter((f) => f.flag === 'warning').length }); return status === 'RAN' && !fs.some((f) => f.flag !== 'warning'); };

  const syntaxOk = run('UBL_SYNTAX', null, () => {
    const f = [];
    if (buf.length > MAX_XML_BYTES) return [{ ruleId: 'NORDLA-SYNTAX-SIZE', flag: 'fatal', message: `document larger than ${MAX_XML_BYTES} bytes` }];
    let root; try { root = parseXml(buf.toString('utf8')); } catch (e) { return [{ ruleId: e instanceof XmlError ? `NORDLA-SYNTAX-${e.code}` : 'NORDLA-SYNTAX-UNREADABLE', flag: 'fatal', message: e instanceof XmlError ? `unsafe or malformed XML (${e.code})` : 'XML cannot be read' }]; }
    if (!['Invoice', 'CreditNote'].includes(root.name)) f.push({ ruleId: 'NORDLA-SYNTAX-ROOT', flag: 'fatal', message: `unexpected root element ${root.name}` });
    else if (expectedType && root.name !== expectedType) f.push({ ruleId: 'NORDLA-SYNTAX-TYPE', flag: 'fatal', message: `expected ${expectedType}, got ${root.name}` });
    return f;
  });
  const schematron = (layer) => (ruleset) => {
    if (!art.available) return [{ ruleId: 'NORDLA-ARTIFACTS-MISSING', flag: 'fatal', message: `official validation artifacts for ${version} are not installed (run scripts/build-peppol-validators.mjs)` }];
    const svrl = saxon().transform({ stylesheetInternal: sefOf(version, LAYERS[layer]), sourceText: buf.toString('utf8'), destination: 'serialized' }, 'sync').principalResult;
    void ruleset; return parseSvrl(svrl);
  };
  if (syntaxOk) { run('EN16931', LAYERS.EN16931, schematron('EN16931')); run('PEPPOL', LAYERS.PEPPOL, schematron('PEPPOL')); }
  else for (const l of ['EN16931', 'PEPPOL']) layers.push({ layer: l, ruleset: rulesetOf(LAYERS[l]), status: 'SKIPPED_SYNTAX_FAILED', fatal: 0, warnings: 0 });
  run('NORDLA', null, () => invariants.filter((i) => !i.ok).map((i) => ({ ruleId: i.id, flag: 'fatal', message: i.message })));
  const required = ['UBL_SYNTAX', 'EN16931', 'PEPPOL'];
  const ok = required.every((l) => layers.find((x) => x.layer === l)?.status === 'RAN') && !findings.some((f) => f.severity === 'fatal');
  return { ok, documentSha256, ruleset: { bis: rs.bis, version: rs.version, release: rs.release, customizationId: rs.customizationId, profileId: rs.profileId }, layers, findings, at };
}
