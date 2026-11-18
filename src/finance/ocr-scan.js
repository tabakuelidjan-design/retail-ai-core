// OCR path for scanned supplier invoices (PDF or image without a text layer).
//
// The text is produced by an OCR command configured by the operator (FINANCE_OCR_COMMAND, see tools/finance-ocr/ocr.py).
// When no command is configured the document stays a manual entry: nothing is read, nothing is guessed.
// The OCR result is NEVER trusted: every field carries a confidence, every unread or inconsistent field is listed in the
// warnings, and the inbox keeps the original file attached. A person validates the draft.

import { spawn } from 'node:child_process';
import { finalizeExtraction } from './purchase-document.js';

const OCR_WARNING = 'OCR_UNVERIFIED';
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const cents = (s) => {
  const m = String(s ?? '').replace(/\s/g, '').match(/^(\d{1,3}(?:[.,]\d{3})*|\d+)[.,](\d{2})$/);
  if (!m) return null;
  return Number(m[1].replace(/[.,]/g, '')) * 100 + Number(m[2]);
};
const ISO = (s) => { const m = String(s ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/**
 * Reads the fields of a supplier invoice from OCR text lines. `own` = the merchant's identity (its VAT is never the supplier's).
 * @returns {{extractor: 'ocr', fields: object, warnings: string[]}}
 */
export function readScanFields(lines, { ownVats = [] } = {}) {
  const text = lines.join('\n');
  const find = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const f = {}; const warnings = [OCR_WARNING];
  const put = (k, value, confidence) => {
    if (value === null || value === undefined || value === '') { warnings.push(`FIELD_UNREAD:${k}`); return; }
    f[k] = { value, confidence };
    if (confidence < 0.8) warnings.push(`FIELD_UNCERTAIN:${k}`); // a heuristic or weak reading: the person must check it
  };

  put('invoiceNumber', find(/Num\S{1,3}ro de facture\s*:?\s*([A-Z0-9][A-Z0-9\-\/]*)/i), 0.9);
  put('issueDate', ISO(find(/Date de facture\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)), 0.9);
  put('dueDate', ISO(find(/ch\S{1,3}ance\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)), 0.9);
  put('netCents', cents(find(/HTVA\s*:?\s*([0-9][0-9.,]*\s*EUR)/i)?.replace(/\s*EUR/i, '')), 0.85);
  put('vatCents', cents(find(/TVA\s*21\s*%\s*:?\s*([0-9][0-9.,]*)/i)), 0.8);
  put('grossCents', cents(find(/Total TTC\s*:?\s*([0-9][0-9.,]*)/i)), 0.9);
  put('currency', /EUR/.test(text) ? 'EUR' : null, 0.6);
  const iban = find(/IBAN\s*:?\s*([A-Z]{2}[0-9 ]{14,30})/i);
  put('supplierIban', iban ? iban.replace(/\s/g, '') : null, 0.9);
  put('paymentReference', find(/(\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+)/), 0.9);
  const vats = [...text.matchAll(/(BE\s?0?\d[\d.\s]{8,12})/g)].map((m) => `BE${digits(m[1]).padStart(10, '0')}`);
  const own = new Set(ownVats.map((v) => `BE${digits(v).padStart(10, '0')}`));
  const supplierVat = vats.find((v) => !own.has(v)) ?? null;
  put('supplierVatNumber', supplierVat, 0.8);
  // The supplier name is the first line that is not a document label: a heuristic, so its confidence stays low.
  const name = lines.map((l) => l.trim()).find((l) => l && !/^(facture|invoice|num|date|total|tva|iban|communication|description|rue|avenue|bd|\d)/i.test(l) && /[A-Za-zÀ-ÿ]{3,}/.test(l)) ?? null;
  put('supplierName', name, 0.5);

  const { netCents: n, vatCents: v, grossCents: g } = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]));
  if (Number.isInteger(n) && Number.isInteger(v) && Number.isInteger(g) && n + v !== g) warnings.push('TOTALS_DO_NOT_ADD_UP');
  return { extractor: 'ocr', fields: f, warnings: [...new Set(warnings)] };
}

/** Runs the configured OCR command on a file and returns its text lines. Rejects when no command is configured or it fails. */
export function runOcrCommand(command, data, { contentType = 'application/pdf', timeoutMs = 120000 } = {}) {
  if (!command) return Promise.reject(new Error('OCR_NOT_CONFIGURED'));
  return new Promise((resolve, reject) => {
    // The operator configures "<program> <script>" (no shell, space-separated, paths without spaces).
    const [bin, ...args] = command.trim().split(/\s+/);
    const child = spawn(bin, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('OCR_TIMEOUT')); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`OCR_FAILED:${code}:${err.slice(0, 120)}`));
      try { resolve(JSON.parse(out).lines); } catch { reject(new Error('OCR_OUTPUT_INVALID')); }
    });
    child.stdin.end(JSON.stringify({ contentType, base64: Buffer.from(data).toString('base64') }));
  });
}

/**
 * Inbox extractor for scans. Without a configured OCR command it reports the scan as needing OCR and reads nothing.
 * @param {{command?: string|null, ownVat?: string|null, runOcr?: Function}} opts  runOcr overrides the command (tests)
 */
export function createOcrExtractor({ command = null, runOcr = null } = {}) {
  return {
    name: 'ocr',
    label: 'Scan : lecture OCR (brouillon à valider)',
    async extract({ data, contentType, context = {} }) {
      if (!command && !runOcr) return { extractor: 'ocr', fields: {}, warnings: ['SCAN_REQUIRES_OCR'] };
      try {
        const lines = await (runOcr ? runOcr(data, contentType) : runOcrCommand(command, data, { contentType }));
        return finalizeExtraction(readScanFields(lines, { ownVats: context.vatNumbers ?? [] }));
      } catch (e) {
        return { extractor: 'ocr', fields: {}, warnings: [OCR_WARNING, String(e.message).startsWith('OCR_') ? String(e.message).split(':')[0] : 'OCR_FAILED'] };
      }
    },
  };
}

/**
 * Keeps the base extractor (UBL, PDF text layer) and adds OCR only where the base cannot read: a PDF without text, or an image.
 * The OCR result is still a draft for review.
 */
export function withOcrFallback(base, ocr) {
  return {
    name: `${base.name}+ocr`,
    label: base.label,
    async extract(file) {
      const r = await base.extract(file);
      const scanned = file.contentType === 'application/pdf' && (r.warnings ?? []).includes('SCAN_REQUIRES_OCR');
      const image = typeof file.contentType === 'string' && file.contentType.startsWith('image/');
      if (!scanned && !image) return r;
      return ocr.extract(file);
    },
  };
}
