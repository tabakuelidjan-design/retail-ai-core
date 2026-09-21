// PDF rendering for quotes, invoices, credit notes and the accountant-pack summary.
// Layout only: every number printed is taken from the document's deterministic totals. Branding (logo, footer, bank
// details, language) is merchant configuration passed in, never hardcoded here. Unissued documents carry a DRAFT mark.

import { existsSync, readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { fromScaled, formatCents } from './money.js';
import { summaryLines } from './accountant-pack.js';

const L = {
  fr: { quote: 'DEVIS', invoice: 'FACTURE', credit_note: 'NOTE DE CRÉDIT', draft: 'BROUILLON', number: 'N°', date: 'Date', due: 'Échéance', valid: 'Valable jusqu’au', customer: 'Client', vat: 'TVA', company: 'N° d’entreprise',
    desc: 'Description', qty: 'Qté', unit: 'Prix unit.', disc: 'Remise', rate: 'TVA', net: 'Montant HT', totals: 'Totaux', totalNet: 'Total HT', totalVat: 'Total TVA', totalGross: 'Total TTC', rounding: 'Arrondi', paymentDue: 'À payer',
    pay: 'Paiement', iban: 'IBAN', bic: 'BIC', ref: 'Communication', terms: 'Conditions de paiement', notes: 'Remarques', original: 'Facture d’origine', reason: 'Motif', breakdown: 'Détail TVA', taxable: 'Base', page: 'Page' },
  nl: { quote: 'OFFERTE', invoice: 'FACTUUR', credit_note: 'CREDITNOTA', draft: 'CONCEPT', number: 'Nr.', date: 'Datum', due: 'Vervaldatum', valid: 'Geldig tot', customer: 'Klant', vat: 'BTW', company: 'Ondernemingsnr.',
    desc: 'Omschrijving', qty: 'Aantal', unit: 'Eenh.prijs', disc: 'Korting', rate: 'BTW', net: 'Bedrag excl.', totals: 'Totalen', totalNet: 'Totaal excl. BTW', totalVat: 'Totaal BTW', totalGross: 'Totaal incl. BTW', rounding: 'Afronding', paymentDue: 'Te betalen',
    pay: 'Betaling', iban: 'IBAN', bic: 'BIC', ref: 'Mededeling', terms: 'Betalingsvoorwaarden', notes: 'Opmerkingen', original: 'Oorspronkelijke factuur', reason: 'Reden', breakdown: 'BTW-detail', taxable: 'Basis', page: 'Pagina' },
  en: { quote: 'QUOTE', invoice: 'INVOICE', credit_note: 'CREDIT NOTE', draft: 'DRAFT', number: 'No.', date: 'Date', due: 'Due date', valid: 'Valid until', customer: 'Customer', vat: 'VAT', company: 'Company no.',
    desc: 'Description', qty: 'Qty', unit: 'Unit price', disc: 'Discount', rate: 'VAT', net: 'Net amount', totals: 'Totals', totalNet: 'Total excl. VAT', totalVat: 'Total VAT', totalGross: 'Total incl. VAT', rounding: 'Rounding', paymentDue: 'Amount due',
    pay: 'Payment', iban: 'IBAN', bic: 'BIC', ref: 'Reference', terms: 'Payment terms', notes: 'Notes', original: 'Original invoice', reason: 'Reason', breakdown: 'VAT breakdown', taxable: 'Taxable', page: 'Page' },
};

export const labels = (lang) => L[lang] ?? L.fr;

/** Belgian structured communication (+++xxx/xxxx/xxxxx+++): 10 base digits + 2 check digits (mod 97). */
export function structuredCommunication(number) {
  const digits = String(number).replace(/\D/g, '');
  if (!digits) return null;
  const base = digits.slice(-10).padStart(10, '0');
  const rem = Number(BigInt(base) % 97n);
  const check = String(rem === 0 ? 97 : rem).padStart(2, '0');
  const all = base + check;
  return `+++${all.slice(0, 3)}/${all.slice(3, 7)}/${all.slice(7)}+++`;
}

export const money = (cents, lang = 'fr') => {
  const s = formatCents(cents);
  const [i, d] = s.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'en' ? ',' : ' ');
  return `${grouped}${lang === 'en' ? '.' : ','}${d}`;
};
/** Unit price shown with at least 2 and at most 4 decimals, exactly as entered (never rounded on the page). */
export const unitPrice = (micro, lang) => { const [i, d] = fromScaled(micro, 4).split('.'); const dec = d.replace(/0+$/, '').padEnd(2, '0'); return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'en' ? ',' : ' ')}${lang === 'en' ? '.' : ','}${dec}`; };
const pct = (bp, lang) => `${fromScaled(bp, 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1').replace('.', lang === 'en' ? '.' : ',')}%`;

function collect(doc) {
  return new Promise((resolve, reject) => { const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
}

function footerAndPages(pdf, footerText, t) {
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    pdf.page.margins.bottom = 0; // footer sits inside the bottom margin: without this pdfkit would add a blank page
    pdf.fontSize(7).fillColor('#666666');
    if (footerText) pdf.text(footerText, 50, 780, { width: 495, align: 'center', lineBreak: true });
    pdf.text(`${t.page} ${i + 1}/${range.count}`, 50, 815, { width: 495, align: 'right' });
  }
}

/**
 * @param {object} doc a finance document
 * @param {{settlement?: object, originalNumber?: string|null, branding?: object}} opts
 * branding: { logoPath?, footer?, accent?, structuredCommunication?: boolean, paymentInstructions? }
 * @returns {Promise<Buffer>}
 */
export async function renderDocumentPdf(doc, { settlement = null, originalNumber = null, branding = {} } = {}) {
  const lang = doc.language ?? 'fr';
  const t = labels(lang);
  const accent = branding.accent ?? '#183247';
  const pdf = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `${t[doc.type]} ${doc.number ?? t.draft}`, Author: doc.seller?.name ?? '' } });
  const done = collect(pdf);
  const s = doc.seller ?? {};
  const c = doc.customer ?? {};

  if (branding.logoPath && existsSync(branding.logoPath)) { try { pdf.image(readFileSync(branding.logoPath), 50, 45, { fit: [120, 50] }); } catch { /* an unreadable logo must never block an invoice */ } }
  pdf.fillColor('#111111').fontSize(9);
  const sellerX = 50;
  const y0 = branding.logoPath ? 100 : 50;
  pdf.font('Helvetica-Bold').text(s.name ?? '', sellerX, y0).font('Helvetica');
  pdf.text(`${s.address?.street ?? ''}`).text(`${s.address?.postalCode ?? ''} ${s.address?.city ?? ''} ${s.address?.countryCode ?? ''}`.trim());
  if (s.vatNumber) pdf.text(`${t.vat}: ${s.vatNumber}`);
  if (s.enterpriseNumber) pdf.text(`${t.company}: ${s.enterpriseNumber}`);
  if (s.email) pdf.text(s.email);

  pdf.font('Helvetica-Bold').fontSize(20).fillColor(accent).text(t[doc.type], 330, 50, { width: 215, align: 'right' });
  pdf.fontSize(9).fillColor('#111111').font('Helvetica');
  const meta = [[t.number, doc.number ?? '—'], [t.date, doc.issueDate ?? ''], ...(doc.type === 'quote' ? [[t.valid, doc.validUntil ?? '—']] : [[t.due, doc.dueDate ?? '']])];
  if (doc.type === 'credit_note' && originalNumber) meta.push([t.original, originalNumber]);
  let my = 80;
  for (const [k, v] of meta) { pdf.text(`${k}: ${v}`, 330, my, { width: 215, align: 'right' }); my += 13; }

  const cy = Math.max(pdf.y, my) + 20;
  pdf.font('Helvetica-Bold').fillColor(accent).text(t.customer, 50, cy).font('Helvetica').fillColor('#111111');
  pdf.text(c.name ?? '', 50, cy + 13).text(c.address?.street ?? '').text(`${c.address?.postalCode ?? ''} ${c.address?.city ?? ''} ${c.address?.countryCode ?? ''}`.trim());
  if (c.vatNumber) pdf.text(`${t.vat}: ${c.vatNumber}`);
  else if (c.enterpriseNumber) pdf.text(`${t.company}: ${c.enterpriseNumber}`);

  // lines
  const cols = [{ w: 185, k: 'desc', a: 'left' }, { w: 45, k: 'qty', a: 'right' }, { w: 70, k: 'unit', a: 'right' }, { w: 45, k: 'disc', a: 'right' }, { w: 45, k: 'rate', a: 'right' }, { w: 105, k: 'net', a: 'right' }];
  let y = pdf.y + 24;
  const head = () => { let x = 50; pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent); for (const col of cols) { pdf.text(t[col.k], x, y, { width: col.w - 4, align: col.a }); x += col.w; } y += 14; pdf.moveTo(50, y - 3).lineTo(545, y - 3).strokeColor(accent).lineWidth(0.7).stroke(); pdf.font('Helvetica').fillColor('#111111'); };
  head();
  for (const l of doc.totals.lines) {
    const dh = pdf.heightOfString(l.description, { width: cols[0].w - 6 });
    if (y + dh > 700) { pdf.addPage(); y = 50; head(); }
    let x = 50;
    const cells = { desc: l.description, qty: fromScaled(l.qtyMilli, 3).replace(/\.?0+$/, '') || '0', unit: unitPrice(l.priceMicro, lang), disc: l.discountBp ? pct(l.discountBp, lang) : l.discountCents ? money(l.discountCents, lang) : '', rate: pct(l.vatRateBp, lang), net: money(l.netCents, lang) };
    for (const col of cols) { pdf.fontSize(8.5).text(cells[col.k], x, y, { width: col.w - 6, align: col.a }); x += col.w; }
    y += Math.max(dh, 11) + 5;
  }
  pdf.moveTo(50, y).lineTo(545, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
  y += 10;

  // totals + VAT breakdown
  if (y > 640) { pdf.addPage(); y = 50; }
  pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent).text(t.breakdown, 50, y);
  let by = y + 12;
  pdf.font('Helvetica').fillColor('#111111').fontSize(8);
  for (const g of doc.totals.vatBreakdown) { pdf.text(`${pct(g.vatRateBp, lang)}  ${t.taxable} ${money(g.taxableCents, lang)}  ${t.vat} ${money(g.vatCents, lang)}`, 50, by); by += 11; }
  let ty = y;
  const row = (label, value, bold) => { pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor('#111111'); pdf.text(label, 340, ty, { width: 110 }); pdf.text(`${value} ${doc.currency}`, 445, ty, { width: 100, align: 'right' }); ty += bold ? 16 : 13; };
  row(t.totalNet, money(doc.totals.netCents, lang)); row(t.totalVat, money(doc.totals.vatCents, lang)); row(t.totalGross, money(doc.totals.grossCents, lang), !doc.totals.roundingCents);
  if (doc.totals.roundingCents) { row(t.rounding, money(doc.totals.roundingCents, lang)); row(t.paymentDue, money(doc.totals.grossCents + doc.totals.roundingCents, lang), true); }
  else if (settlement && doc.type === 'invoice') row(t.paymentDue, money(settlement.remainingCents, lang), true);
  y = Math.max(by, ty) + 14;

  if (doc.vat.mention) { pdf.font('Helvetica-Oblique').fontSize(8.5).fillColor('#111111').text(doc.vat.mention, 50, y, { width: 495 }); y = pdf.y + 8; }
  if (doc.type === 'credit_note' && doc.creditReason) { pdf.font('Helvetica').fontSize(8.5).text(`${t.reason}: ${doc.creditReason}`, 50, y, { width: 495 }); y = pdf.y + 8; }
  if (doc.type !== 'quote') {
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent).text(t.pay, 50, y); y += 12;
    pdf.font('Helvetica').fontSize(8.5).fillColor('#111111');
    if (s.iban) pdf.text(`${t.iban}: ${s.iban}${s.bic ? `   ${t.bic}: ${s.bic}` : ''}`, 50, y);
    if (branding.structuredCommunication && doc.number && doc.type === 'invoice') pdf.text(`${t.ref}: ${structuredCommunication(doc.number)}`);
    else if (doc.number && doc.type === 'invoice') pdf.text(`${t.ref}: ${doc.number}`);
    if (doc.paymentTerms) pdf.text(`${t.terms}: ${doc.paymentTerms}`, { width: 495 });
    if (branding.paymentInstructions) pdf.text(branding.paymentInstructions, { width: 495 });
    y = pdf.y + 8;
  }
  if (doc.notes) { pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent).text(t.notes, 50, y); pdf.font('Helvetica').fontSize(8.5).fillColor('#111111').text(doc.notes, 50, pdf.y + 2, { width: 495 }); }

  const range = pdf.bufferedPageRange();
  if (!doc.lockedAt && doc.status !== 'SENT') {
    for (let i = 0; i < range.count; i++) { pdf.switchToPage(range.start + i); pdf.save().rotate(-35, { origin: [300, 420] }).fontSize(64).fillColor('#dd0000', 0.13).font('Helvetica-Bold').text(t.draft, 60, 400, { width: 480, align: 'center', lineBreak: false }).restore(); }
  }
  footerAndPages(pdf, branding.footer, t);
  pdf.end();
  return done;
}

/** One-page(ish) accountant summary that prints exactly the numbers in the pack. */
export async function renderPackSummaryPdf(pack, { branding = {}, merchantName = '' } = {}) {
  const pdf = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `Accountant pack ${pack.period.start} - ${pack.period.end}` } });
  const done = collect(pdf);
  const accent = branding.accent ?? '#183247';
  pdf.font('Helvetica-Bold').fontSize(16).fillColor(accent).text('Accountant pack — sales summary');
  pdf.font('Helvetica').fontSize(9).fillColor('#111111').text(`${merchantName}   Period: ${pack.period.start} to ${pack.period.end} (${pack.period.timeZone})   Currency: ${pack.currency}`);
  pdf.text(`Generated: ${pack.generated_at}   Completeness: ${pack.completeness.status}   Reconciliation: ${pack.reconciliation.status}`);
  pdf.moveDown(0.6);
  for (const r of pack.completeness.reasons) pdf.fillColor('#aa5500').text(`• ${r}`);
  pdf.fillColor('#111111').moveDown(0.6);
  let y = pdf.y;
  for (const r of summaryLines(pack)) { const bold = r.line.startsWith('TOTAL'); pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(r.line, 50, y, { width: 290 }).text(r.source, 340, y, { width: 110 }).text(r.amount, 450, y, { width: 95, align: 'right' }); y += 14; }
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(accent).text('VAT of standalone B2B documents', 50, y + 8); y = pdf.y + 4;
  pdf.font('Helvetica').fontSize(9).fillColor('#111111');
  for (const g of pack.vat_by_rate_b2b) { pdf.text(`${g.vatRateBp / 100}%   base ${formatCents(g.taxableCents)}   VAT ${formatCents(g.vatCents)}`, 50, y); y += 12; }
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(accent).text(`Retail VAT by rate (${pack.retail.vat_by_rate.status})`, 50, y + 6); y = pdf.y + 4;
  pdf.font('Helvetica').fontSize(9).fillColor('#111111');
  for (const g of pack.retail.vat_by_rate.by_rate) { pdf.text(`${g.vatRateBp / 100}%   base ${formatCents(g.taxableCents)}   VAT ${formatCents(g.vatCents)}`, 50, y); y += 12; }
  if (pack.retail.vat_by_rate.unavailable) { pdf.fillColor('#aa5500').text(`Unavailable: ${pack.retail.vat_by_rate.unavailable.lines} line(s), base ${formatCents(pack.retail.vat_by_rate.unavailable.taxableCents)}, VAT ${formatCents(pack.retail.vat_by_rate.unavailable.vatCents)}`, 50, y); y = pdf.y + 4; pdf.fillColor('#111111'); }
  for (const t of pack.vat_summary.b2b.by_treatment.filter((x) => x.exemptOrReverseCharge)) { pdf.text(`B2B ${t.regime}: base ${formatCents(t.taxableCents)} (VAT ${formatCents(t.vatCents)})`, 50, y); y += 12; }
  y = pdf.y + 8;
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(accent).text('Payment status of B2B invoices issued in the period', 50, y); y = pdf.y + 4;
  pdf.font('Helvetica').fontSize(9).fillColor('#111111');
  for (const [k, v] of Object.entries(pack.payment_status_of_period_invoices)) { pdf.text(`${k}: ${v.count} invoice(s), ${formatCents(v.cents)}`, 50, y); y += 12; }
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(accent).text('Sources', 50, y + 6); y = pdf.y + 4;
  pdf.font('Helvetica').fontSize(9).fillColor('#111111');
  for (const sYs of pack.source_systems) pdf.text(`${sYs.system}: ${sYs.role}`, 50);
  pdf.moveDown(0.5).font('Helvetica-Bold').fontSize(10).fillColor(accent).text(`Unresolved anomalies (${pack.anomalies.length})`);
  pdf.font('Helvetica').fontSize(8.5).fillColor('#111111');
  for (const a of pack.anomalies.slice(0, 25)) pdf.text(`[${a.severity}] ${a.code}: ${a.detail}`, { width: 495 });
  if (!pack.anomalies.length) pdf.text('None detected.');
  pdf.moveDown(0.5).fontSize(7.5).fillColor('#666666').text(pack.definitions, { width: 495 });
  footerAndPages(pdf, branding.footer, labels('en'));
  pdf.end();
  return done;
}
