// Finance Inbox + Purchases (supplier invoices). One record per incoming financial document, moving through
//   RECEIVED -> TO_REVIEW -> VALIDATED -> TO_PAY -> PAID          (or REJECTED when it is not an invoice)
//
// Principles:
//   - Only finance-specific documents enter. Nothing here reads a mailbox: sources are ADAPTERS (upload today; a dedicated finance mailbox
//     and Peppol later) and a mail adapter must pass `filterFinanceMessage` (addressed to the finance address, optional sender allow-list).
//   - Attachments live in a PRIVATE store (no public URL, tenant-scoped path, served only to an authenticated session).
//   - Extraction never decides: every field carries a confidence and the source document stays attached; a person validates.
//   - No bookkeeping classification. Amounts are integer cents and net + VAT must equal the total before a document can be validated.

import { createHash } from 'node:crypto';
import { FinanceError } from './document.js';
import { toCents } from './money.js';
import { eurOfSupplier } from './currency.js';
import { CAPTURE_MAX_BYTES, CAPTURE_ORIGINS, expenseValidationErrors, imageToPdf, isCapturedExpense, normalizeCaptureMeta } from './expense-capture.js';

export const INBOX_STATUSES = ['RECEIVED', 'TO_REVIEW', 'VALIDATED', 'TO_PAY', 'PAID', 'REJECTED'];
export const INBOX_SOURCES = ['upload', 'email', 'peppol', 'manual'];
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
/** Allowed changes of status. PAID and REJECTED are final. */
export const INBOX_TRANSITIONS = { RECEIVED: ['TO_REVIEW', 'REJECTED'], TO_REVIEW: ['VALIDATED', 'REJECTED'], VALIDATED: ['TO_PAY', 'TO_REVIEW', 'REJECTED'], TO_PAY: ['PAID', 'TO_REVIEW'], PAID: [], REJECTED: [] };

// ---------- file sniffing: the declared type is never trusted ----------
export function sniffType(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.subarray(0, 200).toString('utf8').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<Invoice') || head.startsWith('<CreditNote')) return 'application/xml';
  return null;
}
const safeName = (n) => String(n ?? 'document').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'document';

// ---------- source filter: only finance-specific messages may enter ----------
/**
 * A mailbox adapter must run every message through this before anything is stored.
 * Accept only when the message is addressed to the dedicated finance address (To / Delivered-To) and, if an allow-list is set, sent by an allowed sender.
 */
export function filterFinanceMessage(msg, { financeAddress, allowedSenders = [] }) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const addr = norm(financeAddress);
  if (!addr) return { accept: false, reason: 'FINANCE_ADDRESS_NOT_CONFIGURED' };
  const to = [].concat(msg.to ?? [], msg.deliveredTo ?? []).map(norm);
  if (!to.some((t) => t === addr || t.endsWith(`<${addr}>`))) return { accept: false, reason: 'NOT_ADDRESSED_TO_FINANCE' };
  if (allowedSenders.length && !allowedSenders.map(norm).includes(norm(msg.from))) return { accept: false, reason: 'SENDER_NOT_ALLOWED' };
  return { accept: true, reason: null };
}

// ---------- extraction ----------
export const NoExtractor = { name: 'none', label: 'Aucune extraction automatique', async extract() { return { extractor: 'none', fields: {}, warnings: [] }; } };

const tag = (xml, name) => { const m = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9]+:)?${name}>`).exec(xml); return m ? m[1].trim() : null; };
const block = (xml, name) => { const m = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`).exec(xml); return m ? m[1] : ''; };
const cents = (s) => { if (s == null) return null; const c = toCents(s); return Number.isInteger(c) ? c : null; };

/** Deterministic reader for structured invoices (Peppol BIS / UBL 2.1). High confidence because the data is structured, still human-reviewed. */
export const UblExtractor = {
  name: 'ubl', label: 'Facture structurée UBL / Peppol',
  async extract({ data }) {
    const xml = data.toString('utf8');
    const isCredit = /<(?:[A-Za-z0-9]+:)?CreditNote[\s>]/.test(xml.slice(0, 2000));
    const supplier = block(xml, 'AccountingSupplierParty');
    const totals = block(xml, 'LegalMonetaryTotal');
    const docHead = xml.replace(/<(?:[A-Za-z0-9]+:)?AccountingSupplierParty[\s\S]*$/, '');
    const f = {}; const put = (k, value, confidence = 0.98) => { if (value !== null && value !== undefined && value !== '') f[k] = { value, confidence }; };
    put('invoiceNumber', tag(docHead, 'ID')); put('issueDate', tag(docHead, 'IssueDate')); put('dueDate', tag(docHead, 'DueDate')); put('currency', tag(docHead, 'DocumentCurrencyCode'));
    put('supplierName', tag(block(supplier, 'PartyLegalEntity'), 'RegistrationName') ?? tag(block(supplier, 'PartyName'), 'Name'));
    put('supplierVatNumber', tag(block(supplier, 'PartyTaxScheme'), 'CompanyID'));
    put('netCents', cents(tag(totals, 'TaxExclusiveAmount'))); put('grossCents', cents(tag(totals, 'TaxInclusiveAmount')));
    put('vatCents', cents(tag(block(xml.replace(/<(?:[A-Za-z0-9]+:)?InvoiceLine[\s\S]*$/, ''), 'TaxTotal'), 'TaxAmount')));
    put('paymentReference', tag(block(xml, 'PaymentMeans'), 'PaymentID'), 0.9);
    const warnings = [];
    if (isCredit) warnings.push('SUPPLIER_CREDIT_NOTE_REVIEW_MANUALLY');
    if (f.netCents && f.vatCents && f.grossCents && f.netCents.value + f.vatCents.value !== f.grossCents.value) { warnings.push('TOTALS_DO_NOT_ADD_UP'); for (const k of ['netCents', 'vatCents', 'grossCents']) f[k].confidence = 0.4; }
    return { extractor: 'ubl', fields: f, warnings };
  },
};
/** Chooses the extractor from the sniffed type. PDF / image extraction (OCR) is a replaceable boundary: none is configured, so those need manual entry. */
export const defaultExtractor = { name: 'auto', label: 'UBL structuré ; PDF / image : saisie manuelle', async extract(file) { return file.contentType === 'application/xml' ? UblExtractor.extract(file) : NoExtractor.extract(file); } };

// ---------- private attachment storage ----------
export function createMemoryAttachmentStore() {
  const files = new Map();
  return {
    name: 'memory',
    async put(ref, data, meta) { if (!files.has(ref)) files.set(ref, { data: Buffer.from(data), meta }); return ref; },
    async get(ref) { const f = files.get(ref); return f ? { data: Buffer.from(f.data), meta: f.meta } : null; },
    has: (ref) => files.has(ref),
  };
}
/** Supabase Storage, PRIVATE bucket, service-role access from the server only: there is never a public or signed URL handed to the browser. */
export function createSupabaseAttachmentStore({ url, serviceKey, bucket = 'finance-inbox', fetchImpl = fetch }) {
  const base = `${url.replace(/\/$/, '')}/storage/v1/object/${bucket}`;
  const auth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const enc = (ref) => ref.split('/').map(encodeURIComponent).join('/');
  return {
    name: 'supabase-storage',
    async put(ref, data, meta) {
      const res = await fetchImpl(`${base}/${enc(ref)}`, { method: 'POST', headers: { ...auth, 'Content-Type': meta?.contentType ?? 'application/octet-stream', 'x-upsert': 'false' }, body: data });
      if (!res.ok && res.status !== 409 && res.status !== 400) throw new FinanceError('ATTACHMENT_STORE_FAILED', `HTTP ${res.status}`); // 409/400: same content already stored (path holds the hash)
      return ref;
    },
    async get(ref) { const res = await fetchImpl(`${base}/${enc(ref)}`, { headers: auth }); if (!res.ok) return null; return { data: Buffer.from(await res.arrayBuffer()), meta: { contentType: res.headers.get('content-type') } }; },
  };
}

// ---------- service ----------
const FIELD_KEYS = ['supplierName', 'supplierVatNumber', 'invoiceNumber', 'issueDate', 'dueDate', 'netCents', 'vatCents', 'grossCents', 'currency', 'paymentReference'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** What still blocks validation. A person must fix these; nothing is guessed. */
export function validationErrors(r) {
  const e = [];
  if (!String(r.supplierName ?? '').trim()) e.push('SUPPLIER_NAME_MISSING');
  if (!String(r.invoiceNumber ?? '').trim()) e.push('INVOICE_NUMBER_MISSING');
  if (!isDate(r.issueDate)) e.push('ISSUE_DATE_INVALID');
  if (r.dueDate && (!isDate(r.dueDate) || r.dueDate < r.issueDate)) e.push('DUE_DATE_INVALID');
  for (const k of ['netCents', 'vatCents', 'grossCents']) if (!Number.isInteger(r[k]) || r[k] < 0) e.push(`${k.replace('Cents', '').toUpperCase()}_AMOUNT_INVALID`);
  if (Number.isInteger(r.netCents) && Number.isInteger(r.vatCents) && Number.isInteger(r.grossCents) && r.netCents + r.vatCents !== r.grossCents) e.push('NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL');
  if (!/^[A-Z]{3}$/.test(r.currency ?? '')) e.push('CURRENCY_INVALID');
  return e;
}

/** Validation rules for a record: a captured expense (receipt, ticket) uses the lighter expense rules; every other document keeps the full invoice rules. */
export const validationErrorsFor = (r) => (isCapturedExpense(r) ? expenseValidationErrors(r) : validationErrors(r));
const baseOf = (n) => String(n ?? 'document').replace(/\.[A-Za-z0-9]{1,5}$/, '');

/**
 * @param {{store: object, attachments: object, extractor?: object, merchantId: string, now?: () => string, audit?: Function}} deps
 */
export function createInboxService({ store, attachments, extractor = defaultExtractor, merchantId, now = () => new Date().toISOString(), audit = async () => {} }) {
  const merchantOnly = (actor) => { if (actor?.type !== 'merchant') throw new FinanceError('THIS_STEP_REQUIRES_A_MERCHANT_ACTOR'); };
  const must = async (id) => { const r = await store.getSupplierInvoice(id); if (!r || r.merchantId !== merchantId) throw new FinanceError('INBOX_ITEM_NOT_FOUND', id); return r; };
  const move = async (r, to, patch = {}) => {
    if (!INBOX_TRANSITIONS[r.status].includes(to)) throw new FinanceError('INVALID_TRANSITION', `${r.status} -> ${to}`);
    const saved = await store.updateSupplierInvoice(r.id, { ...patch, status: to }, r.status);
    if (!saved) throw new FinanceError('CONCURRENT_MODIFICATION', r.id);
    await audit({ at: now(), action: `SUPPLIER_INVOICE_${to}`, itemId: r.id, from: r.status });
    return saved;
  };
  const pick = (input) => { const out = {}; for (const k of FIELD_KEYS) if (k in input) out[k] = input[k]; return out; };
  const clean = (p) => {
    const out = { ...p };
    for (const k of ['supplierName', 'supplierVatNumber', 'invoiceNumber', 'paymentReference']) if (k in out) out[k] = out[k] == null || out[k] === '' ? null : String(out[k]).trim().slice(0, 120);
    if ('currency' in out && out.currency) out.currency = String(out.currency).toUpperCase();
    for (const k of ['issueDate', 'dueDate']) if (k in out && !out[k]) out[k] = null;
    return out;
  };
  return {
    /** Adapters call this with a file they were allowed to read. Idempotent by content hash. */
    async ingest({ source = 'upload', fileName, data, receivedAt, fromAddress = null, subject = null }) {
      if (!INBOX_SOURCES.includes(source)) throw new FinanceError('SOURCE_INVALID', source);
      if (!Buffer.isBuffer(data) || !data.length) throw new FinanceError('ATTACHMENT_EMPTY');
      if (data.length > MAX_ATTACHMENT_BYTES) throw new FinanceError('ATTACHMENT_TOO_LARGE');
      const contentType = sniffType(data);
      if (!contentType) throw new FinanceError('ATTACHMENT_TYPE_NOT_ALLOWED');
      const sha256 = createHash('sha256').update(data).digest('hex');
      const dup = await store.findSupplierInvoiceBySha(merchantId, sha256);
      if (dup) return { item: dup, duplicate: true };
      const ref = `${merchantId}/${sha256}/${safeName(fileName)}`;
      await attachments.put(ref, data, { contentType });
      const ex = await extractor.extract({ fileName, contentType, data }).catch(() => ({ extractor: 'failed', fields: {}, warnings: ['EXTRACTION_FAILED'] }));
      const values = Object.fromEntries(Object.entries(ex.fields).map(([k, v]) => [k, v.value]));
      const row = await store.saveSupplierInvoice({
        merchantId, source, status: 'RECEIVED', ...clean(pick(values)), currency: values.currency ?? null, fileName: safeName(fileName), contentType, sizeBytes: data.length, sha256, attachmentRef: ref,
        receivedAt: receivedAt ?? now(), fromAddress, subject: subject ? String(subject).slice(0, 200) : null, extraction: { extractor: ex.extractor, at: now(), fields: Object.fromEntries(Object.entries(ex.fields).map(([k, v]) => [k, v.confidence])), warnings: ex.warnings ?? [] },
      });
      await audit({ at: now(), action: 'INBOX_ITEM_RECEIVED', itemId: row.id, source, extractor: ex.extractor });
      return { item: await move(row, 'TO_REVIEW'), duplicate: false }; // extraction attempted: a person reviews next
    },
    /**
     * Capture a receipt / ticket / supplier document (camera photo, image or PDF) as a purchase record awaiting review.
     * The original file is stored untouched; an image also gets a PDF container that becomes the document served and packed.
     * Fields typed by the merchant are stored as given (original currency preserved); nothing is extracted or converted.
     */
    async captureExpense({ fileName, data, origin = 'image', fields = {}, meta = {}, receivedAt }, actor) {
      merchantOnly(actor);
      if (!CAPTURE_ORIGINS.includes(origin)) throw new FinanceError('CAPTURE_ORIGIN_INVALID', origin);
      if (!Buffer.isBuffer(data) || !data.length) throw new FinanceError('ATTACHMENT_EMPTY');
      if (data.length > CAPTURE_MAX_BYTES) throw new FinanceError('ATTACHMENT_TOO_LARGE');
      const contentType = sniffType(data);
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(contentType)) throw new FinanceError('ATTACHMENT_TYPE_NOT_ALLOWED');
      const sha256 = createHash('sha256').update(data).digest('hex');
      const dup = await store.findSupplierInvoiceBySha(merchantId, sha256);
      if (dup) return { item: dup, duplicate: true };
      const at = receivedAt ?? now();
      const originalName = safeName(fileName);
      const originalRef = `${merchantId}/${sha256}/${originalName}`;
      await attachments.put(originalRef, data, { contentType });
      let pdfRef = originalRef; let pdfName = originalName; let pdfSize = data.length; let pdfSha = sha256; let generated = false;
      if (contentType !== 'application/pdf') {
        const pdf = await imageToPdf({ data, contentType, title: baseOf(originalName), capturedAt: at, originalName, originalSha256: sha256 });
        pdfName = `${safeName(baseOf(originalName))}.pdf`; pdfRef = `${merchantId}/${sha256}/${pdfName}`;
        await attachments.put(pdfRef, pdf, { contentType: 'application/pdf' });
        pdfSha = createHash('sha256').update(pdf).digest('hex'); pdfSize = pdf.length; generated = true;
      }
      const capture = { kind: 'expense', origin, capturedAt: at, category: null, paymentMethod: null, note: null, eurAmountCents: null, eurAmountSource: null, vatRateBp: null, ...normalizeCaptureMeta(meta),
        original: { ref: originalRef, sha256, contentType, fileName: originalName, sizeBytes: data.length }, pdf: { ref: pdfRef, sha256: pdfSha, generated, sizeBytes: pdfSize } };
      const row = await store.saveSupplierInvoice({
        merchantId, source: 'upload', status: 'RECEIVED', ...clean(pick(fields)), currency: (fields.currency ? String(fields.currency).toUpperCase() : null), fileName: pdfName, contentType: 'application/pdf', sizeBytes: pdfSize, sha256, attachmentRef: pdfRef,
        receivedAt: at, fromAddress: null, subject: null, extraction: { extractor: 'manual', at: now(), fields: {}, warnings: [], capture },
      });
      await audit({ at: now(), action: 'EXPENSE_CAPTURED', itemId: row.id, origin, pdfGenerated: generated });
      return { item: await move(row, 'TO_REVIEW'), duplicate: false };
    },
    /**
     * Attach a first supporting document to a record that has none (e.g. a manually typed invoice with a missing receipt).
     * Same rules as a capture: the original is kept untouched, an image also gets a PDF container. Never replaces an attachment.
     */
    async attachDocument(id, { fileName, data }, actor) {
      merchantOnly(actor); const r = await must(id);
      if (r.attachmentRef) throw new FinanceError('ATTACHMENT_ALREADY_PRESENT', id);
      if (r.status === 'REJECTED') throw new FinanceError('ITEM_REJECTED', id);
      if (!Buffer.isBuffer(data) || !data.length) throw new FinanceError('ATTACHMENT_EMPTY');
      if (data.length > CAPTURE_MAX_BYTES) throw new FinanceError('ATTACHMENT_TOO_LARGE');
      const contentType = sniffType(data);
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(contentType)) throw new FinanceError('ATTACHMENT_TYPE_NOT_ALLOWED');
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (await store.findSupplierInvoiceBySha(merchantId, sha256)) throw new FinanceError('DUPLICATE_ATTACHMENT');
      const originalName = safeName(fileName); const originalRef = `${merchantId}/${sha256}/${originalName}`;
      await attachments.put(originalRef, data, { contentType });
      let pdfRef = originalRef; let pdfName = originalName; let pdfSize = data.length; let pdfSha = sha256; let generated = false;
      if (contentType !== 'application/pdf') {
        const pdf = await imageToPdf({ data, contentType, title: baseOf(originalName), capturedAt: now(), originalName, originalSha256: sha256 });
        pdfName = `${safeName(baseOf(originalName))}.pdf`; pdfRef = `${merchantId}/${sha256}/${pdfName}`;
        await attachments.put(pdfRef, pdf, { contentType: 'application/pdf' }); pdfSha = createHash('sha256').update(pdf).digest('hex'); pdfSize = pdf.length; generated = true;
      }
      const receipt = { attachedAt: now(), original: { ref: originalRef, sha256, contentType, fileName: originalName, sizeBytes: data.length }, pdf: { ref: pdfRef, sha256: pdfSha, generated, sizeBytes: pdfSize } };
      const saved = await store.setSupplierInvoiceAttachment(id, { fileName: pdfName, contentType: 'application/pdf', sizeBytes: pdfSize, sha256, attachmentRef: pdfRef, extraction: { ...(r.extraction ?? { extractor: 'manual', at: now(), fields: {}, warnings: [] }), receipt } });
      if (!saved) throw new FinanceError('ATTACHMENT_ALREADY_PRESENT', id);
      await audit({ at: now(), action: 'SUPPLIER_INVOICE_DOCUMENT_ATTACHED', itemId: id, pdfGenerated: generated });
      return saved;
    },
    /** Edit the capture metadata (category, payment method, note, merchant-typed EUR amount) while the record is unvalidated. */
    async updateCapture(id, metaPatch, actor) {
      merchantOnly(actor); const r = await must(id);
      if (!isCapturedExpense(r)) throw new FinanceError('NOT_A_CAPTURED_EXPENSE', id);
      if (!['RECEIVED', 'TO_REVIEW'].includes(r.status)) throw new FinanceError('ONLY_UNVALIDATED_ITEMS_CAN_BE_EDITED', r.status);
      const capture = { ...r.extraction.capture, ...normalizeCaptureMeta(metaPatch) };
      const saved = await store.updateSupplierInvoice(id, { extraction: { ...r.extraction, capture } }, r.status);
      if (!saved) throw new FinanceError('CONCURRENT_MODIFICATION', id);
      await audit({ at: now(), action: 'EXPENSE_CAPTURE_EDITED', itemId: id }); return saved;
    },
    /** The untouched original of a captured document (the PDF container is served by file()). */
    async originalFile(id) {
      const r = await must(id); const o = r.extraction?.capture?.original ?? r.extraction?.receipt?.original;
      if (!o) throw new FinanceError('ATTACHMENT_NOT_FOUND', id);
      const f = await attachments.get(o.ref); if (!f) throw new FinanceError('ATTACHMENT_NOT_FOUND', id);
      await audit({ at: now(), action: 'INBOX_ORIGINAL_ACCESSED', itemId: id });
      return { data: f.data, contentType: o.contentType, fileName: o.fileName };
    },
    async createManual(input, actor) {
      merchantOnly(actor);
      const row = await store.saveSupplierInvoice({ merchantId, source: 'manual', status: 'RECEIVED', ...clean(pick(input)), receivedAt: now(), extraction: { extractor: 'manual', at: now(), fields: {}, warnings: [] } });
      return move(row, 'TO_REVIEW');
    },
    get: must,
    async list(f = {}) { return (await store.listSupplierInvoices(merchantId)).filter((r) => (!f.status || r.status === f.status) && (!f.statuses || f.statuses.includes(r.status)) && (!f.source || r.source === f.source)).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))); },
    /** Edit the fields while the document is still being reviewed (a validated one must be reopened first). */
    async update(id, input, actor) {
      merchantOnly(actor); const r = await must(id);
      if (!['RECEIVED', 'TO_REVIEW'].includes(r.status)) throw new FinanceError('ONLY_UNVALIDATED_ITEMS_CAN_BE_EDITED', r.status);
      const saved = await store.updateSupplierInvoice(id, clean(pick(input)), r.status);
      if (!saved) throw new FinanceError('CONCURRENT_MODIFICATION', id);
      await audit({ at: now(), action: 'SUPPLIER_INVOICE_EDITED', itemId: id }); return saved;
    },
    async validate(id, actor) {
      merchantOnly(actor); const r = await must(id);
      const errors = validationErrorsFor(r); if (errors.length) throw new FinanceError('NOT_READY_TO_VALIDATE', errors.join(', '));
      const dup = (await store.listSupplierInvoices(merchantId)).find((x) => x.id !== id && x.invoiceNumber && x.invoiceNumber === r.invoiceNumber && (x.supplierVatNumber ? x.supplierVatNumber === r.supplierVatNumber : x.supplierName === r.supplierName) && ['VALIDATED', 'TO_PAY', 'PAID'].includes(x.status));
      if (dup) throw new FinanceError('DUPLICATE_SUPPLIER_INVOICE', dup.id);
      return move(r, 'VALIDATED', { validatedAt: now() });
    },
    async markToPay(id, actor) { merchantOnly(actor); return move(await must(id), 'TO_PAY'); },
    async pay(id, { paidOn, amountCents, reference }, actor) {
      merchantOnly(actor); const r = await must(id);
      if (!isDate(paidOn)) throw new FinanceError('PAID_ON_INVALID');
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new FinanceError('AMOUNT_INVALID');
      if (amountCents !== r.grossCents) throw new FinanceError('PARTIAL_SUPPLIER_PAYMENTS_NOT_SUPPORTED_YET', `${amountCents} vs ${r.grossCents}`);
      return move(r, 'PAID', { paidAt: paidOn, paidAmountCents: amountCents, paidReference: reference ? String(reference).slice(0, 100) : null });
    },
    async reject(id, reason, actor) { merchantOnly(actor); const r = await must(id); if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED'); return move(r, 'REJECTED', { rejectedReason: String(reason).slice(0, 300) }); },
    async reopen(id, actor) { merchantOnly(actor); const r = await must(id); return move(r, 'TO_REVIEW', { validatedAt: null }); },
    async file(id) { const r = await must(id); const f = await attachments.get(r.attachmentRef); if (!f) throw new FinanceError('ATTACHMENT_NOT_FOUND', id); await audit({ at: now(), action: 'INBOX_ATTACHMENT_ACCESSED', itemId: id }); return { ...f, fileName: r.fileName, contentType: r.contentType }; },
    /** Counts per status. `toPayCents` is EUR-only (Finance currency): foreign-currency documents are counted in `toPayForeign`, never summed. */
    async counts(currency = 'EUR') {
      const all = await store.listSupplierInvoices(merchantId); const c = Object.fromEntries(INBOX_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length]));
      const eur = all.filter((r) => r.status === 'TO_PAY').map((r) => eurOfSupplier(r, currency));
      return { ...c, toReview: c.RECEIVED + c.TO_REVIEW, toPayCents: eur.reduce((a, v) => a + (v ?? 0), 0), toPayForeign: eur.filter((v) => v === null).length };
    },
    /** Phase 1 (Contact foundation): link a supplier invoice to an existing fin_companies contact, or
     * clear the link (contactId = null). Deliberately separate from update()/move(): possible at any
     * status, never touches supplierName/supplierVatNumber (the historical snapshot), always explicit
     * (never automatic beyond the one-time, audited backfill in contacts.js), idempotent (re-linking the
     * same contact, or unlinking an already-unlinked invoice, is a no-op write). Tenant check on the
     * contact is the caller's responsibility (see /api/inbox/:id/contact in server/app.js) because this
     * service does not have access to the company store. */
    async linkContact(id, contactId, actor) {
      merchantOnly(actor);
      const r = await must(id);
      const saved = await store.setSupplierInvoiceContact(id, contactId ?? null);
      if (!saved) throw new FinanceError('INBOX_ITEM_NOT_FOUND', id);
      await audit({ at: now(), action: contactId ? 'SUPPLIER_INVOICE_CONTACT_LINKED' : 'SUPPLIER_INVOICE_CONTACT_UNLINKED', itemId: id, contactId: contactId ?? null, previousContactId: r.supplierCompanyId ?? null });
      return saved;
    },
  };
}

// ---------- adapter boundaries (documented; only upload is active) ----------
/**
 * FinanceInboxAdapter contract: a source of finance documents. `poll()` yields already-filtered items { source, fileName, data, receivedAt, fromAddress?, subject? }.
 *   - upload: the dashboard itself (active).
 *   - email: a DEDICATED finance mailbox only, every message through filterFinanceMessage (NOT CONFIGURED).
 *   - peppol: incoming Peppol invoices (NOT CONFIGURED until the access-point topology is confirmed).
 */
export const INBOX_ADAPTERS = [
  { name: 'upload', label: 'Téléversement de fichier', configured: true },
  { name: 'email', label: 'Boîte e-mail finance dédiée', configured: false, note: 'Pas de boîte personnelle : uniquement l\'adresse finance dédiée.' },
  { name: 'peppol', label: 'Factures Peppol reçues', configured: false, note: 'En attente de la confirmation de la topologie (Codabox / point d\'accès).' },
];
