// Document intelligence, phase 3: deterministic reading of the TEXT of a PDF invoice / credit note (FR / NL / EN), into the SAME
// common model as the UBL reader (purchase-document.js). Local only: no OCR, no image analysis, no language model, no network.
//
// Rules, not guesses:
//   - a value is taken only when a label says what it is ("Total TVAC", "BTW", "Échéance", "IBAN", "+++…+++", "N° TVA", …);
//   - when several different values compete, a value is chosen only by a stated rule (a label that is more explicit than the others,
//     or the only net + VAT = total combination); otherwise the best one is proposed with a LOW confidence, or the field stays empty
//     and is listed as "to check". A number is never taken as the total because it is the largest;
//   - the merchant's own identity (VAT, enterprise number, IBAN, name) is never read as the supplier's;
//   - every field keeps where it was read: page, source text, rule, confidence (provenance, method PDF_TEXT).
// Whether the document is correct is decided by the existing deterministic checks (finalizeExtraction + validation), never here.

import { normalizeBelgianNumber } from './company.js';
import { isValidIban } from './settings.js';
import { toCents } from './money.js';
import { finalizeExtraction } from './purchase-document.js';
import { readPdfText } from './pdf-text.js';

export const SOURCE = 'PDF_TEXT';
/** Below this many non-space characters (all pages together) the PDF is treated as a scan: its text needs image analysis (OCR). */
export const SCAN_TEXT_THRESHOLD = 30;

// ---------- values ----------
const AMOUNT_RE = /(?<![\w.,/-])(-\s?)?((?:\d{1,3}(?:[.   ]\d{3})+|\d+),\d{2}|(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d%])/g;
/** European ("1.234,56", "1 234,56") and English ("1,234.56") amounts with exactly two decimals, as integer cents. */
export function amountsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(AMOUNT_RE)) {
    const raw = m[2]; const comma = /,\d{2}$/.test(raw);
    const plain = comma ? raw.replace(/[.   ]/g, '').replace(',', '.') : raw.replace(/,/g, '');
    const c = toCents(plain); if (!Number.isInteger(c)) continue;
    out.push({ cents: m[1] ? -c : c, index: m.index, raw: m[0] });
  }
  return out;
}
const MONTHS = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8, october: 10 };
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_RE = new RegExp(`(?<!\\d)(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})(?!\\d)|(?<!\\d)(\\d{4})-(\\d{2})-(\\d{2})(?!\\d)|(?<!\\d)(\\d{1,2})(?:er)?\\s+(${MONTH_ALT})\\s+(\\d{4})(?!\\d)|\\b(${MONTH_ALT})\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)`, 'giu');
const iso = (y, m, d) => { const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.getUTCMonth() + 1 === Number(m) && t.getUTCDate() === Number(d) ? s : null; };
/** Dates written day-first (Belgian usage), ISO, or with a FR / NL / EN month name. `ambiguous` = day and month could be swapped. */
export function datesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(DATE_RE)) {
    let v = null; let ambiguous = false;
    if (m[1]) { v = iso(m[3], m[2], m[1]); ambiguous = Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2]; } else if (m[4]) v = iso(m[4], m[5], m[6]);
    else if (m[7]) v = iso(m[9], MONTHS[m[8].toLowerCase()], m[7]); else if (m[10]) v = iso(m[12], MONTHS[m[10].toLowerCase()], m[11]);
    if (v) out.push({ value: v, index: m.index, ambiguous });
  }
  return out;
}
const BE_VAT_RE = /\bBE[\s.]?(0?[01]\d{2,3}[\s.]?\d{3}[\s.]?\d{3})\b/gi;
const EU_VAT_LABELLED_RE = /\b(?:TVA|BTW|VAT|USt-?IdNr\.?|TVA\s*intracom\w*)\s*(?:n[°o]\.?|nr\.?|no\.?|number|numéro|nummer)?\s*[:.]?\s*((?:AT|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[\s.]?[A-Z0-9][A-Z0-9.\s]{6,14}[A-Z0-9])\b/gi;
const ENTERPRISE_RE = /\b(?:n[°o]\.?\s*(?:d['’]\s*)?entreprise|num[ée]ro\s*d['’]\s*entreprise|BCE|KBO|ondernemingsn(?:umme)?r\.?|RPM|RPR|company\s*(?:no\.?|number|registration))\s*[:.]?\s*(?:BE\s?)?([01]\d{3}[.\s]?\d{3}[.\s]?\d{3})\b/gi;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;
const STRUCTURED_RE = /([+*]{3})\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*\1/;
const LEGAL_FORM_RE = /\b(SRL|SA|SPRL|SC|SCRL|SCS|SNC|SComm|ASBL|BV|NV|BVBA|CV|CVBA|VOF|VZW|CommV|GmbH|AG|SAS|SARL|Ltd|LLC|Inc|PLC)\.?(?=\s|$|,)/;
const compactIban = (s) => s.replace(/\s+/g, '').toUpperCase();
const beDigits = (s) => { const n = normalizeBelgianNumber(s); return n.ok ? n.digits : null; };
const normName = (s) => (s ? String(s).toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim() : null);
const structuredValid = (d) => { const base = Number(d.slice(0, 10)); const mod = base % 97 || 97; return mod === Number(d.slice(10)); };

// ---------- labels (FR / NL / EN) ----------
const L = {
  creditTitle: /^(?:note\s*de\s*cr[ée]dit|avoir|credit\s*-?\s*note|creditnota|kredietnota)\b/i,
  invoiceTitle: /^(?:facture|invoice|factuur|tax\s*invoice)\b/i,
  gross: [
    [/\b(?:total\s*(?:ttc|tvac|t\.?v\.?a\.?c\.?|incl\.?\s*(?:btw|tva|vat)|à\s*payer|a\s*payer|to\s*pay|due|te\s*betalen|général|generaal)|montant\s*(?:ttc|tvac|à\s*payer|total)|net\s*à\s*payer|solde\s*à\s*payer|te\s*betalen(?:\s*bedrag)?|totaal\s*(?:incl\.?\s*btw|te\s*betalen)|amount\s*due|balance\s*due|grand\s*total|tvac|ttc)\b/i, 2, 'LABEL_TOTAL_INCL_VAT'],
    [/^(?:total|totaal)\b(?!\s*(?:ht|htva|hors|excl|tva|btw|vat|net))/i, 1, 'LABEL_TOTAL'],
  ],
  net: [[/\b(?:total\s*(?:htva|h\.?t\.?v\.?a\.?|ht|hors\s*tva|excl\.?\s*(?:btw|tva|vat)|net)|sous-?\s*total|sub-?\s*total|totaal\s*excl\.?\s*btw|montant\s*(?:htva|ht|hors\s*tva)|htva|hors\s*tva|excl\.?\s*(?:btw|tva|vat)|maatstaf\s*van\s*heffing|net\s*amount|taxable\s*amount)\b/i, 2, 'LABEL_TOTAL_EXCL_VAT']],
  vat: [[/\b(?:total\s*(?:tva|btw|vat)|montant\s*(?:de\s*(?:la\s*)?)?tva|btw-?\s*bedrag|bedrag\s*btw|vat\s*amount|tva|btw|vat)\b(?!\s*(?:n[°o]|nr|no\b|number|numéro|nummer|intra|:?\s*[A-Z]{2}\s?\d))/i, 2, 'LABEL_VAT']],
  due: /(?<!\p{L})(?:date\s*d['’]\s*[ée]ch[ée]ance|[ée]ch[ée]ance|à\s*payer\s*avant|payable\s*(?:avant|le)|vervaldatum|vervaldag|te\s*betalen\s*(?:voor|vóór|tegen)|uiterste\s*betaal\s*datum|due\s*date|payment\s*due|pay\s*by|payable\s*by)(?!\p{L})/iu,
  otherDate: /\b(?:livraison|levering|delivery|commande|order|bestelling|p[ée]riode|period|periode|prestation|dienst|service|échéancier)\b/i,
  issue: /\b(?:date\s*(?:de\s*(?:la\s*)?)?(?:facture|l['’]\s*avoir|la\s*note|document|[ée]mission)|factuurdatum|datum\s*factuur|creditnotadatum|invoice\s*date|date\s*of\s*(?:issue|invoice)|issue\s*date|datum|date)\b/i,
  docNumber: /(?:\b(?:facture|invoice|factuur|note\s*de\s*cr[ée]dit|avoir|credit\s*-?\s*note|creditnota|kredietnota)\s*(?:n[°o]\.?|nr\.?|no\.?|number|num[ée]ro|nummer|#)?|\b(?:n[°o]\.?\s*(?:de\s*)?(?:la\s*)?(?:facture|document|pi[èe]ce|avoir)|factuurn(?:umme)?r\.?|invoice\s*(?:no\.?|number|#)|document\s*n[°o]))\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi,
  lonelyNumber: /(?:^|\s)(?:n[°o]\.?|nr\.?|number|num[ée]ro|nummer)\s*(?!(?:de\s*)?(?:tva|btw|vat|entreprise|client|klant|customer|commande|order|compte|account|rekening|bestel)\b)[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi,
  billingRef: /\b(?:concerne|relative\s*à|se\s*rapportant\s*à|annule|en\s*r[ée]f[ée]rence\s*à|sur|betreft|m\.?b\.?t\.?|voor|original|related|refers?\s*to|credit(?:s|ing)?)\s*(?:la\s*|de\s*)?(?:facture|factuur|invoice)\s*(?:n[°o]\.?|nr\.?|no\.?|number|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi,
  order: /\b(?:bon\s*de\s*commande|n[°o]\.?\s*(?:de\s*)?commande|commande|votre\s*r[ée]f[ée]rence|v\/?\s*r[ée]f\.?|purchase\s*order|order\s*(?:no\.?|number|ref(?:erence)?|#)|your\s*ref(?:erence)?|PO|bestelbon|bestelnummer|bestelling|uw\s*ref(?:erentie)?|referentie)\s*(?:n[°o]\.?|nr\.?|no\.?)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi,
  paymentFree: /\b(?:communication|mededeling|r[ée]f[ée]rence\s*(?:de\s*)?paiement|payment\s*reference|betalingsreferentie|referentie\s*betaling)\s*[:.]?\s*(.{3,60})$/i,
  vatRow: /\b(?:tva|btw|vat|taux|tarief|rate)\b/i,
  rate: /(?<![\d,.])(\d{1,2}(?:[.,]\d{1,2})?)\s?%/,
  itemsHeader: /\b(?:description|d[ée]signation|libell[ée]|omschrijving|artikel|article|produit|item|product|prestation)\b/i,
  itemsHeaderAmount: /\b(?:total|totaal|montant|bedrag|amount|prix|prijs|price|qt[ée]|quantit[ée]|qty|quantity|aantal)\b/i,
  exemption: /\b(?:exon[ée]r\w*|autoliquidation|vrijgesteld\w*|verlegd\w*|reverse\s*charge|intracommunautaire|art(?:icle|ikel)?\.?\s*(?:39|44|21)\b)/i,
};
const hasDigit = (s) => /\d/.test(s);

/** Lines of all pages, each with its cells (columns). */
function flatten(pages) {
  const out = [];
  for (const p of pages) p.lines.forEach((l, i) => out.push({ ...l, page: p.page, index: i, cells: l.cells ?? [{ text: l.text, x: l.x }] }));
  return out;
}

/**
 * Read the common model from the lines of a PDF. `own` = the merchant's identity, never read as the supplier.
 * @returns {{ extractor: 'pdf_text', fields: object, warnings: string[] }}
 */
export function extractFromPdfLines(pages, own = {}) {
  const lines = flatten(pages); const warnings = []; const f = {};
  // provenance text = the cell (column) the value was read in when it can be located, else the whole line: never another party's column
  const alnum = (s) => String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const sourceOf = (at, value) => { const cell = typeof value === 'string' && alnum(value).length >= 3 ? at.cells?.find((c) => alnum(c.text).includes(alnum(value))) : null; return cell ?? at; };
  const put = (k, value, confidence, at, rule) => { if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return;
    const src = at ? sourceOf(at, value) : null;
    f[k] = { value, confidence, source: SOURCE, path: rule, page: at?.page ?? null, zone: src ? { x: src.x ?? at.x, y: at.y } : null, text: src ? String(src.text).slice(0, 160) : null }; };
  const ownVat = new Set((own.vatNumbers ?? []).map((v) => String(v).replace(/[^A-Z0-9]/gi, '').toUpperCase()));
  const ownEnt = new Set([...(own.enterpriseNumbers ?? []), ...(own.vatNumbers ?? [])].map(beDigits).filter(Boolean));
  const ownIban = new Set((own.ibans ?? []).map(compactIban));
  const ownNames = new Set((own.names ?? []).map(normName).filter(Boolean));
  const text = lines.map((l) => l.text).join('\n');

  // ---- document type (a title line) ----
  const creditLine = lines.find((l) => l.cells.some((c) => L.creditTitle.test(c.text)));
  const invoiceLine = lines.find((l) => l.cells.some((c) => L.invoiceTitle.test(c.text)));
  let docType = null;
  if (creditLine) { docType = 'CREDIT_NOTE'; put('documentType', 'CREDIT_NOTE', 0.9, creditLine, 'TITLE_CREDIT_NOTE'); } else if (invoiceLine) { docType = 'INVOICE'; put('documentType', 'INVOICE', 0.9, invoiceLine, 'TITLE_INVOICE'); }

  // ---- identifiers: supplier VAT / enterprise number / IBAN (never the merchant's own) ----
  const vatHits = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(BE_VAT_RE)) { const n = normalizeBelgianNumber(m[1]); if (n.ok) vatHits.push({ value: n.vatNumber, line: l, digits: n.digits }); }
    for (const m of l.text.matchAll(EU_VAT_LABELLED_RE)) vatHits.push({ value: m[1].replace(/[\s.]/g, '').toUpperCase(), line: l, digits: null });
  }
  const supplierVats = vatHits.filter((h) => !ownVat.has(h.value) && !(h.digits && ownEnt.has(h.digits)));
  const distinctVats = [...new Set(supplierVats.map((h) => h.value))];
  let supplierVatHit = null;
  if (distinctVats.length === 1) { supplierVatHit = supplierVats[0]; put('supplierVatNumber', supplierVatHit.value, 0.9, supplierVatHit.line, 'VAT_NUMBER_NOT_OURS'); } else if (distinctVats.length > 1) {
    supplierVatHit = supplierVats.slice().sort((a, b) => a.line.page - b.line.page || b.line.y - a.line.y)[0]; // the first one on the document, proposed only
    put('supplierVatNumber', supplierVatHit.value, 0.4, supplierVatHit.line, 'VAT_NUMBER_FIRST_OF_SEVERAL'); warnings.push('SUPPLIER_VAT_AMBIGUOUS');
  }
  const entHits = [];
  for (const l of lines) for (const m of l.text.matchAll(ENTERPRISE_RE)) { const n = normalizeBelgianNumber(m[1]); if (n.ok && !ownEnt.has(n.digits)) entHits.push({ value: n.enterpriseNumber, line: l }); }
  const distinctEnt = [...new Set(entHits.map((h) => h.value))];
  if (distinctEnt.length === 1) put('supplierEnterpriseNumber', distinctEnt[0], 0.85, entHits[0].line, 'LABEL_ENTERPRISE_NUMBER');
  else if (distinctEnt.length > 1) warnings.push('SUPPLIER_ENTERPRISE_NUMBER_AMBIGUOUS');
  const ibanHits = [];
  for (const l of lines) for (const m of l.text.matchAll(IBAN_RE)) { const v = compactIban(m[1]); if (isValidIban(v) && !ownIban.has(v)) ibanHits.push({ value: v, line: l, labelled: /\b(?:iban|compte|rekening|account|bank)\b/i.test(l.text) }); }
  const distinctIban = [...new Set(ibanHits.map((h) => h.value))];
  if (distinctIban.length === 1) put('supplierIban', distinctIban[0], 0.9, ibanHits[0].line, 'IBAN_VALID_NOT_OURS');
  else if (distinctIban.length > 1) { const best = ibanHits.find((h) => h.labelled) ?? ibanHits[0]; put('supplierIban', best.value, 0.4, best.line, 'IBAN_FIRST_OF_SEVERAL'); warnings.push('IBAN_AMBIGUOUS'); }

  // ---- supplier name and address: the block (same column) just above the supplier's VAT number ----
  const notOurs = (s) => !ownNames.has(normName(s));
  const cellNear = (l, x) => l.cells.slice().sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
  let nameAt = null;
  if (supplierVatHit) {
    const vl = supplierVatHit.line; const vcell = l2cell(vl, supplierVatHit.value) ?? vl.cells[0];
    const block = lines.filter((l) => l.page === vl.page && l.y > vl.y && l.y - vl.y <= 160).sort((a, b) => a.y - b.y); // nearest first
    const inColumn = block.map((l) => ({ l, c: cellNear(l, vcell.x) })).filter(({ c }) => Math.abs(c.x - vcell.x) <= 60);
    const legal = inColumn.find(({ c }) => LEGAL_FORM_RE.test(c.text) && notOurs(c.text) && !hasDigit(c.text.replace(LEGAL_FORM_RE, '')));
    if (legal) { nameAt = legal; put('supplierName', legal.c.text.trim(), 0.75, { ...legal.l, text: legal.c.text }, 'NAME_WITH_LEGAL_FORM_ABOVE_VAT'); } else if (inColumn.length) {
      const top = inColumn[inColumn.length - 1]; if (notOurs(top.c.text) && !hasDigit(top.c.text)) { nameAt = top; put('supplierName', top.c.text.trim(), 0.5, { ...top.l, text: top.c.text }, 'FIRST_LINE_OF_VAT_BLOCK'); }
    }
    // address: a "postal code + city" line between the name and the VAT number, the street just above it
    if (nameAt) {
      const between = inColumn.filter(({ l }) => l.y < nameAt.l.y);
      const pc = between.find(({ c }) => /^(?:B-?)?\d{4}\s+\S/.test(c.text) || /^\d{4}\s?[A-Z]{2}\s+\S/.test(c.text));
      if (pc) {
        const m = /^(?:B-?)?(\d{4}(?:\s?[A-Z]{2})?)\s+(.+)$/.exec(pc.c.text.trim());
        const street = between.find(({ l }) => l.y > pc.l.y && l.y < nameAt.l.y);
        const cc = /^BE/.test(supplierVatHit.value) ? 'BE' : supplierVatHit.value.slice(0, 2);
        put('supplierAddress', { street: street ? street.c.text.trim() : null, postalCode: m[1], city: m[2].trim(), countryCode: cc }, 0.6, { ...pc.l, text: pc.c.text }, 'ADDRESS_IN_VAT_BLOCK');
      }
    }
  } else {
    const legal = lines.find((l) => l.page === 1 && l.cells.some((c) => LEGAL_FORM_RE.test(c.text) && notOurs(c.text) && !hasDigit(c.text)));
    if (legal) { const c = legal.cells.find((x) => LEGAL_FORM_RE.test(x.text) && notOurs(x.text)); put('supplierName', c.text.trim(), 0.4, { ...legal, text: c.text }, 'FIRST_NAME_WITH_LEGAL_FORM'); warnings.push('SUPPLIER_NOT_IDENTIFIED_BY_VAT'); }
  }

  // ---- references ----
  const billingRefs = [];
  for (const l of lines) for (const m of l.text.matchAll(L.billingRef)) if (hasDigit(m[1])) billingRefs.push({ value: m[1].replace(/[.,;]$/, ''), line: l });
  if (docType === 'CREDIT_NOTE' && billingRefs.length) put('billingReference', billingRefs[0].value, [...new Set(billingRefs.map((b) => b.value))].length === 1 ? 0.8 : 0.4, billingRefs[0].line, 'LABEL_CREDITED_INVOICE');
  const excluded = new Set([...billingRefs.map((b) => b.value), ...vatHits.map((h) => h.value)]);
  const numbers = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(L.docNumber)) if (hasDigit(m[1]) && !excluded.has(m[1]) && !datesIn(m[1]).length) numbers.push({ value: m[1].replace(/[.,;:]$/, ''), line: l, strong: true });
    for (const m of l.text.matchAll(L.lonelyNumber)) if (hasDigit(m[1]) && !excluded.has(m[1]) && !datesIn(m[1]).length) numbers.push({ value: m[1].replace(/[.,;:]$/, ''), line: l, strong: false });
  }
  const orders = [];
  for (const l of lines) for (const m of l.text.matchAll(L.order)) if (hasDigit(m[1]) && !datesIn(m[1]).length) orders.push({ value: m[1].replace(/[.,;:]$/, ''), line: l });
  const orderValues = new Set(orders.map((o) => o.value));
  const numCands = numbers.filter((n) => !orderValues.has(n.value));
  const strongVals = [...new Set(numCands.filter((n) => n.strong).map((n) => n.value))]; const anyVals = [...new Set(numCands.map((n) => n.value))];
  if (strongVals.length === 1) put('invoiceNumber', strongVals[0], 0.85, numCands.find((n) => n.value === strongVals[0]).line, 'LABEL_DOCUMENT_NUMBER');
  else if (strongVals.length > 1) { put('invoiceNumber', strongVals[0], 0.4, numCands.find((n) => n.value === strongVals[0]).line, 'FIRST_OF_SEVERAL_NUMBERS'); warnings.push('INVOICE_NUMBER_AMBIGUOUS'); } else if (anyVals.length === 1) put('invoiceNumber', anyVals[0], 0.6, numCands[0].line, 'LABEL_NUMBER'); else if (anyVals.length > 1) warnings.push('INVOICE_NUMBER_AMBIGUOUS');
  const distinctOrders = [...new Set(orders.map((o) => o.value))];
  if (distinctOrders.length === 1) put('orderReference', distinctOrders[0], 0.8, orders[0].line, 'LABEL_ORDER_REFERENCE'); else if (distinctOrders.length > 1) warnings.push('ORDER_REFERENCE_AMBIGUOUS');
  const sc = lines.map((l) => ({ l, m: STRUCTURED_RE.exec(l.text) })).find((x) => x.m);
  if (sc) { const d = sc.m[2] + sc.m[3] + sc.m[4]; const ok = structuredValid(d); put('paymentReference', `+++${sc.m[2]}/${sc.m[3]}/${sc.m[4]}+++`, ok ? 0.95 : 0.4, sc.l, ok ? 'STRUCTURED_COMMUNICATION' : 'STRUCTURED_COMMUNICATION_CHECK_DIGITS_WRONG'); if (!ok) warnings.push('STRUCTURED_COMMUNICATION_INVALID'); } else {
    const fr = lines.map((l) => ({ l, m: L.paymentFree.exec(l.text) })).find((x) => x.m); if (fr) put('paymentReference', fr.m[1].split(/\s{3,}/)[0].trim(), 0.6, fr.l, 'LABEL_PAYMENT_REFERENCE');
  }

  // ---- dates ----
  const english = /\b(?:invoice|amount\s*due|due\s*date|subtotal)\b/i.test(text) && !/\b(?:facture|factuur|échéance|vervaldatum)\b/i.test(text);
  const issue = []; const due = []; const loose = [];
  lines.forEach((l, i) => {
    for (const d of datesIn(l.text)) {
      const before = l.text.slice(0, d.index); const prev = lines[i - 1] && lines[i - 1].page === l.page ? lines[i - 1].text : '';
      const labelText = before.trim() ? before.split(/\s{3,}/).pop() : prev;
      const hit = { value: d.value, line: l, ambiguous: d.ambiguous && english };
      if (L.due.test(labelText)) due.push(hit); else if (L.otherDate.test(labelText)) continue; else if (L.issue.test(labelText)) issue.push(hit); else loose.push(hit);
    }
  });
  const pickDate = (k, hits, rule) => { const vals = [...new Set(hits.map((h) => h.value))]; if (!vals.length) return false;
    const h = hits.find((x) => x.value === vals[0]); if (vals.length === 1) put(k, vals[0], h.ambiguous ? 0.5 : 0.9, h.line, rule); else { put(k, vals[0], 0.4, h.line, `${rule}_FIRST_OF_SEVERAL`); warnings.push(`${k === 'dueDate' ? 'DUE' : 'ISSUE'}_DATE_AMBIGUOUS`); }
    if (h.ambiguous) warnings.push('DATE_FORMAT_AMBIGUOUS'); return true; };
  if (!pickDate('issueDate', issue, 'LABEL_ISSUE_DATE')) {
    const vals = [...new Set(loose.map((h) => h.value))];
    if (vals.length === 1) put('issueDate', vals[0], 0.6, loose[0].line, 'ONLY_DATE_ON_DOCUMENT'); else if (vals.length > 1) warnings.push('ISSUE_DATE_AMBIGUOUS');
  }
  pickDate('dueDate', due, 'LABEL_DUE_DATE');

  // ---- currency ----
  const cur = { EUR: (text.match(/€|\bEUR\b/g) ?? []).length, USD: (text.match(/\$|\bUSD\b/g) ?? []).length, GBP: (text.match(/£|\bGBP\b/g) ?? []).length, CHF: (text.match(/\bCHF\b/g) ?? []).length };
  const present = Object.entries(cur).filter(([, n]) => n > 0);
  if (present.length === 1) { const [c] = present[0]; const at = lines.find((l) => (c === 'EUR' ? /€|\bEUR\b/ : new RegExp(c === 'USD' ? '\\$|\\bUSD\\b' : c === 'GBP' ? '£|\\bGBP\\b' : '\\bCHF\\b')).test(l.text)); put('currency', c, 0.9, at, 'CURRENCY_SYMBOL'); } else if (present.length > 1) warnings.push('CURRENCY_AMBIGUOUS');

  // ---- VAT by rate (rows with a rate and a VAT word, or inside a rate / base table) ----
  const breakdown = []; let inVatTable = false;
  for (const l of lines) {
    const isHeader = /\b(?:taux|tarief|rate|%)\b/i.test(l.text) && /\b(?:base|maatstaf|taxable|htva|excl|montant\s*ht)\b/i.test(l.text) && !amountsIn(l.text).length;
    if (isHeader) { inVatTable = true; continue; }
    const r = L.rate.exec(l.text); const am = amountsIn(l.text);
    if (r && am.length && (L.vatRow.test(l.text) || inVatTable) && !L.gross.some(([re]) => re.test(l.text))) {
      const rateBp = Math.round(Number(r[1].replace(',', '.')) * 100);
      const after = am.filter((a) => a.index > r.index || am.length > 1);
      breakdown.push({ taxableCents: after.length >= 2 ? Math.abs(after[0].cents) : null, vatCents: Math.abs(after[after.length - 1].cents), rateBp, category: rateBp === 0 ? (L.exemption.test(text) ? 'E' : 'Z') : 'S',
        exemptionReason: rateBp === 0 ? (L.exemption.exec(text)?.[0] ?? null) : null, _line: l });
    } else if (inVatTable && !am.length) inVatTable = false;
  }

  // ---- totals: label -> amount on the same line (after the label), or on the next line when it holds amounts only ----
  const cands = { netCents: [], vatCents: [], grossCents: [] };
  const amountOnlyLine = (l) => l && l.cells.every((c) => amountsIn(c.text).length || /^(?:€|EUR|USD|GBP|\$|£)$/.test(c.text.trim()));
  lines.forEach((l, i) => {
    if (L.rate.test(l.text) && L.vatRow.test(l.text)) return; // a VAT-by-rate row, not a total
    for (const [field, defs] of [['grossCents', L.gross], ['netCents', L.net], ['vatCents', L.vat]]) {
      for (const [re, strength, rule] of defs) {
        const m = re.exec(l.text); if (!m) continue;
        let am = amountsIn(l.text.slice(m.index + m[0].length)); let at = l;
        if (!am.length && amountOnlyLine(lines[i + 1]) && lines[i + 1].page === l.page) { am = amountsIn(lines[i + 1].text); at = lines[i + 1]; }
        if (am.length) cands[field].push({ cents: am[am.length - 1].cents, strength, rule, line: at });
        return; // the most specific label of this line wins (gross before net before VAT: "Total TVAC" is not "TVA")
      }
    }
  });
  if (!cands.vatCents.length && breakdown.length && breakdown.every((b) => Number.isInteger(b.vatCents))) { // no VAT total printed: the sum of the printed VAT rows
    cands.vatCents.push({ cents: breakdown.reduce((a, b) => a + b.vatCents, 0), strength: 1, rule: 'SUM_OF_VAT_BY_RATE', line: breakdown[0]._line });
  }
  const neg = Object.values(cands).flat().some((c) => c.cents < 0);
  for (const k of Object.keys(cands)) for (const c of cands[k]) c.cents = Math.abs(c.cents);
  const chosen = {};
  for (const [k, list] of Object.entries(cands)) {
    const vals = [...new Set(list.map((c) => c.cents))];
    if (vals.length === 1) { const c = list.find((x) => x.strength === Math.max(...list.map((y) => y.strength))); chosen[k] = { ...c, confidence: c.rule === 'SUM_OF_VAT_BY_RATE' ? 0.6 : c.strength === 2 ? 0.9 : 0.7 }; continue; }
    if (vals.length > 1) {
      const top = Math.max(...list.map((c) => c.strength)); const topVals = [...new Set(list.filter((c) => c.strength === top).map((c) => c.cents))];
      if (topVals.length === 1) { chosen[k] = { ...list.find((c) => c.strength === top), confidence: 0.7 }; warnings.push('SEVERAL_AMOUNTS_MOST_EXPLICIT_LABEL_KEPT'); }
    }
  }
  const unresolved = Object.keys(cands).filter((k) => !chosen[k] && cands[k].length);
  const addsUp = (n, v, g) => n + v === g;
  if (unresolved.length) {
    const opts = (k) => (chosen[k] ? [chosen[k]] : cands[k]);
    const triples = [];
    for (const n of opts('netCents')) for (const v of opts('vatCents')) for (const g of opts('grossCents')) if (addsUp(n.cents, v.cents, g.cents)) triples.push({ n, v, g });
    const keys = [...new Set(triples.map((t) => `${t.n.cents}|${t.v.cents}|${t.g.cents}`))];
    if (keys.length === 1) { const t = triples[0]; for (const [k, c] of [['netCents', t.n], ['vatCents', t.v], ['grossCents', t.g]]) if (!chosen[k]) chosen[k] = { ...c, confidence: 0.7 }; warnings.push('AMOUNTS_CHOSEN_BY_CONSISTENCY'); } else for (const k of unresolved) warnings.push(`${k === 'grossCents' ? 'TOTAL_INCL_VAT' : k === 'netCents' ? 'TOTAL_EXCL_VAT' : 'VAT_AMOUNT'}_AMBIGUOUS`);
  }
  for (const k of ['netCents', 'vatCents', 'grossCents']) if (chosen[k]) put(k, chosen[k].cents, chosen[k].confidence, chosen[k].line, chosen[k].rule);
  if (breakdown.length) put('vatBreakdown', breakdown.map(({ _line, ...b }) => b), 0.7, breakdown[0]._line, 'VAT_BY_RATE_ROWS');
  if (neg) {
    if (docType === 'CREDIT_NOTE') warnings.push('NEGATIVE_AMOUNTS_ON_CREDIT_NOTE');
    else { put('documentType', 'CREDIT_NOTE', 0.5, f.grossCents ? { page: f.grossCents.page, x: f.grossCents.zone?.x, y: f.grossCents.zone?.y, text: f.grossCents.text } : null, 'NEGATIVE_AMOUNTS'); warnings.push('NEGATIVE_INVOICE_READ_AS_CREDIT_NOTE'); }
  }

  // ---- invoice lines: a table under a "description ... total" header, until the totals ----
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = lines[i]; if (!(L.itemsHeader.test(h.text) && L.itemsHeaderAmount.test(h.text) && !amountsIn(h.text).length)) continue;
    for (let j = i + 1; j < lines.length && lines[j].page === h.page; j += 1) {
      const l = lines[j]; const am = amountsIn(l.text);
      if (!am.length || L.gross.some(([re]) => re.test(l.text)) || L.net.some(([re]) => re.test(l.text)) || (L.vatRow.test(l.text) && L.rate.test(l.text) && l.cells.length <= 3)) break;
      const desc = l.cells.find((c) => !amountsIn(c.text).length && /[A-Za-zÀ-ÿ]{2}/.test(c.text));
      if (!desc) break;
      const qty = l.cells.find((c) => c !== desc && /^\d+(?:[.,]\d{1,3})?$/.test(c.text.trim()) && !amountsIn(c.text).length);
      const rate = L.rate.exec(l.text);
      items.push({ position: items.length + 1, id: null, description: desc.text.trim(), quantity: qty ? qty.text.trim().replace(',', '.') : null, unitCode: null,
        unitPrice: am.length >= 2 ? am[am.length - 2].raw.trim() : null, netCents: Math.abs(am[am.length - 1].cents), rateBp: rate ? Math.round(Number(rate[1].replace(',', '.')) * 100) : null, category: null, _line: l });
    }
    break;
  }
  if (items.length) {
    const sum = items.reduce((a, it) => a + it.netCents, 0); const net = f.netCents?.value;
    const ok = Number.isInteger(net) && sum === net;
    put('lines', items.map(({ _line, ...it }) => it), ok ? 0.7 : 0.4, items[0]._line, 'ITEMS_TABLE');
    if (Number.isInteger(net) && !ok) warnings.push('LINES_DO_NOT_ADD_UP');
  }
  return { extractor: 'pdf_text', fields: f, warnings: [...new Set(warnings)] };
}
/** The cell of a line that contains a given value (for its x position). */
function l2cell(line, value) { const d = String(value).replace(/\D/g, '').slice(-9); return line.cells?.find((c) => c.text.replace(/\D/g, '').includes(d)) ?? null; }

/** PDF with a text layer -> the common model; a PDF with (almost) no text is a scan: nothing is guessed. */
export async function readPdfDocument(data, own = {}) {
  let t;
  try { t = await readPdfText(data); } catch { return { extractor: 'pdf_text', fields: {}, warnings: ['PDF_TEXT_UNREADABLE'] }; }
  if (t.textChars < SCAN_TEXT_THRESHOLD) return { extractor: 'pdf_text', fields: {}, warnings: ['SCAN_REQUIRES_OCR'], pdf: { pages: t.pageCount, textChars: t.textChars } };
  const ex = extractFromPdfLines(t.pages, own);
  const recognised = ['invoiceNumber', 'issueDate', 'grossCents', 'netCents', 'supplierVatNumber', 'supplierIban'].some((k) => ex.fields[k]);
  if (!recognised) ex.warnings.push('PDF_TEXT_NOTHING_RECOGNISED');
  if (t.pageCount > t.pagesRead) ex.warnings.push('PDF_PAGES_TRUNCATED');
  return { ...finalizeExtraction(ex), pdf: { pages: t.pageCount, textChars: t.textChars } };
}
