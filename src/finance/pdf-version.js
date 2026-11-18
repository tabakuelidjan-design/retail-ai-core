// Versioned choice of the human PDF renderer.
//   nordla-pdf/1  src/finance/pdf.js (legacy layout): every document locked BEFORE RENDERER_V2_SINCE, so historical PDFs
//                 regenerate exactly as before.
//   nordla-pdf/2  src/finance/pdf-classic.js (model A, blue-grey): documents locked on or after RENDERER_V2_SINCE, and drafts.
// Issued documents also keep their archived PDF bytes (legal-artifacts.js), which never change; this choice only applies when a PDF is produced.
import { renderDocumentPdf, PDF_RENDERER_VERSION } from './pdf.js';
import { renderClassicPdf } from './pdf-classic.js';

export const PDF_RENDERER_V1 = PDF_RENDERER_VERSION; // 'nordla-pdf/1'
export const PDF_RENDERER_V2 = 'nordla-pdf/2';
// Model A cut-over (staging, 2026-11-18 12:00 UTC). Any document locked before it keeps the legacy layout.
export const RENDERER_V2_SINCE = '2026-11-18T12:00:00.000Z';

export function rendererVersionOf(doc) {
  if (!doc?.lockedAt) return PDF_RENDERER_V2;
  return String(doc.lockedAt) < RENDERER_V2_SINCE ? PDF_RENDERER_V1 : PDF_RENDERER_V2;
}

/** @returns {Promise<{buffer: Buffer, rendererVersion: string}>} */
export async function renderDocumentVersioned(doc, opts = {}) {
  const rendererVersion = rendererVersionOf(doc);
  const buffer = rendererVersion === PDF_RENDERER_V2
    ? await renderClassicPdf(doc, opts)
    : await renderDocumentPdf(doc, opts);
  return { buffer, rendererVersion };
}
