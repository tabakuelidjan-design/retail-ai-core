'use strict';
// Bank CSV statement import - DOM-free helpers (no network, no storage, no markup), shared by BOTH entry points: the file picker and
// the paste box. Both end in the same two backend calls - POST /api/bank/import-csv/preview (writes nothing), then, after the merchant
// confirms, POST /api/bank/import-csv (all-or-nothing). The file is read in the browser and only ever sent to this backend (never to an AI service).

/** The backend accepts a 4 MB JSON body; the CSV text itself must stay clearly under it. */
const CSV_MAX_BYTES = 3500000;
const CSV_ACCEPT = '.csv,text/csv';

/** A chosen file is only read when it looks like a CSV statement. Returns null (ok) or an error code. */
function csvFileProblem(file) {
  if (!file) return 'BANK_CSV_FILE_MISSING';
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  const csvName = /\.csv$/.test(name);
  const csvType = type === 'text/csv' || type === 'application/csv' || type === 'application/vnd.ms-excel' || type === '';
  if (!csvName || !csvType) return 'BANK_CSV_FILE_TYPE';
  if (!file.size) return 'BANK_CSV_FILE_EMPTY';
  if (file.size > CSV_MAX_BYTES) return 'BANK_CSV_FILE_TOO_LARGE';
  return null;
}

/** Checks on the text itself (pasted, or read from the file as UTF-8) before anything is sent. */
function csvTextProblem(text) {
  const t = String(text || '');
  if (!t.trim()) return 'BANK_CSV_EMPTY';
  if (t.indexOf('\uFFFD') >= 0) return 'BANK_CSV_ENCODING_INVALID'; // not UTF-8: accents would be corrupted, so nothing is imported
  if (t.length > CSV_MAX_BYTES) return 'BANK_CSV_FILE_TOO_LARGE';
  return null;
}

/** A CSV line error as a message id (translated by the caller): it says which format is expected. */
const CSV_ROW_REASON = {
  DATE_INVALID: 'Invalid date (expected DD/MM/YYYY or YYYY-MM-DD)',
  AMOUNT_INVALID: 'Invalid amount (expected e.g. 12,50 or -1.234,56)',
};
function csvRowReason(reason) { return CSV_ROW_REASON[reason] || 'Invalid line'; }

/** What the preview allows: an import only when there is no invalid line and at least one new transaction. */
function csvImportPlan(preview) {
  if (!preview) return { canImport: false, count: 0, blocked: 'NO_PREVIEW' };
  const invalid = (preview.invalid || []).length;
  if (invalid) return { canImport: false, count: 0, blocked: 'ROWS_INVALID' };
  if (!preview.importable) return { canImport: false, count: 0, blocked: 'NOTHING_NEW' };
  return { canImport: true, count: preview.importable, blocked: null };
}
