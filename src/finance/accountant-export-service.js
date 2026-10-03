// Accountant Export service: READ-ONLY on the financial truths. It gathers the facts the other engines own (one read per source, never one per document), hands them to the pure
// builder (accountant-export.js) and, when a package is generated, records ONE audit event (fin_events: no new table) so the package is identifiable later.
// Treasury is deliberately not consulted: forecasts and scenarios are not accounting facts.

import { createHash } from 'node:crypto';
import { requireClock } from './civil-date.js';
import { documentFileName } from './pack-comptable.js';
import { EXPORT_ACTION, buildAccountantExport } from './accountant-export.js';
import { resolvePeriod } from './accountant-package.js';

const extOf = (contentType, fileName = '') => ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/xml': 'xml' }[contentType] ?? (/\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1]?.toLowerCase() ?? 'bin'));
const inRange = (d, a, b) => typeof d === 'string' && d >= a && d <= b;

/**
 * @param {{store: object, merchantId: string, finance: {listInvoices: Function}, inbox: {list: Function}, attachments?: {get: Function}, clock: {now: Function, today: Function, timeZone: string},
 *   merchant: {name?: string}, renderPdf?: (doc: object, ctx: object) => Promise<Buffer>, sourceSchemaVersion?: string, cashCurrency?: string}} d
 */
export function createAccountantExportService({ store, merchantId, finance, inbox, attachments = null, storage = attachments, clock, merchant = {}, renderPdf = null, sourceSchemaVersion = null, cashCurrency = 'EUR' }) {
  requireClock(clock, 'createAccountantExportService');
  if (!clock.timeZone) throw new TypeError('createAccountantExportService: the clock must expose the merchant timeZone');

  async function facts() {
    const [documents, suppliers, registry, allocations, bankAccounts, bankTransactions, reconciliations, cashCounts, cashMovements, legalArtifacts, peppolMessages] = await Promise.all([
      finance.listInvoices(), inbox.list(), store.listRegistry(merchantId), store.listAllocations({ merchantId }), store.listBankAccounts(merchantId), store.listBankTransactions({ merchantId }), store.listReconciliations({ merchantId }), store.listCashCounts(merchantId), store.listCashMovements(merchantId),
      store.listArtifacts({ merchantId }), store.listPeppolMessages({ merchantId })]);
    return { documents, suppliers, registry, allocations, bankAccounts, bankTransactions, reconciliations, cashCounts, cashMovements, legalArtifacts, peppolMessages };
  }

  /** Documents actually present, never fabricated: regenerated copies of issued PDFs (labelled as such) and the stored source files of purchases. */
  async function artifactsFor(f, period, includeDocuments) {
    const out = { sales: new Map(), credit_notes: new Map(), purchases: new Map(), structured: new Map(), inbound: new Map(), extra: [] }; const compliance = new Map();
    // what the legal archive really holds (durable metadata in fin_artifacts): originals are ORIGINALS, nothing else is relabelled
    const byDoc = new Map(); for (const a of f.legalArtifacts ?? []) if (a.documentId) (byDoc.get(a.documentId) ?? byDoc.set(a.documentId, []).get(a.documentId)).push(a);
    const messageOfSupplier = new Map((f.peppolMessages ?? []).filter((m) => m.direction === 'IN' && m.supplierInvoiceId && m.state !== 'DUPLICATE').map((m) => [m.supplierInvoiceId, m]));
    const inboundOf = new Map((f.legalArtifacts ?? []).filter((a) => a.kind === 'INBOUND_ORIGINAL').map((a) => [a.peppolMessageId, a]));
    // With documents requested, the stored bytes are READ BACK and hash-verified: an original that cannot be read or does not match its recorded SHA-256 is reported MISSING with the reason, never claimed as archived. (Preview stays metadata-only.)
    const entry = async (a, extra = {}) => {
      const base = { fileName: a.fileName, sha256: a.sha256, ...extra };
      if (!includeDocuments || !storage) return { status: 'ARCHIVED_ORIGINAL', data: null, ...base };
      const file = await storage.get(a.storageRef).catch(() => null);
      if (!file) return { status: 'MISSING', reason: 'ARTIFACT_BYTES_NOT_FOUND', data: null, ...base };
      if (createHash('sha256').update(file.data).digest('hex') !== a.sha256) return { status: 'MISSING', reason: 'ARTIFACT_HASH_MISMATCH', data: null, ...base };
      return { status: 'ARCHIVED_ORIGINAL', data: file.data, ...base };
    };
    for (const x of f.documents) {
      const { doc } = x; if (!doc.lockedAt || !['invoice', 'credit_note'].includes(doc.type) || !inRange(doc.issueDate, period.start, period.end)) continue;
      const arts = byDoc.get(doc.id) ?? []; const pdf = arts.find((a) => a.kind === 'PDF_ORIGINAL'); const st = arts.find((a) => a.kind === 'STRUCTURED_ORIGINAL'); const kind = doc.type === 'invoice' ? 'sales' : 'credit_notes';
      if (pdf) { out[kind].set(doc.id, await entry(pdf)); compliance.set(doc.id, { route: pdf.provenance?.routing?.route ?? null, paymentReference: pdf.paymentReference, validationOk: st ? true : null }); }
      if (st) { out.structured.set(doc.id, await entry(st)); if (!pdf) compliance.set(doc.id, { route: st.provenance?.routing?.route ?? null, paymentReference: st.provenance?.paymentReference ?? null, validationOk: true }); }
      if (!pdf && includeDocuments && renderPdf) { const data = await renderPdf(doc, x); const name = documentFileName({ date: doc.issueDate, party: doc.customer?.name, number: doc.number, grossCents: doc.totals?.grossCents, currency: doc.currency, ext: 'pdf' }).replace(/\.pdf$/, '_REGENERATED-COPY.pdf'); out[kind].set(doc.id, { status: 'REGENERATED_COPY', data, fileName: name }); }
    }
    for (const r of f.suppliers) { const m = messageOfSupplier.get(r.id); const a = m ? inboundOf.get(m.id) : null; if (a && inRange(r.issueDate, period.start, period.end)) { out.inbound.set(r.id, await entry(a, { fileName: `${r.id.slice(0, 8)}_${a.fileName}`, messageId: m.id }));
      for (const att of (f.legalArtifacts ?? []).filter((x) => x.kind === 'ATTACHMENT' && x.peppolMessageId === m.id)) out.extra.push(await entry(att, { fileName: `${r.id.slice(0, 8)}_${att.fileName}`, sourceId: r.id })); } }
    out.compliance = compliance; if (!includeDocuments) return out;
    if (attachments) {
      const rows = f.suppliers.filter((r) => r.attachmentRef && !out.inbound.has(r.id) && inRange(r.issueDate, period.start, period.end));
      for (let i = 0; i < rows.length; i += 8) await Promise.all(rows.slice(i, i + 8).map(async (r) => {
        const file = await attachments.get(r.attachmentRef).catch(() => null);
        if (!file) return out.purchases.set(r.id, { status: 'MISSING', reason: 'ATTACHMENT_FILE_NOT_FOUND' });
        const ext = extOf(r.contentType, r.fileName); const name = documentFileName({ date: r.issueDate, party: r.supplierName, number: r.invoiceNumber, grossCents: r.grossCents, currency: r.currency, ext });
        out.purchases.set(r.id, { status: 'ARCHIVED_ORIGINAL', data: file.data, fileName: `${r.id.slice(0, 8)}_${name}`, sha256: createHash('sha256').update(file.data).digest('hex') });
      }));
    }
    return out;
  }

  const periodOf = (spec) => resolvePeriod(spec);
  async function build(spec, { includeDocuments = false } = {}) {
    const period = periodOf(spec); const f = await facts(); const artifacts = await artifactsFor(f, period, includeDocuments);
    return buildAccountantExport({ merchant: { id: merchantId, name: merchant.name ?? null }, period, timeZone: clock.timeZone, generatedAt: clock.now(), ...f, artifacts, compliance: artifacts.compliance, reconciliations: f.reconciliations, sourceSchemaVersion, cashCurrency });
  }
  const summary = (b) => ({ period: b.manifest.period, rowCounts: b.rowCounts, warnings: b.warnings, missingArtifacts: b.manifest.missingArtifacts, pdfArchive: b.manifest.pdfArchive, currencies: b.manifest.currencies, totalsByCurrency: b.manifest.totalsByCurrency, contentFingerprint: b.contentFingerprint, files: b.manifest.files.map((x) => ({ path: x.path, rows: x.rows })) });

  return {
    /** What the package would contain (counts, warnings, missing artifacts). Writes nothing, builds no document files. */
    async preview(spec) { return summary(await build(spec, { includeDocuments: false })); },
    /** The package. One audit event identifies it (id, period, fingerprint, ZIP SHA-256); the package itself is never stored. */
    async generate(spec, { includeDocuments = true, actor = null } = {}) {
      const b = await build(spec, { includeDocuments });
      const record = { exportId: b.sha256.slice(0, 16), period: b.manifest.period, generatedAt: b.manifest.generatedAt, contentFingerprint: b.contentFingerprint, zipSha256: b.sha256, size: b.size, rowCounts: b.rowCounts, warnings: b.warnings.map((w) => ({ code: w.code, count: w.count })), includeDocuments };
      await store.appendEvent({ merchantId, documentId: null, at: b.manifest.generatedAt, actor, action: EXPORT_ACTION, detail: record });
      return { ...b, record, summary: summary(b) };
    },
    async history() { return (await store.listEventsForMerchant({ merchantId, limit: 1000 })).filter((e) => e.action === EXPORT_ACTION && e.detail).map((e) => e.detail).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))); },
  };
}
