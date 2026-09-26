import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseBankCsv } from '../src/finance/bank.js';
import { startApp } from './finance-dashboard-helpers.js';

// Finance > Banque & Caisse > CSV statement import: file picker + paste box, ONE parser, ONE backend path, preview before import,
// all-or-nothing, idempotent. SYNTHETIC statements only.
const KEY = randomBytes(32);
const read = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');
const ws = read('views-workspace.js'); const html = read('index.html'); const csvJs = read('bank-csv.js');
// eslint-disable-next-line no-new-func
const helpers = () => new Function(`${csvJs}\nreturn { csvFileProblem, csvTextProblem, csvImportPlan, csvRowReason, CSV_ACCEPT, CSV_MAX_BYTES };`)();

const VALID = 'Date;Montant;Contrepartie;Communication\n10/09/2026;125,50;Client A;+++090/9337/55493+++\n11/09/2026;-42,10;Fournisseur B;Facture 12\n';
const MIXED = 'Date;Montant;Contrepartie\n12/09/2026;10,00;Client C\n31/13/2026;abc;Client D\n';

async function withApp(fn) {
  const a = await startApp({ bankVaultKey: KEY });
  try { const c = await a.authed(); await fn(c); } finally { await a.close(); }
}
const txCount = async (c) => (await c.get('/api/bank/transactions')).data.rows.length;

// ---------- backend: preview, import, failures ----------
test('preview reads the statement and writes nothing: lines, period, recognised columns, invalid lines, duplicates', () => withApp(async (c) => {
  const r = await c.post('/api/bank/import-csv/preview', { csv: VALID });
  assert.equal(r.status, 200);
  assert.equal(r.data.dataLines, 2); assert.equal(r.data.validRows, 2); assert.deepEqual(r.data.invalid, []);
  assert.deepEqual(r.data.period, { from: '2026-09-10', to: '2026-09-11' });
  assert.deepEqual(r.data.columns, { date: 'Date', amount: 'Montant', reference: 'Communication', counterparty: 'Contrepartie', id: null });
  assert.equal(r.data.importable, 2); assert.deepEqual(r.data.duplicates, { alreadyImported: 0, inFile: 0 });
  assert.equal(r.data.sample[0].amountCents, 12550, 'European decimal comma: 125,50 = 125.50 EUR');
  assert.equal(r.data.sample[1].amountCents, -4210, 'a leading minus is a debit');
  assert.equal(await txCount(c), 0, 'a preview never creates a transaction');
}));

test('successful import: the transactions exist and the bank list shows them (the list the page redraws after import)', () => withApp(async (c) => {
  const r = await c.post('/api/bank/import-csv', { csv: VALID });
  assert.equal(r.status, 200); assert.deepEqual(r.data, { created: 2, duplicates: 0, rejected: [] });
  const rows = (await c.get('/api/bank/transactions')).data.rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((t) => t.amountCents).sort((a, b) => a - b), [-4210, 12550]);
  assert.equal((await c.get('/api/bank/status')).data.connected, false, 'an imported statement is not a bank connection');
}));

test('duplicates: the same statement twice creates nothing the second time, and the preview says so beforehand', () => withApp(async (c) => {
  await c.post('/api/bank/import-csv', { csv: VALID });
  const pv = (await c.post('/api/bank/import-csv/preview', { csv: VALID })).data;
  assert.equal(pv.importable, 0); assert.equal(pv.duplicates.alreadyImported, 2);
  const again = (await c.post('/api/bank/import-csv', { csv: VALID })).data;
  assert.equal(again.created, 0); assert.equal(again.duplicates, 2);
  assert.equal(await txCount(c), 2);
  // the same line twice inside one file is reported, and stored once
  const twice = 'Date;Montant;Contrepartie\n12/09/2026;10,00;Client C\n12/09/2026;10,00;Client C\n';
  assert.equal((await c.post('/api/bank/import-csv/preview', { csv: twice })).data.duplicates.inFile, 1);
}));

test('any invalid line: NOTHING is imported (no silent partial import), the lines and reasons are reported', () => withApp(async (c) => {
  const pv = (await c.post('/api/bank/import-csv/preview', { csv: MIXED })).data;
  assert.deepEqual(pv.invalid, [{ line: 3, code: 'ROW_INVALID', reason: 'DATE_INVALID' }]);
  const r = await c.post('/api/bank/import-csv', { csv: MIXED });
  assert.equal(r.status, 422); assert.equal(r.data.error.code, 'BANK_CSV_ROWS_INVALID');
  assert.equal(await txCount(c), 0, 'the valid first line was NOT imported either');
}));

test('empty file, wrong format, missing columns and wrong encoding are refused before anything is created', () => withApp(async (c) => {
  const cases = [['', 422, 'INPUT_INVALID'], ['Date;Montant\n', 422, 'BANK_CSV_EMPTY'], ['a,b\n1,2\n', 422, 'BANK_CSV_COLUMNS_NOT_FOUND'],
    ['Date;Montant\n01/09/2026;caf\uFFFD\n', 422, 'BANK_CSV_ENCODING_INVALID'], ['%PDF-1.7 binary\nnot;a;csv\n', 422, 'BANK_CSV_COLUMNS_NOT_FOUND']];
  for (const [csv, status, code] of cases) {
    for (const path of ['/api/bank/import-csv/preview', '/api/bank/import-csv']) {
      const r = await c.post(path, { csv });
      assert.equal(r.status, status, `${path} ${JSON.stringify(csv)}`); assert.equal(r.data.error.code, code, `${path} ${JSON.stringify(csv)}`);
    }
  }
  assert.equal(await txCount(c), 0);
}));

test('parser: impossible dates and non-amounts are errors, never zero; a non-unique id column is not trusted', () => {
  const r = parseBankCsv('Date;Montant\n31/13/2026;10,00\n30/02/2026;10,00\n01/09/2026;abc\n01/09/2026;\n02/09/2026;12,50 EUR\n03/09/2026;-1.234,56\n');
  assert.deepEqual(r.errors.map((e) => [e.line, e.reason]), [[2, 'DATE_INVALID'], [3, 'DATE_INVALID'], [4, 'AMOUNT_INVALID'], [5, 'AMOUNT_INVALID']]);
  assert.deepEqual(r.rows.map((x) => x.amountCents), [1250, -123456]);
  // "Type de transaction" matches the id column names but repeats: using it would merge different transactions -> ignored
  const t = parseBankCsv('Date;Montant;Type de transaction\n12/09/2026;10,00;Virement\n13/09/2026;12,00;Virement\n');
  assert.equal(t.columns.id, null); assert.notEqual(t.rows[0].id, t.rows[1].id);
  // a real unique id column is used as is
  assert.deepEqual(parseBankCsv('Date;Montant;Transaction ID\n12/09/2026;10,00;A1\n13/09/2026;12,00;A2\n').rows.map((x) => x.id), ['A1', 'A2']);
  // a UTF-8 BOM before the header is ignored
  assert.equal(parseBankCsv('\uFEFFDate;Montant\n12/09/2026;1,00\n').rows.length, 1);
});

test('the preview and import routes need a session', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try { const anon = a.client(); for (const p of ['/api/bank/import-csv/preview', '/api/bank/import-csv']) assert.equal((await anon.post(p, { csv: VALID })).status, 401); } finally { await a.close(); }
});

// ---------- DOM-free rules (real source) ----------
test('file picker rules: only .csv files, not empty, not too large', () => {
  const { csvFileProblem, CSV_ACCEPT, CSV_MAX_BYTES } = helpers();
  assert.equal(CSV_ACCEPT, '.csv,text/csv');
  assert.equal(csvFileProblem({ name: 'releve-septembre.csv', type: 'text/csv', size: 120 }), null);
  assert.equal(csvFileProblem({ name: 'RELEVE.CSV', type: '', size: 120 }), null, 'Windows often gives no MIME type');
  assert.equal(csvFileProblem({ name: 'export.csv', type: 'application/vnd.ms-excel', size: 120 }), null, 'Windows/Excel MIME type for .csv');
  assert.equal(csvFileProblem({ name: 'releve.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 120 }), 'BANK_CSV_FILE_TYPE');
  assert.equal(csvFileProblem({ name: 'releve.pdf', type: 'application/pdf', size: 120 }), 'BANK_CSV_FILE_TYPE');
  assert.equal(csvFileProblem({ name: 'fake.csv', type: 'application/pdf', size: 120 }), 'BANK_CSV_FILE_TYPE');
  assert.equal(csvFileProblem({ name: 'vide.csv', type: 'text/csv', size: 0 }), 'BANK_CSV_FILE_EMPTY');
  assert.equal(csvFileProblem({ name: 'gros.csv', type: 'text/csv', size: CSV_MAX_BYTES + 1 }), 'BANK_CSV_FILE_TOO_LARGE');
  assert.equal(csvFileProblem(null), 'BANK_CSV_FILE_MISSING');
});

test('text rules and the import plan: nothing importable while a line is invalid or when everything is already imported', () => {
  const { csvTextProblem, csvImportPlan, csvRowReason } = helpers();
  assert.equal(csvTextProblem('   '), 'BANK_CSV_EMPTY'); assert.equal(csvTextProblem('Date;Montant\n1/1;\uFFFD'), 'BANK_CSV_ENCODING_INVALID'); assert.equal(csvTextProblem(VALID), null);
  assert.deepEqual(csvImportPlan({ invalid: [], importable: 2 }), { canImport: true, count: 2, blocked: null });
  assert.deepEqual(csvImportPlan({ invalid: [{ line: 3 }], importable: 1 }), { canImport: false, count: 0, blocked: 'ROWS_INVALID' });
  assert.deepEqual(csvImportPlan({ invalid: [], importable: 0 }), { canImport: false, count: 0, blocked: 'NOTHING_NEW' });
  // an invalid line says which format is expected (translated message ids, checked by the i18n test)
  assert.match(csvRowReason('DATE_INVALID'), /DD\/MM\/YYYY or YYYY-MM-DD/); assert.match(csvRowReason('AMOUNT_INVALID'), /12,50/); assert.equal(csvRowReason('???'), 'Invalid line');
});

// ---------- UI wiring (real source) ----------
test('UI: the connect window opens the real file picker; the page offers a file button AND the paste box; both use the same preview + import path', () => {
  const imp = ws.slice(ws.indexOf('function bankCsvImporter'), ws.indexOf('/** The user is back from the bank'));
  assert.match(ws, /close\(\); const imp = getCsvImporter\(\); if \(imp\) imp\.pickFile\(\)/);
  assert.match(imp, /h\('input', \{ type: 'file', accept: CSV_ACCEPT/, 'a real <input type=file> accepting .csv');
  assert.match(imp, /on: \{ click: \(\) => fileInput\.click\(\) \} \}, tt\('Choose a CSV file'\)/, 'the button opens the file picker');
  assert.match(imp, /pickFile: \(\) => \{ el\.scrollIntoView\(\{ block: 'center' \}\); fileInput\.click\(\); \}/);
  assert.match(imp, /h\('textarea'/, 'the paste box is kept');
  assert.match(imp, /run\(paste\.value, tt\('Pasted data'\)\)/); assert.match(imp, /run\(text, f\.name\)/, 'file and paste end in the same run()');
  assert.equal((imp.match(/\/api\/bank\/import-csv\/preview/g) || []).length, 1, 'one preview call for both methods');
  assert.equal((imp.match(/'\/api\/bank\/import-csv'/g) || []).length, 1, 'one import call for both methods');
  assert.match(imp, /fileName\.textContent = f\.name/, 'the chosen file name is shown');
  assert.match(imp, /disabled: plan\.canImport \? null : 'disabled'/, 'no import button while the preview forbids it');
  assert.match(imp, /h\('button', \{ type: 'button', class: 'csv-cancel', on: \{ click: reset \} \}, tt\('Cancel'\)\)/, 'the merchant can cancel');
});

test('UI: no false success - the success toast and the list refresh only happen after the import call returned', () => {
  const imp = ws.slice(ws.indexOf('function bankCsvImporter'), ws.indexOf('/** The user is back from the bank'));
  const i = imp.indexOf("await api('POST', '/api/bank/import-csv'"); const toastAt = imp.indexOf("toast(r.duplicates"); const refresh = imp.indexOf('onImported();');
  assert.ok(i > 0 && toastAt > i && refresh > toastAt, 'toast and refresh come after the awaited API call');
  assert.match(imp, /catch \(e\) \{ ev\.target\.disabled = false; fail\(e, errBox\); \}/, 'an API error is shown inside the preview (which stays), the button comes back, no toast');
  assert.match(ws, /const importer = bankCsvImporter\(\(\) => draw\(\)\)/, 'a successful import redraws the bank page (list included)');
  assert.ok(!/fetch\(|XMLHttpRequest|openai|anthropic|gemini|mistral/i.test(imp + csvJs), 'the file only goes to the Finance backend, never elsewhere');
});

test('the helper script is served and loaded before the workspace views', () => {
  assert.ok(html.indexOf('/bank-csv.js') > 0 && html.indexOf('/bank-csv.js') < html.indexOf('/views-workspace.js'));
});

test('mobile: the bank ledger never widens the page on a long unbreakable reference (the freshly imported row is selected)', () => {
  const css = read('style.css');
  assert.match(css, /\.bank-workspace > \* \{ min-width: 0; \}/, 'grid items may shrink below their longest word');
  assert.match(css, /\.tx-list \.tx small, \.tx-detail \{ overflow-wrap: anywhere; \}/, 'long references wrap');
  assert.match(css, /\.csv-file-input \{ position: absolute;/, 'the native file input stays in the DOM but out of the layout');
  assert.match(css, /\.csv-import, \.csv-import > \*, \.csv-preview \.kv > \* \{ min-width: 0; \}/, 'the CSV block and its preview shrink to the card instead of being clipped');
});
