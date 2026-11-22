// CAMT.053 (ISO 20022 bank-to-customer statement) adapter. SAME import contract as parseBankCsv: { rows, errors, columns, period, dataLines, delimiter }
// where every row is { id, line, date, valueDate, amountCents (signed: + credit / - debit), currency, counterpartyName, reference, structuredReference, fingerprint }.
// Read-only and offline: a file the merchant downloads from the bank. Money is parsed as integer cents from the decimal text, never as a float.
// Safety: parseXml (purchase-document.js) refuses any DOCTYPE / ENTITY outright; the file size is capped; every entry becomes a row or an error.
// Status: SYNTHETIC fixtures only. Bank-specific variants (CGI, Febelfin v2.1 subset, bank extensions) are NOT verified against a real Belgian export.
import { createHash } from 'node:crypto';
import { FinanceError } from './document.js';
import { parseXml, XmlError } from './purchase-document.js';
import { civilDateIn } from './civil-date.js';
import { maskIban } from './bank.js';

export const CAMT_MAX_BYTES = 2_000_000;
const MAX_ENTRIES = 5000;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

const kids = (n, name) => n.children.filter((c) => c.name === name);
const find = (n, name, out = []) => { for (const c of n.children) { if (c.name === name) out.push(c); find(c, name, out); } return out; };
const first = (n, path) => { let cur = [n]; for (const name of path) { cur = cur.flatMap((x) => kids(x, name)); if (!cur.length) return null; } return cur[0]; };
const textAt = (n, path) => { const x = first(n, path); return x ? x.text.trim() : ''; };
const OGM = /\+{3}\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*\+{3}/;

function centsOf(amountText) {
  if (!AMOUNT.test(amountText)) return null;
  const [i, d = ''] = amountText.split('.');
  const v = Number(i) * 100 + Number(d.padEnd(2, '0'));
  return Number.isSafeInteger(v) ? v : null;
}

/**
 * @param {string} xml the CAMT.053 document text
 * @returns {{rows: object[], errors: {line: number, code: string, reason: string}[], delimiter: null, dataLines: number, columns: object, period: {from: string, to: string}|null, currencies: string[]}}
 */
export function parseCamt053(xml, { timeZone = 'Europe/Brussels' } = {}) {
  const text = String(xml ?? '');
  if (!text.trim()) throw new FinanceError('BANK_CAMT_EMPTY');
  if (Buffer.byteLength(text, 'utf8') > CAMT_MAX_BYTES) throw new FinanceError('BANK_CAMT_TOO_LARGE');
  let doc;
  try { doc = parseXml(text); } catch (e) { throw new FinanceError('BANK_CAMT_REFUSED', e instanceof XmlError ? e.code : 'XML_MALFORMED'); }
  // parseXml returns the document element itself (its name has no prefix; its attributes carry the xmlns).
  const root = doc ?? null;
  if (!root) throw new FinanceError('BANK_CAMT_REFUSED', 'XML_EMPTY');
  // Only a CAMT.053 statement is accepted: root <Document> in the camt.053 namespace (prefixes are stripped by parseXml, so the namespace is read from the attributes).
  if (root.name !== 'Document' || !Object.values(root.attrs).some((v) => /camt\.053\.001\.\d{2}/.test(String(v)))) throw new FinanceError('BANK_CAMT_REFUSED', 'NOT_CAMT053');
  // The account is identified by its IBAN, kept MASKED only (never the full number).
  const ibanNode = first(root, ['BkToCstmrStmt', 'Stmt', 'Acct', 'Id', 'IBAN']);
  const ibanMasked = ibanNode ? maskIban(ibanNode.text.trim()) : null;
  // The account is part of every identifier: two bank accounts never share an id, a fingerprint or a reliable reference (only a hash of the IBAN is used, never the number).
  const accountTag = ibanNode ? createHash('sha256').update(ibanNode.text.replace(/\s+/g, '').toUpperCase()).digest('hex').slice(0, 12) : 'noiban';
  const entries = find(root, 'Ntry');
  if (!entries.length) throw new FinanceError('BANK_CAMT_NO_ENTRIES');
  if (entries.length > MAX_ENTRIES) throw new FinanceError('BANK_CAMT_TOO_MANY_ENTRIES', String(entries.length));

  const parsed = []; const errors = []; const batches = [];
  entries.forEach((e, idx) => {
    const line = idx + 1;
    const status = textAt(e, ['Sts']) || 'BOOK';
    if (status !== 'BOOK') { errors.push({ line, code: 'ROW_INVALID', reason: 'NOT_BOOKED' }); return; }
    // A reversal (correction) is not imported automatically: it would have to cancel a movement already reconciled. Refused per line, never guessed.
    if (textAt(e, ['RvslInd']) === 'true') { errors.push({ line, code: 'ROW_INVALID', reason: 'REVERSAL_NOT_SUPPORTED' }); return; }
    const amtNode = first(e, ['Amt']); const ccy = amtNode?.attrs?.Ccy ?? '';
    const cents = centsOf(amtNode?.text.trim() ?? '');
    if (cents === null || cents === 0) { errors.push({ line, code: 'ROW_INVALID', reason: 'AMOUNT_INVALID' }); return; }
    if (!/^[A-Z]{3}$/.test(ccy)) { errors.push({ line, code: 'ROW_INVALID', reason: 'CURRENCY_INVALID' }); return; }
    const ind = textAt(e, ['CdtDbtInd']);
    if (ind !== 'CRDT' && ind !== 'DBIT') { errors.push({ line, code: 'ROW_INVALID', reason: 'DIRECTION_INVALID' }); return; }
    // The business date is the merchant's civil date of the booking instant (never a truncated timestamp string).
    const bookDt = textAt(e, ['BookgDt', 'Dt']); const bookTm = textAt(e, ['BookgDt', 'DtTm']);
    const date = bookDt || (bookTm ? civilDateIn(bookTm, timeZone) : '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push({ line, code: 'ROW_INVALID', reason: 'DATE_INVALID' }); return; }
    const valueDate = textAt(e, ['ValDt', 'Dt']) || null;
    const signed = ind === 'CRDT' ? cents : -cents;
    const unstructured = find(e, 'Ustrd').map((n) => n.text.trim()).filter(Boolean).join(' ');
    // A batch entry (several TxDtls) may carry several creditor references: a structured reference is used only when it is UNIQUE in the entry.
    const strdRefs = [...new Set(find(e, 'Ref').map((n) => n.text.replace(/\D/g, '')).filter((d) => d.length === 12))];
    const strdRef = strdRefs.length === 1 ? strdRefs[0] : '';
    // Batch detail: the entry amount is the bank's truth; the TxDtls sum is only reported (fees or several items can make it differ).
    const details = find(e, 'TxDtls');
    if (details.length > 1) {
      const detailSum = details.reduce((s, d) => { const a = first(d, ['Amt']); const v = a ? centsOf(a.text.trim()) : null; return v === null ? s : s + v; }, 0);
      batches.push({ line, txCount: details.length, detailSumCents: detailSum, entryCents: cents, consistent: detailSum === cents });
    }
    const reference = unstructured.slice(0, 300);
    const structuredReference = strdRef || ((OGM.exec(reference) ?? []).slice(1).join('') || null);
    const cpPath = ind === 'CRDT' ? 'Dbtr' : 'Cdtr';
    const counterpartyName = textAt(e, ['NtryDtls', 'TxDtls', 'RltdPties', cpPath, 'Nm']).slice(0, 140);
    // The "camt053|" prefix keeps a CAMT fallback id apart from a CSV fingerprint: the same text in the two formats is NOT the same identifier.
    const fingerprint = createHash('sha256').update(`camt053|${accountTag}|${date}|${signed}|${ccy === 'EUR' ? '' : ccy + '|'}${reference}|${counterpartyName}`).digest('hex').slice(0, 24);
    const ref = textAt(e, ['AcctSvcrRef']) || textAt(e, ['NtryRef']) || null;
    parsed.push({ line, fileId: ref, date, valueDate, amountCents: signed, currency: ccy, counterpartyName, reference, structuredReference, fingerprint });
  });

  // An AcctSvcrRef is trusted only when it is unique in the file; otherwise the fingerprint is used, with "#n" for the n-th IDENTICAL entry (never merged).
  const refs = parsed.map((r) => r.fileId).filter(Boolean);
  const refsUsable = refs.length === parsed.length && new Set(refs).size === refs.length;
  const seen = new Map();
  const rows = parsed.map(({ line, fileId, fingerprint, ...r }) => {
    const n = (seen.get(fingerprint) ?? 0) + 1; seen.set(fingerprint, n);
    const id = refsUsable ? `${accountTag}:${fileId}` : (n > 1 ? `${fingerprint}#${n}` : fingerprint);
    const bankReference = refsUsable ? fileId : null; // the bank's own reference, shared with the CSV id column (same movement, other format)
    return { id, line, fingerprint, bankReference, ...r };
  });
  const dates = rows.map((r) => r.date).sort();
  return {
    rows, errors, batches, delimiter: null, dataLines: entries.length, account: { ibanMasked },
    columns: { date: 'BookgDt/Dt', amount: 'Amt+CdtDbtInd', reference: 'RmtInf/Ustrd', counterparty: 'RltdPties/Dbtr|Cdtr/Nm', id: refsUsable ? 'AcctSvcrRef' : null },
    period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    currencies: [...new Set(rows.map((r) => r.currency))],
  };
}
