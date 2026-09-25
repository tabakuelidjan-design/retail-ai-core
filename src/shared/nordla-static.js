// Shared static reader for the Nordla icon system: serves src/shared/nordla-icon.js at /nordla-icon.js and
// everything under src/shared/assets/nordla/ at /nordla-assets/... so every module (Analytics Premium,
// Finance, future ones) uses ONE set of files instead of a copy per module. Each module's server calls
// readNordlaShared(pathname) and sends the result itself (so its own security headers still apply).
// Only whitelisted file types and plain path segments are accepted - no traversal is possible.

import { readFile } from 'node:fs/promises';

const ROOT = new URL('./', import.meta.url);
const TYPES = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', woff2: 'font/woff2' };
const ASSET = /^\/nordla-assets\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(svg|png|webp|woff2))$/;

/** @returns {Promise<{body: Buffer, type: string}|null>} null when the path is not a shared Nordla file. */
export async function readNordlaShared(pathname) {
  let rel; let type;
  if (pathname === '/nordla-icon.js') { rel = 'nordla-icon.js'; type = 'text/javascript; charset=utf-8'; } else if (pathname === '/nordla-charts.js') { rel = 'nordla-charts.js'; type = 'text/javascript; charset=utf-8'; } else if (pathname === '/nordla-fonts.css') { rel = 'nordla-fonts.css'; type = 'text/css; charset=utf-8'; } else if (pathname === '/nordla-charts.css') { rel = 'nordla-charts.css'; type = 'text/css; charset=utf-8'; } else {
    const m = ASSET.exec(pathname);
    if (!m) return null;
    rel = `assets/nordla/${m[1]}`; type = TYPES[m[2]];
  }
  try { return { body: await readFile(new URL(rel, ROOT)), type }; } catch { return null; }
}
