// Refined rendering of the validated model A « Classique » for quotes, invoices and credit notes.
// Separate module on purpose: documents already issued keep the rendering of src/finance/pdf.js (renderDocumentPdf).
// Layout only: every amount comes from the document's deterministic totals. Palette = HABB/Nordla tokens (navy, sable, crème).
// No gradients, no shadows, no decorative ornaments.

import PDFDocument from 'pdfkit';
import { fromScaled } from './money.js';
import { labels, money, unitPrice, structuredCommunication } from './pdf.js';
import { buildEpcPayload, epcQrPng } from './epc-qr.js';

const C = { navy: '#0f2a52', ink: '#1b2430', muted: '#5b6573', sable: '#e8eef5', creme: '#f4f7fb', line: '#d5dde8', white: '#ffffff' };
const L = 50; const R = 545; const W = R - L;

const rate = (bp, lang) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0).replace('.', lang === 'en' ? '.' : ',')} %`;
const qty = (milli) => fromScaled(milli, 3).replace(/\.?0+$/, '') || '0';

const T = {
  fr: { lu: 'Lu et approuvé', date: 'Date', sign: 'Signature et cachet', client: 'CLIENT', pay: 'PAIEMENT', conditions: 'CONDITIONS', breakdown: 'DÉTAIL TVA', demo: 'Document de démonstration fictif',
    head: { desc: 'Description', qty: 'Qté', unit: 'Prix HTVA', disc: 'Remise', rate: 'TVA', net: 'Montant HTVA' }, totalNet: 'Total HTVA', totalVat: 'Total TVA', totalGross: 'Total TTC' },
  en: { lu: 'Read and approved', date: 'Date', sign: 'Signature and stamp', client: 'CUSTOMER', pay: 'PAYMENT', conditions: 'TERMS', breakdown: 'VAT BREAKDOWN', demo: 'Fictitious demonstration document',
    head: { desc: 'Description', qty: 'Qty', unit: 'Unit excl. VAT', disc: 'Discount', rate: 'VAT', net: 'Amount excl. VAT' }, totalNet: 'Total excl. VAT', totalVat: 'Total VAT', totalGross: 'Total incl. VAT' },
};

function collect(doc) {
  return new Promise((resolve, reject) => { const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
}

/**
 * @param {object} doc finance document (quote, invoice or credit_note), already computed/locked
 * @param {{originalNumber?: string|null, branding?: {footer?: string, structuredCommunication?: boolean, paymentInstructions?: string, accent?: string}}} opts
 * @returns {Promise<Buffer>}
 */
export async function renderClassicPdf(doc, { originalNumber = null, branding = {}, paymentReference = null } = {}) {
  const lang = doc.language ?? 'fr';
  const t = labels(lang); const x = T[lang] ?? T.fr;
  const pdf = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `${t[doc.type]} ${doc.number ?? t.draft}`, Author: doc.seller?.name ?? '' } });
  const done = collect(pdf);
  const s = doc.seller ?? {}; const c = doc.customer ?? {};
  const isQuote = doc.type === 'quote'; const isCredit = doc.type === 'credit_note';
  const cur = doc.currency;

  // ---- header: seller left, document title + meta right
  pdf.rect(L, 30, W, 2.2).fill(C.navy);
  pdf.rect(L, 44, 4, 46).fill(C.navy);
  pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(15).text((s.name ?? '').toUpperCase(), L + 14, 46, { width: 230 });
  pdf.fillColor(C.muted).font('Helvetica').fontSize(8.5);
  const sellerLines = [s.address?.street, `${s.address?.postalCode ?? ''} ${s.address?.city ?? ''}`.trim(), s.address?.countryCode, s.vatNumber ? `TVA ${s.vatNumber}` : null, s.enterpriseNumber ? `${t.company} ${s.enterpriseNumber}` : null, s.phone, s.email].filter(Boolean);
  pdf.text(sellerLines.join('\n'), L + 14, 66, { width: 230, lineGap: 1.5 });

  pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(26).text(t[doc.type].toUpperCase(), 300, 42, { width: R - 300, align: 'right' });
  if (!doc.lockedAt && doc.status !== 'SENT') pdf.fillColor('#b03a2e').font('Helvetica-Bold').fontSize(8).text(t.draft, 300, 74, { width: R - 300, align: 'right' });

  const meta = [[t.number, doc.number ?? '—'], [t.date, doc.issueDate ?? '']];
  if (isQuote) meta.push([t.valid, doc.validUntil ?? '—']);
  else if (!isCredit) meta.push([t.due, doc.dueDate ?? '']);
  if (isCredit && originalNumber) meta.push([t.original, originalNumber]);
  if (isCredit && doc.creditReason) meta.push([t.reason, doc.creditReason]);
  const mh = 16 * meta.length + 14;
  pdf.rect(300, 96, R - 300, mh).fill(C.sable);
  let my = 105;
  for (const [k, v] of meta) {
    pdf.fillColor(C.muted).font('Helvetica').fontSize(8).text(k, 312, my, { width: 110 });
    pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(9).text(String(v), 400, my, { width: R - 412, align: 'right' });
    my += 16;
  }

  // ---- client box
  const cy = 96 + mh + 22;
  pdf.rect(L, cy, 235, 96).fill(C.creme).strokeColor(C.line).lineWidth(0.6).stroke();
  pdf.rect(L, cy, 3, 96).fill(C.navy);
  pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(7.5).text(x.client, L + 14, cy + 10, { characterSpacing: 1 });
  pdf.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(c.name ?? '', L + 14, cy + 24, { width: 210 });
  pdf.font('Helvetica').fontSize(8.5).fillColor(C.ink).text([c.address?.street, `${c.address?.postalCode ?? ''} ${c.address?.city ?? ''}`.trim(), c.address?.countryCode, c.vatNumber ? `TVA ${c.vatNumber}` : (c.enterpriseNumber ? `${t.company} ${c.enterpriseNumber}` : null)].filter(Boolean).join('\n'), L + 14, pdf.y + 2, { width: 210, lineGap: 1 });

  // ---- lines table
  const cols = [{ w: 205, k: 'desc', a: 'left' }, { w: 45, k: 'qty', a: 'right' }, { w: 62, k: 'unit', a: 'right' }, { w: 50, k: 'disc', a: 'right' }, { w: 40, k: 'rate', a: 'right' }, { w: 93, k: 'net', a: 'right' }];
  let ty = cy + 124;
  const head = () => {
    pdf.rect(L, ty, W, 20).fill(C.navy);
    let hx = L + 6;
    pdf.fillColor(C.white).font('Helvetica-Bold').fontSize(7.5);
    for (const col of cols) { pdf.text(x.head[col.k] ?? col.k, hx, ty + 7, { width: col.w - 12, align: col.a }); hx += col.w; }
    ty += 24;
  };
  head();
  pdf.font('Helvetica').fontSize(8.5).fillColor(C.ink);
  for (const l of doc.totals.lines) {
    const dh = pdf.heightOfString(l.description, { width: cols[0].w - 12 });
    if (ty + dh > 640) { pdf.addPage(); ty = 50; head(); pdf.font('Helvetica').fontSize(8.5).fillColor(C.ink); }
    const cells = { desc: l.description, qty: qty(l.qtyMilli), unit: unitPrice(l.priceMicro, lang), disc: l.discountBp ? rate(l.discountBp, lang).replace(' %', '%') : l.discountCents ? money(l.discountCents, lang) : '', rate: rate(l.vatRateBp, lang), net: money(l.netCents, lang) };
    let rx = L + 6;
    for (const col of cols) { pdf.text(cells[col.k], rx, ty, { width: col.w - 12, align: col.a }); rx += col.w; }
    ty += Math.max(dh, 11) + 11;
    pdf.moveTo(L, ty - 5.5).lineTo(R, ty - 3.5).strokeColor(C.line).lineWidth(0.5).stroke();
  }

  // ---- VAT breakdown (left) + totals block (right)
  ty += 14;
  if (ty > 610) { pdf.addPage(); ty = 50; }
  pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(7.5).text(x.breakdown, L, ty, { characterSpacing: 1 });
  let by = ty + 14;
  pdf.font('Helvetica').fontSize(8.5).fillColor(C.ink);
  for (const g of doc.totals.vatBreakdown) {
    pdf.text(`${rate(g.vatRateBp, lang)}`, L, by, { width: 40 });
    pdf.text(`${t.taxable ?? 'Base'} ${money(g.taxableCents, lang)}`, L + 45, by, { width: 130 });
    pdf.text(`TVA ${money(g.vatCents, lang)}`, L + 165, by, { width: 100 });
    by += 13;
  }
  const rows = [[x.totalNet, money(doc.totals.netCents, lang)], [x.totalVat, money(doc.totals.vatCents, lang)]];
  const tot = doc.totals.roundingCents
    ? [[t.rounding, money(doc.totals.roundingCents, lang)], [t.paymentDue, money(doc.totals.grossCents + doc.totals.roundingCents, lang)]]
    : [[x.totalGross, money(doc.totals.grossCents, lang)]];
  const boxH = 16 * (rows.length + tot.length) + 22;
  pdf.rect(330, ty, R - 330, boxH).fill(C.navy);
  let ry = ty + 11;
  pdf.fillColor(C.white).font('Helvetica').fontSize(9);
  for (const [k, v] of rows) { pdf.text(k, 346, ry, { width: 110 }); pdf.text(`${v} ${cur}`, 440, ry, { width: 95, align: 'right' }); ry += 16; }
  pdf.moveTo(346, ry - 3).lineTo(R - 14, ry - 3).strokeColor('#4a6588').lineWidth(0.5).stroke();
  ry += 4;
  tot.forEach(([k, v], i) => {
    const big = i === tot.length - 1;
    pdf.font(big ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 12 : 9).text(k, 346, ry, { width: 110 });
    pdf.font('Helvetica-Bold').fontSize(big ? 12 : 9).text(`${v} ${cur}`, 440, ry, { width: 95, align: 'right' });
    ry += big ? 18 : 16;
  });
  ty += boxH + 16;

  // ---- legal mentions, reason, payment
  if (doc.vat.mention) { pdf.fillColor(C.muted).font('Helvetica-Oblique').fontSize(8).text(doc.vat.mention, L, ty, { width: W }); ty = pdf.y + 8; }
  // Payment details only on invoices: a credit note does not ask for a transfer.
  if (doc.type === 'invoice') {
    // EPC QR for a direct payment: beneficiary, IBAN, BIC, amount due and the Belgian structured communication.
    // Skipped (and the invoice still prints normally) when the seller IBAN is not Belgian or the amount cannot be encoded.
    const dueCents = doc.totals.grossCents + (doc.totals.roundingCents ?? 0);
    const printedRef = paymentReference ?? (doc.number ? structuredCommunication(doc.number) : null);
    const qrBuild = branding.paymentQr === false || !doc.number ? { payload: null } : buildEpcPayload({ name: s.name, iban: s.iban, bic: s.bic, amountCents: dueCents, communication: printedRef });
    const qrPng = qrBuild.payload ? await epcQrPng(qrBuild.payload) : null;
    const QR = 84;
    const payH = Math.max((branding.paymentInstructions ? 96 : 84) - (doc.paymentTerms ? 0 : 14), qrPng ? QR + 26 : 0);
    if (ty + payH > 760) { pdf.addPage(); ty = 50; }
    pdf.rect(L, ty, W, payH).fill(C.sable);
    pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(7.5).text(x.pay, L + 14, ty + 10, { characterSpacing: 1 });
    pdf.fillColor(C.ink).font('Helvetica').fontSize(8.5);
    const tw = qrPng ? W - 28 - QR - 24 : W - 28;
    let py = ty + 24;
    if (s.iban) { pdf.text(`IBAN  ${s.iban}${s.bic ? `      BIC  ${s.bic}` : ''}`, L + 14, py, { width: tw }); py = pdf.y + 2; }
    if (!isCredit && doc.number) {
      // With a QR code the communication is always the structured one, so the QR, the PDF and the XML carry the same reference.
      const ref = printedRef ?? doc.number;
      pdf.text(`${t.ref ?? 'Communication'}  ${ref}`, L + 14, py, { width: tw }); py = pdf.y + 2;
    }
    if (doc.paymentTerms) { pdf.text(`${t.terms ?? 'Conditions'}  ${doc.paymentTerms}`, L + 14, py, { width: tw }); py = pdf.y + 4; }
    if (branding.paymentInstructions) pdf.text(branding.paymentInstructions, L + 14, py, { width: tw });
    if (qrPng) {
      const qx = R - 14 - QR;
      pdf.rect(qx - 5, ty + 8, QR + 10, QR + 14).fill(C.white);
      pdf.image(qrPng, qx, ty + 13, { width: QR, height: QR });
      pdf.fillColor(C.muted).font('Helvetica').fontSize(6.5).text(lang === 'en' ? 'Scan to pay' : 'Scanner pour payer', qx - 5, ty + 13 + QR + 3, { width: QR + 10, align: 'center', lineBreak: false });
    }
    ty += payH + 18;
  }
  if (doc.notes && !isQuote) { pdf.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(doc.notes, L, ty, { width: W }); ty = pdf.y + 12; }

  // ---- quote: conditions, then read-and-approved block with the amount, validity, date and signature
  if (isQuote) {
    const conds = [[t.valid, doc.validUntil], [t.terms ?? 'Conditions de paiement', doc.paymentTerms], [lang === 'en' ? 'Delivery' : 'Livraison', doc.notes]].filter(([, v]) => v);
    if (conds.length) {
      if (ty + 30 + conds.length * 14 > 700) { pdf.addPage(); ty = 50; }
      pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(7.5).text(x.conditions, L, ty, { characterSpacing: 1 });
      let cy2 = ty + 14;
      for (const [k, v] of conds) { pdf.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(k, L, cy2, { width: 150 }); pdf.fillColor(C.ink).text(String(v), L + 150, cy2, { width: W - 150 }); cy2 = Math.max(pdf.y, cy2 + 13) + 3; }
      ty = cy2 + 14;
    }
    if (ty + 120 > 790) { pdf.addPage(); ty = 50; }
    pdf.rect(L, ty, W, 112).strokeColor(C.navy).lineWidth(0.8).stroke();
    pdf.fillColor(C.navy).font('Helvetica-Bold').fontSize(11).text(x.lu, L + 16, ty + 14);
    const amountTxt = `${money(doc.totals.grossCents, lang)} ${cur} TTC (${money(doc.totals.netCents, lang)} ${cur} HTVA)`;
    const luText = lang === 'en'
      ? `Good for agreement. The customer accepts this quote for a total of ${amountTxt}${doc.validUntil ? `, valid until ${doc.validUntil}` : ''}.`
      : `Bon pour accord. Le client accepte la présente offre pour un montant total de ${amountTxt}${doc.validUntil ? `, valable jusqu’au ${doc.validUntil}` : ''}.`;
    pdf.fillColor(C.ink).font('Helvetica').fontSize(8.5).text(luText, L + 16, ty + 32, { width: W - 32, lineGap: 1 });
    const sy = ty + 78;
    pdf.strokeColor(C.muted).lineWidth(0.6);
    pdf.moveTo(L + 16, sy).lineTo(L + 230, sy).stroke();
    pdf.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(`${x.date} (JJ/MM/AAAA)`, L + 16, sy + 4);
    pdf.moveTo(L + 290, sy).lineTo(R - 16, sy).stroke();
    pdf.text(x.sign, L + 290, sy + 4);
    ty += 124;
  }

  // ---- footer on every page
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    pdf.page.margins.bottom = 0;
    pdf.moveTo(L, 790).lineTo(R, 790).strokeColor(C.line).lineWidth(0.5).stroke();
    pdf.fillColor(C.muted).font('Helvetica').fontSize(7);
    pdf.text(branding.footer ?? [s.name, s.vatNumber ? `TVA ${s.vatNumber}` : null, s.enterpriseNumber ? `${t.company} ${s.enterpriseNumber}` : null, s.phone].filter(Boolean).join(' · '), L, 796, { width: W - 80, lineBreak: false });
    pdf.text(`${t.page} ${i + 1}/${range.count}`, R - 70, 796, { width: 70, align: 'right', lineBreak: false });
  }
  pdf.end();
  return done;
}
