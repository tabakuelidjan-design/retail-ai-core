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
export function createAccountantExportService({ store, merchantId, finance, inbox, attachments = null, clock, merchant = {}, renderPdf = null, sourceSchemaVersion = null, cashCurrency = 'EUR' }) {
  requireClock(clock, 'createAccountantExportService');
  if (!clock.timeZone) throw new TypeError('createAccountantExportService: the clock must expose the merchant timeZone');

  async function facts() {
    const [documents, suppliers, registry, allocations, bankAccounts, bankTransactions, reconciliations, cashCounts, cashMovements] = await Promise.all([
      finance.listInvoices(), inbox.list(), store.listRegistry(merchantId), store.listAllocations({ merchantId }), store.listBankAccounts(merchantId), store.listBankTransactions({ merchantId }), store.listReconciliations({ merchantId }), store.listCashCounts(merchantId), store.listCashMovements(merchantId)]);
    return { documents, suppliers, registry, allocations, bankAccounts, bankTransactions, reconciliations, cashCounts, cashMovements };
  }

  /** Documents actually present, never fabricated: regenerated copies of issued PDFs (labelled as such) and the stored source files of purchases. */
  async function artifactsFor(f, period, includeDocuments) {
    const out = { sales: new Map(), credit_notes: new Map(), purchases: new Map() }; if (!includeDocuments) return out;
    const used = new Set(); const unique = (n) => { let x = n; let k = 2; while (used.has(x)) x = n.replace(/(\.[^.]+)$/, `_${k++}$1`); used.add(x); return x; };
    if (renderPdf) for (const x of f.documents) {
      const { doc } = x; if (!doc.lockedAt || !['invoice', 'credit_note'].includes(doc.type) || !inRange(doc.issueDate, period.start, period.end)) continue;
      const data = await renderPdf(doc, x); const name = documentFileName({ date: doc.issueDate, party: doc.customer?.name, number: doc.number, grossCents: doc.totals?.grossCents, currency: doc.currency, ext: 'pdf' }).replace(/\.pdf$/, '_REGENERATED-COPY.pdf');
      out[doc.type === 'invoice' ? 'sales' : 'credit_notes'].set(doc.id, { status: 'REGENERATED_COPY', data, fileName: unique(name) });
    }
    if (attachments) {
      const rows = f.suppliers.filter((r) => r.attachmentRef && inRange(r.issueDate, period.start, period.end));
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
    return buildAccountantExport({ merchant: { id: merchantId, name: merchant.name ?? null }, period, timeZone: clock.timeZone, generatedAt: clock.now(), ...f, artifacts, sourceSchemaVersion, cashCurrency });
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
