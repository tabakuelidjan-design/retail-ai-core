// Pure rules of the legal-artifact and Peppol-message tables (twin of migration 20261006090000, same rules, same error codes). The database is the authority;
// this module lets the memory store honour the identical contract. No I/O.

import { FinanceError } from './document.js';
import { vcsValid } from './belgium-compliance.js';

export const ARTIFACT_KINDS = ['PDF_ORIGINAL', 'STRUCTURED_ORIGINAL', 'INBOUND_ORIGINAL', 'ATTACHMENT', 'REGENERATED_COPY'];
export const RETENTION_CLASSES = ['FISCAL_DOCUMENT', 'SUPPORTING_DOCUMENT', 'TECHNICAL', 'REGENERATED_COPY'];
/** Retention is a CLASSIFICATION per artifact type; no duration is hard-coded here and nothing is ever deleted automatically (legal duration depends on the document and the situation). */
export const DEFAULT_RETENTION = { PDF_ORIGINAL: 'FISCAL_DOCUMENT', STRUCTURED_ORIGINAL: 'FISCAL_DOCUMENT', INBOUND_ORIGINAL: 'FISCAL_DOCUMENT', ATTACHMENT: 'SUPPORTING_DOCUMENT', REGENERATED_COPY: 'REGENERATED_COPY' };

export const OUT_STATES = ['QUEUED', 'SUBMITTING', 'SUBMITTED', 'DELIVERED', 'VALIDATION_FAILED', 'SUBMISSION_FAILED', 'DELIVERY_FAILED'];
export const IN_STATES = ['RECEIVED', 'TO_REVIEW', 'ACCEPTED', 'REJECTED', 'VALIDATION_FAILED', 'DUPLICATE'];
const TRANSITIONS = new Set(['QUEUED>SUBMITTING', 'SUBMITTING>SUBMITTED', 'SUBMITTING>SUBMISSION_FAILED', 'SUBMISSION_FAILED>QUEUED', 'SUBMITTED>DELIVERED', 'SUBMITTED>DELIVERY_FAILED', 'SUBMITTING>QUEUED',
  'RECEIVED>TO_REVIEW', 'RECEIVED>VALIDATION_FAILED', 'VALIDATION_FAILED>TO_REVIEW', 'TO_REVIEW>ACCEPTED', 'TO_REVIEW>REJECTED', 'RECEIVED>DUPLICATE']);
export const canTransition = (from, to) => TRANSITIONS.has(`${from}>${to}`);
export const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

/** Mirror of the fin_artifacts constraints. Throws a FinanceError. */
export function checkArtifact(a) {
  if (!ARTIFACT_KINDS.includes(a.kind)) throw new FinanceError('ARTIFACT_KIND_INVALID', String(a.kind));
  if ((a.kind === 'REGENERATED_COPY') !== (a.classification === 'REGENERATED')) throw new FinanceError('ARTIFACT_CLASSIFICATION_INVALID', 'an original is never REGENERATED and a regenerated copy is never an ORIGINAL');
  if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) throw new FinanceError('ARTIFACT_HASH_INVALID');
  if (!Number.isInteger(a.sizeBytes) || a.sizeBytes < 0) throw new FinanceError('ARTIFACT_SIZE_INVALID');
  if (!a.storageRef) throw new FinanceError('ARTIFACT_STORAGE_REF_REQUIRED');
  if (!a.documentId && !a.supplierInvoiceId && !a.peppolMessageId) throw new FinanceError('ARTIFACT_OWNER_REQUIRED');
  if (a.paymentReference != null) { if (!vcsValid(a.paymentReference)) throw new FinanceError('PAYMENT_REFERENCE_INVALID', 'not a valid VCS/OGM (12 digits, mod 97)'); if (a.kind !== 'PDF_ORIGINAL') throw new FinanceError('PAYMENT_REFERENCE_ONLY_ON_PDF_ORIGINAL'); }
}
export const ownerOf = (a) => a.documentId ?? a.supplierInvoiceId ?? a.peppolMessageId;
/** The unique indexes of fin_artifacts as a predicate: which existing artifact does a new one collide with? */
export function artifactCollision(existing, a) {
  const same = existing.filter((x) => x.merchantId === a.merchantId);
  if (a.kind === 'PDF_ORIGINAL') { const c = same.find((x) => x.kind === 'PDF_ORIGINAL' && x.documentId === a.documentId); if (c) return { by: 'ORIGINAL', row: c }; }
  if (a.kind === 'STRUCTURED_ORIGINAL') { const c = same.find((x) => x.kind === 'STRUCTURED_ORIGINAL' && x.documentId === a.documentId); if (c) return { by: 'ORIGINAL', row: c }; }
  if (a.kind === 'INBOUND_ORIGINAL') { const c = same.find((x) => x.kind === 'INBOUND_ORIGINAL' && x.peppolMessageId === a.peppolMessageId); if (c) return { by: 'ORIGINAL', row: c }; }
  if (a.paymentReference) { const c = same.find((x) => x.paymentReference === a.paymentReference); if (c) return { by: 'PAYMENT_REFERENCE', row: c }; }
  const c = same.find((x) => x.kind === a.kind && x.sha256 === a.sha256 && ownerOf(x) === ownerOf(a)); if (c) return { by: 'CONTENT', row: c };
  return null;
}
