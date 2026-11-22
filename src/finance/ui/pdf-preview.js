// PDF preview inside the Finance screen, without an iframe and without a new window: the PDF is drawn page by page on canvases,
// with pdf.js (a Finance dependency) served by the module itself. Same-origin requests only: the session cookie is sent, nothing else.
function pdfPreviewBase() { return (typeof finApiBase === 'string' && finApiBase) ? finApiBase : '/'; }
let pdfJsLoad = null;
function loadPdfJs() {
  if (!pdfJsLoad) pdfJsLoad = import(pdfPreviewBase() + 'pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = pdfPreviewBase() + 'pdf.worker.mjs'; return m; });
  return pdfJsLoad;
}
/** Draws the PDF at `url` into `container` (replaces its content). Errors are shown as text, never as a blank frame. */
function renderPdfPreview(container, url) {
  container.replaceChildren(h('p', { class: 'muted small' }, tt('Loading preview…')));
  loadPdfJs().then(async (pdfjs) => {
    const pdf = await pdfjs.getDocument({ url }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i += 1) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 860 / base.width) });
      const canvas = h('canvas', { class: 'pdf-page', width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), style: 'max-width:100%;height:auto;display:block;margin:0 auto 12px;background:#fff;box-shadow:var(--shadow);border-radius:4px' });
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pages.push(canvas);
    }
    container.replaceChildren(...(pages.length ? pages : [h('p', { class: 'muted small' }, tt('This PDF has no pages.'))]));
  }).catch(() => container.replaceChildren(h('p', { class: 'muted small' }, tt('Preview is not available for this file.'))));
}
