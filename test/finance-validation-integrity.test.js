import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildUbl } from '../src/finance/peppol.js';
import { validateStructured, artifactsFor, xsdFindings } from '../src/finance/peppol-validation.js';
import { PINNED_MANIFEST_SHA256, ValidationArtifactsError, checkArtifacts, resetArtifactVerification, verifiedArtifacts } from '../src/finance/validation-artifacts.js';
import { legalWorld, MERCHANT_ACTOR } from './finance-legal-helpers.js';

// Validation integrity: the official UBL XSD layer (Invoice and CreditNote), and the pinned, fail-closed official artifacts. SYNTHETIC data only.
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); const VENDOR = join(ROOT, 'vendor'); const AT = '2026-10-03T10:00:00.000Z';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const ubl = (doc, o = {}) => Buffer.from(buildUbl(doc, { defaultBuyerReference: 'document_number', ...o }), 'utf8');
const vendorCopy = () => { const d = mkdtempSync(join(tmpdir(), 'vendor-')); cpSync(VENDOR, d, { recursive: true }); return d + '/'; };
async function samples() { const w = legalWorld(); const inv = await w.store.getDocument((await w.issue({})).id); const base = await w.issue({ issueDate: '2026-09-11' }); const cn = await w.store.getDocument((await w.creditNote(base, [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }])).id); return { w, inv, cn, invXml: ubl(inv).toString('utf8'), cnXml: ubl(cn, { originalNumber: base.number }).toString('utf8') }; }
const layerStatus = (r) => Object.fromEntries(r.layers.map((l) => [l.layer, l.status]));

// ===================================================== A. OFFICIAL UBL XSD
test('XSD: the official OASIS UBL 2.1 schema accepts a valid Invoice and a valid CreditNote and runs FIRST among the official layers, before the Schematron', async () => {
  const s = await samples();
  for (const [name, xml, type] of [['invoice', s.invXml, 'Invoice'], ['credit note', s.cnXml, 'CreditNote']]) {
    const r = await validateStructured(xml, { at: AT, expectedType: type }); assert.equal(r.ok, true, `${name}: ${r.findings.map((f) => f.ruleId)}`); assert.deepEqual(r.layers.map((l) => l.layer), ['UBL_SYNTAX', 'UBL_XSD', 'EN16931', 'PEPPOL', 'NORDLA'], name);
    const x = r.layers.find((l) => l.layer === 'UBL_XSD'); assert.deepEqual([x.status, x.fatal, x.ruleset.name], ['RAN', 0, `UBL-${type}-2.1.xsd`]); assert.match(x.ruleset.artifactSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(JSON.stringify(Object.keys((await artifactsFor('3.0.21')).meta.xsd).sort()).includes('UBL-CreditNote-2.1.xsd'), true);
});
const mutate = (xml, from, to) => { assert.ok(xml.includes(from), `mutation anchor: ${from.slice(0, 40)}`); return xml.replace(from, to); };
const XSD_NEGATIVES = (xml, type) => ({
  'elements out of the schema sequence (IssueDate before ID)': mutate(xml, /<cbc:ID>[^<]+<\/cbc:ID>\s*<cbc:IssueDate>[^<]+<\/cbc:IssueDate>/.exec(xml)[0], /<cbc:IssueDate>[^<]+<\/cbc:IssueDate>/.exec(xml)[0] + /<cbc:ID>[^<]+<\/cbc:ID>/.exec(xml)[0]),
  'an element that does not exist in UBL (cac:Bogus inside a party)': mutate(xml, '<cac:PartyName>', '<cac:Bogus/><cac:PartyName>'),
  'an impossible calendar date (xs:date)': mutate(xml, /<cbc:IssueDate>[^<]+<\/cbc:IssueDate>/.exec(xml)[0], '<cbc:IssueDate>2026-13-45</cbc:IssueDate>'),
  'a non-numeric amount (xs:decimal)': mutate(xml, /<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">[\d.]+/.exec(xml)[0], '<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">twelve euros'),
  'a text node where the schema wants an aggregate (cbc:Name directly under the root)': mutate(xml, '</cbc:DocumentCurrencyCode>', '</cbc:DocumentCurrencyCode><cbc:Name>stray</cbc:Name>'),
  'the mandatory monetary total removed': xml.replace(/<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/, ''),
  'a root in the wrong UBL namespace': xml.replace(/xmlns="urn:oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)-2"/, 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:$1-3"'),
  [type === 'Invoice' ? 'a credit-note line inside an invoice' : 'an invoice line inside a credit note']: type === 'Invoice' ? xml.replace(/<cac:InvoiceLine>/g, '<cac:CreditNoteLine>').replace(/<\/cac:InvoiceLine>/g, '</cac:CreditNoteLine>') : xml.replace(/<cac:CreditNoteLine>/g, '<cac:InvoiceLine>').replace(/<\/cac:CreditNoteLine>/g, '</cac:InvoiceLine>'),
  ...(type === 'CreditNote' ? { 'an element only an invoice may carry (DueDate in a credit note)': mutate(xml, '<cbc:CreditNoteTypeCode>', '<cbc:DueDate>2026-10-10</cbc:DueDate><cbc:CreditNoteTypeCode>') } : { 'a credit-note type code in an invoice': mutate(xml, '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>') }),
});
test('XSD negatives (structure the Schematron does not state): Invoice and CreditNote, each failure is a structured UBL_XSD finding and the Schematron layers do NOT run on it', async () => {
  const s = await samples();
  for (const [xml, type] of [[s.invXml, 'Invoice'], [s.cnXml, 'CreditNote']]) for (const [name, bad] of Object.entries(XSD_NEGATIVES(xml, type))) {
    const r = await validateStructured(bad, { at: AT }); const label = `${type}: ${name}`; assert.equal(r.ok, false, label);
    const st = layerStatus(r); const fx = r.findings.filter((f) => f.layer === 'UBL_XSD');
    assert.equal(st.UBL_SYNTAX, 'RAN', label); assert.deepEqual(r.findings.filter((f) => f.layer === 'UBL_SYNTAX'), [], `${label}: well-formed XML, the failure must come from the XSD`);
    assert.equal(st.UBL_XSD, 'RAN', label); assert.ok(fx.length >= 1 && fx.every((f) => f.ruleId === 'UBL-XSD' && f.severity === 'fatal' && f.message && f.documentSha256 === r.documentSha256 && f.ruleset.name === `UBL-${type}-2.1.xsd`), `${label}: ${JSON.stringify(r.findings.slice(0, 2))}`);
    assert.deepEqual([st.EN16931, st.PEPPOL], ['SKIPPED_XSD_FAILED', 'SKIPPED_XSD_FAILED'], label); assert.ok(!r.findings.some((f) => ['EN16931', 'PEPPOL'].includes(f.layer)), `${label}: Schematron findings on a document that is not valid UBL`);
  }
});
test('XSD negatives are reported by the XSD layer itself (not by Schematron): the same defects judged WITHOUT the XSD would not all be caught', async () => {
  const s = await samples(); let onlyXsd = 0;
  for (const [name, bad] of Object.entries(XSD_NEGATIVES(s.invXml, 'Invoice'))) {
    const art = artifactsFor('3.0.21'); const xsd = await xsdFindings(art, 'Invoice', bad).catch(() => ['x']); assert.ok(xsd.length >= 1, name);
    // what the Schematron alone says about the same bytes (run through the pipeline with the XSD layer's verdict ignored)
    const { createRequire } = await import('node:module'); const saxon = createRequire(import.meta.url)('saxon-js'); const sef = JSON.parse(art.files.get('peppol-bis-3.0.21/CEN-EN16931-UBL.sef.json').toString('utf8'));
    let sch = []; try { const svrl = saxon.transform({ stylesheetInternal: sef, sourceText: bad, destination: 'serialized' }, 'sync').principalResult; sch = svrl.match(/<svrl:failed-assert/g) ?? []; } catch { sch = ['threw']; }
    if (sch.length === 0) onlyXsd += 1;
  }
  assert.ok(onlyXsd >= 2, `at least two structural defects are invisible to the EN 16931 Schematron and caught only by the XSD (found ${onlyXsd})`);
});
test('XSD with a large attachment (3 MB inside the document) validates without exhausting the engine', async () => {
  const s = await samples(); const big = Buffer.alloc(3 * 1024 * 1024, 65); const xml = ubl(s.inv, { attachments: [{ fileName: 'big.pdf', mediaType: 'application/pdf', data: big }] });
  const r = await validateStructured(xml, { at: AT }); assert.equal(layerStatus(r).UBL_XSD, 'RAN'); assert.deepEqual(r.findings.filter((f) => f.layer === 'UBL_XSD'), []);
});
test('SERVICE: an XSD failure prevents archive-as-valid, queueing and sending (the validator saw a structurally invalid document)', async () => {
  const breaker = (xml, o) => validateStructured(Buffer.from(xml.toString('utf8').replace('<cac:PartyName>', '<cac:Bogus/><cac:PartyName>')), o);
  const w = legalWorld({ validate: breaker }); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id); const comp = await w.legal.compliance(doc.id);
  assert.ok(comp.pdf, 'the invoice is issued and its PDF original archived'); assert.equal(comp.structured, null); assert.equal((await w.store.listArtifacts({ merchantId: w.merchantId, documentId: doc.id, kind: 'STRUCTURED_ORIGINAL' })).length, 0);
  const failed = (await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 50 })).find((e) => e.action === 'COMPLIANCE_FAILED'); assert.deepEqual(failed.detail.firstRules.slice(0, 1), ['UBL-XSD']);
  await assert.rejects(() => w.peppol.queue(doc, { actor: MERCHANT_ACTOR }), (e) => e.code === 'PEPPOL_NOT_READY' && e.errors.includes('UBL-XSD'));
  const msgs = await w.store.listPeppolMessages({ merchantId: w.merchantId, documentId: doc.id }); assert.deepEqual(msgs.map((m) => m.state), ['VALIDATION_FAILED']); assert.equal(w.provider.calls.submit, 0); assert.equal((await w.peppol.dispatch(msgs[0].id)).sent, false);
  const { xml } = await (await import('./finance-legal-helpers.js')).supplierInvoiceXml(); const w2 = legalWorld({ validate: undefined }); const bad = Buffer.from(xml.toString('utf8').replace('<cac:PartyName>', '<cac:Bogus/><cac:PartyName>'));
  const r = await w2.peppol.receive({ providerMessageId: 'xsd-bad', payload: bad }); assert.equal(r.message.state, 'VALIDATION_FAILED', 'an inbound document that is not valid UBL waits for a person, never auto-accepted'); assert.ok(r.validation.findings.some((f) => f.layer === 'UBL_XSD'));
});

// ===================================================== B. PINNED, FAIL-CLOSED ARTIFACTS
test('MANIFEST: one centralized manifest with source / version / retrieval date / SHA-256 / size for every official artifact; its own hash is pinned in code; nothing unlisted lives under vendor/', () => {
  const raw = readFileSync(join(VENDOR, 'MANIFEST.json')); assert.equal(sha(raw), PINNED_MANIFEST_SHA256); const m = JSON.parse(raw.toString('utf8')); assert.deepEqual([m.manifestVersion, m.bisVersion], [1, '3.0.21']);
  const roles = new Set(m.artifacts.map((a) => a.role)); assert.deepEqual([...roles].sort(), ['DERIVED', 'SOURCE']);
  for (const a of m.artifacts) { assert.match(a.sha256, /^[0-9a-f]{64}$/); assert.ok(a.bytes > 0 && (a.role === 'SOURCE' ? a.source.url : a.source.builtWith) && a.source.version && /^2026-/.test(a.source.retrievedOn), a.path); const b = readFileSync(join(VENDOR, a.path)); assert.equal(sha(b), a.sha256, a.path); assert.equal(b.length, a.bytes); }
  const listed = new Set(m.artifacts.map((a) => a.path)); const onDisk = walk(VENDOR).map((f) => relative(VENDOR, f).replace(/\\/g, '/')).filter((f) => f !== 'MANIFEST.json'); assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [], 'every file under vendor/ is pinned'); assert.deepEqual([...listed].filter((f) => !onDisk.includes(f)), []);
  for (const must of ['peppol-bis-3.0.21/src/CEN-EN16931-UBL.sch', 'peppol-bis-3.0.21/src/PEPPOL-EN16931-UBL.sch', 'ubl-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd', 'ubl-2.1/xsd/maindoc/UBL-CreditNote-2.1.xsd', 'peppol-bis-3.0.21/CEN-EN16931-UBL.sef.json']) assert.ok(listed.has(must), must);
  assert.equal(m.artifacts.find((a) => a.path.endsWith('UBL-Invoice-2.1.xsd')).source.archiveSha256, '60b80d76394a8a2add90723ecb8e0e2e9d826775de9749df37a72d60703f86ed');
});
test('LINE ENDINGS: Git is told never to convert or text-diff vendor/; every vendored file is stored exactly as the bytes that are pinned', () => {
  assert.match(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), /^vendor\/\*\* -text -diff$/m);
  const attrs = execSync('git check-attr text diff -- vendor/peppol-bis-3.0.21/src/CEN-EN16931-UBL.sch vendor/ubl-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd vendor/MANIFEST.json', { cwd: ROOT, encoding: 'utf8' }); assert.equal((attrs.match(/text: unset/g) ?? []).length, 3); assert.equal((attrs.match(/diff: unset/g) ?? []).length, 3);
  const eol = execSync('git ls-files --eol vendor', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n'); assert.ok(eol.length >= 25); for (const l of eol) { const [i, w, a] = l.split(/\s+/); assert.equal(i.replace('i/', ''), w.replace('w/', ''), `index and working copy differ in line endings: ${l}`); assert.equal(a, 'attr/-text', l); }
  const ids = execSync('git ls-files vendor', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n'); for (const f of ids.filter((x) => /\.(sch|xsd|xsl)$/.test(x))) { const blob = execSync(`git show :${f}`, { cwd: ROOT, maxBuffer: 50_000_000 }); assert.equal(sha(blob), sha(readFileSync(join(ROOT, f))), `${f}: the committed bytes are the working bytes`); }
});
test('TAMPER: a modified, missing, wrong-version or replaced-manifest artifact makes validation REFUSE TO START (explicit error, no official layer runs); the pristine copy still validates', async () => {
  const s = await samples(); const good = vendorCopy(); try {
    resetArtifactVerification(); assert.equal(checkArtifacts({ vendorDir: good, version: '3.0.21' }).ok, true); assert.equal((await validateStructured(s.invXml, { at: AT, vendorDir: good })).ok, true);
    const cases = {
      'one byte changed in the EN 16931 Schematron source': (d) => { const p = d + 'peppol-bis-3.0.21/src/CEN-EN16931-UBL.sch'; const b = readFileSync(p); b[b.length - 5] ^= 1; writeFileSync(p, b); return ['ARTIFACTS_UNVERIFIED', 'ARTIFACT_MODIFIED', 'CEN-EN16931-UBL.sch']; },
      'the Invoice XSD changed': (d) => { const p = d + 'ubl-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd'; writeFileSync(p, readFileSync(p, 'utf8').replace('minOccurs="1"', 'minOccurs="0"') + ' '); return ['ARTIFACTS_UNVERIFIED', 'ARTIFACT_MODIFIED', 'UBL-Invoice-2.1.xsd']; },
      'a common XSD deleted': (d) => { rmSync(d + 'ubl-2.1/xsd/common/UBL-CommonBasicComponents-2.1.xsd'); return ['ARTIFACTS_UNVERIFIED', 'ARTIFACT_MISSING', 'UBL-CommonBasicComponents-2.1.xsd']; },
      'the compiled Peppol validator altered': (d) => { const p = d + 'peppol-bis-3.0.21/PEPPOL-EN16931-UBL.sef.json'; const b = readFileSync(p); b[10] ^= 1; writeFileSync(p, b); return ['ARTIFACTS_UNVERIFIED', 'ARTIFACT_MODIFIED', 'PEPPOL-EN16931-UBL.sef.json']; },
      'a file truncated': (d) => { const p = d + 'iso-schematron/iso_svrl_for_xslt2.xsl'; writeFileSync(p, readFileSync(p).subarray(0, 1000)); return ['ARTIFACTS_UNVERIFIED', 'ARTIFACT_MODIFIED', 'iso_svrl_for_xslt2.xsl']; },
      'the manifest rewritten to match a swapped file': (d) => { const m = JSON.parse(readFileSync(d + 'MANIFEST.json', 'utf8')); m.artifacts[0].sha256 = '0'.repeat(64); writeFileSync(d + 'MANIFEST.json', JSON.stringify(m, null, 2) + '\n'); return ['MANIFEST_MODIFIED', 'MANIFEST_MODIFIED', 'MANIFEST.json']; },
      'the manifest deleted': (d) => { rmSync(d + 'MANIFEST.json'); return ['MANIFEST_MISSING', 'MANIFEST_MISSING', 'MANIFEST.json']; },
    };
    for (const [name, alter] of Object.entries(cases)) {
      const dir = vendorCopy(); try {
        resetArtifactVerification(); const [code, problem, file] = alter(dir);
        const c = checkArtifacts({ vendorDir: dir, version: '3.0.21' }); assert.deepEqual([c.ok, c.code], [false, code], name); assert.ok(c.problems.some((p) => p.code === problem && p.path.endsWith(file)), `${name}: ${JSON.stringify(c.problems)}`);
        assert.throws(() => verifiedArtifacts({ vendorDir: dir, version: '3.0.21' }), (e) => e instanceof ValidationArtifactsError && e.code === code, name);
        const r = await validateStructured(s.invXml, { at: AT, vendorDir: dir }); assert.equal(r.ok, false, name); const art = r.findings.find((f) => f.layer === 'ARTIFACTS'); assert.equal(art.ruleId, 'VALIDATION-ARTIFACTS-UNVERIFIED', name); assert.ok(art.message.includes(code), name);
        assert.deepEqual([layerStatus(r).UBL_XSD, layerStatus(r).EN16931, layerStatus(r).PEPPOL], ['NOT_RUN_ARTIFACTS_UNVERIFIED', 'NOT_RUN_ARTIFACTS_UNVERIFIED', 'NOT_RUN_ARTIFACTS_UNVERIFIED'], `${name}: no official layer starts`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    resetArtifactVerification(); const wrongVersion = checkArtifacts({ vendorDir: good, version: '3.0.20' }); assert.deepEqual([wrongVersion.ok, wrongVersion.code], [false, 'RELEASE_NOT_PINNED']); assert.equal(artifactsFor('9.9.9').available, false); assert.equal(artifactsFor('9.9.9').error.code, 'RELEASE_NOT_PINNED');
    assert.equal(checkArtifacts({ vendorDir: good, version: '3.0.21', expectedManifestSha256: 'f'.repeat(64) }).code, 'MANIFEST_MODIFIED', 'a manifest that is not the pinned one is refused even if its files are intact');
  } finally { rmSync(good, { recursive: true, force: true }); resetArtifactVerification(); }
});
test('TAMPER at the service level: with a tampered validator set no structured original is archived, nothing is queued, nothing is sent; the failure is recorded with the artifact error', async () => {
  const dir = vendorCopy(); try {
    const p = dir + 'peppol-bis-3.0.21/src/PEPPOL-EN16931-UBL.sch'; const b = readFileSync(p); b[b.length - 9] ^= 1; writeFileSync(p, b); resetArtifactVerification();
    const w = legalWorld({ validate: (xml, o) => validateStructured(xml, { ...o, vendorDir: dir }) }); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id);
    const comp = await w.legal.compliance(doc.id); assert.ok(comp.pdf); assert.equal(comp.structured, null); const ev = (await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 50 })).find((e) => e.action === 'COMPLIANCE_FAILED'); assert.deepEqual(ev.detail.firstRules, ['VALIDATION-ARTIFACTS-UNVERIFIED']);
    await assert.rejects(() => w.peppol.queue(doc), (e) => e.code === 'PEPPOL_NOT_READY' && e.errors.includes('VALIDATION-ARTIFACTS-UNVERIFIED')); assert.equal(w.provider.calls.submit, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); resetArtifactVerification(); }
});
test('EVIDENCE: a structured original records the exact pinned artifacts that validated it (XSD, Schematron sources, compiled validators, engines)', async () => {
  const s = await samples(); const c = await s.w.legal.compliance(s.inv.id); const rs = c.structured.provenance.ruleset; const m = JSON.parse(readFileSync(join(VENDOR, 'MANIFEST.json'), 'utf8')); const pin = (suffix) => m.artifacts.find((a) => a.path.endsWith(suffix)).sha256;
  assert.equal(rs.xsd['UBL-Invoice-2.1.xsd'], pin('UBL-Invoice-2.1.xsd')); assert.equal(rs.sources['CEN-EN16931-UBL.sch'], pin('CEN-EN16931-UBL.sch')); assert.equal(rs.artifacts['PEPPOL-EN16931-UBL.sef.json'], pin('PEPPOL-EN16931-UBL.sef.json')); assert.deepEqual(rs.engines, { xsd: 'xmllint-wasm (libxml2)', schematron: 'saxon-js' });
  assert.deepEqual(c.structured.provenance.validation.layers.map((l) => l.layer), ['UBL_SYNTAX', 'UBL_XSD', 'EN16931', 'PEPPOL', 'NORDLA']); assert.ok(existsSync(join(VENDOR, 'MANIFEST.json')));
});
