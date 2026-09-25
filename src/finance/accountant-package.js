// One-click accountant closing package: ZIP with the period's sales summary, VAT, client invoices, credit notes, refunds,
// supplier invoices, reconciliation and anomalies. Every file is rendered from the SAME pack object (no second computation), and
// a manifest lists the SHA-256 of each file. Nothing here sends anything: sending is a separate, approval-gated step (mail.js).
//
// Folder and file names are French (first market: Belgium); the labels inside the PDFs are French.

import { REFUND_CSV_KEYS, refundCsvRows } from './refund-rows.js';
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { summaryLines } from './accountant-pack.js';
import { toCsv } from './export-csv.js';
import { formatCents } from './money.js';
import { renderDocumentPdf } from './pdf.js';
import { packFileBuffers } from './reports.js';
import { zip } from './xlsx.js';

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Month / quarter / year / custom period -> { start, end, label, kind }. Throws a coded error for anything else. */
export function resolvePeriod(spec = {}) {
  const y = Number(spec.year);
  const bad = (code) => Object.assign(new Error(code), { code });
  if (spec.kind === 'custom') {
    const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
    if (!ok(spec.from) || !ok(spec.to) || spec.to < spec.from) throw bad('PERIOD_INVALID');
    return { kind: 'custom', start: spec.from, end: spec.to, label: `${spec.from}_${spec.to}` };
  }
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw bad('PERIOD_INVALID');
  if (spec.kind === 'year') return { kind: 'year', start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  if (spec.kind === 'quarter') { const q = Number(spec.quarter); if (![1, 2, 3, 4].includes(q)) throw bad('PERIOD_INVALID'); const m0 = (q - 1) * 3 + 1; return { kind: 'quarter', start: `${y}-${pad(m0)}-01`, end: `${y}-${pad(m0 + 2)}-${lastDay(y, m0 + 2)}`, label: `Q${q}_${y}` }; }
  if (spec.kind === 'month') { const m = Number(spec.month); if (!Number.isInteger(m) || m < 1 || m > 12) throw bad('PERIOD_INVALID'); return { kind: 'month', start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${lastDay(y, m)}`, label: `${y}-${pad(m)}` }; }
  throw bad('PERIOD_INVALID');
}

const FR_LINE = {
  'Retail gross sales (shop + POS)': 'Ventes brutes retail (boutique + caisse)', 'Retail discounts': 'Remises retail', 'Retail product refunds': 'Remboursements produits retail', 'Retail product net sales incl. VAT': 'Ventes nettes produits retail TVAC',
  'Retail product VAT collected': 'TVA collectée produits retail', 'Retail product net sales excl. VAT': 'Ventes nettes produits retail HTVA',
  'Retail shipping charged incl. VAT': 'Livraison facturée retail TVAC', 'Retail shipping refunds incl. VAT': 'Remboursements livraison retail TVAC',
  'Retail shipping net excl. VAT (after refunds)': 'Livraison nette retail HTVA (après remboursements)', 'Retail shipping VAT collected (after refunds)': 'TVA collectée sur livraison retail (après remboursements)',
  'Retail refunds total (products + shipping + other)': 'Remboursements retail total (produits + livraison + autres)',
  'Retail net sales incl. VAT': 'Ventes nettes retail TVAC (produits + livraison)',
  'Retail VAT collected': 'TVA collectée retail (produits + livraison)', 'Retail net sales excl. VAT': 'Ventes nettes retail HTVA (produits + livraison)',
  '  of which POS excl. VAT (products + shipping)': '  dont caisse HTVA (produits + livraison)', '  of which online excl. VAT (products + shipping)': '  dont en ligne HTVA (produits + livraison)',
  'Standalone B2B net excl. VAT (invoices - credit notes)': 'B2B autonome net HTVA (factures - avoirs)', 'Standalone B2B VAT': 'TVA B2B autonome', 'Standalone B2B incl. VAT': 'B2B autonome TVAC',
  'Linked invoices (documentation only, NOT added)': 'Factures liées (documentation seulement, NON ajoutées)', 'TOTAL sales excl. VAT': 'TOTAL ventes HTVA', 'TOTAL VAT collected': 'TOTAL TVA collectée', 'TOTAL sales incl. VAT': 'TOTAL ventes TVAC',
};
const FR_REASON = (r) => r;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const collect = (pdf) => new Promise((resolve, reject) => { const chunks = []; pdf.on('data', (c) => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

/** Generic French report PDF: title, subtitle, sections of label/value rows or plain lines. */
export async function renderReportPdf({ title, subtitle, sections, branding = {}, footer = '' }) {
  const pdf = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: title } });
  const done = collect(pdf);
  const accent = branding.accent ?? '#183247';
  pdf.font('Helvetica-Bold').fontSize(16).fillColor(accent).text(title);
  if (subtitle) pdf.font('Helvetica').fontSize(9).fillColor('#444444').text(subtitle);
  pdf.moveDown(0.8);
  for (const s of sections) {
    if (pdf.y > 720) pdf.addPage();
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(accent).text(s.heading); pdf.moveDown(0.2);
    pdf.font('Helvetica').fontSize(9).fillColor('#111111');
    for (const r of s.rows) {
      if (pdf.y > 760) pdf.addPage();
      if (Array.isArray(r)) { const y = pdf.y; pdf.font(r[2] ? 'Helvetica-Bold' : 'Helvetica').text(String(r[0]), 50, y, { width: 330 }).text(String(r[1]), 390, y, { width: 155, align: 'right' }); pdf.font('Helvetica'); } else pdf.text(String(r), 50, pdf.y, { width: 495 });
    }
    if (!s.rows.length) pdf.fillColor('#666666').text('Aucun élément.').fillColor('#111111');
    pdf.moveDown(0.7);
  }
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) { pdf.switchToPage(range.start + i); pdf.font('Helvetica').fontSize(7.5).fillColor('#777777').text(`${footer}${footer ? '   ' : ''}Page ${i + 1} / ${range.count}`, 50, 800, { width: 495, align: 'center', lineBreak: false }); }
  pdf.end();
  return done;
}

const STATUS_FR = { COMPLETE: 'COMPLET', PARTIAL: 'PARTIEL', CLEAN: 'CONFORME', REVIEW_REQUIRED: 'À VÉRIFIER' };

/**
 * @param {{pack: object, period: object, docs: Array<{doc: object, settlement: object|null, originalNumber: string|null}>, refunds: object[], supplierInvoices: object[],
 *          merchantName: string, branding?: object, filePrefix?: string}} input
 * @returns {Promise<{fileName: string, zip: Buffer, files: Array<{path: string, size: number, sha256: string}>, sha256: string, counts: object, completeness: string}>}
 */
export async function buildAccountantPackage({ pack, period, docs, refunds = [], supplierInvoices = [], merchantName = '', namePrefix, branding = {}, filePrefix = 'Comptabilite', generatedAt = new Date().toISOString() }) {
  const L = period.label;
  const root = `${(namePrefix || merchantName || 'Societe').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Societe'}_${filePrefix}_${L}`;
  const sub = `${merchantName}   Période : ${period.start} au ${period.end}   Devise : ${pack.currency}`;
  const files = [];
  const add = (path, data) => files.push({ name: `${root}/${path}`, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
  const base = await packFileBuffers(pack, { branding, merchantName });
  const stem = `accountant-pack_${pack.period.start}_${pack.period.end}`;

  // 00 summary
  const lines = summaryLines(pack);
  add(`00_Resume_${L}.pdf`, await renderReportPdf({
    title: `Dossier comptable ${L.replace('_', ' ')} - résumé`, subtitle: `${sub}   Généré : ${generatedAt}`, branding, footer: merchantName,
    sections: [
      { heading: 'Complétude et rapprochement', rows: [['Complétude', STATUS_FR[pack.completeness.status] ?? pack.completeness.status, true], ['Rapprochement', STATUS_FR[pack.reconciliation.status] ?? pack.reconciliation.status, true], ...pack.completeness.reasons.map((r) => `• ${FR_REASON(r)}`)] },
      { heading: 'Ventes', rows: lines.map((r) => [FR_LINE[r.line] ?? r.line, `${r.amount} ${pack.currency}`, r.line.startsWith('TOTAL')]) },
      { heading: 'Nombre de documents', rows: [['Factures clients (période)', docs.filter((d) => d.doc.type === 'invoice').length], ['Avoirs (période)', docs.filter((d) => d.doc.type === 'credit_note').length], ['Remboursements retail (période)', refunds.length], ['Factures fournisseurs (période)', supplierInvoices.length]] },
      { heading: 'Statut de paiement des factures B2B émises dans la période', rows: Object.entries(pack.payment_status_of_period_invoices).map(([k, v]) => [k, `${v.count} facture(s) - ${formatCents(v.cents)}`]) },
    ],
  }));
  // 01 / 02 sales workbook and csv (the very same rows as the accountant pack)
  add(`01_Ventes_${L}.xlsx`, base.get(`${stem}.xlsx`).data);
  add(`02_Ventes_${L}.csv`, base.get(`${stem}_summary.csv`).data);
  // 03 VAT
  const rate = (g) => [`Taux ${g.vatRateBp / 100} %  -  base ${formatCents(g.taxableCents)}`, `TVA ${formatCents(g.vatCents)}`];
  add(`03_TVA_${L}.pdf`, await renderReportPdf({
    title: `TVA ${L.replace('_', ' ')}`, subtitle: sub, branding, footer: merchantName,
    sections: [
      { heading: `TVA retail par taux (${STATUS_FR[pack.retail.vat_by_rate.status] ?? pack.retail.vat_by_rate.status})`, rows: [...pack.retail.vat_by_rate.by_rate.map(rate), ...(pack.retail.vat_by_rate.unavailable ? [`Indisponible : ${pack.retail.vat_by_rate.unavailable.lines} ligne(s) sans taux de TVA enregistré (base ${formatCents(pack.retail.vat_by_rate.unavailable.taxableCents)}, TVA ${formatCents(pack.retail.vat_by_rate.unavailable.vatCents)}).`] : [])] },
      { heading: 'TVA des documents B2B autonomes', rows: pack.vat_by_rate_b2b.map(rate) },
      { heading: 'Traitements particuliers B2B (exonéré / autoliquidation)', rows: pack.vat_summary.b2b.by_treatment.filter((t) => t.exemptOrReverseCharge).map((t) => [`${t.regime}`, `base ${formatCents(t.taxableCents)}`]) },
      { heading: 'Totaux', rows: [['Ventes HTVA', formatCents(pack.totals.sales_ex_vat_cents), true], ['TVA collectée', formatCents(pack.totals.vat_collected_cents), true], ['Ventes TVAC', formatCents(pack.totals.sales_incl_vat_cents), true]] },
    ],
  }));
  // 04 client invoices, 05 credit notes: the issued PDFs themselves, plus a list
  const invoices = docs.filter((d) => d.doc.type === 'invoice'); const credits = docs.filter((d) => d.doc.type === 'credit_note');
  for (const d of invoices) add(`04_Factures_clients/${d.doc.number}.pdf`, await renderDocumentPdf(d.doc, { settlement: d.settlement, branding }));
  add('04_Factures_clients/liste.csv', base.get(`${stem}_documents.csv`).data);
  for (const d of credits) add(`05_Avoirs/${d.doc.number}.pdf`, await renderDocumentPdf(d.doc, { originalNumber: d.originalNumber, branding }));
  // 06 refunds (retail): dates and amounts only, no customer data
  add(`06_Remboursements/remboursements_${L}.csv`, toCsv(refundCsvRows(refunds), REFUND_CSV_KEYS.map((k) => ({ key: k, header: k }))));
  // 07 supplier invoices (list; attachments join here once private document storage is connected)
  add(`07_Factures_fournisseurs/liste_${L}.csv`, toCsv(supplierInvoices.map((s) => ({ fournisseur: s.supplierName, tva_fournisseur: s.supplierVatNumber ?? '', numero: s.invoiceNumber, date: s.issueDate, echeance: s.dueDate ?? '', htva: formatCents(s.netCents), tva: formatCents(s.vatCents), tvac: formatCents(s.grossCents), statut: s.status ?? s.paymentStatus, source: s.source, piece: s.attachmentRef ? 'oui' : 'non' })),
    ['fournisseur', 'tva_fournisseur', 'numero', 'date', 'echeance', 'htva', 'tva', 'tvac', 'statut', 'source', 'piece'].map((k) => ({ key: k, header: k }))));
  // 08 reconciliation, 09 anomalies and completeness
  add(`08_Rapprochement_${L}.pdf`, await renderReportPdf({
    title: `Rapprochement ${L.replace('_', ' ')}`, subtitle: sub, branding, footer: merchantName,
    sections: [
      { heading: 'Règle', rows: ['Une vente boutique/caisse est comptée une seule fois, depuis Retail Core. Seules les factures déclarées « B2B autonome » s\'ajoutent au chiffre d\'affaires.'] },
      { heading: 'Résultat', rows: [['Statut', STATUS_FR[pack.reconciliation.status] ?? pack.reconciliation.status, true], ['Documents liés (non ajoutés)', pack.reconciliation.linked_documents_excluded], ['Documents B2B autonomes (ajoutés)', pack.reconciliation.standalone_documents_added], ['Doublons suspects', pack.reconciliation.suspected_duplicates]] },
      { heading: 'Devis de la période (jamais comptés comme chiffre d\'affaires)', rows: [['Nombre', pack.quotes_in_period.count]] },
    ],
  }));
  add(`09_Anomalies_et_completude_${L}.pdf`, await renderReportPdf({
    title: `Anomalies et complétude ${L.replace('_', ' ')}`, subtitle: sub, branding, footer: merchantName,
    sections: [
      { heading: 'Complétude', rows: [['Statut', STATUS_FR[pack.completeness.status] ?? pack.completeness.status, true], ...pack.completeness.reasons.map((r) => `• ${FR_REASON(r)}`)] },
      { heading: `Anomalies (${pack.anomalies.length})`, rows: pack.anomalies.map((a) => `[${a.severity}] ${a.code} : ${a.detail}`) },
      { heading: 'Définitions', rows: [pack.definitions] },
    ],
  }));
  const manifest = { generatedAt, period: { start: period.start, end: period.end, label: L }, currency: pack.currency, completeness: pack.completeness.status, reconciliation: pack.reconciliation.status, files: files.map((f) => ({ path: f.name.slice(root.length + 1), size: f.data.length, sha256: sha(f.data) })) };
  add('manifest.json', JSON.stringify(manifest, null, 2));
  const zipped = zip(files);
  return { fileName: `${root}.zip`, zip: zipped, files: manifest.files, sha256: sha(zipped), completeness: pack.completeness.status, counts: { invoices: invoices.length, creditNotes: credits.length, refunds: refunds.length, supplierInvoices: supplierInvoices.length } };
}
