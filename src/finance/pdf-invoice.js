// Document intelligence, phase 3 (+ 3.1 hardening): deterministic reading of the TEXT of a PDF invoice / credit note (FR / NL / EN),
// into the SAME common model as the UBL reader (purchase-document.js). Local only: no OCR, no image analysis, no language model, no network.
//
// Rules, not guesses:
//   - a value is taken only when a label says what it is. A label is found where people put it: before the value in the same cell,
//     in the cell on its left, or in the cell ABOVE it in the same column (a header row). A label that cannot be aligned with its value
//     is not used (the field stays to check) - e.g. an invoice date is never taken as the due date because both labels share a row;
//   - when several different values compete, a value is chosen only by a stated rule (a label that is more explicit than the others,
//     or the only net + VAT = total combination); otherwise the best one is proposed with a LOW confidence, or the field stays empty
//     and is listed as "to check". A number is never taken as the total because it is the largest;
//   - lines of the invoice-lines table and of the VAT table are never read as document totals ("BTW Import" on a line is not the VAT);
//   - a pro forma, a booking confirmation, or a PDF carrying several invoices is reported as such, never typed as a normal invoice;
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
const CURRENCY_CODES = ['EUR', 'USD', 'GBP', 'CHF', 'CNY', 'RMB'];
/** "EUR582.28" -> "EUR 582.28": a currency code glued to its amount. */
const unglue = (s) => String(s).replace(/\b(EUR|USD|GBP|CHF|CNY|RMB)(?=-?\d)/g, '$1 ');
const AMOUNT_RE = /(?<![\w.,/-])(-\s?)?((?:\d{1,3}(?:[.   ]\d{3})+|\d+),\d{2}|(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d%])/g;
/** European ("1.234,56", "1 234,56") and English ("1,234.56") amounts with exactly two decimals, as integer cents. */
export function amountsIn(text) {
  const out = [];
  for (const m of unglue(text).matchAll(AMOUNT_RE)) {
    const raw = m[2]; const comma = /,\d{2}$/.test(raw);
    const plain = comma ? raw.replace(/[.   ]/g, '').replace(',', '.') : raw.replace(/,/g, '');
    const c = toCents(plain); if (!Number.isInteger(c)) continue;
    out.push({ cents: m[1] ? -c : c, index: m.index, raw: m[0] });
  }
  return out;
}
const MONTHS = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8, october: 10,
  jan: 1, janv: 1, feb: 2, febr: 2, fev: 2, fév: 2, févr: 2, mar: 3, mrt: 3, apr: 4, avr: 4, jun: 6, jul: 7, juil: 7, aug: 8, aou: 8, aoû: 8, sep: 9, sept: 9, oct: 10, okt: 10, nov: 11, dec: 12, déc: 12 };
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_RE = new RegExp([
  '(?<!\\d)(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})(?!\\d)', // 10/09/2026, 10-09-2026, 07.06.2026
  '(?<!\\d)(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?!\\d)', // 2026-09-10, 2026/02/13
  `(?<![\\p{L}\\d])(\\d{1,2})(?:er)?[\\s-]+(${MONTH_ALT})(?!\\p{L})\\.?[\\s-]+(\\d{4})(?!\\d)`, // 12 septembre 2026, 26-MAR-2026, 02 APR 2026
  `(?<!\\p{L})(${MONTH_ALT})(?!\\p{L})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)`, // September 15, 2026, Jan 12, 2026
].join('|'), 'giu');
const iso = (y, m, d) => { const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.getUTCMonth() + 1 === Number(m) && t.getUTCDate() === Number(d) ? s : null; };
/** Dates written day-first (Belgian usage), year-first, or with a FR / NL / EN month name or abbreviation. `ambiguous` = day and month could be swapped. */
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

// ---------- identifiers ----------
const BE_VAT_RE = /\bBE[\s.]?(0?[01]\d{2,3}[\s.]?\d{3}[\s.]?\d{3})\b/gi;
/** VAT number formats per EU country (without the country code). A candidate that does not match is never a VAT number. */
const EU_VAT_FORMATS = { AT: /^U\d{8}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/, DK: /^\d{8}$/, EE: /^\d{9}$/, EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/, FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/, HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^(?:\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$/, IT: /^\d{11}$/,
  LT: /^(?:\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/, SE: /^\d{12}$/, SI: /^\d{8}$/, SK: /^\d{10}$/ };
const EU_VAT_LABELLED_RE = /\b(?:TVA|BTW|VAT|USt-?IdNr\.?|Btw-?nummer|Code\s*TVA)\s*(?:n[°o]\.?|nr\.?|no\.?|number|numéro|nummer|intracom\w*)?\s*[:.]?\s*((?:AT|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)(?:[\s.]?[A-Z0-9+*]){2,16})/gi;
/** The longest leading part of a labelled candidate that is a well-formed EU VAT number, or null (a word like "LUXEMBOURGEOIS" never is). */
function euVatOf(raw) {
  const tokens = raw.trim().split(/\s+/);
  for (let k = tokens.length; k >= 1; k -= 1) {
    const v = tokens.slice(0, k).join('').replace(/\./g, '').toUpperCase(); const re = EU_VAT_FORMATS[v.slice(0, 2)];
    if (re && re.test(v.slice(2))) return v;
  }
  return null;
}
const ENTERPRISE_RE = /\b(?:n[°o]\.?\s*(?:d['’]\s*)?entreprise|num[ée]ro\s*d['’]\s*entreprise|BCE|KBO|ondernemingsn(?:umme)?r\.?|RPM|RPR|company\s*(?:no\.?|number|registration))\s*[:.]?\s*(?:BE\s?)?([01]\d{3}[.\s]?\d{3}[.\s]?\d{3})\b/gi;
const ENTERPRISE_AFTER_RE = /\b([01]\d{3}[.\s]\d{3}[.\s]\d{3})\s*(?:RPR|RPM|KBO|BCE)\b/gi;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;
const STRUCTURED_RE = /([+*]{3})\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*\1/;
// legal forms: long ones in any case ("Limited", "B.V.", "CO.,LIMITED", "PTE. LTD.", "S.à r.l."), short ones only in capitals ("SA", "BV")
const LEGAL_LONG = /(?:\blimited\b|\bltd\b\.?|\bgmbh\b|\bs\.?\s?à\s?r\.?\s?l\.?|\bsarl\b|\bco\.?\s*,?\s*(?:ltd|limited)\b\.?|\bpte\.?\s*ltd\b|\binc\b\.?|\bllc\b|\bplc\b|\bb\.v\.|\bn\.v\.|\bs\.r\.l\.|\bs\.a\.(?!\w)|\bbvba\b|\bcvba\b|\bvzw\b|\basbl\b|\bsprl\b|\bscrl\b|soci[ée]t[ée]\s+anonyme|besloten\s+vennootschap)/i;
const LEGAL_SHORT = /\b(?:SRL|SA|SPRL|SC|SCS|SNC|SComm|BV|NV|CV|VOF|CommV|AG|SAS|SARL|Ltd)\b/;
const hasLegalForm = (s) => LEGAL_LONG.test(s) || LEGAL_SHORT.test(s);
/** Text that is never a company name: thanks, payment status, labels, web / contact details, sentences. */
const GENERIC_NAME = /(?:thank|merci|bedankt|danke|\bpay[ée]\b|\bpaid\b|betaald|\binvoice\b|\bfacture\b|\bfactuur\b|\breceipt\b|\bpage\s*\d|\btotal\b|\bclient\b|\bcustomer\b|\bklant\b|www\.|https?:|@|shopping|\border\b|commande|bestel|\bdate\b|datum|\btel\b|phone|\biban\b|swift|\bbic\b|\bvat\b|\btva\b|\bbtw\b|address|adresse|\badres\b|name\s*-)/i;
const plausibleName = (s) => { const t = String(s ?? '').trim(); return t.length >= 2 && t.length <= 90 && /\p{L}{2}/u.test(t) && !/[!?]$/.test(t) && !GENERIC_NAME.test(t) && (t.match(/\d/g) ?? []).length < 3; };
const compactIban = (s) => s.replace(/\s+/g, '').toUpperCase();
const beDigits = (s) => { const n = normalizeBelgianNumber(s); return n.ok ? n.digits : null; };
const normName = (s) => (s ? String(s).toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim() : null);
const structuredValid = (d) => { const base = Number(d.slice(0, 10)); const mod = base % 97 || 97; return mod === Number(d.slice(10)); };
const COUNTRY_WORDS = { BE: /^(?:belgi(?:que|ë|e|um)|belgique)$/i, NL: /^(?:the\s+)?netherlands$|^nederland$|^pays-bas$/i, FR: /^france$|^frankrijk$/i, IE: /^ireland$|^irlande$|^ierland$/i, LU: /^luxembourg$|^luxemburg$/i, DE: /^germany$|^deutschland$|^allemagne$|^duitsland$/i };
const countryOfWord = (s) => Object.entries(COUNTRY_WORDS).find(([, re]) => re.test(String(s).trim()))?.[0] ?? null;

// ---------- labels (FR / NL / EN) ----------
const L = {
  creditTitle: /^(?:note\s*de\s*cr[ée]dit|avoir|credit\s*-?\s*note|creditnota|kredietnota)\b/i,
  invoiceTitle: /^(?:facture|invoice|factuur|tax\s*invoice|bill\s*#|receipt\s*\/\s*tax\s*invoice)|\btax\s*invoice\b/i,
  receiptTitle: /^(?:e-?receipt|receipt|re[çc]u|ticket(?:\s*de\s*caisse)?|kassabon|kwitantie)\b/i,
  proforma: /\bpro[\s-]?forma\b/i,
  booking: /confirmation\s*de\s*r[ée]servation|booking\s*confirmation|reservation\s*confirmation|reserveringsbevestiging|bevestiging\s*van\s*(?:uw\s*)?reservering/i,
  due: /(?<!\p{L})(?:date\s*d['’]\s*[ée]ch[ée]ance|[ée]ch[ée]ance|à\s*payer\s*avant|à\s*r[ée]gler\s*avant|payable\s*(?:avant|le)|vervaldatum|vervaldag|te\s*betalen\s*(?:voor|vóór|tegen)|uiterste\s*betaal\s*datum|due\s*date|due\s*on|payment\s*due|pay\s*by|payable\s*by)(?!\p{L})/iu,
  issueExplicit: /\b(?:date\s*(?:de\s*(?:la\s*)?)?(?:facture|l['’]\s*avoir|la\s*note|document|[ée]mission)|factuurdatum|datum\s*factuur|creditnotadatum|invoice\s*date|date\s*of\s*(?:issue|invoice)|issue\s*date|tax\s*point)\b/i,
  issuePayment: /\b(?:payment\s*date|paid\s*on|date\s*de\s*paiement|betaaldatum|betaald\s*op|receipt\s*date)\b/i,
  otherDate: /\b(?:livraison|levering|delivery|commande|order|bestel\w*|p[ée]riode|period|periode|prestation|dienst|service|échéancier|call\s*date|e\.?t\.?[sa]\b\.?|departure|arrival|check-?in|check-?out|rate\s*application|valid\w*|expir\w*|imprim\w*|printed|shipping|verzend\w*|exp[ée]di\w*|voyage|vessel|created)\b/i,
  issueGeneric: /\b(?:date|datum)\s*[:.]?\s*$/i,
  billingRef: /\b(?:concerne|relative\s*à|se\s*rapportant\s*à|annule|en\s*r[ée]f[ée]rence\s*à|sur|betreft|m\.?b\.?t\.?|voor|original|related|refers?\s*to|credit(?:s|ing)?)\s*(?:la\s*|de\s*)?(?:facture|factuur|invoice)\s*(?:n[°o]\.?|nr\.?|no\.?|number|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi,
  order: /\b(?:bon\s*de\s*commande|n[°o]\.?\s*(?:de\s*)?commande|num[ée]ro\s*de\s*(?:la\s*)?commande|commande|votre\s*r[ée]f[ée]rence|v\/?\s*r[ée]f\.?|purchase\s*order|order\s*(?:no\.?|number|ref(?:erence)?|#)|your\s*ref(?:erence)?|PO|bestelbon|bestelnummer|bestelling|uw\s*ref(?:erentie)?|booking\s*(?:no\.?|number|ref(?:erence)?|#)|num[ée]ro\s*de\s*confirmation|confirmation\s*(?:no\.?|number))\s*(?:n[°o]\.?|nr\.?|no\.?)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi,
  paymentFree: /\b(?:communication|mededeling|r[ée]f[ée]rence\s*(?:de\s*)?paiement|payment\s*reference|betalingsreferentie|referentie\s*betaling)\s*[:.]?\s*(.{3,60})$/i,
  vatWord: /\b(?:tva|btw|vat)\b/i,
  rateWord: /\b(?:taux|tarief|rate)\b|%|btw-tarief/i,
  rate: /(?<![\d,.])(\d{1,2}(?:[.,]\d{1,2})?)\s?%/,
  itemsHeader: /\b(?:description|d[ée]signation|libell[ée]|omschrijving|beschrijving|artikel|article|produit|items?|product|prestation|name\s*of\s*commodity)\b/i,
  descWord: /\b(?:description|d[ée]signation|libell[ée]|omschrijving|beschrijving|artikel|article|produit|product|prestation|name\s*of\s*commodity)\b/i,
  itemsHeaderAmount: /\b(?:total|totaal|montant|bedrag|amount|prix|prijs|price|qt[ée]|quantit[ée]|qty|quantity|aantal)\b/i,
  exemption: /\b(?:exon[ée]r\w*|autoliquidation|vrijgesteld\w*|verlegd\w*|reverse\s*charge|intracommunautaire|art(?:icle|ikel)?\.?\s*(?:39|44|21)\b)/i,
  seller: /^(?:verkocht\s*door|vendu\s*par|sold\s*by|seller|vendeur|verkoper|fournisseur|supplier|leverancier|[ée]mis\s*par|issued\s*by|billed\s*by)\s*[:.]?\s*(.*)$/i,
  addressLine: /\b(?:rue|straat|street|road|avenue|ave\.?|laan|weg|plaza|building|floor|district|zone|province|bank\s*address|chauss[ée]e|boulevard|quai|place|plein|steenweg)\b/i,
  pricesInclVat: /\b(?:tva|btw|vat)\b[^|]{0,20}\bincl|\b(?:tva|btw)\s*incluse?\b|inclusief\s*btw/i,
};
// labels of amounts, ANCHORED at the start of the label text (strength: 3 invoice total, 2 explicit, 1 generic)
const AMOUNT_LABELS = [
  ['grossCents', 3, 'LABEL_TOTAL_INCL_VAT', /^(?:(?:grand\s*)?total\s*(?:ttc|tvac|t\.?v\.?a\.?c\.?|incl(?:\.|uding|usief)?\s*(?:btw|tva|vat|tax)|g[ée]n[ée]ral|generaal|factuur|facture|invoice)|(?:facture|factuur|invoice)\s*total|montant\s*(?:ttc|tvac|total)|totaal\s*(?:incl\.?\s*btw|factuur)|grand\s*total|tvac|ttc)\b/i],
  ['grossCents', 2, 'LABEL_TOTAL_TO_PAY', /^(?:total\s*(?:à\s*payer|a\s*payer|to\s*pay|due|te\s*betalen|paid|pay[ée]|betaald)|montant\s*à\s*payer|net\s*à\s*payer|solde\s*à\s*payer|(?:totaal\s*)?te\s*betalen(?:\s*bedrag)?|amount\s*due|balance\s*due)\b/i],
  ['netCents', 2, 'LABEL_TOTAL_EXCL_VAT', /^(?:total\s*(?:htva|h\.?t\.?v\.?a\.?|ht|hors\s*tva|excl(?:\.|uding|usief)?\s*(?:btw|tva|vat|tax)?|net)\b|totaal\s*excl\.?\s*btw|montant\s*(?:htva|ht|hors\s*tva)|htva\b|hors\s*tva|excl\.?\s*(?:btw|tva|vat)|maatstaf\s*van\s*heffing|net\s*amount|taxable\s*amount)/i],
  ['vatCents', 2, 'LABEL_VAT', /^(?:total\s*(?:tva|btw|vat|tax)|(?:[A-Z]{2}\s+)?(?:tva|btw|vat)(?:\s*total)?|montant\s*(?:de\s*(?:la\s*)?)?tva|btw-?\s*bedrag|bedrag\s*btw|vat\s*amount|tax\s*amount)\b(?![\s:]*(?:n[°o]|nr\b|no\b|number|numéro|nummer|intra|id\b|reg|applied|due\b|zero|exempt|charged|déclarée|afgedragen|collect|import))/i],
  ['grossCents', 1, 'LABEL_TOTAL', /^(?:total|totaal)(?:\s*amount|\s*bedrag)?\b(?!\s*(?:ht\b|htva|hors|excl|tva|btw|vat|tax|net|item|weight|cbm|pcs|qty|kg|ctn|charge))/i],
  ['netCents', 1, 'LABEL_SUBTOTAL', /^(?:sous-?\s*total|sub-?\s*total|subtotaal)\b/i],
];
const classifyAmountLabel = (label) => { const t = label.replace(/^[\s*:·•-]+/, '').trim(); return AMOUNT_LABELS.find(([, , , re]) => re.test(t)) ?? null; };
const hasDigit = (s) => /\d/.test(s);
const letters = (s) => (String(s).match(/\p{L}/gu) ?? []).length;
const isCurrencyOnly = (s) => /^(?:€|\$|£|¥|EUR|USD|GBP|CHF|CNY|RMB)$/i.test(String(s).trim());
const clean = (s) => String(s).replace(/[\s:·|.\-–#]+$/, '').trim();

/** Lines of all pages, each with its cells (columns). */
function flatten(pages) {
  const out = [];
  for (const p of pages) p.lines.forEach((l, i) => out.push({ ...l, page: p.page, index: i, cells: l.cells ?? [{ text: l.text, x: l.x }] }));
  return out;
}
/** The cell right above `cell` in the same column (a header row): previous lines of the same page, at most 30 points higher, left edges aligned. */
function cellAbove(lines, li, cell, tolerance = 25) {
  const l = lines[li];
  for (let j = li - 1; j >= 0 && j >= li - 3; j -= 1) {
    const p = lines[j]; if (p.page !== l.page || p.y - l.y > 30) break;
    const c = p.cells.find((x) => Math.abs(x.x - cell.x) <= tolerance);
    if (c) return { line: p, cell: c };
  }
  return null;
}
/**
 * The label of a value found in cell `ci` of line `li` (`before` = the text before the value in that same cell):
 * that text, else the nearest cell on the left (stopping at a cell that holds another value), else the aligned cell above.
 */
function labelFor(lines, li, ci, before) {
  const b = clean(before).replace(/(?:€|\$|£|¥|\b(?:EUR|USD|GBP|CHF|CNY|RMB))\s*$/i, '').trim();
  if (letters(b) >= 2) return { text: b, how: 'SAME_CELL' };
  const l = lines[li];
  for (let k = ci - 1; k >= 0; k -= 1) {
    const t = l.cells[k].text; if (isCurrencyOnly(t)) continue;
    if (datesIn(t).length || amountsIn(t).length) break;
    if (letters(t) >= 2) return { text: clean(t), how: 'LEFT_CELL' };
  }
  const above = cellAbove(lines, li, l.cells[ci]);
  if (above && letters(above.cell.text) >= 2 && !datesIn(above.cell.text).length && !amountsIn(above.cell.text).length) return { text: clean(above.cell.text), how: 'ABOVE', line: above.line };
  return null;
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
  const notOurs = (s) => !ownNames.has(normName(s)) && ![...ownNames].some((n) => n && normName(s).includes(n));
  const text = lines.map((l) => l.text).join('\n');
  const cellAt = (li, ci) => ({ ...lines[li], text: lines[li].cells[ci].text, x: lines[li].cells[ci].x });

  // ---- document type: title cells; a pro forma or a booking confirmation is never a normal invoice ----
  const anyCell = (re) => { for (let i = 0; i < lines.length; i += 1) { const c = lines[i].cells.findIndex((x) => re.test(x.text)); if (c >= 0) return cellAt(i, c); } return null; };
  const proforma = anyCell(L.proforma); const booking = L.booking.test(text) ? anyCell(L.booking) : null;
  const creditLine = anyCell(L.creditTitle); const invoiceLine = anyCell(L.invoiceTitle); const receiptLine = anyCell(L.receiptTitle);
  let docType = null;
  if (proforma) warnings.push('DOCUMENT_IS_PRO_FORMA');
  else if (booking) warnings.push('DOCUMENT_IS_BOOKING_CONFIRMATION');
  else if (creditLine) { docType = 'CREDIT_NOTE'; put('documentType', 'CREDIT_NOTE', 0.9, creditLine, 'TITLE_CREDIT_NOTE'); } else if (invoiceLine) { docType = 'INVOICE'; put('documentType', 'INVOICE', 0.9, invoiceLine, 'TITLE_INVOICE'); } else if (receiptLine) { docType = 'RECEIPT'; put('documentType', 'RECEIPT', 0.7, receiptLine, 'TITLE_RECEIPT'); }

  // ---- identifiers: supplier VAT / enterprise number / IBAN (never the merchant's own; never a malformed value) ----
  const vatHits = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(BE_VAT_RE)) { const n = normalizeBelgianNumber(m[1]); if (n.ok) vatHits.push({ value: n.vatNumber, line: l, digits: n.digits }); }
    for (const m of l.text.matchAll(EU_VAT_LABELLED_RE)) { const v = euVatOf(m[1]); if (v && !v.startsWith('BE')) vatHits.push({ value: v, line: l, digits: null }); }
  }
  const supplierVats = vatHits.filter((h) => !ownVat.has(h.value) && !(h.digits && ownEnt.has(h.digits)));
  const distinctVats = [...new Set(supplierVats.map((h) => h.value))];
  let supplierVatHit = null;
  if (distinctVats.length === 1) { supplierVatHit = supplierVats[0]; put('supplierVatNumber', supplierVatHit.value, 0.9, supplierVatHit.line, 'VAT_NUMBER_NOT_OURS'); } else if (distinctVats.length > 1) {
    supplierVatHit = supplierVats.slice().sort((a, b) => a.line.page - b.line.page || b.line.y - a.line.y)[0]; // the first one on the document, proposed only
    put('supplierVatNumber', supplierVatHit.value, 0.4, supplierVatHit.line, 'VAT_NUMBER_FIRST_OF_SEVERAL'); warnings.push('SUPPLIER_VAT_AMBIGUOUS');
  }
  const entHits = [];
  for (const l of lines) for (const re of [ENTERPRISE_RE, ENTERPRISE_AFTER_RE]) for (const m of l.text.matchAll(re)) { const n = normalizeBelgianNumber(m[1]); if (n.ok && !ownEnt.has(n.digits)) entHits.push({ value: n.enterpriseNumber, line: l }); }
  const distinctEnt = [...new Set(entHits.map((h) => h.value))];
  if (distinctEnt.length === 1) put('supplierEnterpriseNumber', distinctEnt[0], 0.85, entHits[0].line, 'LABEL_ENTERPRISE_NUMBER');
  else if (distinctEnt.length > 1) warnings.push('SUPPLIER_ENTERPRISE_NUMBER_AMBIGUOUS');
  const ibanHits = [];
  for (const l of lines) for (const m of l.text.matchAll(IBAN_RE)) { const v = compactIban(m[1]); if (isValidIban(v) && !ownIban.has(v)) ibanHits.push({ value: v, line: l, labelled: /\b(?:iban|compte|rekening|account|bank)\b/i.test(l.text) }); }
  const distinctIban = [...new Set(ibanHits.map((h) => h.value))];
  if (distinctIban.length === 1) put('supplierIban', distinctIban[0], 0.9, ibanHits[0].line, 'IBAN_VALID_NOT_OURS');
  else if (distinctIban.length > 1) { const best = ibanHits.find((h) => h.labelled) ?? ibanHits[0]; put('supplierIban', best.value, 0.4, best.line, 'IBAN_FIRST_OF_SEVERAL'); warnings.push('IBAN_AMBIGUOUS'); }

  // ---- supplier name: a "seller" label, else the block above the supplier's VAT number, else a company name at the top of page 1 ----
  const nameCands = [];
  const sellerValue = (li, ci, rest) => {
    const l = lines[li];
    if (letters(rest) >= 2) return { li, ci, text: rest };
    if (l.cells[ci + 1] && letters(l.cells[ci + 1].text) >= 2) return { li, ci: ci + 1, text: l.cells[ci + 1].text };
    for (let j = li + 1; j < lines.length && j <= li + 3 && lines[j].page === l.page && l.y - lines[j].y <= 30; j += 1) { // value BELOW its label (a header row)
      const k = lines[j].cells.findIndex((x) => Math.abs(x.x - l.cells[ci].x) <= 25); if (k >= 0) return { li: j, ci: k, text: lines[j].cells[k].text };
    }
    return null;
  };
  lines.forEach((l, li) => l.cells.forEach((c, ci) => { const m = L.seller.exec(c.text.trim()); if (!m) return; const v = sellerValue(li, ci, m[1].trim()); if (v && plausibleName(v.text) && notOurs(v.text)) nameCands.push({ ...v, rule: 'LABEL_SELLER', conf: 0.8 }); }));
  const inColumnBlock = (vl, vcell, maxUp = 160) => lines.map((l, li) => ({ l, li })).filter(({ l }) => l.page === vl.page && l.y > vl.y && l.y - vl.y <= maxUp).sort((a, b) => a.l.y - b.l.y)
    .map(({ l, li }) => { const ci = l.cells.map((c, k) => [Math.abs(c.x - vcell.x), k]).sort((a, b) => a[0] - b[0])[0][1]; return { l, li, ci, c: l.cells[ci] }; }).filter(({ c }) => Math.abs(c.x - vcell.x) <= 60);
  if (!nameCands.length && supplierVatHit) {
    const vl = supplierVatHit.line; const vcell = l2cell(vl, supplierVatHit.value) ?? vl.cells[0];
    const col = inColumnBlock(vl, vcell); const footer = vl.y < 110;
    const legal = col.find(({ c }) => hasLegalForm(c.text) && plausibleName(c.text) && notOurs(c.text));
    if (legal) nameCands.push({ li: legal.li, ci: legal.ci, text: legal.c.text, rule: 'NAME_WITH_LEGAL_FORM_ABOVE_VAT', conf: 0.75 });
    else if (!footer && col.length) { const top = col[col.length - 1]; if (plausibleName(top.c.text) && notOurs(top.c.text)) nameCands.push({ li: top.li, ci: top.ci, text: top.c.text, rule: 'FIRST_LINE_OF_VAT_BLOCK', conf: 0.5 }); }
  }
  if (!nameCands.length) { // a company name (legal form) at the top of page 1; "Name • street • city" cells are split
    const p1 = lines.filter((l) => l.page === 1); const topY = p1.length ? Math.max(...p1.map((l) => l.y)) : 0;
    outer: for (let li = 0; li < lines.length; li += 1) {
      const l = lines[li]; if (l.page !== 1 || topY - l.y > 260) continue;
      for (let ci = 0; ci < l.cells.length; ci += 1) {
        const part = l.cells[ci].text.split(/\s+[•|]\s+|\s+-\s+(?=\S)/)[0].trim();
        if (hasLegalForm(part) && plausibleName(part) && notOurs(part)) { nameCands.push({ li, ci, text: part, rule: 'NAME_WITH_LEGAL_FORM_AT_TOP', conf: supplierVatHit ? 0.5 : 0.4 }); break outer; }
      }
    }
    if (nameCands.length && !supplierVatHit) warnings.push('SUPPLIER_NOT_IDENTIFIED_BY_VAT');
  }
  const nameKey = (s) => normName(String(s).split(',')[0]);
  const distinctNames = [...new Set(nameCands.map((n) => nameKey(n.text)))];
  let nameAt = null;
  if (nameCands.length) {
    nameAt = nameCands[0];
    const conf = distinctNames.length > 1 ? 0.4 : nameAt.conf; if (distinctNames.length > 1) warnings.push('SUPPLIER_NAME_AMBIGUOUS');
    put('supplierName', nameAt.text.trim(), conf, cellAt(nameAt.li, nameAt.ci), nameAt.rule);
  }

  // ---- supplier address: the lines under the name (same column), or the parts of a "Name • street • 7512HL City" cell ----
  const parsePostal = (s) => {
    const t = String(s).trim().replace(/\s*,\s*$/, ''); let m;
    if ((m = /^(.*?)[,\s]+([AC-FHKNPRTV-Y]\d{2}|D6W)\s?([0-9AC-FHKNPRTV-Y]{4})\b[,\s]*(.*)$/u.exec(t))) { // Irish Eircode
      const after = m[4].trim(); const before = m[1].trim(); const tail = countryOfWord(after);
      return tail || !after ? { postalCode: `${m[2]} ${m[3]}`, city: before.split(',').pop().trim(), streetPart: before.includes(',') ? before.split(',').slice(0, -1).join(',').trim() : null, country: tail ?? 'IE' }
        : { postalCode: `${m[2]} ${m[3]}`, city: after.replace(/,.*$/, '').trim(), streetPart: before || null, country: 'IE' };
    }
    if ((m = /^(?:[A-Z]{1,2}-)?(\d{4}\s?[A-Z]{2})\s+(\p{L}[\p{L}' .-]{1,40})$/u.exec(t))) return { postalCode: m[1].replace(/\s/, ''), city: m[2].trim(), country: 'NL' };
    if ((m = /^(?:(?:B|F|L|D|NL)-)?(\d{4,5})\s*(?:\.\.)?\s*(\p{L}[\p{L}' .-]{1,40})$/u.exec(t))) return { postalCode: m[1], city: m[2].trim() };
    if ((m = /^(\p{L}[\p{L}' .-]{1,40}),\s*(\d{4,5})$/u.exec(t))) return { postalCode: m[2], city: m[1].trim() };
    return null;
  };
  const vatCountry = () => (f.supplierVatNumber ? String(f.supplierVatNumber.value).slice(0, 2) : null);
  const addressFrom = (cand) => {
    const l = lines[cand.li]; const cell = l.cells[cand.ci];
    const parts = cell.text.split(/\s+[•|]\s+/).map((s) => s.trim());
    if (parts.length >= 3) { // "Exemple Trading B.V. • Exempelstraat 25-E • 7512HL Enschede • The Netherlands"
      const pi = parts.findIndex((p, k) => k > 0 && parsePostal(p)); if (pi > 0) { const pc = parsePostal(parts[pi]); return { street: parts.slice(1, pi).join(', ') || null, postalCode: pc.postalCode, city: pc.city, countryCode: countryOfWord(parts[pi + 1] ?? '') ?? pc.country ?? vatCountry(), at: { ...l, text: cell.text } }; }
    }
    const below = []; // the next lines of the same column, under the name
    for (let j = cand.li + 1; j < lines.length && below.length < 6; j += 1) {
      const n = lines[j]; if (n.page !== l.page || l.y - n.y > 100) break;
      const c = n.cells.find((x) => Math.abs(x.x - cell.x) <= 60); if (!c) continue;
      if (/\b(?:tva|btw|vat|iban|tel|phone|e-?mail|www|kbo|bce|rpr|rpm)\b|@/i.test(c.text)) break;
      below.push({ n, c });
    }
    for (let k = 0; k < below.length; k += 1) {
      const pc = parsePostal(below[k].c.text); if (!pc) continue;
      const streetLines = below.slice(0, k).map((b) => b.c.text.trim()).filter((s) => !countryOfWord(s));
      const street = [...streetLines, ...(pc.streetPart ? [pc.streetPart] : [])].join(', ') || null;
      const country = countryOfWord(below[k + 1]?.c.text ?? '') ?? pc.country ?? vatCountry() ?? null;
      return { street, postalCode: pc.postalCode, city: pc.city, countryCode: country, at: { ...below[k].n, text: below[k].c.text } };
    }
    return null;
  };
  for (const cand of nameCands.filter((n) => nameKey(n.text) === nameKey(nameCands[0]?.text ?? ''))) {
    const a = addressFrom(cand); if (!a) continue;
    const { at, ...addr } = a; put('supplierAddress', addr, 0.6, at, 'ADDRESS_UNDER_SUPPLIER_NAME'); break;
  }
  if (!f.supplierAddress && supplierVatHit && nameAt) { // the historical layout: postal line between the name and the VAT number
    const vl = supplierVatHit.line; const vcell = l2cell(vl, supplierVatHit.value) ?? vl.cells[0];
    const between = inColumnBlock(vl, vcell).filter(({ l }) => l.y < lines[nameAt.li].y);
    const pcl = between.find(({ c }) => parsePostal(c.text));
    if (pcl) { const pc = parsePostal(pcl.c.text); const street = between.find(({ l }) => l.y > pcl.l.y && l.y < lines[nameAt.li].y);
      put('supplierAddress', { street: street ? street.c.text.trim() : null, postalCode: pc.postalCode, city: pc.city, countryCode: /^BE/.test(supplierVatHit.value) ? 'BE' : supplierVatHit.value.slice(0, 2) }, 0.6, { ...pcl.l, text: pcl.c.text }, 'ADDRESS_IN_VAT_BLOCK'); }
  }

  // ---- references: document number (hardened), credited invoice, order / booking reference, payment communication ----
  const billingRefs = [];
  for (const l of lines) for (const m of l.text.matchAll(L.billingRef)) if (hasDigit(m[1])) billingRefs.push({ value: m[1].replace(/[.,;]$/, ''), line: l });
  if (docType === 'CREDIT_NOTE' && billingRefs.length) put('billingReference', billingRefs[0].value, [...new Set(billingRefs.map((b) => b.value))].length === 1 ? 0.8 : 0.4, billingRefs[0].line, 'LABEL_CREDITED_INVOICE');
  const orders = [];
  for (const l of lines) for (const m of l.text.matchAll(L.order)) if (hasDigit(m[1]) && !datesIn(m[1]).length) orders.push({ value: m[1].replace(/[.,;:]$/, ''), line: l });
  const orderValues = new Set(orders.map((o) => o.value));
  const excluded = new Set([...billingRefs.map((b) => b.value), ...vatHits.map((h) => h.value), ...orderValues]);
  const NOT_A_DOC_NUMBER_BEFORE = /(?:account|compte|rekening|customer|client|klant|debtor|d[ée]biteur|debiteur|file|dossier|booking|container|bank|tel|phone|order|commande|bestel|vat|tva|btw|company|registration|kvk|confirmation|ref|reference|house|licen[cs]e|serial|imei|reg|street|rue|straat|address|adres|plaza|avenue|road|building|floor|room|unit|seat|flight|vol|gst|kbo|bce|entreprise|item|article|artikel)\W*$/i;
  const DOC_WORD = '(?:facture|invoice|factuur|note\\s*de\\s*cr[ée]dit|avoir|credit\\s*-?\\s*note|creditnota|kredietnota|bill|tax\\s*invoice)';
  const NUM_LABEL = '(?:n[°o]\\.?|nr\\.?|no\\.?|number|num[ée]ro|nummer|#)';
  const DOC_NUMBER = new RegExp(`(?:\\b${DOC_WORD}\\s*${NUM_LABEL}?|\\b(?:n[°o]\\.?\\s*(?:de\\s*)?(?:la\\s*)?(?:facture|document|pi[èe]ce|avoir)|num[ée]ro\\s*de\\s*(?:la\\s*)?facture|factuurn(?:umme)?r\\.?|invoice\\s*(?:no\\.?|number|#)|document\\s*n[°o]))\\s*[:.#]?\\s*([A-Z0-9][A-Z0-9\\-/._]{0,29})`, 'gi');
  const EXPLICIT_NUMBER = /(?:factuurn(?:umme)?r|num[ée]ro\s*de\s*(?:la\s*)?facture|invoice\s*(?:no|number)|n[°o]\s*(?:de\s*)?facture|bill\s*#)/i;
  const LONELY_NUMBER = /(?:^|\s)(?:n[°o]\.?|nr\.?|number|num[ée]ro|nummer)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,29})/gi;
  const okNumber = (value, textAfter) => hasDigit(value) && !excluded.has(value) && !datesIn(value).length && !/^[,.]\d/.test(textAfter) && !amountsIn(value + textAfter.slice(0, 3)).length;
  const numbers = [];
  lines.forEach((l, li) => {
    for (const m of l.text.matchAll(DOC_NUMBER)) {
      const value = m[1].replace(/[.,;:]$/, ''); const after = l.text.slice(m.index + m[0].length); const pre = l.text.slice(Math.max(0, m.index - 25), m.index);
      if (/(?:total|totaal|montant|sub|sous|proforma|pro\s*forma)\s*$/i.test(pre) || !okNumber(value, after)) continue;
      numbers.push({ value, line: l, strong: true, explicit: EXPLICIT_NUMBER.test(m[0]) });
    }
    for (const m of l.text.matchAll(LONELY_NUMBER)) {
      const value = m[1].replace(/[.,;:]$/, ''); const after = l.text.slice(m.index + m[0].length); const pre = l.text.slice(Math.max(0, m.index - 30), m.index + 1);
      if (NOT_A_DOC_NUMBER_BEFORE.test(pre) || L.addressLine.test(l.text) || !okNumber(value, after)) continue;
      numbers.push({ value, line: l, strong: false });
    }
    // a number label alone in its cell ("INVOICE", "Invoice NO.:"): its value is the next cell, or the aligned cell BELOW it
    l.cells.forEach((c, ci) => {
      if (!/^(?:invoice|facture|factuur|invoice\s*(?:no\.?|number)|n[°o]\s*(?:de\s*)?facture|factuurnummer)\s*[:.#]?$/i.test(c.text.trim())) return;
      const isValue = (t) => /^[:#]?\s*[A-Z0-9][A-Z0-9\-/._]{1,29}$/i.test(t.trim()) && okNumber(t.replace(/^[:#]?\s*/, '').trim(), '');
      const right = l.cells[ci + 1];
      if (right && isValue(right.text)) { numbers.push({ value: right.text.replace(/^[:#]?\s*/, '').trim(), line: l, strong: true }); return; }
      for (let j = li + 1; j < lines.length && j <= li + 2 && lines[j].page === l.page && l.y - lines[j].y <= 20; j += 1) {
        const b = lines[j].cells.find((x) => Math.abs(x.x - c.x) <= 25); if (b && isValue(b.text)) { numbers.push({ value: b.text.trim(), line: lines[j], strong: true }); return; }
      }
    });
  });
  const numCands = numbers.filter((n) => !orderValues.has(n.value));
  const strongVals = [...new Set(numCands.filter((n) => n.strong).map((n) => n.value))]; const anyVals = [...new Set(numCands.map((n) => n.value))];
  const explicitVals = [...new Set(numCands.filter((n) => n.explicit).map((n) => n.value))];
  const severalInvoices = explicitVals.length > 1;
  if (severalInvoices) { warnings.push('MULTIPLE_INVOICES_IN_PDF'); put('invoiceNumber', explicitVals[0], 0.4, numCands.find((n) => n.value === explicitVals[0]).line, 'FIRST_OF_SEVERAL_INVOICES'); } else if (strongVals.length === 1) put('invoiceNumber', strongVals[0], 0.85, numCands.find((n) => n.value === strongVals[0]).line, 'LABEL_DOCUMENT_NUMBER');
  else if (strongVals.length > 1) { put('invoiceNumber', strongVals[0], 0.4, numCands.find((n) => n.value === strongVals[0]).line, 'FIRST_OF_SEVERAL_NUMBERS'); warnings.push('INVOICE_NUMBER_AMBIGUOUS'); } else if (anyVals.length === 1) put('invoiceNumber', anyVals[0], 0.6, numCands[0].line, 'LABEL_NUMBER'); else if (anyVals.length > 1) warnings.push('INVOICE_NUMBER_AMBIGUOUS');
  const distinctOrders = [...new Set(orders.map((o) => o.value))];
  if (distinctOrders.length === 1) put('orderReference', distinctOrders[0], 0.8, orders[0].line, 'LABEL_ORDER_REFERENCE'); else if (distinctOrders.length > 1) warnings.push('ORDER_REFERENCE_AMBIGUOUS');
  const sc = lines.map((l) => ({ l, m: STRUCTURED_RE.exec(l.text) })).find((x) => x.m);
  if (sc) { const d = sc.m[2] + sc.m[3] + sc.m[4]; const ok = structuredValid(d); put('paymentReference', `+++${sc.m[2]}/${sc.m[3]}/${sc.m[4]}+++`, ok ? 0.95 : 0.4, sc.l, ok ? 'STRUCTURED_COMMUNICATION' : 'STRUCTURED_COMMUNICATION_CHECK_DIGITS_WRONG'); if (!ok) warnings.push('STRUCTURED_COMMUNICATION_INVALID'); } else {
    const fr = lines.map((l) => ({ l, m: L.paymentFree.exec(l.text) })).find((x) => x.m); if (fr) put('paymentReference', fr.m[1].split(/\s{3,}/)[0].trim(), 0.6, fr.l, 'LABEL_PAYMENT_REFERENCE');
  }

  // ---- dates: each date gets the label of its own column (same cell, left cell, or the aligned cell of a header row above) ----
  const english = /\b(?:invoice|amount\s*due|due\s*date|subtotal)\b/i.test(text) && !/\b(?:facture|factuur|échéance|vervaldatum)\b/i.test(text);
  const issue = []; const due = []; const loose = [];
  lines.forEach((l, li) => l.cells.forEach((c, ci) => {
    for (const d of datesIn(c.text)) {
      const lab = labelFor(lines, li, ci, c.text.slice(0, d.index));
      const hit = { value: d.value, line: l, ambiguous: d.ambiguous && english, above: lab?.how === 'ABOVE' };
      const t = lab?.text ?? '';
      if (!lab) {
        // a header row right above that holds date labels, but not in this date's column: never guess which label is which
        const prev = lines[li - 1]; if (prev && prev.page === l.page && prev.y - l.y <= 30 && (L.due.test(prev.text) || L.issueExplicit.test(prev.text))) { warnings.push('DATE_LABELS_NOT_ALIGNED'); continue; }
        loose.push(hit); continue;
      }
      if (L.due.test(t)) due.push({ ...hit, strength: 3 }); else if (L.issueExplicit.test(t)) issue.push({ ...hit, strength: 3 });
      else if (L.otherDate.test(t)) continue; else if (L.issuePayment.test(t)) issue.push({ ...hit, strength: 2 }); else if (L.issueGeneric.test(t)) issue.push({ ...hit, strength: 1 }); else loose.push(hit);
    }
  }));
  const pickDate = (k, hits, rule) => {
    if (!hits.length) return false;
    const top = Math.max(...hits.map((h) => h.strength)); const best = hits.filter((h) => h.strength === top); const vals = [...new Set(best.map((h) => h.value))];
    const h = best.find((x) => x.value === vals[0]); const base = h.above ? 0.8 : top >= 2 ? 0.9 : 0.8;
    if (vals.length === 1) put(k, vals[0], h.ambiguous ? 0.5 : base, h.line, h.above ? `${rule}_ABOVE` : rule); else { put(k, vals[0], 0.4, h.line, `${rule}_FIRST_OF_SEVERAL`); warnings.push(`${k === 'dueDate' ? 'DUE' : 'ISSUE'}_DATE_AMBIGUOUS`); }
    if (h.ambiguous) warnings.push('DATE_FORMAT_AMBIGUOUS'); return true;
  };
  if (!pickDate('issueDate', issue, 'LABEL_ISSUE_DATE') && docType) { // an unlabelled date is used only on a document recognised as invoice / credit note / receipt
    const vals = [...new Set(loose.map((h) => h.value))];
    if (vals.length === 1) put('issueDate', vals[0], 0.6, loose[0].line, 'ONLY_DATE_ON_DOCUMENT'); else if (vals.length > 1) warnings.push('ISSUE_DATE_AMBIGUOUS');
  }
  pickDate('dueDate', due, 'LABEL_DUE_DATE');
  if (f.dueDate && f.issueDate && f.dueDate.value === f.issueDate.value && f.dueDate.zone && f.issueDate.zone && f.dueDate.zone.y === f.issueDate.zone.y && f.dueDate.zone.x === f.issueDate.zone.x) { delete f.dueDate; warnings.push('DUE_DATE_AMBIGUOUS'); } // one printed date cannot be both

  // ---- tables that are never document totals: invoice lines, and the VAT-by-rate table ----
  const isItemsHeader = (l) => L.itemsHeader.test(l.text) && L.itemsHeaderAmount.test(l.text) && !amountsIn(l.text).length && !datesIn(l.text).length;
  const isVatHeader = (l) => !amountsIn(l.text).length && !L.descWord.test(l.text) && L.rateWord.test(l.text) && (L.vatWord.test(l.text) || /\b(?:base|maatstaf|taxable|htva|excl)\b/i.test(l.text));
  const isTotalsLine = (l) => l.cells.some((c) => classifyAmountLabel(c.text) || /\b(?:totals?|totaal)\b/i.test(c.text));
  const itemsSpan = new Set(); const itemHeaders = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isItemsHeader(lines[i])) continue; itemHeaders.push(i);
    for (let j = i + 1; j < lines.length && lines[j].page === lines[i].page; j += 1) { if (isTotalsLine(lines[j]) || isVatHeader(lines[j])) break; itemsSpan.add(j); }
  }
  const vatTableRows = new Set(); const vatTableTotals = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isVatHeader(lines[i]) || itemsSpan.has(i)) continue;
    for (let j = i + 1; j < lines.length && lines[j].page === lines[i].page; j += 1) {
      const l = lines[j]; const am = amountsIn(l.text);
      if (!am.length && /^\(/.test(l.text.trim())) { vatTableRows.add(j); continue; } // "(excl. btw)" continuation of the header
      if (am.length && L.rate.test(l.text)) { vatTableRows.add(j); continue; }
      if (am.length >= 2 && /^(?:total|totaal)\b/i.test(l.cells[0].text.trim())) { vatTableRows.add(j); vatTableTotals.push({ line: l, net: am[am.length - 2].cents, vat: am[am.length - 1].cents }); }
      break;
    }
  }

  // ---- currency: the one written on the total line, else the only one on the document ----
  const CUR_RE = { EUR: /€|\bEUR\b/, USD: /\$|\bUSD\b/, GBP: /£|\bGBP\b/, CHF: /\bCHF\b/, CNY: /¥|\bCNY\b|\bRMB\b/ };

  // ---- VAT by rate: rows with a rate and a VAT word, or inside a VAT table ----
  const breakdown = [];
  lines.forEach((l, li) => {
    if (itemsSpan.has(li)) return;
    const r = L.rate.exec(l.text); const am = amountsIn(l.text);
    if (!r || !am.length || !(L.vatWord.test(l.text) || vatTableRows.has(li)) || AMOUNT_LABELS.some(([k, s, , re]) => k === 'grossCents' && s >= 2 && re.test(l.text.trim()))) return;
    const rateBp = Math.round(Number(r[1].replace(',', '.')) * 100);
    breakdown.push({ taxableCents: am.length >= 2 ? Math.abs(am[0].cents) : null, vatCents: Math.abs(am[am.length - 1].cents), rateBp, category: rateBp === 0 ? (L.exemption.test(text) ? 'E' : 'Z') : 'S',
      exemptionReason: rateBp === 0 ? (L.exemption.exec(text)?.[0] ?? null) : null, _line: l });
  });

  // ---- totals: every amount gets the label of its own column; tables above are excluded ----
  const cands = { netCents: [], vatCents: [], grossCents: [] };
  const inclPrices = lines.some((l) => L.pricesInclVat.test(l.text));
  lines.forEach((l, li) => {
    if (itemsSpan.has(li) || vatTableRows.has(li) || (L.rate.test(l.text) && L.vatWord.test(l.text))) return;
    l.cells.forEach((c, ci) => {
      const am = amountsIn(c.text); if (!am.length) return;
      const a = am[am.length - 1]; const lab = labelFor(lines, li, ci, unglue(c.text).slice(0, am[0].index)); if (!lab) return;
      const cls = classifyAmountLabel(lab.text); if (!cls) return;
      const [field, strength, rule] = cls;
      if (field === 'netCents' && strength === 1 && inclPrices) return; // "Sous-total" of prices that include VAT is not the amount excl. VAT
      cands[field].push({ cents: a.cents, strength, rule, line: l });
    });
    // a label alone on its line, its amount alone on the next line ("PL VAT -" / "€0,00")
    if (!amountsIn(l.text).length) {
      const n = lines[li + 1]; const cls = l.cells.map((c) => classifyAmountLabel(c.text)).find(Boolean);
      if (cls && n && n.page === l.page && l.y - n.y <= 30 && n.cells.every((c) => amountsIn(c.text).length || isCurrencyOnly(c.text)) && !itemsSpan.has(li + 1)) {
        const am = amountsIn(n.text); if (am.length) cands[cls[0]].push({ cents: am[am.length - 1].cents, strength: cls[1], rule: cls[2], line: n });
      }
    }
  });
  for (const t of vatTableTotals) { cands.netCents.push({ cents: t.net, strength: 2, rule: 'VAT_TABLE_TOTAL', line: t.line }); cands.vatCents.push({ cents: t.vat, strength: 2, rule: 'VAT_TABLE_TOTAL', line: t.line }); }
  const firstPageRows = breakdown.filter((b) => b._line.page === (breakdown[0]?._line.page));
  if (!cands.vatCents.length && firstPageRows.length && firstPageRows.every((b) => Number.isInteger(b.vatCents))) { // no VAT total printed: the sum of the printed VAT rows (one page)
    cands.vatCents.push({ cents: firstPageRows.reduce((a, b) => a + b.vatCents, 0), strength: 1, rule: 'SUM_OF_VAT_BY_RATE', line: firstPageRows[0]._line });
  }
  const neg = Object.values(cands).flat().some((c) => c.cents < 0);
  for (const k of Object.keys(cands)) for (const c of cands[k]) c.cents = Math.abs(c.cents);
  const chosen = {};
  if (!severalInvoices) {
    for (const [k, list] of Object.entries(cands)) {
      const vals = [...new Set(list.map((c) => c.cents))];
      if (vals.length === 1) { const c = list.find((x) => x.strength === Math.max(...list.map((y) => y.strength))); chosen[k] = { ...c, confidence: c.rule === 'SUM_OF_VAT_BY_RATE' ? 0.6 : c.strength >= 2 ? 0.9 : 0.7 }; continue; }
      if (vals.length > 1) {
        const top = Math.max(...list.map((c) => c.strength)); const topVals = [...new Set(list.filter((c) => c.strength === top).map((c) => c.cents))];
        if (topVals.length === 1) { chosen[k] = { ...list.find((c) => c.strength === top), confidence: 0.7 }; warnings.push('SEVERAL_AMOUNTS_MOST_EXPLICIT_LABEL_KEPT'); }
      }
    }
    const unresolved = Object.keys(cands).filter((k) => !chosen[k] && cands[k].length);
    if (unresolved.length) {
      const opts = (k) => (chosen[k] ? [chosen[k]] : cands[k]);
      const triples = [];
      for (const n of opts('netCents')) for (const v of opts('vatCents')) for (const g of opts('grossCents')) if (n.cents + v.cents === g.cents) triples.push({ n, v, g });
      const keys = [...new Set(triples.map((t) => `${t.n.cents}|${t.v.cents}|${t.g.cents}`))];
      if (keys.length === 1) { const t = triples[0]; for (const [k, c] of [['netCents', t.n], ['vatCents', t.v], ['grossCents', t.g]]) if (!chosen[k]) chosen[k] = { ...c, confidence: 0.7 }; warnings.push('AMOUNTS_CHOSEN_BY_CONSISTENCY'); } else for (const k of unresolved) warnings.push(`${k === 'grossCents' ? 'TOTAL_INCL_VAT' : k === 'netCents' ? 'TOTAL_EXCL_VAT' : 'VAT_AMOUNT'}_AMBIGUOUS`);
    }
    for (const k of ['netCents', 'vatCents', 'grossCents']) if (chosen[k]) put(k, chosen[k].cents, chosen[k].confidence, chosen[k].line, chosen[k].rule);
    const rows = breakdown.filter((b, i) => !breakdown.some((o, j) => j < i && o._line.page !== b._line.page && o.rateBp === b.rateBp && o.taxableCents === b.taxableCents && o.vatCents === b.vatCents));
    if (rows.length) put('vatBreakdown', rows.map(({ _line, ...b }) => b), 0.7, rows[0]._line, 'VAT_BY_RATE_ROWS');
  }
  // currency: written on the total line, else the only currency of the document
  const onTotal = f.grossCents ? Object.entries(CUR_RE).filter(([, re]) => re.test(f.grossCents.text ?? '')).map(([c]) => c) : [];
  const present = Object.entries(CUR_RE).filter(([, re]) => re.test(text)).map(([c]) => c);
  if (onTotal.length === 1) put('currency', onTotal[0], 0.9, { page: f.grossCents.page, x: f.grossCents.zone?.x, y: f.grossCents.zone?.y, text: f.grossCents.text }, 'CURRENCY_ON_TOTAL');
  else if (present.length === 1) { const c = present[0]; put('currency', c, 0.9, lines.find((l) => CUR_RE[c].test(l.text)), 'CURRENCY_SYMBOL'); } else if (present.length > 1) warnings.push('CURRENCY_AMBIGUOUS');
  if (neg) {
    if (docType === 'CREDIT_NOTE') warnings.push('NEGATIVE_AMOUNTS_ON_CREDIT_NOTE');
    else if (!proforma && !booking) { put('documentType', 'CREDIT_NOTE', 0.5, f.grossCents ? { page: f.grossCents.page, x: f.grossCents.zone?.x, y: f.grossCents.zone?.y, text: f.grossCents.text } : null, 'NEGATIVE_AMOUNTS'); warnings.push('NEGATIVE_INVOICE_READ_AS_CREDIT_NOTE'); }
  }

  // ---- invoice lines: rows of the items table; a row may span several text lines (description above its amounts) ----
  if (!severalInvoices) {
    let items = [];
    for (const hi of itemHeaders) {
      const found = []; let pending = null; let started = false;
      const cont = lines[hi + 1] && lines[hi + 1].page === lines[hi].page && lines[hi].y - lines[hi + 1].y <= 16 && /^\(/.test(lines[hi + 1].text.trim()) ? lines[hi + 1] : null;
      const marks = [...lines[hi].cells, ...(cont ? cont.cells : [])];
      const exclCell = marks.find((c) => /\((?:\s*excl|\s*ht\b|\s*htva|\s*hors)/i.test(c.text)); const hasIncl = marks.some((c) => /\((?:\s*incl|\s*ttc)/i.test(c.text));
      const exclIsUnit = exclCell ? lines[hi].cells.some((c) => Math.abs(c.x - exclCell.x) <= 25 && /per\s*eenheid|unitaire|unit/i.test(c.text)) : false;
      // the amount column named by the header (the rightmost "Amount / Total / Bedrag"): a later column may be a weight or a remark
      const amountCol = lines[hi].cells.filter((c) => /^(?:amount|total|totaal|montant|bedrag|subtotaal|item\s*total|line\s*total|prix\s*total|sub-?total)\b/i.test(c.text.trim())).pop() ?? null;
      for (let j = hi + 1; j < lines.length && itemsSpan.has(j); j += 1) {
        const l = lines[j]; const am = amountsIn(l.text);
        if (isItemsHeader(l)) { pending = null; continue; } // a second header inside the same span
        if (!am.length) {
          if (!started && /^\(/.test(l.text.trim())) continue; // header continuation "(excl. btw)"
          const t = l.cells.slice().sort((a, b) => letters(b.text) - letters(a.text))[0].text.trim();
          if (letters(t) >= 2 && (!pending || letters(t) > letters(pending))) pending = t;
          continue;
        }
        started = true;
        const firstAmountCell = l.cells.findIndex((c) => amountsIn(c.text).length && !(letters(c.text) >= 4));
        const left = l.cells.slice(0, firstAmountCell < 0 ? l.cells.length : firstAmountCell).filter((c) => letters(c.text) >= 2 && !isCurrencyOnly(c.text));
        const own = left.slice().sort((a, b) => letters(b.text) - letters(a.text))[0];
        const ownText = own ? own.text.trim() : null;
        const description = ownText && (letters(ownText) >= 12 || ownText.split(/\s+/).length >= 3) ? ownText : (pending ?? ownText);
        const right = l.cells.slice(firstAmountCell < 0 ? 0 : firstAmountCell).flatMap((c) => amountsIn(c.text));
        if (!description || !right.length) continue;
        const qty = l.cells.find((c) => /^\d+(?:[.,]\d{1,3})?$/.test(c.text.trim()) && !amountsIn(c.text).length);
        const rate = L.rate.exec(l.text);
        let lineNet = Math.abs(right[right.length - 1].cents);
        if (amountCol) { const near = l.cells.filter((c) => amountsIn(c.text).length && Math.abs(c.x - amountCol.x) <= 60).sort((a, b) => Math.abs(a.x - amountCol.x) - Math.abs(b.x - amountCol.x))[0]; if (near) lineNet = Math.abs(amountsIn(near.text).pop().cents); }
        if (exclCell && hasIncl) { // the last column includes VAT: take the aligned excl. VAT column
          const ex = l.cells.find((c) => Math.abs(c.x - exclCell.x) <= 30 && amountsIn(c.text).length); const q = qty ? Number(qty.text.trim().replace(',', '.')) : 1;
          if (ex) lineNet = Math.round(Math.abs(amountsIn(ex.text)[0].cents) * (exclIsUnit && Number.isInteger(q) ? q : 1));
        }
        found.push({ position: found.length + 1, id: null, description, quantity: qty ? qty.text.trim().replace(',', '.') : null, unitCode: null,
          unitPrice: right.length >= 2 ? right[right.length - 2].raw.trim() : null, netCents: lineNet, rateBp: rate ? Math.round(Number(rate[1].replace(',', '.')) * 100) : null, category: null, _line: l, _amounts: right.length }); // amounts of the amount columns only (not those written inside a description)
        pending = null;
      }
      // when most rows carry several amounts (quantity, price, total), a row with a single amount is a group subtotal or a reference, not a line
      const multi = found.filter((r) => r._amounts >= 2).length;
      const rows = multi >= 2 && multi > found.length / 2 ? found.filter((r) => r._amounts >= 2).map((r, i) => ({ ...r, position: i + 1 })) : found;
      if (rows.length) { items = rows; break; }
    }
    if (items.length) {
      const sum = items.reduce((a, it) => a + it.netCents, 0); const net = f.netCents?.value;
      const ok = Number.isInteger(net) && sum === net;
      put('lines', items.map(({ _line, _amounts, ...it }) => it), ok ? 0.7 : Number.isInteger(net) ? 0.4 : 0.5, items[0]._line, 'ITEMS_TABLE');
      if (Number.isInteger(net) && !ok) warnings.push('LINES_DO_NOT_ADD_UP');
    }
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
