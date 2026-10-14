import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountantExportService } from '../src/finance/accountant-export-service.js';
import { createMerchantClock } from '../src/finance/civil-date.js';
import { loadDocsForReports } from '../src/finance/reports.js';
import { verifyExportPackage } from '../src/finance/accountant-export.js';
import { createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { legalWorld } from './finance-legal-helpers.js';

// Final acceptance, section 23 (artifact failures). SYNTHETIC data only.
const parse = (buf) => { const rows = []; let row = []; let cell = ''; let q = false; const t = buf.toString('utf8').replace(/^﻿/, ''); for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; } const [h, ...b] = rows; return b.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };
const Q3 = { kind: 'quarter', year: 2026, quarter: 3 };

async function scenario(damage) {
  const inner = createMemoryAttachmentStore(); const broken = new Map(); const storage = { ...inner, name: 'faulty', get: async (ref) => { const how = broken.get(ref); if (how === 'missing') return null; if (how === 'corrupt') { const f = await inner.get(ref); f.data[0] ^= 0xff; return f; } if (how === 'throw') throw new Error('storage unavailable'); return inner.get(ref); } };
  const w = legalWorld({ storage }); const inv = await w.issue({ issueDate: '2026-09-10' }); const arts = await w.store.listArtifacts({ merchantId: w.merchantId, documentId: inv.id });
  const pdf = arts.find((a) => a.kind === 'PDF_ORIGINAL'); const ubl = arts.find((a) => a.kind === 'STRUCTURED_ORIGINAL'); if (damage) damage(broken, { pdf, ubl });
  const ex = createAccountantExportService({ store: w.store, merchantId: w.merchantId, clock: createMerchantClock({ now: () => '2026-10-05T09:00:00.000Z', timeZone: 'Europe/Brussels' }), merchant: { name: 'Exemple Atelier SRL' },
    finance: { listInvoices: () => loadDocsForReports(w.store, w.merchantId) }, inbox: { list: () => w.store.listSupplierInvoices(w.merchantId) }, storage, renderPdf: async () => Buffer.from('%PDF-regenerated') });
  return { w, inv, pdf, ubl, ex };
}

test('S23 export tells the truth about archived originals: intact bytes are included, missing / corrupted / unreadable bytes are reported MISSING with a reason (never silently claimed)', async () => {
  const ok = await scenario(null); const good = await ok.ex.generate(Q3, { includeDocuments: true });
  assert.equal(parse(good.files.get('missing-artifacts.csv')).length, 0); assert.equal(verifyExportPackage(good.zip).ok, true);
  assert.ok([...good.files.keys()].some((n) => n.endsWith('.pdf')) && [...good.files.keys()].some((n) => n.endsWith('.xml')));
  for (const [how, code] of [['missing', 'ARTIFACT_BYTES_NOT_FOUND'], ['corrupt', 'ARTIFACT_HASH_MISMATCH'], ['throw', 'ARTIFACT_BYTES_NOT_FOUND']]) {
    const s = await scenario((broken, { pdf, ubl }) => { broken.set(pdf.storageRef, how); broken.set(ubl.storageRef, how); });
    const pkg = await s.ex.generate(Q3, { includeDocuments: true }); const rows = parse(pkg.files.get('missing-artifacts.csv'));
    const pdfRow = rows.find((r) => r.expected_artifact === 'PDF_ARCHIVED_ORIGINAL' && r.source_id === s.inv.id); const xmlRow = rows.find((r) => r.expected_artifact === 'STRUCTURED_ORIGINAL' && r.source_id === s.inv.id);
    assert.ok(pdfRow && xmlRow, `${how}: both originals reported`); assert.equal(pdfRow.reason, code); assert.equal(xmlRow.reason, code);
    assert.ok(![...pkg.files.keys()].some((n) => n.startsWith('documents/') && n.includes(s.inv.number)), `${how}: no damaged bytes are exported as an original`);
    assert.equal(verifyExportPackage(pkg.zip).ok, true, 'the package itself stays self-consistent');
    const sales = parse(pkg.files.get('sales.csv')).find((r) => r.number === s.inv.number); assert.ok(sales); assert.notEqual(sales.pdf_status, 'ARCHIVED_ORIGINAL');
  }
});
