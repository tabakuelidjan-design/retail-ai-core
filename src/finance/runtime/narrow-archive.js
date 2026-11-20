// PILOT: database side of the legal archive on the archive role (least privilege). Same methods, same results and same refusals as
// legalStoreMethods (supabase-store-legal.js) for the calls the archive makes: archiveArtifact, listArtifacts, getArtifact,
// recordSellerProfile, appendEvent. The PDF/XML bytes are NOT handled here: they stay in the existing Supabase Storage bucket.
//
// Rules: the merchant comes from the bound login (the database refuses any other), every call runs in a transaction on the archive
// role, no fallback to the service client, and a failure is thrown as it is (translated the same way as the service store).

import { FinanceError } from '../document.js';
import { DEFAULT_RETENTION, checkArtifact } from '../legal-ledger.js';
import { artFromRow, verFromRow } from '../supabase-store-legal.js';
import { translateDbError } from '../supabase-store.js';

export const PILOT_ARCHIVE_ROLE = 'nordla_fin_archive_pilot';
const DUP = /fin_artifacts_(pdf_original|structured_original|inbound_original|content)_uq/;
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * @param {{ transaction: (run: (client) => Promise<any>) => Promise<any>, merchantId: string }} d  transaction runs `run` on the archive role
 */
export function createNarrowArchive({ transaction, merchantId }) {
  if (typeof transaction !== 'function') throw new TypeError('an archive transaction is required');
  const tx = async (run) => {
    try { return await transaction(run); } catch (e) { throw translateDbError(e); }
  };
  const findSame = async (c, a) => {
    const col = a.documentId ? 'document_id' : a.peppolMessageId ? 'peppol_message_id' : 'supplier_invoice_id';
    const val = a.documentId ?? a.peppolMessageId ?? a.supplierInvoiceId;
    return (await c.query(`select * from public.fin_artifacts where merchant_id = $1 and kind = $2 and ${col} = $3`, [merchantId, a.kind, val])).rows.map(artFromRow);
  };

  return {
    async archiveArtifact(row) {
      // a row that names another merchant is refused (never silently re-written to the bound merchant)
      if (row.merchantId != null && row.merchantId !== merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'the artifact names another merchant');
      const a = { ...row, merchantId, retentionClass: row.retentionClass ?? DEFAULT_RETENTION[row.kind] };
      checkArtifact({ ...a, documentId: a.documentId ?? null }); // same refusals as the table, before the round trip
      const params = [merchantId, a.kind, a.classification, a.documentId ?? null, a.supplierInvoiceId ?? null, a.peppolMessageId ?? null, a.parentArtifactId ?? null,
        a.storageRef, a.sha256, a.sizeBytes, a.mediaType, a.fileName ?? null, a.paymentReference ?? null, a.retentionClass, json(a.provenance ?? {})];
      const cols = 'merchant_id, kind, classification, document_id, supplier_invoice_id, peppol_message_id, parent_artifact_id, storage_ref, sha256, size_bytes, media_type, file_name, payment_reference, retention_class, provenance';
      // the effective database role is recorded in the same transaction (trace of who wrote the row; no secret, no client content)
      const vals = "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,($15::jsonb || jsonb_build_object('writtenByRole', current_user::text))";
      const sql = a.createdAt
        ? `insert into public.fin_artifacts (${cols}, created_at) values (${vals}, $16) returning *`
        : `insert into public.fin_artifacts (${cols}) values (${vals}) returning *`;
      try {
        const r = await tx((c) => c.query(sql, a.createdAt ? [...params, a.createdAt] : params));
        return { duplicate: false, artifact: artFromRow(r.rows[0]) };
      } catch (e) {
        if (!DUP.test(String(e?.message ?? e))) throw e;
        // the original (or the same bytes) already exists: an identical retry is a duplicate, other content for an original is refused
        const same = await tx((c) => findSame(c, a));
        const hit = same.find((x) => x.sha256 === a.sha256);
        if (hit) return { duplicate: true, artifact: hit };
        throw new FinanceError('ARTIFACT_ORIGINAL_EXISTS_WITH_OTHER_CONTENT');
      }
    },

    async listArtifacts({ documentId, supplierInvoiceId, peppolMessageId, kind } = {}) {
      return tx(async (c) => {
        const where = ['merchant_id = $1']; const p = [merchantId];
        const add = (col, v) => { if (v) { p.push(v); where.push(`${col} = $${p.length}`); } };
        add('document_id', documentId); add('supplier_invoice_id', supplierInvoiceId); add('peppol_message_id', peppolMessageId); add('kind', kind);
        return (await c.query(`select * from public.fin_artifacts where ${where.join(' and ')} order by created_at asc, id asc`, p)).rows.map(artFromRow);
      });
    },

    async getArtifact(_m, id) {
      return tx(async (c) => { const r = (await c.query('select * from public.fin_artifacts where id = $1 and merchant_id = $2', [id, merchantId])).rows[0]; return r ? artFromRow(r) : null; });
    },

    async recordSellerProfile({ profile, sha256, actor = null, at = null }) {
      const r = await tx(async (c) => (await c.query('select public.fin_seller_profile_record($1::uuid, $2::jsonb, $3::text, $4::jsonb, $5::timestamptz) as r',
        [merchantId, json(profile), sha256, json(actor), at])).rows[0].r);
      return { duplicate: r.duplicate === true, version: verFromRow(r.version) };
    },

    async appendEvent(e) {
      await tx((c) => c.query('insert into public.fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb)',
        [e.merchantId ?? merchantId, e.documentId ?? null, e.at, json(e.actor), e.action, e.fromStatus ?? null, e.toStatus ?? null, json(e.detail ?? null)]));
    },
  };
}
