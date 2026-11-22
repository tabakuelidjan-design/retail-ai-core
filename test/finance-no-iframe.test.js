// Finance inside Nordla Core: no iframe and no new window anywhere in the Finance UI, and the PDF previews are drawn in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const UI = new URL('../src/finance/ui/', import.meta.url);

async function sources() {
  const files = (await readdir(UI)).filter((f) => f.endsWith('.js') || f.endsWith('.html'));
  return Promise.all(files.map(async (f) => [f, await readFile(new URL(f, UI), 'utf8')]));
}

test('the Finance UI creates no iframe and opens no new window or tab', async () => {
  for (const [name, text] of await sources()) {
    assert.doesNotMatch(text, /createElement\(['"]iframe['"]\)|h\('iframe'/, `${name}: no iframe`);
    assert.doesNotMatch(text, /target:\s*['"]_blank['"]|target="_blank"|window\.open\(/, `${name}: no new tab`);
  }
});

test('the PDF previews are drawn in place with pdf.js (same screen, no frame)', async () => {
  const app = await readFile(new URL('app.js', UI), 'utf8');
  const workspace = await readFile(new URL('views-workspace.js', UI), 'utf8');
  const preview = await readFile(new URL('pdf-preview.js', UI), 'utf8');
  assert.match(app, /renderPdfPreview\(holder, `\$\{FIN_API_BASE\}api\/documents\/\$\{id\}\/pdf`\)/);
  assert.match(workspace, /renderPdfPreview\(holder, /);
  assert.match(preview, /import\(pdfPreviewBase\(\) \+ 'pdf\.mjs'\)/);
  assert.match(preview, /GlobalWorkerOptions\.workerSrc = pdfPreviewBase\(\) \+ 'pdf\.worker\.mjs'/);
});

test('source documents are downloads in the same tab, never a new tab', async () => {
  const workspace = await readFile(new URL('views-workspace.js', UI), 'utf8');
  const pack = await readFile(new URL('views-pack.js', UI), 'utf8');
  assert.match(workspace, /download: it\.fileName/);
  assert.match(pack, /download: it\.fileName \|\| 'original'/);
});

test('the Finance server serves the pdf.js files and the embed bundle through the module (session and gateway apply)', async () => {
  const server = await readFile(new URL('../src/finance/server/app.js', import.meta.url), 'utf8');
  // from src/finance/ui/ the package root is three levels up (the deployed image has /app/node_modules)
  assert.match(server, /'\/pdf\.mjs': \['\.\.\/\.\.\/\.\.\/node_modules\/pdfjs-dist\/build\/pdf\.mjs'/);
  assert.match(server, /'\/pdf\.worker\.mjs': \['\.\.\/\.\.\/\.\.\/node_modules\/pdfjs-dist\/build\/pdf\.worker\.mjs'/);
  assert.match(server, /'\/finance-embed\.js': \['\.\.\/\.\.\/finance-embed\/finance-embed\.js'/);
});
