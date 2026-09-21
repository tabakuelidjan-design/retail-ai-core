// Assembles finance documents for reporting and produces the accountant-pack files (CSV set, XLSX workbook, PDF summary, JSON).
// Every format renders the SAME pack object (summaryLines / vat rows), so numbers cannot differ between formats.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summaryLines } from './accountant-pack.js';
import { toCsv } from './export-csv.js';
import { formatCents } from './money.js';
import { renderPackSummaryPdf } from './pdf.js';
import { buildXlsx } from './xlsx.js';

/** Every document with its payments and credit notes, ready for settlement maths. */
export async function loadDocsForReports(store, merchantId) {
  const docs = await store.listDocuments({ merchantId });
  const payments = await store.listPaymentsForMerchant(merchantId);
  const byDoc = new Map();
  for (const p of payments) (byDoc.get(p.documentId) ?? byDoc.set(p.documentId, []).get(p.documentId)).push(p);
  return docs.map((doc) => ({ doc, payments: byDoc.get(doc.id) ?? [], creditNotes: docs.filter((d) => d.type === 'credit_note' && d.relatedDocumentId === doc.id) }));
}

const DOC_COLUMNS = ['number', 'type', 'issueDate', 'dueDate', 'customer', 'customerVat', 'revenueBasis', 'status', 'net', 'vat', 'gross', 'paid', 'remaining', 'additive'];
const AMOUNT_KEYS = new Set(['net', 'vat', 'gross', 'paid', 'remaining']);
const cols = (keys) => keys.map((k) => ({ key: k, header: k }));

export function vatRows(pack) {
  const v = pack.vat_summary;
  return [
    ...v.retail.by_rate.map((g) => ({ source: 'retail', treatment: 'as reported by the sales channel', rate_percent: g.vatRateBp / 100, taxable_base: formatCents(g.taxableCents), vat: formatCents(g.vatCents), status: v.retail.status })),
    ...(v.retail.unavailable ? [{ source: 'retail', treatment: 'rate not captured', rate_percent: '', taxable_base: formatCents(v.retail.unavailable.taxableCents), vat: formatCents(v.retail.unavailable.vatCents), status: 'UNAVAILABLE' }] : []),
    ...v.b2b.by_treatment.map((t) => ({ source: 'standalone_b2b', treatment: t.regime, rate_percent: '', taxable_base: formatCents(t.taxableCents), vat: formatCents(t.vatCents), status: 'COMPLETE' })),
    ...v.b2b.by_rate.map((g) => ({ source: 'standalone_b2b', treatment: 'by rate', rate_percent: g.vatRateBp / 100, taxable_base: formatCents(g.taxableCents), vat: formatCents(g.vatCents), status: 'COMPLETE' })),
    ...v.combined_by_rate.map((g) => ({ source: 'combined (known rates only)', treatment: '', rate_percent: g.vatRateBp / 100, taxable_base: formatCents(g.taxableCents), vat: formatCents(g.vatCents), status: v.status })),
  ];
}

const channelRows = (pack) => Object.entries(pack.retail.by_channel).map(([channel, v]) => ({ channel, ...v }));
const receivableRows = (pack) => pack.receivables.invoices;
const CHANNEL_KEYS = ['channel', 'orders', 'gross_sales', 'discounts', 'refunds', 'net_sales', 'vat', 'net_sales_ex_vat'];
const VAT_KEYS = ['source', 'treatment', 'rate_percent', 'taxable_base', 'vat', 'status'];
const RECEIVABLE_KEYS = ['number', 'customer', 'issueDate', 'dueDate', 'grossCents', 'paidCents', 'creditedCents', 'remainingCents', 'daysOverdue', 'bucket', 'effectiveStatus'];

const sheetOf = (name, keys, rows) => ({ name, rows: [keys, ...rows.map((r) => keys.map((k) => { const v = r[k]; return AMOUNT_KEYS.has(k) || (typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v) && /taxable|vat|amount/.test(k)) ? (v === '' ? null : Number(v)) : v ?? null; }))] });

/** All export files as in-memory buffers: { name -> { contentType, data } }. Nothing touches the disk. */
export async function packFileBuffers(pack, { delimiter = ',', branding = {}, merchantName = '' } = {}) {
  const stem = `accountant-pack_${pack.period.start}_${pack.period.end}`;
  const csv = (name, keys, rows) => [`${stem}_${name}.csv`, { contentType: 'text/csv; charset=utf-8', data: Buffer.from(toCsv(rows, cols(keys), { delimiter }), 'utf8') }];
  const summary = summaryLines(pack);
  const files = new Map([
    [`${stem}_summary.csv`, { contentType: 'text/csv; charset=utf-8', data: Buffer.from(toCsv(summary, [{ key: 'line', header: 'line' }, { key: 'source', header: 'source' }, { key: 'amount', header: `amount_${pack.currency}` }], { delimiter }), 'utf8') }],
    csv('retail_by_channel', CHANNEL_KEYS, channelRows(pack)),
    [`${stem}_vat_b2b.csv`, { contentType: 'text/csv; charset=utf-8', data: Buffer.from(toCsv(pack.vat_by_rate_b2b.map((g) => ({ rate_percent: g.vatRateBp / 100, taxable_cents: g.taxableCents, vat_cents: g.vatCents })), cols(['rate_percent', 'taxable_cents', 'vat_cents']), { delimiter }), 'utf8') }],
    csv('vat_by_rate', VAT_KEYS, vatRows(pack)),
    csv('documents', DOC_COLUMNS, pack.documents),
    csv('anomalies', ['severity', 'code', 'detail'], pack.anomalies),
    csv('receivables', RECEIVABLE_KEYS, receivableRows(pack)),
    [`${stem}.json`, { contentType: 'application/json', data: Buffer.from(JSON.stringify(pack, null, 2), 'utf8') }],
    [`${stem}_summary.pdf`, { contentType: 'application/pdf', data: await renderPackSummaryPdf(pack, { branding, merchantName }) }],
    [`${stem}.xlsx`, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: buildXlsx([
        { name: 'Summary', rows: [['line', 'source', `amount_${pack.currency}`], ...summary.map((s) => [s.line, s.source, Number(s.amount)]), [], ['period', `${pack.period.start} to ${pack.period.end}`], ['completeness', pack.completeness.status], ['reconciliation', pack.reconciliation.status], ['generated_at', pack.generated_at], ...pack.completeness.reasons.map((r) => ['reason', r])] },
        sheetOf('Retail by channel', CHANNEL_KEYS, channelRows(pack)),
        sheetOf('VAT by rate', VAT_KEYS, vatRows(pack)),
        sheetOf('Documents', DOC_COLUMNS, pack.documents),
        sheetOf('Receivables', RECEIVABLE_KEYS, receivableRows(pack)),
        sheetOf('Anomalies', ['severity', 'code', 'detail'], pack.anomalies),
      ]),
    }],
  ]);
  return files;
}

/** Write the pack files into `dir` (CLI use). Returns the file names written. */
export async function writePackFiles(pack, dir, opts = {}) {
  await mkdir(dir, { recursive: true });
  const files = await packFileBuffers(pack, opts);
  for (const [name, f] of files) await writeFile(join(dir, name), f.data);
  return [...files.keys()];
}
