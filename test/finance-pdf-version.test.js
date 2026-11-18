import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_RENDERER_V1, PDF_RENDERER_V2, RENDERER_V2_SINCE, rendererVersionOf, renderDocumentVersioned } from '../src/finance/pdf-version.js';
import { structuredCommunication } from '../src/finance/pdf.js';
import { vcsFormat, vcsForInvoiceNumber } from '../src/finance/belgium-compliance.js';
import { issueInvoice, makeService } from './finance-fixtures.js';

test('renderer version: drafts and documents locked on/after the cut-over use nordla-pdf/2; older documents keep nordla-pdf/1', () => {
  assert.equal(rendererVersionOf({ lockedAt: null }), PDF_RENDERER_V2);
  assert.equal(rendererVersionOf({ lockedAt: '2026-11-19T10:00:00.000Z' }), PDF_RENDERER_V2);
  assert.equal(rendererVersionOf({ lockedAt: '2026-09-21T10:00:00.000Z' }), PDF_RENDERER_V1);
  assert.equal(rendererVersionOf({ lockedAt: RENDERER_V2_SINCE.replace('23:59:59', '23:59:58') }), PDF_RENDERER_V1);
});

test('the reference printed on the PDF equals the structured communication used by the archive (VCS)', () => {
  assert.equal(vcsFormat(vcsForInvoiceNumber('INV-2026-0001')), structuredCommunication('INV-2026-0001'));
});

test('an issued invoice renders with the version recorded for it, and the PDF is a real PDF', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const r = await renderDocumentVersioned(inv, { branding: { structuredCommunication: true } });
  assert.equal(r.rendererVersion, rendererVersionOf(inv));
  assert.equal(r.buffer.subarray(0, 4).toString('latin1'), '%PDF');
});
