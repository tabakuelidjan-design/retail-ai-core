// Expense capture (photo / image / PDF -> supplier-document record). Pure helpers; the workflow lives in inbox.js.
//
// Principles:
//   - The ORIGINAL file is stored untouched and never deleted or replaced. An image only gets a PDF *container* (the picture is
//     embedded as-is, rotated to its EXIF orientation for reading) - the accounting content is never altered.
//   - Amounts stay in their ORIGINAL currency (a CNY receipt stays CNY). No exchange rate is ever invented: a EUR amount exists only
//     when the merchant typed it (for example the amount actually charged on the card statement), and it is labelled as such.
//   - No OCR exists in this system: every field is entered or confirmed by a person.

import PDFDocument from 'pdfkit';

export const CAPTURE_MAX_BYTES = 12 * 1024 * 1024; // phone photos are larger than a scanned invoice
export const CAPTURE_ORIGINS = ['camera', 'image', 'pdf'];
export const EXPENSE_CATEGORIES = ['hotel', 'transport', 'meal', 'supplier', 'exhibition', 'office', 'other'];
export const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'other'];

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** EXIF orientation (1-8) of a JPEG; 1 when absent or unreadable. Only 3, 6 and 8 (pure rotations) are applied. */
export function jpegOrientation(buf) {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let off = 2;
    while (off + 4 < buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1]; const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
        const t = off + 10; const le = buf.toString('latin1', t, t + 2) === 'II';
        const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)); const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + r32(t + 4); const n = r16(ifd);
        for (let i = 0; i < n; i += 1) { const e = ifd + 2 + i * 12; if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; } }
        return 1;
      }
      if (marker === 0xda) break;
      off += 2 + len;
    }
  } catch { /* unreadable EXIF: treat as upright */ }
  return 1;
}
const ROTATION = { 3: 180, 6: 90, 8: -90 };

const collect = (pdf) => new Promise((resolve, reject) => { const chunks = []; pdf.on('data', (c) => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

/** Wrap a JPEG/PNG in a one-page PDF. The image bytes are embedded unchanged. */
export async function imageToPdf({ data, contentType, title = 'Justificatif', capturedAt = null, originalName = '', originalSha256 = '' }) {
  if (!['image/jpeg', 'image/png'].includes(contentType)) throw new Error('imageToPdf: only JPEG and PNG are supported');
  const orientation = contentType === 'image/jpeg' ? jpegOrientation(data) : 1;
  const rot = ROTATION[orientation] ?? 0;
  const pdf = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: title, Subject: `Image d'origine : ${originalName}`, Keywords: originalSha256 ? `sha256:${originalSha256}` : undefined, Creator: 'Nordla Finance', CreationDate: capturedAt ? new Date(capturedAt) : new Date() } });
  const done = collect(pdf);
  const img = pdf.openImage(data);
  const swapped = Math.abs(rot) === 90;
  const w = swapped ? img.height : img.width; const h = swapped ? img.width : img.height; // displayed size once upright
  pdf.addPage({ size: 'A4', layout: w > h ? 'landscape' : 'portrait', margin: 0 });
  const pw = pdf.page.width; const ph = pdf.page.height; const m = 24;
  const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h);
  const cx = pw / 2; const cy = ph / 2;
  pdf.save();
  if (rot) pdf.rotate(rot, { origin: [cx, cy] });
  pdf.image(data, cx - (img.width * s) / 2, cy - (img.height * s) / 2, { width: img.width * s, height: img.height * s });
  pdf.restore();
  pdf.end();
  return done;
}

/** What a captured expense needs before it can be validated. Net/VAT/invoice number are optional (a taxi receipt has none): nothing is guessed. */
export function expenseValidationErrors(r) {
  const e = [];
  if (!String(r.supplierName ?? '').trim()) e.push('SUPPLIER_NAME_MISSING');
  if (!isDate(r.issueDate)) e.push('ISSUE_DATE_INVALID');
  if (!Number.isInteger(r.grossCents) || r.grossCents <= 0) e.push('GROSS_AMOUNT_INVALID');
  if (!/^[A-Z]{3}$/.test(r.currency ?? '')) e.push('CURRENCY_INVALID');
  for (const k of ['netCents', 'vatCents']) if (r[k] != null && (!Number.isInteger(r[k]) || r[k] < 0)) e.push(`${k.replace('Cents', '').toUpperCase()}_AMOUNT_INVALID`);
  if (Number.isInteger(r.grossCents)) {
    if (Number.isInteger(r.netCents) && Number.isInteger(r.vatCents) && r.netCents + r.vatCents !== r.grossCents) e.push('NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL');
    if (Number.isInteger(r.vatCents) && r.vatCents > r.grossCents) e.push('VAT_EXCEEDS_TOTAL');
  }
  return e;
}

export const isCapturedExpense = (r) => r?.extraction?.capture?.kind === 'expense';

/** Sanitise the merchant-entered metadata of a capture (enumerations, bounded text, optional merchant-typed EUR amount). */
export function normalizeCaptureMeta(input = {}) {
  const out = {};
  if ('category' in input) out.category = EXPENSE_CATEGORIES.includes(input.category) ? input.category : null;
  if ('paymentMethod' in input) out.paymentMethod = PAYMENT_METHODS.includes(input.paymentMethod) ? input.paymentMethod : null;
  if ('note' in input) out.note = input.note == null || input.note === '' ? null : String(input.note).trim().slice(0, 300);
  if ('eurAmountCents' in input) {
    const c = input.eurAmountCents;
    out.eurAmountCents = Number.isInteger(c) && c > 0 ? c : null;
    out.eurAmountSource = out.eurAmountCents ? 'merchant' : null; // typed by the merchant, never computed
  }
  if ('vatRateBp' in input) out.vatRateBp = Number.isInteger(input.vatRateBp) && input.vatRateBp >= 0 && input.vatRateBp <= 10000 ? input.vatRateBp : null;
  return out;
}
