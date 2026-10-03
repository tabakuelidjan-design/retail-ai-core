// Legal artifacts: what is archived at the moment a document is issued, byte for byte, and how it is read back.
//
//   Immutable issue snapshot (the document, hash-locked at issuance)  ->  PDF original  ->  structured original (UBL / Peppol BIS)   [ONE calculator: the structured document is built from the SAME snapshot]
//
// - The PDF bytes are kept EXACTLY as produced (SHA-256, renderer version, snapshot hash, timestamps) in the artifact storage behind storage_ref; fin_artifacts holds the durable, immutable metadata.
// - A PDF produced later is a REGENERATED_COPY, never an original: classification is decided by WHEN it was produced (at issuance or not), not by the caller's wish.
// - The structured original is archived only when it passed the official validation pipeline; the exact ruleset (BIS version, customization/profile ids, artifact hashes) is recorded with it.
// - The Belgian payment reference (VCS/OGM) is derived once from the legal number, stored on the PDF original, and read back by every other artifact and by the export; it is never regenerated.
// - Nothing here deletes anything. Retention is a classification per artifact (legal-ledger.js); no duration is hard-coded.

import { createHash } from 'node:crypto';
import { FinanceError } from './document.js';
import { PDF_RENDERER_VERSION } from './pdf.js';
import { buildUbl, endpointOf, validatePeppolReadiness } from './peppol.js';
import { CURRENT_PEPPOL_VERSION, artifactsFor, rulesetFor, validateStructured } from './peppol-validation.js';
import { STRUCTURED_ROUTES, determineInvoiceRoute, routingContextOf, vcsForInvoiceNumber, vcsFormat } from './belgium-compliance.js';
import { DEFAULT_RETENTION } from './legal-ledger.js';

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** Stable JSON (sorted keys): the same profile always hashes the same. */
export const canonicalJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const STRUCTURED_MEDIA_TYPE = 'application/xml';
const safe = (s) => String(s ?? 'document').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';

/**
 * @param {{store: object, merchantId: string, storage: {put: Function, get: Function}, clock: {now: Function}, renderPdf: (doc: object, ctx: object) => Promise<Buffer>,
 *   audit?: (e: object) => Promise<void>, defaultBuyerReference?: string|null, validate?: Function}} d
 */
export function createLegalArtifacts({ store, merchantId, storage, clock, renderPdf, audit = async () => {}, defaultBuyerReference = 'document_number', validate = validateStructured, peppolVersion = CURRENT_PEPPOL_VERSION }) {
  const event = (doc, action, detail, actor = { type: 'system', id: 'legal-artifacts' }) => store.appendEvent({ merchantId, documentId: doc?.id ?? null, at: clock.now(), actor, action, detail });
  const keyOf = (docId, kind, hash) => `${merchantId}/legal/${docId}/${kind}/${hash}`;

  /** The seller profile in force, as an immutable version (same content = same version). */
  async function recordSeller(profile, actor = null) {
    const r = await store.recordSellerProfile({ merchantId, profile, sha256: sha256(canonicalJson(profile)), actor, at: clock.now() });
    return r.version;
  }
  async function putBytes(docId, kind, data) { const ref = keyOf(docId, kind, sha256(data)); await storage.put(ref, data, { contentType: kind === 'pdf' ? 'application/pdf' : STRUCTURED_MEDIA_TYPE }); return ref; }

  const api = {
    recordSeller,
    /** Route decision from the issued snapshot (+ explicit agreement / original route for a credit note). */
    async routeOf(doc, { agreement = null, buyerFacts = {} } = {}) {
      let originalInvoiceRoute = null;
      if (doc.type === 'credit_note' && doc.relatedDocumentId) originalInvoiceRoute = (await api.compliance(doc.relatedDocumentId))?.routing?.route ?? null;
      return determineInvoiceRoute(routingContextOf(doc, { agreement, originalInvoiceRoute, buyerFacts }));
    },
    /** The compliance record of an issued document: read back from its archived PDF original (routing, reference, seller version), never recomputed. */
    async compliance(documentId) {
      const pdf = (await store.listArtifacts({ merchantId, documentId, kind: 'PDF_ORIGINAL' }))[0] ?? null;
      const structured = (await store.listArtifacts({ merchantId, documentId, kind: 'STRUCTURED_ORIGINAL' }))[0] ?? null; if (!pdf && !structured) return null;
      if (!pdf) return { documentId, routing: structured.provenance.routing ?? null, paymentReference: structured.provenance.paymentReference ?? null, sellerProfileVersion: null, snapshotHash: structured.provenance.snapshotHash ?? null, pdf: null, structured, validation: structured.provenance.validation ?? null };
      return { documentId, routing: pdf.provenance.routing ?? null, paymentReference: pdf.paymentReference, sellerProfileVersion: pdf.provenance.sellerProfileVersion ?? null, snapshotHash: pdf.provenance.snapshotHash ?? null, pdf, structured, validation: structured?.provenance?.validation ?? pdf.provenance.structuredValidation ?? null };
    },

    /**
     * Archive an issued document. Idempotent: an original that already exists is returned, never re-rendered (PDF bytes are not deterministic and an original never changes).
     * atIssue=true  -> ORIGINAL artifacts (called right after issuance).   atIssue=false -> a PDF is a REGENERATED_COPY (a repair long after issuance) and no structured "original" is invented.
     */
    async archiveIssued(doc, { atIssue = true, originalNumber = null, settlement = null, branding = {}, agreement = null, attachments = [], sellerProfile = doc.seller, actor = null } = {}) {
      if (!doc?.lockedAt || !doc.number || !['invoice', 'credit_note'].includes(doc.type)) throw new FinanceError('ONLY_ISSUED_INVOICES_AND_CREDIT_NOTES_ARE_ARCHIVED');
      if (doc.merchantId !== merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', doc.id);
      const existing = await api.compliance(doc.id);
      if (existing?.pdf) return { ...existing, duplicate: true };
      const version = await recordSeller(sellerProfile, actor); const route = await api.routeOf(doc, { agreement });
      const reference = doc.type === 'invoice' ? vcsForInvoiceNumber(doc.number) : null; const printed = reference ? vcsFormat(reference) : null;
      const at = clock.now();
      const provenance = { source: atIssue ? 'issue' : 'repair', rendererVersion: PDF_RENDERER_VERSION, snapshotHash: doc.snapshotHash, documentNumber: doc.number, issuedAt: doc.lockedAt, archivedAt: at, routing: route, sellerProfileVersion: version.version, sellerProfileSha256: version.profileSha256, paymentReference: reference };
      // 1. the human PDF, from the snapshot, bytes kept as they are
      const pdfBytes = await renderPdf(doc, { settlement, originalNumber, branding, paymentReference: printed });
      let ref; try { ref = await putBytes(doc.id, 'pdf', pdfBytes); } catch (e) { await event(doc, 'ARTIFACT_STORAGE_FAILED', { kind: 'PDF', error: String(e.message).slice(0, 120) }, actor ?? undefined); throw new FinanceError('ARTIFACT_STORAGE_FAILED', 'the document stays issued; archive it again'); }
      const kind = atIssue ? 'PDF_ORIGINAL' : 'REGENERATED_COPY';
      let pdf; try { pdf = await store.archiveArtifact({ merchantId, kind, classification: atIssue ? 'ORIGINAL' : 'REGENERATED', documentId: doc.id, storageRef: ref, sha256: sha256(pdfBytes), sizeBytes: pdfBytes.length, mediaType: 'application/pdf', fileName: `${safe(doc.number)}.pdf`, paymentReference: atIssue ? reference : null, retentionClass: DEFAULT_RETENTION[kind], provenance, createdAt: at }); } catch (e) { if (e.code === 'ARTIFACT_ORIGINAL_EXISTS_WITH_OTHER_CONTENT' || e.code === 'PAYMENT_REFERENCE_NOT_UNIQUE') { const won = await api.compliance(doc.id); if (won?.pdf) return { ...won, duplicate: true }; } throw e; } // a concurrent worker archived the original first: that one is THE original
      await event(doc, 'ARTIFACT_ARCHIVED', { kind, artifactId: pdf.artifact.id, sha256: pdf.artifact.sha256, route: route.route }, actor ?? undefined);
      if (!atIssue) return { documentId: doc.id, routing: route, paymentReference: reference, pdf: pdf.artifact, structured: null, validation: null, duplicate: false, repaired: true };
      // 2. the structured original, from the SAME snapshot, only when the route asks for one and only if the official validation passes
      let structured = null; let validation = null;
      if (STRUCTURED_ROUTES.includes(route.route)) ({ structured, validation } = await api.archiveStructured(doc, { route, reference, printed, originalNumber, attachments, parentArtifactId: pdf.artifact.id, source: 'issue', actor }));
      await event(doc, 'ISSUE_COMPLIANCE_RECORDED', { route: route.route, reasons: route.reasons, missingFacts: route.missingFacts, paymentReference: reference, pdfArtifactId: pdf.artifact.id, structuredArtifactId: structured?.id ?? null, sellerProfileVersion: version.version }, actor ?? undefined);
      await audit({ at, action: 'DOCUMENT_ARCHIVED', documentId: doc.id });
      return { documentId: doc.id, routing: route, paymentReference: reference, pdf: pdf.artifact, structured, validation, sellerProfileVersion: version.version, duplicate: false };
    },


    /**
     * Build the structured document from the issue snapshot, validate it with the OFFICIAL artifacts and archive it as the STRUCTURED_ORIGINAL (once). Used at issuance and, for a document issued before
     * archiving existed, at the moment the first structured document is actually produced (provenance.source tells which). Never archives a document that failed validation.
     */
    async archiveStructured(doc, { route = null, reference = null, printed = null, originalNumber = null, attachments = [], parentArtifactId = null, source = 'send_time', actor = null } = {}) {
      if (doc.merchantId !== merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', doc.id);
      const existing = (await store.listArtifacts({ merchantId, documentId: doc.id, kind: 'STRUCTURED_ORIGINAL' }))[0]; if (existing) return { structured: existing, validation: existing.provenance?.validation ?? null, duplicate: true, route: existing.provenance?.routing ?? route };
      route ??= await api.routeOf(doc); if (reference === null && doc.type === 'invoice') { reference = vcsForInvoiceNumber(doc.number); } if (printed === null && reference) printed = vcsFormat(reference);
      const at = clock.now(); let structured = null; let validation = null;
      const opts = { originalNumber, defaultBuyerReference, paymentReference: printed, attachments };
      const readiness = validatePeppolReadiness(doc, opts);
      if (readiness.length) { validation = { ok: false, stage: 'READINESS', errors: readiness, at }; await event(doc, 'COMPLIANCE_FAILED', { stage: 'READINESS', errors: readiness }, actor ?? undefined); return { structured, validation, duplicate: false, route }; }
      const xml = Buffer.from(buildUbl(doc, opts), 'utf8');
      const result = validate(xml, { version: peppolVersion, at, expectedType: doc.type === 'credit_note' ? 'CreditNote' : 'Invoice', invariants: structuredInvariants(doc, xml) });
      validation = summarize(result);
      if (!result.ok) { await event(doc, 'COMPLIANCE_FAILED', { stage: 'VALIDATION', bis: peppolVersion, fatal: validation.fatal, firstRules: validation.findings.slice(0, 5).map((f) => f.ruleId), documentSha256: result.documentSha256 }, actor ?? undefined); return { structured, validation, duplicate: false, route }; }
      const sref = await putBytes(doc.id, 'ubl', xml); const rs = rulesetFor(peppolVersion);
      try { structured = (await store.archiveArtifact({ merchantId, kind: 'STRUCTURED_ORIGINAL', classification: 'ORIGINAL', documentId: doc.id, parentArtifactId, storageRef: sref, sha256: sha256(xml), sizeBytes: xml.length, mediaType: STRUCTURED_MEDIA_TYPE, fileName: `${safe(doc.number)}.xml`, retentionClass: DEFAULT_RETENTION.STRUCTURED_ORIGINAL,
        provenance: { source, syntax: 'UBL 2.1', snapshotHash: doc.snapshotHash, documentNumber: doc.number, createdAt: at, paymentReference: reference, ruleset: { bis: rs.bis, version: rs.version, release: rs.release, customizationId: rs.customizationId, profileId: rs.profileId, artifacts: artifactsFor(peppolVersion).meta?.compiled ?? null, sources: artifactsFor(peppolVersion).meta?.schematronSources ?? null }, validation, routing: route }, createdAt: at })).artifact; } catch (e) { if (e.code !== 'ARTIFACT_ORIGINAL_EXISTS_WITH_OTHER_CONTENT') throw e; const won = (await store.listArtifacts({ merchantId, documentId: doc.id, kind: 'STRUCTURED_ORIGINAL' }))[0]; return { structured: won, validation: won?.provenance?.validation ?? null, duplicate: true, route: won?.provenance?.routing ?? route }; }
      await event(doc, 'ARTIFACT_ARCHIVED', { kind: 'STRUCTURED_ORIGINAL', artifactId: structured.id, sha256: structured.sha256, bis: rs.version }, actor ?? undefined);
      await event(doc, 'COMPLIANCE_VALIDATED', { bis: rs.version, layers: validation.layers, route: route.route }, actor ?? undefined);
      return { structured, validation, duplicate: false, route };
    },

    /** Exact bytes of an artifact, with the integrity check (storage can lose or alter a file: that is detected, not hidden). */
    async read(artifactId) {
      const a = await store.getArtifact(merchantId, artifactId); if (!a) throw new FinanceError('ARTIFACT_NOT_FOUND', String(artifactId));
      const f = await storage.get(a.storageRef); if (!f) return { artifact: a, data: null, verified: false, problem: 'STORAGE_OBJECT_MISSING' };
      const ok = sha256(f.data) === a.sha256; return { artifact: a, data: f.data, verified: ok, problem: ok ? null : 'HASH_MISMATCH' };
    },
    async originalPdf(documentId) { const a = (await store.listArtifacts({ merchantId, documentId, kind: 'PDF_ORIGINAL' }))[0]; if (!a) throw new FinanceError('ARTIFACT_NOT_FOUND', 'no original PDF archived for this document'); return api.read(a.id); },
    async structuredOriginal(documentId) { const a = (await store.listArtifacts({ merchantId, documentId, kind: 'STRUCTURED_ORIGINAL' }))[0]; if (!a) throw new FinanceError('ARTIFACT_NOT_FOUND', 'no structured original archived for this document'); return api.read(a.id); },
  };
  return api;
}

/** Nordla business invariants on the structured document (NOT Peppol rules): the amounts in the XML are exactly the issue snapshot's. */
export function structuredInvariants(doc, xml) {
  const text = xml.toString('utf8'); const cents = (n) => (n / 100).toFixed(2);
  const has = (tag, value) => new RegExp(`<cbc:${tag}[^>]*>${value}</cbc:${tag}>`).test(text);
  const payable = doc.totals.grossCents + (doc.totals.roundingCents ?? 0);
  return [
    { id: 'NORDLA-SNAPSHOT-NUMBER', ok: has('ID', doc.number.replace(/&/g, '&amp;')), message: 'document number differs from the issue snapshot' },
    { id: 'NORDLA-SNAPSHOT-NET', ok: has('LineExtensionAmount currencyID="' + doc.currency + '"', cents(doc.totals.netCents)) || new RegExp(`LineExtensionAmount currencyID="${doc.currency}">${cents(doc.totals.netCents)}<`).test(text), message: 'net total differs from the issue snapshot' },
    { id: 'NORDLA-SNAPSHOT-GROSS', ok: new RegExp(`TaxInclusiveAmount currencyID="${doc.currency}">${cents(doc.totals.grossCents)}<`).test(text), message: 'gross total differs from the issue snapshot' },
    { id: 'NORDLA-SNAPSHOT-PAYABLE', ok: new RegExp(`PayableAmount currencyID="${doc.currency}">${cents(payable)}<`).test(text), message: 'payable amount differs from the issue snapshot' },
    { id: 'NORDLA-SNAPSHOT-VAT', ok: new RegExp(`<cac:TaxTotal><cbc:TaxAmount currencyID="${doc.currency}">${cents(doc.totals.vatCents)}<`).test(text), message: 'VAT total differs from the issue snapshot' },
  ];
}
/** A compact, storable, UI-ready view of a validation result (full findings kept, bounded). */
export function summarize(r) {
  return { ok: r.ok, at: r.at, documentSha256: r.documentSha256, ruleset: { bis: r.ruleset.bis, version: r.ruleset.version, release: r.ruleset.release, customizationId: r.ruleset.customizationId, profileId: r.ruleset.profileId },
    layers: r.layers.map((l) => ({ layer: l.layer, status: l.status, fatal: l.fatal, warnings: l.warnings, ruleset: l.ruleset?.name ?? null, artifactSha256: l.ruleset?.artifactSha256 ?? null })), fatal: r.findings.filter((f) => f.severity === 'fatal').length, warnings: r.findings.filter((f) => f.severity === 'warning').length,
    findings: r.findings.slice(0, 50).map((f) => ({ layer: f.layer, ruleId: f.ruleId, severity: f.severity, message: String(f.message).slice(0, 300), location: f.location ? String(f.location).slice(0, 200) : null })) };
}
export { endpointOf };
