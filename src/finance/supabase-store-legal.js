// Supabase half of the legal-artifact / seller-version / Peppol-message tables (migration 20261006090000). Same method names and results as memory-store-legal.js.
import { FinanceError } from './document.js';
import { DEFAULT_RETENTION, checkArtifact } from './legal-ledger.js';

const artFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, kind: r.kind, classification: r.classification, documentId: r.document_id ?? null, supplierInvoiceId: r.supplier_invoice_id ?? null, peppolMessageId: r.peppol_message_id ?? null, parentArtifactId: r.parent_artifact_id ?? null,
  storageRef: r.storage_ref, sha256: r.sha256, sizeBytes: Number(r.size_bytes), mediaType: r.media_type, fileName: r.file_name ?? null, paymentReference: r.payment_reference ?? null, retentionClass: r.retention_class, legalHold: r.legal_hold === true, provenance: r.provenance ?? {}, createdAt: r.created_at });
const verFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, version: Number(r.version), profile: r.profile, profileSha256: r.profile_sha256, effectiveFrom: r.effective_from, createdBy: r.created_by ?? null, createdAt: r.created_at });
export const messageFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, direction: r.direction, documentId: r.document_id ?? null, supplierInvoiceId: r.supplier_invoice_id ?? null, documentSha256: r.document_sha256, documentVersion: r.document_version ?? null, provider: r.provider, providerMessageId: r.provider_message_id ?? null,
  idempotencyKey: r.idempotency_key, state: r.state, attempts: Number(r.attempts), senderEndpoint: r.sender_endpoint ?? null, receiverEndpoint: r.receiver_endpoint ?? null, businessKey: r.business_key ?? null, duplicateOf: r.duplicate_of ?? null, validation: r.validation ?? null, errorCode: r.error_code ?? null,
  queuedAt: r.queued_at ?? null, lastAttemptAt: r.last_attempt_at ?? null, submittedAt: r.submitted_at ?? null, deliveredAt: r.delivered_at ?? null, receivedAt: r.received_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
const dupCode = (e) => /fin_artifacts_(pdf_original|structured_original|inbound_original|content)_uq/.test(String(e?.message ?? e));

export function legalStoreMethods(supabase, { merchantId, guard, eq }) {
  const out = {
    async archiveArtifact(row) {
      const a = { merchantId, ...row, retentionClass: row.retentionClass ?? DEFAULT_RETENTION[row.kind] }; checkArtifact({ ...a, documentId: a.documentId ?? null }); // same refusals as the table, before the round trip
      const toRow = { merchant_id: merchantId, kind: a.kind, classification: a.classification, document_id: a.documentId ?? null, supplier_invoice_id: a.supplierInvoiceId ?? null, peppol_message_id: a.peppolMessageId ?? null, parent_artifact_id: a.parentArtifactId ?? null, storage_ref: a.storageRef, sha256: a.sha256,
        size_bytes: a.sizeBytes, media_type: a.mediaType, file_name: a.fileName ?? null, payment_reference: a.paymentReference ?? null, retention_class: a.retentionClass, provenance: a.provenance ?? {}, ...(a.createdAt ? { created_at: a.createdAt } : {}) };
      try { const [r] = await guard(() => supabase.insert('fin_artifacts', [toRow])); return { duplicate: false, artifact: artFromRow(r) }; } catch (e) {
        if (!dupCode(e)) throw e;
        // the original (or the same bytes) already exists: an identical retry is a duplicate, other content for an original is refused
        const same = (await supabase.select('fin_artifacts', { select: '*', merchant_id: eq(merchantId), kind: eq(a.kind), ...(a.documentId ? { document_id: eq(a.documentId) } : a.peppolMessageId ? { peppol_message_id: eq(a.peppolMessageId) } : { supplier_invoice_id: eq(a.supplierInvoiceId) }) })).map(artFromRow);
        const hit = same.find((x) => x.sha256 === a.sha256); if (hit) return { duplicate: true, artifact: hit };
        throw new FinanceError('ARTIFACT_ORIGINAL_EXISTS_WITH_OTHER_CONTENT');
      }
    },
    async listArtifacts({ documentId, supplierInvoiceId, peppolMessageId, kind } = {}) {
      const p = { select: '*', merchant_id: eq(merchantId), order: 'created_at.asc,id.asc' }; if (documentId) p.document_id = eq(documentId); if (supplierInvoiceId) p.supplier_invoice_id = eq(supplierInvoiceId); if (peppolMessageId) p.peppol_message_id = eq(peppolMessageId); if (kind) p.kind = eq(kind);
      return (await supabase.selectAll('fin_artifacts', p)).map(artFromRow);
    },
    async getArtifact(_m, id) { const [r] = await supabase.select('fin_artifacts', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? artFromRow(r) : null; },
    async setLegalHold(_m, id, on) { const r = await guard(() => supabase.update('fin_artifacts', { id: eq(id), merchant_id: eq(merchantId) }, { legal_hold: !!on })); if (!r.length) throw new FinanceError('ARTIFACT_NOT_FOUND', id); return artFromRow(r[0]); },

    async recordSellerProfile({ profile, sha256, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_seller_profile_record', { p_merchant: merchantId, p_profile: profile, p_sha256: sha256, p_actor: actor, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, version: verFromRow(r.version) };
    },
    async listSellerProfileVersions() { return (await supabase.selectAll('fin_seller_profile_versions', { select: '*', merchant_id: eq(merchantId), order: 'version.asc' })).map(verFromRow); },

    async enqueuePeppol({ documentId, key, sha256, provider, state = 'QUEUED', validation = null, sender = null, receiver = null, documentVersion = null, errorCode = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_peppol_enqueue', { p_merchant: merchantId, p_document: documentId, p_key: key, p_sha256: sha256, p_provider: provider, p_state: state, p_validation: validation, p_sender: sender, p_receiver: receiver, p_doc_version: documentVersion, p_error: errorCode, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, message: messageFromRow(r.message) };
    },
    async transitionPeppol({ id, from, to, patch = {}, at = null }) {
      const r = await guard(() => supabase.rpc('fin_peppol_transition', { p_merchant: merchantId, p_id: id, p_from: from, p_to: to, p_patch: patch, p_at: at }));
      return { changed: r.changed === true, message: messageFromRow(r.message) };
    },
    async registerInboundPeppol({ provider, providerMessageId, key, sha256, sender = null, receiver = null, businessKey = null, validation = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_peppol_inbound_register', { p_merchant: merchantId, p_provider: provider, p_provider_message_id: providerMessageId, p_key: key, p_sha256: sha256, p_sender: sender, p_receiver: receiver, p_business_key: businessKey, p_validation: validation, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, message: messageFromRow(r.message), ...(r.first ? { first: messageFromRow(r.first) } : {}) };
    },
    async getPeppolMessage(_m, id) { const [r] = await supabase.select('fin_peppol_messages', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? messageFromRow(r) : null; },
    async listPeppolMessages({ direction, state, documentId } = {}) {
      const p = { select: '*', merchant_id: eq(merchantId), order: 'created_at.asc,id.asc' }; if (direction) p.direction = eq(direction); if (state) p.state = eq(state); if (documentId) p.document_id = eq(documentId);
      return (await supabase.selectAll('fin_peppol_messages', p)).map(messageFromRow);
    },
  };
  return out;
}
