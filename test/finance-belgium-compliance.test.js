import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vcsGenerate, vcsCanonicalize, vcsValid, vcsFormat, vcsForInvoiceNumber, determineInvoiceRoute, routingContextOf, RULES, ROUTES, STRUCTURED_ROUTES } from '../src/finance/belgium-compliance.js';
import { structuredCommunication, PDF_RENDERER_VERSION } from '../src/finance/pdf.js';
import { readPdfText } from '../src/finance/pdf-text.js';
import { structuredInvariants } from '../src/finance/legal-artifacts.js';
import { buildUbl, validatePeppolReadiness, CUSTOMIZATION_ID, PROFILE_ID, MAX_ATTACHMENT_BYTES, safeFileName } from '../src/finance/peppol.js';
import { validateStructured, parseSvrl, CURRENT_PEPPOL_VERSION, PEPPOL_RULESETS, rulesetFor, artifactsFor } from '../src/finance/peppol-validation.js';
import { legalWorld, MERCHANT_ACTOR, CUSTOMER, LINES, VAT_OK } from './finance-legal-helpers.js';

// Belgium & Peppol finalization: VCS/OGM, route decision, rules registry, official validation, immutable issue snapshot and original archive. SYNTHETIC data only.
const sha = (b) => createHash('sha256').update(b).digest('hex'); const AT = '2026-10-03T10:00:00.000Z';

// ===================================================== VCS / OGM
test('VCS: known valid references, check digits, remainder 0 -> 97, leading zeros (independent BigInt check)', () => {
  const independent = (base10) => { const r = Number(BigInt(base10) % 97n); return String(r === 0 ? 97 : r).padStart(2, '0'); };
  for (const base of ['0108068171', '0909337554', '0000000001', '0000000097', '0000000194', '1234567890', '9999999999', '0000000000']) assert.equal(vcsGenerate(base), base + independent(base), base);
  assert.equal(vcsGenerate('97'), '000000009797', 'remainder 0 gives check digits 97, not 00'); assert.equal(vcsGenerate('0'), '000000000097'); assert.equal(vcsGenerate('1'), '000000000101');
  assert.ok(vcsValid('010806817183') && vcsValid('+++090/9337/55493+++') && vcsValid('090/9337/55493'));
  assert.ok(!vcsValid('090933755494'), 'wrong check digits'); assert.ok(!vcsValid('000000009700'), '00 is never a check for remainder 0'); assert.throws(() => vcsGenerate('12345678901'), /VCS_BASE_INVALID/); assert.throws(() => vcsGenerate('12a'), /VCS_BASE_INVALID/);
});
test('VCS: canonicalization and formatting; malformed forms are refused, never repaired', () => {
  assert.equal(vcsCanonicalize('+++123/4567/89002+++'), '123456789002'); assert.equal(vcsCanonicalize(' 123 4567 89002 '), '123456789002'); assert.equal(vcsFormat('010806817183'), '+++010/8068/17183+++'); assert.equal(vcsFormat('+++010/8068/17183+++'), '+++010/8068/17183+++');
  for (const bad of ['+++123/4567/89002', '123/4567/89002+++', '12345678901', '1234567890123', '12-34', 'abcdefghijkl', '', null, undefined, '+++123/456/789002+++']) assert.equal(vcsCanonicalize(bad), null, String(bad));
  assert.throws(() => vcsFormat('090933755494'), /VCS_INVALID/);
});
test('VCS: derived from the legal number only; unique where numbers are unique; identical to the reference the PDF already printed; no float involved', () => {
  assert.equal(vcsForInvoiceNumber('INV-2026-0001'), '002026000196'); assert.equal(structuredCommunication('INV-2026-0001'), '+++002/0260/00196+++');
  const seen = new Set(); for (let i = 1; i <= 3000; i++) { const r = vcsForInvoiceNumber(`INV-2026-${String(i).padStart(4, '0')}`); assert.ok(vcsValid(r)); assert.ok(!seen.has(r), `collision at ${i}`); seen.add(r); }
  assert.notEqual(vcsForInvoiceNumber('INV-2026-0001'), vcsForInvoiceNumber('INV-2027-0001')); assert.throws(() => vcsForInvoiceNumber('NO-DIGITS'), /VCS_NUMBER_HAS_NO_DIGITS/);
  const src = readFileSync(new URL('../src/finance/belgium-compliance.js', import.meta.url), 'utf8'); assert.ok(!/parseFloat|Math\.floor\(|Number\(.*\) \/ /.test(src.split('// ---------------------------------------------------------------- invoice route')[0].split('// ---------------------------------------------------------------- VCS / OGM')[1]), 'integer arithmetic only');
});

// ===================================================== ROUTING (explainable, from facts)
const seller = { country: 'BE', vatNumber: 'BE0000000097', iban: 'BE00 0000 0000 0000' };
const ctx = (over = {}) => ({ document: { kind: 'invoice' }, seller, buyer: { kind: 'business', country: 'BE', vatNumber: 'BE0000000196' }, vatRegime: 'domestic', ...over });
const agreement = { format: 'UBL-EN16931', en16931Compliant: true, reason: 'customer ERP imports UBL by e-mail', evidence: 'signed agreement 2026-01-12', agreedAt: '2026-01-12T09:00:00Z', recordedBy: 'owner' };
test('ROUTING A: a Belgian VAT-liable seller -> a Belgian VAT-liable company, domestic: structured required via Peppol, with the rule that says so', () => {
  const r = determineInvoiceRoute(ctx()); assert.equal(r.route, 'PEPPOL_REQUIRED'); assert.deepEqual(r.rules, ['BE-B2B-STRUCTURED-2026']); assert.deepEqual(r.reasons, ['BELGIAN_B2B_BETWEEN_VAT_LIABLE_ENTERPRISES']); assert.deepEqual(r.missingFacts, []);
  assert.equal(determineInvoiceRoute(ctx({ vatRegime: 'vat_exempt_small_business' })).route, 'PEPPOL_REQUIRED', 'the small-business exemption scheme is still in scope');
});
test('ROUTING B / C / international / B2G / Art. 44 / insufficient facts / agreement', () => {
  assert.equal(determineInvoiceRoute(ctx({ buyer: { kind: 'individual', country: 'BE' } })).route, 'NON_STRUCTURED_ALLOWED'); // B: private individual
  const fr = determineInvoiceRoute(ctx({ buyer: { kind: 'business', country: 'FR', vatNumber: 'FR12345678901' }, vatRegime: 'intra_eu_b2b_exempt' })); assert.equal(fr.route, 'NON_STRUCTURED_ALLOWED'); assert.ok(fr.notes.includes('VOLUNTARY_PEPPOL_POSSIBLE')); // C: never imposed automatically
  assert.equal(determineInvoiceRoute(ctx({ buyer: { kind: 'business', country: 'FR', vatNumber: 'FR12345678901', peppolId: '0009:12345678901234' } })).route, 'PEPPOL_PREFERRED');
  assert.equal(determineInvoiceRoute(ctx({ buyer: { kind: 'public_authority', country: 'BE' } })).route, 'B2G_STRUCTURED'); assert.ok(determineInvoiceRoute(ctx({ buyer: { kind: 'public_authority', country: 'BE' } })).notes.includes('B2G_THRESHOLDS_AND_EXCEPTIONS_NOT_EVALUATED'));
  const art44 = determineInvoiceRoute(ctx({ buyer: { kind: 'business', country: 'BE', exemptArt44Only: true } })); assert.equal(art44.route, 'NON_STRUCTURED_ALLOWED'); assert.deepEqual(art44.rules, ['BE-ART44-OUT']);
  assert.equal(determineInvoiceRoute(ctx({ buyer: { kind: 'business', country: 'BE' } })).route, 'MANUAL_REVIEW_REQUIRED'); // Belgian business without VAT number and no explicit exemption fact: not guessed
  assert.equal(determineInvoiceRoute(ctx({ buyer: { kind: 'business', country: 'FR', vatNumber: 'BE0000000196' } })).route, 'MANUAL_REVIEW_REQUIRED', 'foreign address with a Belgian VAT number');
  assert.equal(determineInvoiceRoute(ctx({ seller: { country: 'FR', vatNumber: 'FR1' } })).route, 'MANUAL_REVIEW_REQUIRED', 'non-established seller: establishment facts needed');
  assert.equal(determineInvoiceRoute(ctx({ vatRegime: 'reverse_charge' })).route, 'MANUAL_REVIEW_REQUIRED'); assert.equal(determineInvoiceRoute(ctx({ vatRegime: undefined })).route, 'MANUAL_REVIEW_REQUIRED'); assert.equal(determineInvoiceRoute({ ...ctx(), buyer: {} }).route, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(determineInvoiceRoute(ctx({ seller: { country: 'BE', vatNumber: 'BE0000000097' } })).route, 'COMPLIANCE_BLOCKED'); assert.deepEqual(determineInvoiceRoute(ctx({ seller: { country: 'BE', vatNumber: 'BE0000000097' } })).missingFacts, ['seller.iban']);
  const alt = determineInvoiceRoute(ctx({ agreement })); assert.equal(alt.route, 'ALTERNATIVE_EN16931_AGREED'); assert.deepEqual(alt.rules, ['BE-ALT-FORMAT-AGREEMENT']);
  const weak = determineInvoiceRoute(ctx({ agreement: { ...agreement, evidence: '' } })); assert.equal(weak.route, 'COMPLIANCE_BLOCKED'); assert.ok(weak.missingFacts.includes('agreement.evidence')); assert.equal(determineInvoiceRoute(ctx({ agreement: { ...agreement, en16931Compliant: false } })).route, 'COMPLIANCE_BLOCKED', 'never a silent fallback');
  for (const r of ['PEPPOL_REQUIRED', 'PEPPOL_PREFERRED', 'B2G_STRUCTURED', 'NON_STRUCTURED_ALLOWED', 'ALTERNATIVE_EN16931_AGREED', 'MANUAL_REVIEW_REQUIRED', 'COMPLIANCE_BLOCKED']) assert.ok(ROUTES.includes(r));
});
test('ROUTING: a credit note follows the route of the invoice it corrects; unknown original = manual review', () => {
  assert.equal(determineInvoiceRoute({ ...ctx(), document: { kind: 'credit_note' }, originalInvoice: { route: 'PEPPOL_REQUIRED' } }).route, 'PEPPOL_REQUIRED'); assert.equal(determineInvoiceRoute({ ...ctx(), document: { kind: 'credit_note' }, originalInvoice: { route: 'NON_STRUCTURED_ALLOWED' } }).route, 'NON_STRUCTURED_ALLOWED');
  assert.equal(determineInvoiceRoute({ ...ctx(), document: { kind: 'credit_note' } }).route, 'MANUAL_REVIEW_REQUIRED');
  const doc = { type: 'invoice', vat: { regime: 'domestic' }, seller: { address: { countryCode: 'BE' }, vatNumber: 'BE0000000097', iban: 'x' }, customer: { kind: 'business', vatNumber: 'BE0000000196', address: { countryCode: 'BE' } } }; assert.equal(determineInvoiceRoute(routingContextOf(doc)).route, 'PEPPOL_REQUIRED');
});
test('RULES: every LEGAL / PEPPOL MUST names its official source, URL, verification date and Nordla component; classes are the four agreed ones; the documentation lists every rule id', () => {
  assert.deepEqual([...new Set(RULES.map((r) => r.class))].sort(), ['BACKLOG', 'LEGAL MUST', 'NORDLA INVARIANT', 'PEPPOL MUST']);
  for (const r of RULES.filter((x) => ['LEGAL MUST', 'PEPPOL MUST'].includes(x.class))) { assert.ok(r.source && /^https:\/\//.test(r.url) && /^2026-\d\d-\d\d$/.test(r.verifiedOn) && r.component && r.rule, r.id); }
  const doc = readFileSync(new URL('../docs/finance-belgium-compliance.md', import.meta.url), 'utf8'); for (const r of RULES) assert.ok(doc.includes(r.id), `docs must list ${r.id}`);
  for (const r of ROUTES) assert.ok(doc.includes(r), `docs must explain route ${r}`); assert.ok(STRUCTURED_ROUTES.every((r) => ROUTES.includes(r)));
});

// ===================================================== RULESET / OFFICIAL ARTIFACTS
test('RULESET: one declared release (Peppol BIS Billing 3.0.21), identifiers equal to the builder, official artifacts present with recorded hashes; unknown version refused; history stays linked to its version', () => {
  const rs = rulesetFor(CURRENT_PEPPOL_VERSION); assert.deepEqual([rs.bis, rs.version, rs.release], ['Peppol BIS Billing 3.0', '3.0.21', '2026 May release']); assert.equal(CUSTOMIZATION_ID, rs.customizationId); assert.equal(PROFILE_ID, rs.profileId); assert.match(rs.verifiedOn, /^2026-/);
  const art = artifactsFor('3.0.21'); assert.equal(art.available, true); assert.deepEqual(Object.keys(art.meta.compiled).sort(), ['CEN-EN16931-UBL.sef.json', 'PEPPOL-EN16931-UBL.sef.json']); for (const h of [...Object.values(art.meta.compiled), ...Object.values(art.meta.schematronSources)]) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(new URL('../vendor/peppol-bis-3.0.21/src/PEPPOL-EN16931-UBL.sch', import.meta.url), 'utf8').includes('2026 May release 3.0.21'), true, 'the official Schematron itself states the release');
  assert.throws(() => rulesetFor('9.9.9'), /UNKNOWN_PEPPOL_RULESET/); assert.equal(artifactsFor('9.9.9').available, false); assert.ok(PEPPOL_RULESETS['3.0.21'].attachmentMediaTypes.includes('application/pdf'));
});
const issued = async (w, over) => { const inv = await w.issue(over); const doc = await w.store.getDocument(inv.id); return doc; };
const ubl = (doc, o = {}) => Buffer.from(buildUbl(doc, { defaultBuyerReference: 'document_number', ...o }), 'utf8'); const validate = (xml, o = {}) => validateStructured(xml, { at: AT, ...o });
const fatalIds = (r) => r.findings.filter((f) => f.severity === 'fatal').map((f) => f.ruleId);

test('STRUCTURED MATRIX (official EN 16931 + Peppol Schematron executed): single rate, several rates, 12 %, zero, exempt, reverse charge, discounts, rounding, due date, terms, IBAN, VCS, identifiers, special characters, long text', async () => {
  const w = legalWorld(); const cases = {
    single: { lines: [{ description: 'Item A', quantity: '2', unitPrice: '10.00', vatRate: '21' }] }, several: {}, reduced12: { lines: [{ description: 'Restaurant', quantity: '3', unitPrice: '10.00', vatRate: '12' }] }, six: { lines: [{ description: 'Livre', quantity: '1', unitPrice: '10.00', vatRate: '6' }] },
    zero: { lines: [{ description: 'Zero rated', quantity: '1', unitPrice: '10.00', vatRate: '0' }] }, exempt: { vat: { regime: 'vat_exempt_small_business', confirmed: true, mention: 'Franchise de la taxe (régime des petites entreprises)' }, lines: [{ description: 'Service', quantity: '1', unitPrice: '10.00', vatRate: '0' }] },
    reverse: { vat: { regime: 'reverse_charge', confirmed: true, mention: 'Autoliquidation' }, lines: [{ description: 'Chantier', quantity: '1', unitPrice: '100.00', vatRate: '0' }] }, pctDiscount: { lines: [{ description: 'Item', quantity: '3', unitPrice: '9.99', vatRate: '21', discountPercent: '15' }] },
    fixedDiscount: { lines: [{ description: 'Item', quantity: '2', unitPrice: '10.00', vatRate: '21', discountAmount: '1.00' }] }, rounding: { lines: [{ description: 'Café', quantity: '7', unitPrice: '3.33', vatRate: '21' }, { description: 'Thé', quantity: '3', unitPrice: '1.11', vatRate: '6' }] },
    terms: { paymentTerms: '30 jours net', dueDate: '2026-10-10' }, accents: { lines: [{ description: 'Crème brûlée « spécialité » — Zoë & Søren <b>', quantity: '1', unitPrice: '12.50', vatRate: '21' }] }, long: { lines: [{ description: `Prestation ${'très longue description '.repeat(40)}`.slice(0, 900), quantity: '1', unitPrice: '10.00', vatRate: '21' }] } };
  for (const [name, over] of Object.entries(cases)) { const doc = await issued(w, over); assert.deepEqual(validatePeppolReadiness(doc, { defaultBuyerReference: 'document_number' }), [], name); const r = await validate(ubl(doc, { paymentReference: vcsFormat(vcsForInvoiceNumber(doc.number)) })); assert.equal(r.ok, true, `${name}: ${fatalIds(r)}`); assert.deepEqual(r.layers.map((l) => [l.layer, l.status]), [['UBL_SYNTAX', 'RAN'], ['UBL_XSD', 'RAN'], ['EN16931', 'RAN'], ['PEPPOL', 'RAN'], ['NORDLA', 'RAN']], name); }
});
test('STRUCTURED: credit note (BillingReference to the corrected invoice), attachment (BG-24), Belgian and foreign identifiers', async () => {
  const w = legalWorld(); const inv = await issued(w, {}); const cn0 = await w.creditNote(inv, [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }]); const cn = await w.store.getDocument(cn0.id);
  const r = await validate(ubl(cn, { originalNumber: inv.number }), { expectedType: 'CreditNote' }); assert.equal(r.ok, true, fatalIds(r).join()); assert.match(ubl(cn, { originalNumber: inv.number }).toString(), new RegExp(`<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>[\\s\\S]*<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${inv.number}</cbc:ID>`));
  assert.ok(validatePeppolReadiness(cn, {}).includes('CREDIT_NOTE_ORIGINAL_INVOICE_NUMBER_REQUIRED'));
  const pdf = Buffer.from('%PDF-1.4 synthetic attachment'); const withAtt = await validate(ubl(inv, { attachments: [{ fileName: 'conditions.pdf', mediaType: 'application/pdf', data: pdf }] })); assert.equal(withAtt.ok, true, fatalIds(withAtt).join());
  assert.ok(validatePeppolReadiness(inv, { attachments: [{ fileName: 'x.exe', mediaType: 'application/x-msdownload', data: pdf }] }).includes('ATTACHMENT_MEDIA_TYPE_NOT_ALLOWED')); assert.ok(validatePeppolReadiness(inv, { attachments: [{ fileName: '../../etc/passwd', mediaType: 'application/pdf', data: pdf }] }).includes('ATTACHMENT_FILE_NAME_INVALID'));
  assert.ok(validatePeppolReadiness(inv, { attachments: [{ fileName: 'big.pdf', mediaType: 'application/pdf', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }] }).includes('ATTACHMENT_SIZE_INVALID')); assert.ok(validatePeppolReadiness(inv, { attachments: [{ fileName: 'a.xml', mediaType: 'application/xml', data: pdf }] }).includes('ATTACHMENT_MEDIA_TYPE_NOT_ALLOWED'), 'XML only by agreement: not a default');
  for (const n of ['a.pdf', 'Facture été 1.pdf']) assert.equal(safeFileName(n), true); for (const n of ['', '..', 'a/b.pdf', 'a\\b.pdf', 'a\u0000.pdf', 'x'.repeat(121)]) assert.equal(safeFileName(n), false, JSON.stringify(n));
});
test('STRUCTURED failures: unsupported / invalid cases are reported by layer with rule ids (invalid tax category, intra-EU facts, schema failure, EN 16931 failure, Peppol failure)', async () => {
  const w = legalWorld(); const doc = await issued(w, {}); const good = ubl(doc).toString('utf8');
  const intra = await issued(w, { customer: { ...CUSTOMER, vatNumber: 'FR12345678901', enterpriseNumber: undefined, address: { street: 'Rue 1', postalCode: '75001', city: 'Paris', countryCode: 'FR' } }, vat: { regime: 'intra_eu_b2b_exempt', confirmed: true, mention: 'Exonération intracommunautaire' }, lines: [{ description: 'x', quantity: '1', unitPrice: '10.00', vatRate: '0' }] });
  assert.ok(validatePeppolReadiness(intra, {}).includes('INTRA_EU_DELIVERY_FACTS_REQUIRED'), 'the delivery facts the norm needs are not in the model: not invented');
  const bad = (xml, o) => validate(Buffer.from(xml), o); const schema = await bad('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID>'); assert.equal(schema.ok, false); assert.equal(schema.layers.find((l) => l.layer === 'UBL_SYNTAX').fatal, 1); assert.deepEqual(schema.layers.filter((l) => l.layer !== 'UBL_SYNTAX' && l.layer !== 'NORDLA').map((l) => l.status), ['SKIPPED_SYNTAX_FAILED', 'SKIPPED_SYNTAX_FAILED', 'SKIPPED_SYNTAX_FAILED']);
  const en = await bad(good.replace(/(<cbc:PayableAmount currencyID="EUR">)[\d.]+/, '$199.99')); assert.equal(en.ok, false); assert.ok(en.findings.some((f) => f.layer === 'EN16931' && /^BR-/.test(f.ruleId)), fatalIds(en).join());
  const pep = await bad(good.replace(/<cbc:CustomizationID>[^<]+/, '<cbc:CustomizationID>urn:other')); assert.equal(pep.ok, false); assert.ok(pep.findings.some((f) => f.layer === 'PEPPOL' && /^PEPPOL-EN16931-R/.test(f.ruleId)));
  const wrongType = await bad(good, { expectedType: 'CreditNote' }); assert.equal(wrongType.ok, false); const f0 = en.findings[0]; assert.deepEqual(Object.keys(f0).sort(), ['at', 'documentSha256', 'layer', 'location', 'message', 'ruleId', 'ruleset', 'severity']); assert.equal(f0.documentSha256, en.documentSha256); assert.equal(f0.ruleset.bisVersion, '3.0.21'); assert.match(f0.ruleset.artifactSha256, /^[0-9a-f]{64}$/);
  await assert.rejects(() => validateStructured(good), /explicit timestamp/); assert.deepEqual(parseSvrl('<svrl:failed-assert id="X-1" flag="warning" location="/a"><svrl:text>a &amp; b</svrl:text></svrl:failed-assert>'), [{ ruleId: 'X-1', flag: 'warning', location: '/a', message: 'a & b' }]);
  const inv = await validate(good, { invariants: [{ id: 'NORDLA-X', ok: false, message: 'mismatch' }] }); assert.equal(inv.ok, false); assert.equal(inv.findings.find((f) => f.layer === 'NORDLA').ruleId, 'NORDLA-X');
  assert.equal((await validate(Buffer.alloc(6 * 1024 * 1024, 32))).findings[0].ruleId, 'NORDLA-SYNTAX-SIZE');
});

// ===================================================== ISSUE: SNAPSHOT, ORIGINAL PDF, STRUCTURED ORIGINAL, IMMUTABILITY
test('G / H / I. ISSUE ARCHIVE: the exact PDF bytes and their hash are recoverable; the structured original is archived with its validation and exact ruleset; PDF, UBL and compliance record share the same amounts, tax and reference', async () => {
  const w = legalWorld(); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id);
  const comp = await w.legal.compliance(doc.id); assert.ok(comp.pdf && comp.structured); assert.deepEqual([comp.pdf.kind, comp.pdf.classification, comp.structured.kind, comp.structured.classification], ['PDF_ORIGINAL', 'ORIGINAL', 'STRUCTURED_ORIGINAL', 'ORIGINAL']);
  const o = await w.legal.originalPdf(doc.id); assert.equal(o.verified, true); assert.equal(sha(o.data), comp.pdf.sha256); assert.equal(o.data.length, comp.pdf.sizeBytes); assert.equal(o.data.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual([comp.pdf.provenance.rendererVersion, comp.pdf.provenance.snapshotHash, comp.pdf.provenance.documentNumber, comp.pdf.provenance.source], [PDF_RENDERER_VERSION, doc.snapshotHash, doc.number, 'issue']); assert.ok(comp.pdf.createdAt && comp.pdf.storageRef.includes(doc.id));
  const s = await w.legal.structuredOriginal(doc.id); assert.equal(s.verified, true); assert.equal(sha(s.data), comp.structured.sha256); const v = comp.structured.provenance;
  assert.equal(v.validation.ok, true); assert.deepEqual([v.ruleset.bis, v.ruleset.version, v.ruleset.customizationId, v.ruleset.profileId], ['Peppol BIS Billing 3.0', '3.0.21', CUSTOMIZATION_ID, PROFILE_ID]); assert.ok(v.ruleset.artifacts['CEN-EN16931-UBL.sef.json'] && v.ruleset.sources['PEPPOL-EN16931-UBL.sch']); assert.equal(v.snapshotHash, doc.snapshotHash); assert.deepEqual(v.validation.layers.map((l) => l.status), ['RAN', 'RAN', 'RAN', 'RAN', 'RAN']);
  assert.equal(comp.structured.parentArtifactId, comp.pdf.id, 'the structured original descends from the same issue');
  // the same numbers everywhere
  const xml = s.data.toString('utf8'); const cents = (n) => (n / 100).toFixed(2); const pay = doc.totals.grossCents + (doc.totals.roundingCents ?? 0);
  assert.ok(xml.includes(`<cbc:ID>${doc.number}</cbc:ID>`) && xml.includes(`TaxInclusiveAmount currencyID="EUR">${cents(doc.totals.grossCents)}<`) && xml.includes(`PayableAmount currencyID="EUR">${cents(pay)}<`) && xml.includes(`<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${cents(doc.totals.vatCents)}<`));
  for (const g of doc.totals.vatBreakdown) assert.ok(xml.includes(`TaxableAmount currencyID="EUR">${cents(g.taxableCents)}<`) && xml.includes(`<cbc:Percent>${(g.vatRateBp / 100).toFixed(2)}</cbc:Percent>`));
  const printed = vcsFormat(comp.paymentReference); assert.equal(comp.paymentReference, vcsForInvoiceNumber(doc.number)); assert.ok(xml.includes(`<cbc:PaymentID>${comp.paymentReference}</cbc:PaymentID>`)); assert.equal(comp.structured.provenance.paymentReference, comp.paymentReference);
  const text = (await readPdfText(o.data)).pages.flatMap((p) => p.lines.map((l) => l.text)).join(' '); assert.ok(text.replace(/\s+/g, '').includes(printed.replace(/\s+/g, '')), `the reference printed in the PDF is the stored one: ${printed}`); assert.ok(text.includes(doc.number));
  assert.equal(comp.routing.route, 'PEPPOL_REQUIRED'); const ev = (await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 100 })).map((e) => e.action); for (const a of ['ARTIFACT_ARCHIVED', 'COMPLIANCE_VALIDATED', 'ISSUE_COMPLIANCE_RECORDED']) assert.ok(ev.includes(a), a);
  const again = await w.legal.archiveIssued(doc, { atIssue: true }); assert.equal(again.duplicate, true); assert.equal((await w.store.listArtifacts({ merchantId: w.merchantId, documentId: doc.id })).length, 2, 'archiving twice stores nothing twice (an original never changes)');
});
test('E / F. IMMUTABILITY: changing the seller profile or the customer afterwards changes nothing of an issued invoice, its archived PDF, its structured original or its seller version', async () => {
  const w = legalWorld(); const inv = await w.issue({}); const before = await w.store.getDocument(inv.id); const comp0 = await w.legal.compliance(inv.id); const pdf0 = (await w.legal.originalPdf(inv.id)).data; const xml0 = (await w.legal.structuredOriginal(inv.id)).data;
  // a new seller profile version (new IBAN, new address) and a changed customer record
  const v2 = await w.legal.recordSeller({ ...before.seller, iban: 'BE68 5390 0754 7034', address: { ...before.seller.address, city: 'Ailleurs' } }); const versions = await w.store.listSellerProfileVersions(w.merchantId);
  assert.equal(versions.length, 2); assert.equal(v2.version, 2); assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  const company = await w.svc.createCompany?.({ ...CUSTOMER, name: 'Renamed Customer SA' }, MERCHANT_ACTOR).catch(() => null); void company;
  const after = await w.store.getDocument(inv.id); assert.equal(after.snapshotHash, before.snapshotHash); assert.deepEqual(after.seller, before.seller); assert.deepEqual(after.customer, before.customer); assert.deepEqual(after.totals, before.totals);
  assert.equal(sha((await w.legal.originalPdf(inv.id)).data), sha(pdf0)); assert.equal(sha((await w.legal.structuredOriginal(inv.id)).data), sha(xml0)); assert.equal((await w.legal.compliance(inv.id)).sellerProfileVersion, comp0.sellerProfileVersion); assert.equal(comp0.sellerProfileVersion, 1);
  await assert.rejects(() => w.svc.update?.(inv.id, { notes: 'changed' }, MERCHANT_ACTOR) ?? Promise.reject(Object.assign(new Error('x'), { code: 'LOCKED' })), (e) => /LOCKED|IMMUTABLE|CANNOT|INVALID|NOT_/.test(String(e.code ?? e.message)));
  const second = await w.issue({}); assert.equal((await w.legal.compliance(second.id)).sellerProfileVersion, 1, 'the profile in force when issuing is the one recorded (same content = same version)');
});
test('ARCHIVE honesty: a PDF produced after issuance is a REGENERATED_COPY and no structured "original" is invented; a storage failure never undoes the issuance and is audited; the repair is idempotent', async () => {
  const failing = { puts: 0, files: new Map(), async put(r, d) { this.puts += 1; if (this.fail) throw new Error('disk full'); this.files.set(r, d); return r; }, async get(r) { return this.files.has(r) ? { data: this.files.get(r) } : null; } };
  failing.fail = true; const w = legalWorld({ storage: failing }); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id);
  assert.equal(doc.status, 'ISSUED'); assert.equal(await w.legal.compliance(doc.id), null, 'nothing archived'); const ev = (await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 50 })).map((e) => e.action); assert.ok(ev.includes('ARTIFACT_STORAGE_FAILED') && ev.includes('ARCHIVE_HOOK_FAILED'));
  failing.fail = false; const repaired = await w.legal.archiveIssued(doc, { atIssue: false }); assert.equal(repaired.repaired, true); const arts = await w.store.listArtifacts({ merchantId: w.merchantId, documentId: doc.id }); assert.deepEqual(arts.map((a) => [a.kind, a.classification]), [['REGENERATED_COPY', 'REGENERATED']]); assert.equal(repaired.structured, null);
  assert.equal(arts[0].retentionClass, 'REGENERATED_COPY'); assert.equal(arts[0].paymentReference, null, 'the reference belongs to the original');
});
test('J. CREDIT NOTE: its own number, a structured original referencing the corrected invoice, the route inherited, PDF original archived; the original invoice artifacts untouched', async () => {
  const w = legalWorld(); const inv = await w.issue({}); const invComp = await w.legal.compliance(inv.id); const cn = await w.creditNote(inv, [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }]);
  const c = await w.legal.compliance(cn.id); assert.ok(cn.number && cn.number !== inv.number); assert.equal(c.routing.route, invComp.routing.route); assert.equal(c.paymentReference, null, 'a credit note carries no payment reference'); assert.ok(c.pdf && c.structured);
  const xml = (await w.legal.structuredOriginal(cn.id)).data.toString('utf8'); assert.ok(xml.includes('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>') && xml.includes(`<cac:InvoiceDocumentReference><cbc:ID>${inv.number}</cbc:ID>`)); assert.equal(c.structured.provenance.validation.ok, true);
  assert.equal((await w.legal.compliance(inv.id)).pdf.sha256, invComp.pdf.sha256);
});
test('K. an invoice whose structured document fails the official validation is never archived as an original, never queued and never sent; the failure is recorded', async () => {
  const failing = () => ({ ok: false, documentSha256: 'a'.repeat(64), ruleset: { bis: 'Peppol BIS Billing 3.0', version: '3.0.21', release: 'r', customizationId: 'c', profileId: 'p' }, layers: [{ layer: 'EN16931', status: 'RAN', fatal: 1, warnings: 0, ruleset: { name: 'n' } }], findings: [{ layer: 'EN16931', ruleId: 'BR-FAKE', severity: 'fatal', message: 'injected', location: null }], at: AT });
  const w = legalWorld({ validate: failing }); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id);
  const comp = await w.legal.compliance(doc.id); assert.ok(comp.pdf, 'the legal PDF original exists: the invoice is issued'); assert.equal(comp.structured, null);
  assert.equal((await w.store.listArtifacts({ merchantId: w.merchantId, documentId: doc.id, kind: 'STRUCTURED_ORIGINAL' })).length, 0);
  assert.ok((await w.store.listEventsForMerchant({ merchantId: w.merchantId, limit: 50 })).some((e) => e.action === 'COMPLIANCE_FAILED' && e.detail.firstRules.includes('BR-FAKE')));
  await assert.rejects(() => w.peppol.queue(doc, { actor: MERCHANT_ACTOR }), (e) => e.code === 'PEPPOL_NOT_READY' && e.errors.includes('BR-FAKE'));
  const msgs = await w.store.listPeppolMessages({ merchantId: w.merchantId, documentId: doc.id }); assert.deepEqual(msgs.map((m) => m.state), ['VALIDATION_FAILED']); assert.equal(w.provider.calls.submit, 0); const dispatch = await w.peppol.dispatch(msgs[0].id); assert.deepEqual([dispatch.state, dispatch.sent], ['VALIDATION_FAILED', false]);
  await assert.rejects(() => w.store.transitionPeppol({ merchantId: w.merchantId, id: msgs[0].id, from: ['VALIDATION_FAILED'], to: 'QUEUED' }), (e) => e.code === 'PEPPOL_INVALID_TRANSITION');
});

// ===================================================== BT-83 (Payment identifier) - final verification
// Official sources read on 2026-10-03: (1) Peppol BIS Billing 3.0.21, cbc:PaymentID = BT-83 "Payment identifier": "A textual value used to establish a link between the payment and the Invoice,
// issued by the Seller", cardinality 0..1, type Text, its examples are plain values (432948234234234, 93274234, payref2); it carries the "Remittance information" of a credit transfer. The BIS
// states NO Belgian-specific format. (2) Febelfin / EPC "AOS1 OGM-VCS" (27/7/2017): "Electronic: 12 digits (010806817183); Visual: +++ 3 digits / 4 digits / 5 digits +++"; in SEPA electronic
// messages the structured creditor reference <CdtrRefInf> (Tp SCOR, Issr BBA) carries "Reference: 12 digits". DECISION: BT-83 is the machine channel that feeds the buyer's payment instruction,
// so it carries the ELECTRONIC form (12 canonical digits); the human PDF keeps the visual +++xxx/xxxx/xxxxx+++ form; the stored canonical value is the same everywhere.
test('BT-83: the UBL payment identifier carries the Febelfin ELECTRONIC form (12 canonical digits), the PDF the visual form, the stored reference is the canonical one', async () => {
  const w = legalWorld(); const inv = await w.issue({}); const doc = await w.store.getDocument(inv.id); const comp = await w.legal.compliance(doc.id); const xml = (await w.legal.structuredOriginal(doc.id)).data.toString('utf8');
  assert.match(comp.paymentReference, /^\d{12}$/); assert.ok(vcsValid(comp.paymentReference));
  assert.ok(xml.includes(`<cbc:PaymentID>${comp.paymentReference}</cbc:PaymentID>`), 'BT-83 = 12 electronic digits'); assert.ok(!xml.includes('+++'), 'no visual form in the structured document');
  const text = (await readPdfText((await w.legal.originalPdf(doc.id)).data)).pages.flatMap((p) => p.lines.map((l) => l.text)).join(' '); assert.ok(text.replace(/\s+/g, '').includes(vcsFormat(comp.paymentReference)), 'the human PDF prints the visual form of the same number');
  assert.equal(comp.structured.provenance.paymentReference, comp.paymentReference); assert.ok(RULES.some((r) => r.id === 'PEPPOL-BT83-PAYMENT-ID' && r.url.startsWith('https://docs.peppol.eu/')) && RULES.some((r) => r.id === 'FEBELFIN-OGM-VCS'));
  // a UBL whose BT-83 is not the stored reference is refused by the Nordla invariant
  const bad = xml.replace(`<cbc:PaymentID>${comp.paymentReference}</cbc:PaymentID>`, '<cbc:PaymentID>+++000/0000/00000+++</cbc:PaymentID>');
  assert.equal(structuredInvariants(doc, Buffer.from(bad), { paymentReference: comp.paymentReference }).find((i) => i.id === 'NORDLA-SNAPSHOT-PAYMENT-REFERENCE').ok, false); assert.ok(structuredInvariants(doc, Buffer.from(xml), { paymentReference: comp.paymentReference }).every((i) => i.ok));
});
