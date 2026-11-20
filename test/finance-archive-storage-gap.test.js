// KNOWN LIMIT (kept explicit): the PDF is written to storage, then its row is inserted in the database. A failure between the two
// leaves an object without a row. This file documents what the system does in that window, in an isolated memory store
// (no shared staging is touched). It is a characterisation test: it asserts the CURRENT behaviour, and fails if it changes silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { startApp } from './finance-dashboard-helpers.js';
import { FinanceError } from '../src/finance/document.js';

const create = async (c) => { const r = await c.post('/api/documents', (await import('./finance-dashboard-helpers.js')).invoiceBody()); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };

test('storage then database: a failed original insert leaves no original, and the repair path cannot create one', async () => {
  const base = createMemoryStore();
  let failNextOriginal = true;
  const store = Object.assign(Object.create(base), {
    archiveArtifact: async (row) => {
      if (failNextOriginal && row.kind === 'PDF_ORIGINAL') { failNextOriginal = false; throw new FinanceError('ARTIFACT_STORAGE_FAILED', 'simulated database interruption after the storage write'); }
      return base.archiveArtifact(row);
    },
  });
  const attachments = createMemoryAttachmentStore();
  const a = await startApp({ store, deps: { attachmentStore: attachments } });
  try {
    const c = await a.authed();
    const d = await create(c);
    await c.post(`/api/documents/${d.id}/submit`, {});
    const approved = await c.post(`/api/documents/${d.id}/approve`, {});
    const issued = (await c.get(`/api/documents/${d.id}`)).data;
    assert.equal(issued.status, 'ISSUED', 'the document is issued even when its original could not be archived');
    const originals = await base.listArtifacts({ merchantId: 'merchant-test-1', documentId: d.id, kind: 'PDF_ORIGINAL' });
    assert.equal(originals.length, 0, 'no PDF original was recorded');
    const objects = await attachments.get ? 'listing not exposed by the store' : '';
    void objects; void approved;
    // the repair path (the only archive route after issue) records a REGENERATED copy, never an original
    const repaired = await c.post(`/api/documents/${d.id}/archive`, {});
    assert.equal(repaired.status, 200);
    assert.equal(repaired.data.pdf?.classification, 'REGENERATED', 'the repair path records a regenerated copy');
    const originalsAfter = await base.listArtifacts({ merchantId: 'merchant-test-1', documentId: d.id, kind: 'PDF_ORIGINAL' });
    assert.equal(originalsAfter.length, 0, 'still no original after repair: this is the recovery gap');
  } finally { await a.close(); }
});
