// Memory-store half of the legal-artifact / seller-version / Peppol-message tables (the same contract as migration 20261006090000, via legal-ledger.js).
// Synchronous bodies = atomic (checks first, commit last). Used by memory-store.js.

import { randomUUID } from 'node:crypto';
import { FinanceError } from './document.js';
import { DEFAULT_RETENTION, KEY_RE, artifactCollision, canTransition, checkArtifact } from './legal-ledger.js';

const clone = (o) => (o === undefined ? o : structuredClone(o));

export function createLegalMemory({ docs, supplierInvoices }) {
  const artifacts = []; const sellerVersions = []; const messages = [];
  const owns = (merchantId, a) => (!a.documentId || docs.get(a.documentId)?.merchantId === merchantId) && (!a.supplierInvoiceId || supplierInvoices.find((s) => s.id === a.supplierInvoiceId)?.merchantId === merchantId)
    && (!a.peppolMessageId || messages.find((m) => m.id === a.peppolMessageId)?.merchantId === merchantId) && (!a.parentArtifactId || artifacts.find((x) => x.id === a.parentArtifactId)?.merchantId === merchantId);
  const msg = (merchantId, id) => messages.find((m) => m.id === id && m.merchantId === merchantId);

  return {
    archiveArtifact(row) {
      const a = { id: randomUUID(), merchantId: row.merchantId, kind: row.kind, classification: row.classification, documentId: row.documentId ?? null, supplierInvoiceId: row.supplierInvoiceId ?? null, peppolMessageId: row.peppolMessageId ?? null, parentArtifactId: row.parentArtifactId ?? null,
        storageRef: row.storageRef, sha256: row.sha256, sizeBytes: row.sizeBytes, mediaType: row.mediaType, fileName: row.fileName ?? null, paymentReference: row.paymentReference ?? null, retentionClass: row.retentionClass ?? DEFAULT_RETENTION[row.kind], legalHold: false,
        provenance: clone(row.provenance ?? {}), createdAt: row.createdAt ?? new Date().toISOString() };
      checkArtifact(a);
      if (!owns(a.merchantId, a)) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'refused by the database');
      const hit = artifactCollision(artifacts, a);
      if (hit) {
        if (hit.by === 'PAYMENT_REFERENCE') throw new FinanceError('PAYMENT_REFERENCE_NOT_UNIQUE');
        if (hit.by === 'ORIGINAL' && hit.row.sha256 !== a.sha256) throw new FinanceError('ARTIFACT_ORIGINAL_EXISTS_WITH_OTHER_CONTENT');
        return { duplicate: true, artifact: clone(hit.row) };
      }
      artifacts.push(a); return { duplicate: false, artifact: clone(a) };
    },
    listArtifacts({ merchantId, documentId, supplierInvoiceId, peppolMessageId, kind } = {}) {
      return artifacts.filter((a) => a.merchantId === merchantId && (!documentId || a.documentId === documentId) && (!supplierInvoiceId || a.supplierInvoiceId === supplierInvoiceId) && (!peppolMessageId || a.peppolMessageId === peppolMessageId) && (!kind || a.kind === kind)).map(clone);
    },
    getArtifact(merchantId, id) { const a = artifacts.find((x) => x.id === id && x.merchantId === merchantId); return a ? clone(a) : null; },
    setLegalHold(merchantId, id, on) { const a = artifacts.find((x) => x.id === id && x.merchantId === merchantId); if (!a) throw new FinanceError('ARTIFACT_NOT_FOUND', id); a.legalHold = !!on; return clone(a); },
    /** There is no update or delete API for artifacts: immutability is structural here, like the trigger in PostgreSQL. */

    recordSellerProfile({ merchantId, profile, sha256, actor = null, at = null }) {
      if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new FinanceError('PROFILE_HASH_INVALID');
      const same = sellerVersions.find((v) => v.merchantId === merchantId && v.profileSha256 === sha256); if (same) return { duplicate: true, version: clone(same) };
      const version = Math.max(0, ...sellerVersions.filter((v) => v.merchantId === merchantId).map((v) => v.version)) + 1;
      const v = { id: randomUUID(), merchantId, version, profile: clone(profile), profileSha256: sha256, effectiveFrom: at ?? new Date().toISOString(), createdBy: clone(actor), createdAt: at ?? new Date().toISOString() };
      sellerVersions.push(v); return { duplicate: false, version: clone(v) };
    },
    listSellerProfileVersions(merchantId) { return sellerVersions.filter((v) => v.merchantId === merchantId).sort((a, b) => a.version - b.version).map(clone); },

    enqueuePeppol({ merchantId, documentId, key, sha256, provider, state = 'QUEUED', validation = null, sender = null, receiver = null, documentVersion = null, errorCode = null, at = null }) {
      if (!['QUEUED', 'VALIDATION_FAILED'].includes(state)) throw new FinanceError('PEPPOL_INVALID_INITIAL_STATE', state);
      if (!KEY_RE.test(key ?? '')) throw new FinanceError('IDEMPOTENCY_KEY_INVALID');
      if (docs.get(documentId)?.merchantId !== merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'refused by the database');
      const prior = messages.find((m) => m.merchantId === merchantId && m.direction === 'OUT' && m.documentId === documentId);
      if (prior) { if (prior.documentSha256 !== sha256) throw new FinanceError('PEPPOL_DOCUMENT_CHANGED', 'the logical document already has a message for other bytes'); return { duplicate: true, message: clone(prior) }; }
      if (messages.some((m) => m.merchantId === merchantId && m.direction === 'OUT' && m.idempotencyKey === key)) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key);
      const now = at ?? new Date().toISOString();
      const m = { id: randomUUID(), merchantId, direction: 'OUT', documentId, supplierInvoiceId: null, documentSha256: sha256, documentVersion, provider, providerMessageId: null, idempotencyKey: key, state, attempts: 0, senderEndpoint: sender, receiverEndpoint: receiver, businessKey: null, duplicateOf: null,
        validation: clone(validation), errorCode, queuedAt: state === 'QUEUED' ? now : null, lastAttemptAt: null, submittedAt: null, deliveredAt: null, receivedAt: null, createdAt: now, updatedAt: now };
      messages.push(m); return { duplicate: false, message: clone(m) };
    },
    transitionPeppol({ merchantId, id, from, to, patch = {}, at = null }) {
      const m = msg(merchantId, id); if (!m) throw new FinanceError('PEPPOL_MESSAGE_NOT_FOUND', String(id));
      if (!from.includes(m.state)) return { changed: false, message: clone(m) };
      if (m.state !== to && !canTransition(m.state, to)) throw new FinanceError('PEPPOL_INVALID_TRANSITION', `${m.state} -> ${to}`);
      const now = at ?? new Date().toISOString();
      if (to === 'SUBMITTING') { m.attempts += 1; m.lastAttemptAt = now; }
      if (to === 'QUEUED') m.queuedAt = now; if (to === 'SUBMITTED') m.submittedAt = now; if (to === 'DELIVERED') m.deliveredAt = now;
      if (patch.providerMessageId) m.providerMessageId = patch.providerMessageId;
      if ('errorCode' in patch) m.errorCode = patch.errorCode; else if (['SUBMITTED', 'DELIVERED', 'QUEUED', 'TO_REVIEW', 'ACCEPTED'].includes(to)) m.errorCode = null;
      if (patch.validation) m.validation = clone(patch.validation); if (patch.supplierInvoiceId) m.supplierInvoiceId = patch.supplierInvoiceId;
      m.state = to; m.updatedAt = now; return { changed: true, message: clone(m) };
    },
    registerInboundPeppol({ merchantId, provider, providerMessageId, key, sha256, sender = null, receiver = null, businessKey = null, validation = null, at = null }) {
      if (!KEY_RE.test(key ?? '')) throw new FinanceError('IDEMPOTENCY_KEY_INVALID');
      const ins = messages.filter((m) => m.merchantId === merchantId && m.direction === 'IN');
      const first = ins.filter((m) => m.state !== 'DUPLICATE').find((m) => (m.provider === provider && m.providerMessageId === providerMessageId) || m.documentSha256 === sha256 || (businessKey && m.businessKey === businessKey));
      const now = at ?? new Date().toISOString();
      const base = { merchantId, direction: 'IN', documentId: null, supplierInvoiceId: null, documentSha256: sha256, documentVersion: null, provider, attempts: 0, senderEndpoint: sender, receiverEndpoint: receiver, errorCode: null, queuedAt: null, lastAttemptAt: null, submittedAt: null, deliveredAt: null, receivedAt: now, createdAt: now, updatedAt: now };
      if (first) {
        const same = ins.find((m) => m.idempotencyKey === key); if (same) return { duplicate: true, message: clone(same), first: clone(first) };
        const d = { id: randomUUID(), ...base, providerMessageId: null, idempotencyKey: key, state: 'DUPLICATE', businessKey: null, duplicateOf: first.id, validation: null }; messages.push(d); return { duplicate: true, message: clone(d), first: clone(first) };
      }
      if (ins.some((m) => m.idempotencyKey === key)) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key);
      const m = { id: randomUUID(), ...base, providerMessageId, idempotencyKey: key, state: 'RECEIVED', businessKey, duplicateOf: null, validation: clone(validation) }; messages.push(m); return { duplicate: false, message: clone(m) };
    },
    getPeppolMessage(merchantId, id) { const m = msg(merchantId, id); return m ? clone(m) : null; },
    listPeppolMessages({ merchantId, direction, state, documentId } = {}) { return messages.filter((m) => m.merchantId === merchantId && (!direction || m.direction === direction) && (!state || m.state === state) && (!documentId || m.documentId === documentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone); },
  };
}
