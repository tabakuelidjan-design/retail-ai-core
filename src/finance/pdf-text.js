// Local reading of the TEXT layer of a PDF (pdfjs-dist). No OCR, no image analysis, no network: the file never leaves Nordla.
// Returns the text of each page rebuilt into lines from the positions pdfjs gives (top to bottom, left to right), so that the
// deterministic rules (pdf-invoice.js) can read "label ... amount" on one line and know where each value was found.

export const PDF_MAX_PAGES = 20;
const Y_TOLERANCE = 3; // points: text items this close vertically are on the same line
const CELL_GAP = 12; // points: a wider horizontal gap starts a new column (cell)

let pdfjsPromise = null;
/** pdfjs is loaded on first use only (it is large), and never for XML or image documents. */
const pdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

/**
 * @param {Buffer} data a PDF file
 * @returns {Promise<{ pageCount: number, pagesRead: number, textChars: number, pages: Array<{ page: number, lines: Array<{ text: string, x: number, y: number }> }> }>}
 */
export async function readPdfText(data) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true,
    stopAtErrors: false, verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const pagesRead = Math.min(pdf.numPages, PDF_MAX_PAGES);
    const pages = [];
    for (let n = 1; n <= pagesRead; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items = content.items.filter((it) => typeof it.str === 'string' && it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0 }));
      pages.push({ page: n, lines: toLines(items) });
      page.cleanup();
    }
    const textChars = pages.reduce((a, p) => a + p.lines.reduce((b, l) => b + l.text.replace(/\s+/g, '').length, 0), 0);
    return { pageCount: pdf.numPages, pagesRead, textChars, pages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** Group positioned text items into lines (same baseline within a tolerance), top of the page first. */
export function toLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Y_TOLERANCE);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  return lines.map((l) => {
    const parts = l.items.sort((a, b) => a.x - b.x);
    // Cells: items separated by a clear horizontal gap are different columns ("Total TVAC" | "121,00", supplier block | customer block).
    const cells = []; let cur = null; let end = null;
    for (const p of parts) {
      const gap = end === null ? 0 : p.x - end;
      if (!cur || gap > CELL_GAP) { cur = { text: p.str.trim(), x: Math.round(p.x) }; cells.push(cur); } else cur.text += (gap > 0.5 ? ' ' : '') + p.str.trim();
      end = p.x + p.w;
    }
    return { text: cells.map((c) => c.text).join('   '), cells, x: cells[0].x, y: Math.round(l.y) };
  }).sort((a, b) => b.y - a.y);
}
