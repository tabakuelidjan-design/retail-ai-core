// Local PDF text (reuses the Finance text-layer reader: no OCR, no network). A scanned PDF yields almost no text: the document inspection then says
// INSUFFICIENT_EVIDENCE rather than guessing.
import { readPdfText } from '../../finance/pdf-text.js';

export async function pdfToText(buffer) {
  const r = await readPdfText(buffer);
  return { text: r.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n'), pages: r.pages.map((p) => p.page), pageCount: r.pageCount, pagesRead: r.pagesRead, textChars: r.textChars };
}
