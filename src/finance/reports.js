// Assembles finance documents for reporting and writes the accountant-pack files (CSV set, PDF summary, JSON).
// CSV and PDF render the same summaryLines(), so the numbers cannot differ between formats.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summaryLines } from './accountant-pack.js';
import { toCsv } from './export-csv.js';
import { renderPackSummaryPdf } from './pdf.js';

/** Every document with its payments and credit notes, ready for settlement maths. */
export async function loadDocsForReports(store, merchantId) {
  const docs = await store.listDocuments({ merchantId });
  const payments = await store.listPaymentsForMerchant(merchantId);
  const byDoc = new Map();
  for (const p of payments) (byDoc.get(p.documentId) ?? byDoc.set(p.documentId, []).get(p.documentId)).push(p);
  return docs.map((doc) => ({ doc, payments: byDoc.get(doc.id) ?? [], creditNotes: docs.filter((d) => d.type === 'credit_note' && d.relatedDocumentId === doc.id) }));
}

const DOC_COLUMNS = ['number', 'type', 'issueDate', 'dueDate', 'customer', 'customerVat', 'revenueBasis', 'status', 'net', 'vat', 'gross', 'paid', 'remaining', 'additive'].map((k) => ({ key: k, header: k }));

/** Write summary/vat/documents/anomalies CSVs, a PDF summary and the raw JSON into `dir`. Returns the file names written. */
export async function writePackFiles(pack, dir, { delimiter = ',', branding = {}, merchantName = '' } = {}) {
  await mkdir(dir, { recursive: true });
  const stem = `accountant-pack_${pack.period.start}_${pack.period.end}`;
  const files = {};
  const put = async (name, content) => { await writeFile(join(dir, name), content); files[name] = true; };
  await put(`${stem}_summary.csv`, toCsv(summaryLines(pack), [{ key: 'line', header: 'line' }, { key: 'source', header: 'source' }, { key: 'amount', header: `amount_${pack.currency}` }], { delimiter }));
  await put(`${stem}_retail_by_channel.csv`, toCsv(Object.entries(pack.retail.by_channel).map(([channel, v]) => ({ channel, ...v })), ['channel', 'orders', 'gross_sales', 'discounts', 'refunds', 'net_sales', 'vat', 'net_sales_ex_vat'].map((k) => ({ key: k, header: k })), { delimiter }));
  await put(`${stem}_vat_b2b.csv`, toCsv(pack.vat_by_rate_b2b.map((g) => ({ rate_percent: g.vatRateBp / 100, taxable_cents: g.taxableCents, vat_cents: g.vatCents })), ['rate_percent', 'taxable_cents', 'vat_cents'].map((k) => ({ key: k, header: k })), { delimiter }));
  await put(`${stem}_documents.csv`, toCsv(pack.documents, DOC_COLUMNS, { delimiter }));
  await put(`${stem}_anomalies.csv`, toCsv(pack.anomalies, ['severity', 'code', 'detail'].map((k) => ({ key: k, header: k })), { delimiter }));
  await put(`${stem}_receivables.csv`, toCsv(pack.receivables.invoices.map((i) => ({ ...i, customer: i.customer })), ['number', 'customer', 'issueDate', 'dueDate', 'grossCents', 'paidCents', 'creditedCents', 'remainingCents', 'daysOverdue', 'bucket', 'effectiveStatus'].map((k) => ({ key: k, header: k })), { delimiter }));
  await put(`${stem}.json`, JSON.stringify(pack, null, 2));
  await writeFile(join(dir, `${stem}_summary.pdf`), await renderPackSummaryPdf(pack, { branding, merchantName }));
  files[`${stem}_summary.pdf`] = true;
  return Object.keys(files);
}
