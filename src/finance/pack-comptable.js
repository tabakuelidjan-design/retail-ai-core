// Pack comptable v1: PREPARE -> CONTROL -> COMPLETE -> DOWNLOAD. Nordla is not an accounting application.
//
// Everything is derived from data that already exists (the accountant pack of accountant-pack.js, issued documents, purchases /
// captured expenses, bank transactions, cash movements). Nothing is estimated: a missing source is reported as missing, partial
// data keeps its PARTIAL meaning, and no rule that blocks generation exists beyond the three structural ones listed below.
//
// BLOCKING (structural only - the pack cannot be trusted or built):
//   PERIOD_NOT_COVERED_BY_DATA        the retail history does not cover the period (existing pack reasons NO_RETAIL_ORDERS_LOADED / RETAIL_HISTORY_STARTS_*)
//   CORRUPTED_SOURCE                  an issued document fails its integrity hash (existing anomaly DOCUMENT_INTEGRITY_HASH_MISMATCH)
//   RETAIL_SOURCE_UNAVAILABLE         the sales source cannot be read (raised by the server)
// Everything else is a WARNING and never prevents generation ("Générer malgré les avertissements").
//
// Verdict (user-facing mapping of the existing COMPLETE / PARTIAL truth, no score):
//   incomplete  a blocking issue exists, or something is PARTIAL (open period, retail VAT rate missing, critical anomaly, ...)
//   review      COMPLETE but at least one warning (missing receipt, unmatched transaction, ...)
//   ready       COMPLETE and no warning

import { createHash } from 'node:crypto';
import { toCsv } from './export-csv.js';
import { formatCents } from './money.js';
import { renderDocumentPdf } from './pdf.js';
import { renderReportPdf } from './accountant-package.js';
import { buildUbl, validatePeppolReadiness } from './peppol.js';
import { packFileBuffers, vatRows } from './reports.js';
import { buildXlsx, unzip, zip } from './xlsx.js';

export const CATEGORIES = [
  { id: 'clients', folder: '01_FACTURES_CLIENTS', file: 'FacturesClients' },
  { id: 'credit_notes', folder: '02_NOTES_DE_CREDIT', file: 'NotesDeCredit' },
  { id: 'purchases', folder: '03_ACHATS_FOURNISSEURS', file: 'AchatsFournisseurs' },
  { id: 'sales', folder: '04_VENTES', file: 'Ventes' },
  { id: 'bank', folder: '05_BANQUE', file: 'Banque' },
  { id: 'pos', folder: '06_CAISSE_POS', file: 'CaissePOS' },
  { id: 'receipts', folder: '07_JUSTIFICATIFS', file: 'Justificatifs' },
  { id: 'vat', folder: '08_TVA', file: 'TVA' },
];
export const CONTROL_FOLDER = '00_CONTROLE';
export const EXPORTS_FOLDER = '09_EXPORTS';
export const VAT_WORDING = 'Estimation indicative basée sur les données disponibles. Ceci n’est pas une déclaration TVA officielle.';
export const PACK_ACTION = 'PACK_COMPTABLE_GENERATED';

const VALIDATED = ['VALIDATED', 'TO_PAY', 'PAID'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const inRange = (d, a, b) => typeof d === 'string' && d.slice(0, 10) >= a && d.slice(0, 10) <= b;
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const cat = (id) => CATEGORIES.find((c) => c.id === id);

// ---------- naming ----------
const stripMarks = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** "Client Exemple SA" -> "ClientExempleSA": ASCII, no separators or characters that are invalid in a file name. */
export function namePart(s, max = 30) {
  const parts = stripMarks(s).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return parts.join('').slice(0, max);
}
const extOf = (contentType, fileName = '') => ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/xml': 'xml' }[contentType] ?? (/\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1]?.toLowerCase() ?? 'bin'));
/** YYYY-MM-DD_Tiers_NumeroDocument_Montant.ext  e.g. 2026-05-14_TotalEnergies_INV-8831_78.40EUR.pdf ("SN" = sans numéro). */
export function documentFileName({ date, party, number, grossCents, currency, ext }) {
  const num = stripMarks(number ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'SN';
  const amount = Number.isInteger(grossCents) ? `${formatCents(Math.abs(grossCents))}${currency ?? ''}` : 'SansMontant';
  return `${date || 'SansDate'}_${namePart(party) || 'Tiers'}_${num}_${amount}.${ext}`;
}
const uniqueName = (name, used) => {
  if (!used.has(name)) { used.add(name); return name; }
  const m = /^(.*?)(\.[A-Za-z0-9]+)$/.exec(name); const stem = m ? m[1] : name; const ext = m ? m[2] : '';
  for (let i = 2; ; i += 1) { const n = `${stem}_${i}${ext}`; if (!used.has(n)) { used.add(n); return n; } }
};
/** Quarter labels become 2026_Q2 for the archive name; months, years and custom ranges keep their own label. */
export function packLabel(period) { const m = /^Q(\d)_(\d{4})$/.exec(period.label); return m ? `${m[2]}_Q${m[1]}` : period.label; }
const rootName = (prefix, label) => `${namePart(prefix, 24) || 'Nordla'}_Pack_Comptable_${label}`;

// ---------- analysis ----------
const kindOfType = (t) => (t === 'credit_note' ? 'credit_note' : 'invoice');

/**
 * @param {object} input see the server gather step: { period, pack, currency, invoices, creditNotes, refunds, purchases, undatedInbox, bank, cash }
 * @returns the model shown on the page (JSON safe): verdict, issues, facts, categories, vat, captured summary, per-category readiness.
 */
export function analyzePack(input) {
  const { period, pack, currency } = input;
  const issues = [];
  let n = 0;
  const add = (o) => { issues.push({ id: `i${(n += 1)}`, level: 'warning', partial: false, priority: 'normal', date: null, party: null, amountCents: null, currency: null, ref: null, ...o }); };
  const docOf = new Map([...input.invoices, ...input.creditNotes].map((d) => [d.doc.number, d.doc]));

  // sales / documents: the existing pack reasons and anomalies, kept verbatim as codes
  for (const r of pack.completeness.reasons) {
    const structural = r === 'NO_RETAIL_ORDERS_LOADED' || r.startsWith('RETAIL_HISTORY_STARTS_');
    const partial = structural || r === 'PERIOD_NOT_CLOSED' || r === 'RETAIL_LAST_SYNC_BEFORE_PERIOD_END' || r.startsWith('RETAIL_VAT_RATE_UNAVAILABLE');
    add({ category: 'sales', kind: 'sales_data', code: structural ? 'PERIOD_NOT_COVERED_BY_DATA' : r.replace(/^\d+_/, 'N_').replace(/_\d+_/g, '_N_'), level: structural ? 'blocking' : 'warning', partial, detail: r, action: { type: 'open_sales' } });
  }
  for (const a of pack.anomalies) {
    const num = /^([^:]+):/.exec(a.detail)?.[1] ?? null; const doc = num ? docOf.get(num) : null;
    const isCreditKey = /^credit_note\|/.test(a.detail);
    const blocking = a.code === 'DOCUMENT_INTEGRITY_HASH_MISMATCH';
    add({ category: doc ? (doc.type === 'credit_note' ? 'credit_notes' : 'clients') : (isCreditKey ? 'credit_notes' : 'clients'), kind: a.code.startsWith('POSSIBLE_DUPLICATE') ? 'duplicate' : 'document', code: blocking ? 'CORRUPTED_SOURCE' : a.code,
      level: blocking ? 'blocking' : 'warning', partial: a.severity === 'critical', priority: a.severity === 'critical' ? 'critical' : 'normal', date: doc?.issueDate ?? null, party: doc?.customer?.name ?? null, amountCents: doc?.totals?.grossCents ?? null, currency: doc?.currency ?? null,
      ref: num, detail: a.detail, action: doc ? { type: 'open_document', id: doc.id } : { type: 'open_sales' } });
  }

  // purchases and captured expenses
  const purchases = input.purchases;
  const isEur = (r) => r.currency === currency;
  const dupKey = (r) => `${String(r.supplierName ?? '').trim().toLowerCase()}|${r.issueDate}|${r.grossCents}|${r.currency}`;
  const dupGroups = new Map();
  for (const r of purchases.filter((x) => x.supplierName && x.issueDate && Number.isInteger(x.grossCents))) (dupGroups.get(dupKey(r)) ?? dupGroups.set(dupKey(r), []).get(dupKey(r))).push(r);
  for (const r of purchases) {
    const base = { category: 'purchases', date: r.issueDate, party: r.supplierName, amountCents: r.grossCents, currency: r.currency, ref: r.invoiceNumber, action: { type: 'open_purchase', id: r.id } };
    const captured = r.extraction?.capture?.kind === 'expense';
    if (!VALIDATED.includes(r.status)) add({ ...base, kind: 'not_validated', code: 'DOCUMENT_NOT_VALIDATED', detail: 'The document is still under review.' });
    if (!r.attachmentRef) add({ ...base, category: 'receipts', kind: 'missing_receipt', code: 'MISSING_RECEIPT', detail: 'No supporting document is attached.', action: { type: 'add_receipt', id: r.id } });
    else if (r._attachmentMissing) add({ ...base, category: 'receipts', kind: 'missing_receipt', code: 'ATTACHMENT_NOT_FOUND', detail: 'The stored file could not be read.', action: { type: 'add_receipt', id: r.id } });
    if (VALIDATED.includes(r.status) && r.vatCents > 0 && !r.supplierVatNumber) add({ ...base, kind: 'vat', code: 'SUPPLIER_VAT_MISSING', detail: 'VAT is claimed but the supplier VAT number is missing.' });
    if (VALIDATED.includes(r.status) && r.vatCents == null) add({ ...base, kind: 'vat', code: 'VAT_NOT_PROVIDED', detail: 'The VAT amount is not recorded: it is left out of the VAT control.' });
    if (!isEur(r) && r.currency && !r.extraction?.capture?.eurAmountCents) add({ ...base, kind: 'currency', code: 'FOREIGN_CURRENCY_NOT_CONVERTED', detail: `Original currency ${r.currency} is kept; no EUR amount was provided, so it is left out of the EUR totals.` });
    if (captured && (!r.extraction.capture.category || !r.extraction.capture.paymentMethod)) add({ ...base, kind: 'metadata', code: 'CAPTURE_METADATA_MISSING', detail: 'Category or payment method is not filled in.' });
    const g = dupGroups.get(dupKey(r)); if (g && g.length > 1) add({ ...base, kind: 'duplicate', code: 'POSSIBLE_DUPLICATE_EXPENSE', priority: 'critical', detail: 'Same supplier, date, amount and currency as another document.', action: { type: 'open_purchase', id: r.id } });
  }
  if (input.undatedInbox > 0) add({ category: 'purchases', kind: 'undated', code: 'DOCUMENTS_WITHOUT_DATE', detail: `${input.undatedInbox} incoming document(s) have no date yet and cannot be placed in a period.`, action: { type: 'open_inbox' }, ref: String(input.undatedInbox) });

  // bank: unmatched transactions and source coverage
  const bank = input.bank;
  for (const t of bank.transactions.filter((x) => x.status === 'NEW')) add({ category: 'bank', kind: 'unmatched', code: 'TRANSACTION_UNMATCHED', date: t.date, party: t.counterpartyName ?? null, amountCents: t.amountCents, currency: t.currency ?? null, ref: t.reference ?? null, detail: 'The transaction is not matched to a document.', action: { type: 'open_bank' } });
  const bankCoverage = bank.allCount === 0 ? 'none' : (bank.first > period.start || bank.last < period.end ? 'partial' : 'full');
  if (bankCoverage === 'partial') add({ category: 'bank', kind: 'bank_data', code: 'BANK_COVERAGE_PARTIAL', detail: `Bank transactions available from ${bank.first} to ${bank.last}.`, action: { type: 'open_bank' } });

  // ---- VAT (indicative) ----
  const eurValidated = purchases.filter((r) => VALIDATED.includes(r.status) && isEur(r));
  const withVat = eurValidated.filter((r) => Number.isInteger(r.vatCents));
  const deductibleCents = sum(withVat, (r) => r.vatCents);
  const excluded = { foreign: purchases.filter((r) => VALIDATED.includes(r.status) && !isEur(r)).length, notValidated: purchases.filter((r) => !VALIDATED.includes(r.status)).length, vatMissing: eurValidated.length - withVat.length };
  const vatReasons = [
    ...(pack.vat_summary.status === 'PARTIAL' ? ['RETAIL_VAT_RATE_UNAVAILABLE'] : []),
    ...(excluded.foreign ? ['FOREIGN_CURRENCY_EXCLUDED'] : []), ...(excluded.notValidated ? ['UNVALIDATED_PURCHASES_EXCLUDED'] : []), ...(excluded.vatMissing ? ['PURCHASE_VAT_NOT_RECORDED'] : []),
    ...(pack.completeness.reasons.includes('PERIOD_NOT_CLOSED') ? ['PERIOD_NOT_CLOSED'] : []),
  ];
  const vat = {
    wording: VAT_WORDING, status: vatReasons.length ? 'PARTIAL' : 'COMPLETE', reasons: vatReasons,
    collectedCents: pack.totals.vat_collected_cents, deductibleCents, balanceCents: pack.totals.vat_collected_cents - deductibleCents,
    byRate: pack.vat_summary.combined_by_rate, unclassified: pack.vat_summary.retail_unclassified,
    purchases: { documents: withVat.length, excluded, note: 'Deductible VAT is the VAT printed on validated purchase documents; the right to deduct is not assessed.' },
    coverage: { retailRateKnown: pack.vat_summary.retail_unclassified === null, purchaseDocumentsWithVat: withVat.length, purchaseDocumentsTotal: purchases.filter((r) => VALIDATED.includes(r.status)).length },
  };

  // ---- category cards ----
  const byCat = (id) => issues.filter((i) => i.category === id);
  const statusOf = (id, count) => { const is = byCat(id); return count === 0 && !is.length ? 'empty' : is.some((i) => i.level === 'blocking' || i.partial) ? 'incomplete' : is.length ? 'review' : 'ready'; };
  const validatedPurchases = purchases.filter((r) => VALIDATED.includes(r.status));
  const receiptsFiles = purchases.filter((r) => r.attachmentRef && !r._attachmentMissing && r.contentType !== 'application/xml');
  const bankMatched = bank.transactions.filter((t) => t.status === 'MATCHED').length;
  const posBlock = pack.retail.by_channel.pos;
  const categories = [
    { id: 'clients', count: input.invoices.length, note: null },
    { id: 'credit_notes', count: input.creditNotes.length, note: null },
    { id: 'purchases', count: validatedPurchases.length, note: null },
    { id: 'sales', count: pack.retail.orders + input.invoices.filter((d) => d.doc.revenueBasis === 'standalone_b2b').length, note: null },
    { id: 'bank', count: bank.transactions.length, note: bankCoverage === 'none' ? 'NO_BANK_DATA' : null },
    { id: 'pos', count: posBlock.orders + input.cash.movements.length, note: 'CASH_RECONCILIATION_NOT_SUPPORTED' },
    { id: 'receipts', count: receiptsFiles.length, note: null },
    { id: 'vat', count: (pack.totals.vat_collected_cents !== 0 || deductibleCents !== 0) ? 1 : 0, note: null },
  ].map((c) => {
    const st = c.id === 'vat' ? (c.count === 0 ? 'empty' : vat.status === 'PARTIAL' ? 'incomplete' : 'ready') : statusOf(c.id, c.count);
    const is = byCat(c.id);
    return { ...c, status: st, issues: is.length, blocking: is.filter((i) => i.level === 'blocking').length, downloadable: c.count > 0, folder: cat(c.id).folder };
  });

  const blocking = issues.filter((i) => i.level === 'blocking');
  const warnings = issues.filter((i) => i.level !== 'blocking');
  const verdict = blocking.length || issues.some((i) => i.partial) || pack.completeness.status === 'PARTIAL' ? 'incomplete' : warnings.length ? 'review' : 'ready';

  const captured = purchases.filter((r) => r.extraction?.capture?.kind === 'expense');
  const facts = {
    invoices: input.invoices.length, creditNotes: input.creditNotes.length, purchases: validatedPurchases.length,
    purchasesWithReceipt: purchases.filter((r) => r.attachmentRef && !r._attachmentMissing).length, purchasesTotal: purchases.length,
    bankTransactions: bank.transactions.length, bankMatched, bankCoverage,
  };
  return {
    period, currency, verdict, completeness: pack.completeness.status, reconciliation: pack.reconciliation.status,
    counts: { blocking: blocking.length, warnings: warnings.length, items: issues.length },
    issues, facts, categories, vat,
    captured: { total: captured.length, notValidated: captured.filter((r) => !VALIDATED.includes(r.status)).length, missingMetadata: captured.filter((r) => !r.extraction.capture.category || !r.extraction.capture.paymentMethod).length,
      withPdf: captured.filter((r) => r.extraction.capture.pdf?.ref).length, foreignCurrency: captured.filter((r) => r.currency !== currency).length },
    bank: { coverage: bankCoverage, first: bank.first ?? null, last: bank.last ?? null, counts: { NEW: bank.transactions.filter((t) => t.status === 'NEW').length, MATCHED: bankMatched, IGNORED: bank.transactions.filter((t) => t.status === 'IGNORED').length }, codaSupported: false },
    sales: { orders: pack.retail.orders, standaloneB2b: pack.b2b.standalone_invoices, netExVatCents: pack.totals.sales_ex_vat_cents, vatCollectedCents: pack.totals.vat_collected_cents, retailVat: pack.retail.vat_by_rate.status, reasons: pack.completeness.reasons, creditNotes: pack.credit_notes.issued, refunds: input.refunds.length },
    pos: { orders: posBlock.orders, netExVat: posBlock.net_sales_ex_vat, cashMovements: input.cash.movements.length, cashReconciliation: 'NOT_SUPPORTED' },
  };
}

export const DEFAULT_INCLUDE = { clients: true, credit_notes: true, purchases: true, receipts: true, sales: true, bank: true, pos: true, vat: true, control: true, csv: true, xlsx: true, ubl: true };
export const normalizeInclude = (i = {}) => Object.fromEntries(Object.keys(DEFAULT_INCLUDE).map((k) => [k, k in i ? i[k] === true : DEFAULT_INCLUDE[k]]));

/** REAL counts of what a generation with these options would contain (no file is built). */
export function previewCounts(model, include, input) {
  const inc = normalizeInclude(include); const c = (id) => model.categories.find((x) => x.id === id);
  const on = (id) => inc[id] && c(id).count > 0;
  return {
    invoices: on('clients') ? c('clients').count : 0, creditNotes: on('credit_notes') ? c('credit_notes').count : 0, purchases: on('purchases') ? c('purchases').count : 0,
    receipts: on('receipts') ? c('receipts').count : 0, bankExports: on('bank') ? 1 : 0, salesExports: on('sales') && c('sales').count > 0 ? 1 : 0, posExports: on('pos') ? 1 : 0,
    vatSummaries: on('vat') ? 1 : 0, controlReports: inc.control ? 1 : 0,
    ubl: inc.ubl ? ublCandidates(input).length : 0,
  };
}
const ublCandidates = (input) => [...input.invoices, ...input.creditNotes].filter((d) => validatePeppolReadiness(d.doc, { originalNumber: d.originalNumber }).length === 0);

// ---------- files ----------
const partyOfPurchase = (r) => r.supplierName;
export const originalOf = (r) => r.extraction?.capture?.original ?? r.extraction?.receipt?.original ?? null;
export const pdfOf = (r) => r.extraction?.capture?.pdf ?? r.extraction?.receipt?.pdf ?? null;
const eurOf = (r) => r.extraction?.capture?.eurAmountCents ?? '';
const purchaseRow = (r) => ({ fournisseur: r.supplierName ?? '', tva_fournisseur: r.supplierVatNumber ?? '', numero: r.invoiceNumber ?? '', date: r.issueDate ?? '', echeance: r.dueDate ?? '', devise_origine: r.currency ?? '',
  htva: r.netCents == null ? '' : formatCents(r.netCents), tva: r.vatCents == null ? '' : formatCents(r.vatCents), tvac: r.grossCents == null ? '' : formatCents(r.grossCents), montant_eur_saisi: eurOf(r) === '' ? '' : formatCents(eurOf(r)),
  categorie: r.extraction?.capture?.category ?? '', moyen_paiement: r.extraction?.capture?.paymentMethod ?? '', note: r.extraction?.capture?.note ?? '', statut: r.status, source: r.source, piece: r.attachmentRef ? 'oui' : 'non', image_originale: originalOf(r) && pdfOf(r)?.generated ? 'oui' : 'non' });
const PURCHASE_KEYS = ['fournisseur', 'tva_fournisseur', 'numero', 'date', 'echeance', 'devise_origine', 'htva', 'tva', 'tvac', 'montant_eur_saisi', 'categorie', 'moyen_paiement', 'note', 'statut', 'source', 'piece', 'image_originale'];
const csvOf = (rows, keys) => Buffer.from(toCsv(rows, keys.map((k) => ({ key: k, header: k }))), 'utf8');
const xlsxOf = (name, keys, rows) => buildXlsx([{ name, rows: [keys, ...rows.map((r) => keys.map((k) => r[k] ?? ''))] }]);

/** Files of every category (paths relative to the category folder). Only what is selected AND has real data is produced. */
async function collectFiles(input, model, include) {
  const inc = normalizeInclude(include); const { period, pack, branding = {}, merchantName = '' } = input; const L = packLabel(period);
  const files = new Map(CATEGORIES.map((c) => [c.id, []])); const add = (id, path, data, kind) => files.get(id).push({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), kind });
  const c = (id) => model.categories.find((x) => x.id === id);
  const want = (id) => inc[id] && c(id).count > 0;

  if (want('clients')) {
    const used = new Set();
    for (const d of input.invoices) add('clients', uniqueName(documentFileName({ date: d.doc.issueDate, party: d.doc.customer.name, number: d.doc.number, grossCents: d.doc.totals.grossCents, currency: d.doc.currency, ext: 'pdf' }), used), await renderDocumentPdf(d.doc, { settlement: d.settlement, branding }), 'pdf');
    const rows = input.invoices.map((d) => ({ numero: d.doc.number, date: d.doc.issueDate, echeance: d.doc.dueDate ?? '', client: d.doc.customer.name, tva_client: d.doc.customer.vatNumber ?? '', base: d.doc.revenueBasis, statut: d.doc.status, htva: formatCents(d.doc.totals.netCents), tva: formatCents(d.doc.totals.vatCents), tvac: formatCents(d.doc.totals.grossCents), paye: d.settlement ? formatCents(d.settlement.paidCents) : '', reste: d.settlement ? formatCents(d.settlement.remainingCents) : '' }));
    const keys = Object.keys(rows[0]);
    if (inc.csv) add('clients', `Liste_factures_clients_${L}.csv`, csvOf(rows, keys), 'csv');
    if (inc.xlsx) add('clients', `Liste_factures_clients_${L}.xlsx`, xlsxOf('Factures clients', keys, rows), 'xlsx');
    if (inc.ubl) for (const d of input.invoices.filter((x) => validatePeppolReadiness(x.doc, { originalNumber: x.originalNumber }).length === 0)) add('clients', `UBL/${documentFileName({ date: d.doc.issueDate, party: d.doc.customer.name, number: d.doc.number, grossCents: d.doc.totals.grossCents, currency: d.doc.currency, ext: 'xml' })}`, buildUbl(d.doc, { originalNumber: d.originalNumber }), 'ubl');
  }
  if (want('credit_notes')) {
    const used = new Set();
    for (const d of input.creditNotes) add('credit_notes', uniqueName(documentFileName({ date: d.doc.issueDate, party: d.doc.customer.name, number: d.doc.number, grossCents: d.doc.totals.grossCents, currency: d.doc.currency, ext: 'pdf' }), used), await renderDocumentPdf(d.doc, { originalNumber: d.originalNumber, branding }), 'pdf');
    const rows = input.creditNotes.map((d) => ({ numero: d.doc.number, date: d.doc.issueDate, facture_origine: d.originalNumber ?? '', client: d.doc.customer.name, base: d.doc.revenueBasis, htva: formatCents(d.doc.totals.netCents), tva: formatCents(d.doc.totals.vatCents), tvac: formatCents(d.doc.totals.grossCents) }));
    const keys = Object.keys(rows[0]);
    if (inc.csv) add('credit_notes', `Liste_notes_de_credit_${L}.csv`, csvOf(rows, keys), 'csv');
    if (inc.xlsx) add('credit_notes', `Liste_notes_de_credit_${L}.xlsx`, xlsxOf('Notes de crédit', keys, rows), 'xlsx');
    if (inc.ubl) for (const d of input.creditNotes.filter((x) => validatePeppolReadiness(x.doc, { originalNumber: x.originalNumber }).length === 0)) add('credit_notes', `UBL/${documentFileName({ date: d.doc.issueDate, party: d.doc.customer.name, number: d.doc.number, grossCents: d.doc.totals.grossCents, currency: d.doc.currency, ext: 'xml' })}`, buildUbl(d.doc, { originalNumber: d.originalNumber }), 'ubl');
  }
  if (want('purchases')) {
    const validated = input.purchases.filter((r) => VALIDATED.includes(r.status)); const rows = validated.map(purchaseRow);
    if (inc.csv) add('purchases', `Liste_achats_${L}.csv`, csvOf(rows, PURCHASE_KEYS), 'csv');
    if (inc.xlsx) add('purchases', `Liste_achats_${L}.xlsx`, xlsxOf('Achats', PURCHASE_KEYS, rows), 'xlsx');
    if (inc.ubl) { const used = new Set(); for (const r of validated.filter((x) => x.contentType === 'application/xml' && x._data)) add('purchases', `UBL/${uniqueName(documentFileName({ date: r.issueDate, party: partyOfPurchase(r), number: r.invoiceNumber, grossCents: r.grossCents, currency: r.currency, ext: 'xml' }), used)}`, r._data, 'ubl'); }
  }
  if (want('sales')) {
    const base = await packFileBuffers(pack, { branding, merchantName }); const stem = `accountant-pack_${pack.period.start}_${pack.period.end}`;
    if (inc.xlsx) add('sales', `Ventes_${L}.xlsx`, base.get(`${stem}.xlsx`).data, 'xlsx');
    if (inc.csv) {
      add('sales', `Ventes_synthese_${L}.csv`, base.get(`${stem}_summary.csv`).data, 'csv');
      add('sales', `Remboursements_${L}.csv`, csvOf(input.refunds.map((r) => ({ date: r.date, montant: r.amount, commande: r.orderRef ?? '' })), ['date', 'montant', 'commande']), 'csv');
    }
  }
  if (want('bank')) {
    const rows = input.bank.transactions.map((t) => ({ date: t.date, montant: formatCents(t.amountCents), devise: t.currency ?? '', contrepartie: t.counterpartyName ?? '', reference: t.reference ?? '', reference_structuree: t.structuredReference ?? '', source: t.source ?? '',
      rapprochement: t.status === 'MATCHED' ? 'rapproché' : t.status === 'IGNORED' ? 'ignoré' : 'non rapproché', type_rapprochement: t.matchedKind ?? '' }));
    const keys = Object.keys(rows[0]);
    if (inc.csv) add('bank', `Transactions_bancaires_${L}.csv`, csvOf(rows, keys), 'csv');
    if (inc.xlsx) add('bank', `Transactions_bancaires_${L}.xlsx`, xlsxOf('Banque', keys, rows), 'xlsx');
  }
  if (want('pos')) {
    const p = pack.retail.by_channel.pos;
    if (inc.csv) {
      add('pos', `Ventes_POS_${L}.csv`, csvOf([{ commandes: p.orders, ventes_brutes: p.gross_sales, remises: p.discounts, remboursements: p.refunds, ventes_nettes_tvac: p.net_sales, tva: p.vat, ventes_nettes_htva: p.net_sales_ex_vat }], ['commandes', 'ventes_brutes', 'remises', 'remboursements', 'ventes_nettes_tvac', 'tva', 'ventes_nettes_htva']), 'csv');
      if (input.cash.movements.length) add('pos', `Mouvements_especes_${L}.csv`, csvOf(input.cash.movements.map((m) => ({ date: m.date, type: m.kind, montant: formatCents(m.amountCents), note: m.note ?? '' })), ['date', 'type', 'montant', 'note']), 'csv');
    }
  }
  if (want('receipts')) {
    const used = new Set();
    for (const r of input.purchases.filter((x) => x.attachmentRef && !x._attachmentMissing && x.contentType !== 'application/xml' && x._data)) {
      const std = { date: r.issueDate, party: partyOfPurchase(r), number: r.invoiceNumber, grossCents: r.grossCents, currency: r.currency };
      add('receipts', uniqueName(documentFileName({ ...std, ext: extOf(r.contentType, r.fileName) }), used), r._data, 'pdf');
      const o = originalOf(r);
      if (o && pdfOf(r)?.generated && r._original) add('receipts', `Originaux/${uniqueName(documentFileName({ ...std, ext: extOf(o.contentType, o.fileName) }), used)}`, r._original, 'original');
    }
  }
  if (want('vat')) {
    const v = model.vat; const e2 = formatCents;
    add('vat', `TVA_indicative_${L}.pdf`, await renderReportPdf({ title: `TVA indicative ${L.replace('_', ' ')}`, subtitle: `${merchantName}   Période : ${period.start} au ${period.end}   Devise : ${input.currency}`, branding, footer: merchantName,
      sections: [
        { heading: 'Avertissement', rows: [VAT_WORDING, `Statut : ${v.status === 'COMPLETE' ? 'COMPLET' : 'PARTIEL'}${v.reasons.length ? ` (${v.reasons.join(', ')})` : ''}`] },
        { heading: 'Solde indicatif', rows: [['TVA collectée', e2(v.collectedCents), true], ['TVA sur achats validés (déductibilité non évaluée)', e2(v.deductibleCents), true], ['Solde indicatif (collectée − achats)', e2(v.balanceCents), true]] },
        { heading: 'TVA collectée par taux (taux connus uniquement)', rows: v.byRate.map((g) => [`Taux ${g.vatRateBp / 100} %  -  base ${e2(g.taxableCents)}`, `TVA ${e2(g.vatCents)}`]) },
        { heading: 'Non classé / exclu', rows: [...(v.unclassified ? [`${v.unclassified.lines} ligne(s) de vente sans taux de TVA enregistré (base ${e2(v.unclassified.taxableCents)}, TVA ${e2(v.unclassified.vatCents)}).`] : []), `Achats en devise étrangère exclus : ${v.purchases.excluded.foreign}`, `Achats non validés exclus : ${v.purchases.excluded.notValidated}`, `Achats validés sans montant de TVA : ${v.purchases.excluded.vatMissing}`] },
      ] }), 'pdf');
    if (inc.csv) add('vat', `TVA_indicative_${L}.csv`, csvOf(vatRows(pack), ['source', 'treatment', 'rate_percent', 'taxable_base', 'vat', 'status']), 'csv');
  }
  return files;
}

const CONTROL_STATE = { ready: 'PRÊT', review: 'À VÉRIFIER', incomplete: 'INCOMPLET' };
const CAT_FR = { clients: 'Factures clients', credit_notes: 'Notes de crédit', purchases: 'Achats / factures fournisseurs', sales: 'Ventes', bank: 'Banque', pos: 'Caisse / POS', receipts: 'Justificatifs', vat: 'TVA' };
const STATUS_FR = { ready: 'Prêt', review: 'À vérifier', incomplete: 'Incomplet', empty: 'Aucun document' };
const ISSUE_FR = { PERIOD_NOT_COVERED_BY_DATA: 'Période non couverte par les données de vente', CORRUPTED_SOURCE: 'Document dont l’empreinte d’intégrité ne correspond plus', MISSING_RECEIPT: 'Justificatif manquant', ATTACHMENT_NOT_FOUND: 'Fichier stocké illisible', DOCUMENT_NOT_VALIDATED: 'Document non validé',
  SUPPLIER_VAT_MISSING: 'N° de TVA du fournisseur manquant', VAT_NOT_PROVIDED: 'Montant de TVA non renseigné', FOREIGN_CURRENCY_NOT_CONVERTED: 'Devise étrangère sans montant EUR', CAPTURE_METADATA_MISSING: 'Catégorie ou moyen de paiement manquant', POSSIBLE_DUPLICATE_EXPENSE: 'Doublon suspect', TRANSACTION_UNMATCHED: 'Transaction non rapprochée',
  BANK_COVERAGE_PARTIAL: 'Couverture bancaire partielle', DOCUMENTS_WITHOUT_DATE: 'Documents sans date' };
const issueLabel = (i) => ISSUE_FR[i.code] ?? i.code;

async function controlFiles(input, model, include, fileList, version) {
  const inc = normalizeInclude(include); const { period, pack, merchantName = '', branding = {} } = input; const L = packLabel(period); const cur = input.currency; const e2 = formatCents;
  const out = [];
  if (inc.control) {
    out.push({ path: 'Rapport_Controle_Nordla.pdf', kind: 'pdf', data: await renderReportPdf({
      title: `Rapport de contrôle Nordla — ${L.replace('_', ' ')}`, subtitle: `${merchantName}   Période : ${period.start} au ${period.end}   Généré : ${input.generatedAt}   Version : ${version}`, branding, footer: merchantName,
      sections: [
        { heading: 'État du dossier', rows: [['État', CONTROL_STATE[model.verdict], true], ['Complétude (données)', model.completeness === 'COMPLETE' ? 'COMPLET' : 'PARTIEL', true], ['Éléments bloquants', model.counts.blocking], ['Avertissements', model.counts.warnings]] },
        { heading: 'Documents par catégorie', rows: model.categories.map((c) => [`${CAT_FR[c.id]}${inc[c.id] === false ? ' (non inclus)' : ''}`, `${c.count} — ${STATUS_FR[c.status]}`]) },
        { heading: 'Totaux', rows: [['Ventes HTVA (retail + B2B autonome)', `${e2(pack.totals.sales_ex_vat_cents)} ${cur}`], ['TVA collectée', `${e2(pack.totals.vat_collected_cents)} ${cur}`], ['Ventes TVAC', `${e2(pack.totals.sales_incl_vat_cents)} ${cur}`], ['Factures clients / notes de crédit', `${model.facts.invoices} / ${model.facts.creditNotes}`], ['Achats validés', model.facts.purchases]] },
        { heading: 'Couverture', rows: [['Achats avec justificatif', `${model.facts.purchasesWithReceipt} / ${model.facts.purchasesTotal}`], ['Transactions bancaires rapprochées', model.bank.coverage === 'none' ? 'Aucune donnée bancaire dans Nordla' : `${model.facts.bankMatched} / ${model.facts.bankTransactions}`], ['Couverture bancaire de la période', { none: 'aucune', partial: 'partielle', full: 'complète' }[model.bank.coverage]], ['Caisse : rapprochement des espèces', 'non pris en charge']] },
        { heading: 'TVA indicative', rows: [VAT_WORDING, ['TVA collectée', e2(model.vat.collectedCents)], ['TVA sur achats validés', e2(model.vat.deductibleCents)], ['Solde indicatif', e2(model.vat.balanceCents), true], `Statut : ${model.vat.status === 'COMPLETE' ? 'COMPLET' : 'PARTIEL'}${model.vat.reasons.length ? ` (${model.vat.reasons.join(', ')})` : ''}`] },
        { heading: `Avertissements et éléments non résolus (${model.issues.length})`, rows: model.issues.map((i) => `[${i.level === 'blocking' ? 'BLOQUANT' : i.priority === 'critical' ? 'IMPORTANT' : 'AVERTISSEMENT'}] ${issueLabel(i)}${i.party ? ` — ${i.party}` : ''}${i.date ? ` — ${i.date}` : ''}${Number.isInteger(i.amountCents) ? ` — ${e2(i.amountCents)} ${i.currency ?? ''}` : ''}${i.ref ? ` — réf. ${i.ref}` : ''}`) },
        { heading: 'Traçabilité', rows: [`Chaque fichier de ce dossier est listé avec son empreinte SHA-256 dans ${CONTROL_FOLDER}/manifest.json (${fileList.length} fichiers hors manifest).`, 'L’empreinte du fichier ZIP est conservée dans l’historique des packs de Nordla.'] },
      ] }) });
    out.push({ path: 'LISEZMOI.txt', kind: 'txt', data: Buffer.from(readme(model, period, cur, version), 'utf8') });
  }
  return out;
}
const readme = (model, period, cur, version) => `PACK COMPTABLE NORDLA — ${packLabel(period)} (${version})
Période : ${period.start} au ${period.end}   Devise : ${cur}
État : ${CONTROL_STATE[model.verdict]} — ${model.counts.blocking} bloquant(s), ${model.counts.warnings} avertissement(s)

Contenu (un dossier par catégorie, à téléverser séparément dans votre logiciel comptable si besoin) :
${CATEGORIES.map((c) => `  ${c.folder}/   ${CAT_FR[c.id]}`).join('\n')}
  ${CONTROL_FOLDER}/   Rapport de contrôle, ce fichier, manifest.json (SHA-256 de chaque fichier)

Ce dossier est un dossier de préparation : il n’est pas au format d’import natif d’un logiciel comptable précis (WinBooks, etc.).
Les fichiers CSV / XLSX / PDF / UBL sont ceux générés par Nordla. La TVA est INDICATIVE.
${VAT_WORDING}
`;

/** Build the complete pack (numbered folders + 00_CONTROLE with report and SHA-256 manifest). */
export async function buildPackComptable({ input, model, include, version = 'v1.0' }) {
  const label = packLabel(input.period); const root = rootName(input.namePrefix || input.merchantName, label);
  const cats = await collectFiles(input, model, include); const all = [];
  for (const c of CATEGORIES) for (const f of cats.get(c.id)) all.push({ name: `${root}/${c.folder}/${f.path}`, data: f.data, kind: f.kind, category: c.id });
  const ctrl = await controlFiles(input, model, include, all, version);
  for (const f of ctrl) all.push({ name: `${root}/${CONTROL_FOLDER}/${f.path}`, data: f.data, kind: f.kind, category: 'control' });
  const manifest = {
    generatedAt: input.generatedAt, version, period: { start: input.period.start, end: input.period.end, label: input.period.label }, currency: input.currency,
    verdict: model.verdict, completeness: model.completeness, reconciliation: model.reconciliation, warnings: model.counts.warnings, blocking: model.counts.blocking,
    categories: model.categories.map((c) => ({ id: c.id, folder: c.folder, count: c.count, status: c.status })),
    files: all.map((f) => ({ path: f.name.slice(root.length + 1), size: f.data.length, sha256: sha(f.data) })),
  };
  all.push({ name: `${root}/${CONTROL_FOLDER}/manifest.json`, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), kind: 'json', category: 'control' });
  const zipped = zip(all.map((f) => ({ name: f.name, data: f.data })));
  return { fileName: `${root}.zip`, root, zip: zipped, sha256: sha(zipped), size: zipped.length, files: manifest.files, manifest, fileCount: all.length,
    counts: { invoices: input.invoices.length, creditNotes: input.creditNotes.length, purchases: model.facts.purchases, receipts: cats.get('receipts').filter((f) => f.kind === 'pdf').length, documents: input.invoices.length + input.creditNotes.length + model.facts.purchases } };
}

/** One category as its own ZIP (merchants often upload each category to their accounting software separately). Includes its own SHA-256 manifest. */
export async function buildCategoryPackage({ input, model, category, include }) {
  const def = cat(category); if (!def) throw Object.assign(new Error('CATEGORY_UNKNOWN'), { code: 'CATEGORY_UNKNOWN' });
  const c = model.categories.find((x) => x.id === category);
  if (!c.count) throw Object.assign(new Error('CATEGORY_EMPTY'), { code: 'CATEGORY_EMPTY' });
  const inc = normalizeInclude({ ...include, [category]: true, control: false });
  const files = (await collectFiles(input, model, inc)).get(category);
  const label = packLabel(input.period); const root = `${namePart(input.namePrefix || input.merchantName, 24) || 'Nordla'}_${def.file}_${label}`;
  const entries = files.map((f) => ({ name: `${root}/${f.path}`, data: f.data }));
  const manifest = { generatedAt: input.generatedAt, category, period: { start: input.period.start, end: input.period.end, label: input.period.label }, currency: input.currency, status: c.status, warnings: model.issues.filter((i) => i.category === category).length,
    files: entries.map((f) => ({ path: f.name.slice(root.length + 1), size: f.data.length, sha256: sha(f.data) })) };
  entries.push({ name: `${root}/manifest.json`, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  const zipped = zip(entries);
  return { fileName: `${root}.zip`, zip: zipped, sha256: sha(zipped), size: zipped.length, files: manifest.files, count: c.count, status: c.status };
}

/** Re-cut a category out of an already generated (stored) pack ZIP. */
export function categoryFromStoredZip(zipBuffer, category) {
  const def = cat(category); if (!def) throw Object.assign(new Error('CATEGORY_UNKNOWN'), { code: 'CATEGORY_UNKNOWN' });
  const entries = unzip(zipBuffer); const picked = [];
  let root = null;
  for (const [name, data] of entries) { const m = /^([^/]+)\/([^/]+)\/(.+)$/.exec(name); if (m && m[2] === def.folder) { root = m[1]; picked.push({ name: `${root.replace(/_Pack_Comptable_/, `_${def.file}_`)}/${m[3]}`, data }); } }
  if (!picked.length) throw Object.assign(new Error('CATEGORY_EMPTY'), { code: 'CATEGORY_EMPTY' });
  const out = root.replace(/_Pack_Comptable_/, `_${def.file}_`);
  const manifest = { category, derivedFromPack: root, files: picked.map((f) => ({ path: f.name.slice(out.length + 1), size: f.data.length, sha256: sha(f.data) })) };
  picked.push({ name: `${out}/manifest.json`, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  const zipped = zip(picked); return { fileName: `${out}.zip`, zip: zipped, sha256: sha(zipped), size: zipped.length };
}

// ---------- soft versioning ----------
/** A small, comparable snapshot of what a pack was built from (ids only - no amounts, no names). */
export function fingerprintOf(input) {
  const ids = (xs) => xs.map((x) => x).sort();
  return {
    invoices: ids(input.invoices.map((d) => d.doc.id)), creditNotes: ids(input.creditNotes.map((d) => d.doc.id)),
    purchases: input.purchases.map((r) => `${r.id}:${r.status}`).sort(), bankTransactions: input.bank.transactions.length,
    retail: { orders: input.pack.retail.orders, netCents: Math.round(input.pack.retail.net_sales * 100) }, refunds: input.refunds.length,
  };
}
/** What changed since a stored fingerprint: new documents, changed purchases, changed retail figures. null when nothing changed. */
export function changesSince(prev, cur) {
  if (!prev) return null;
  const added = (a, b) => b.filter((x) => !a.includes(x));
  const prevIds = new Set(prev.purchases.map((s) => s.split(':')[0]));
  const purchasesAdded = cur.purchases.filter((s) => !prevIds.has(s.split(':')[0])).length;
  const purchasesChanged = cur.purchases.filter((s) => prev.purchases.length && !prev.purchases.includes(s) && prevIds.has(s.split(':')[0])).length;
  const r = { newInvoices: added(prev.invoices, cur.invoices).length, newCreditNotes: added(prev.creditNotes, cur.creditNotes).length, newPurchases: purchasesAdded, changedPurchases: purchasesChanged,
    newBankTransactions: Math.max(0, cur.bankTransactions - prev.bankTransactions), retailChanged: prev.retail.orders !== cur.retail.orders || prev.retail.netCents !== cur.retail.netCents, newRefunds: Math.max(0, cur.refunds - prev.refunds) };
  r.newDocuments = r.newInvoices + r.newCreditNotes + r.newPurchases;
  return r.newDocuments || r.changedPurchases || r.newBankTransactions || r.retailChanged || r.newRefunds ? r : null;
}
/** History rows from the stored events (newest first). */
export function historyFromEvents(events) {
  return events.filter((e) => e.action === PACK_ACTION && e.detail).map((e) => ({ ...e.detail })).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)) || (b.version ?? 0) - (a.version ?? 0));
}
export const nextVersion = (rows, label) => rows.filter((r) => r.label === label).length + 1;
