// The Phase 5 product test matrix, run by hand: node scripts/creative-integration-matrix.mjs [--out <dir>] [--real <image.png> ...]
// Without --real it integrates the seven DRAWN product classes of the tests (phone case, tumbler, magnet, framed print, gift box, small tech, mirror-finish bottle) and the multi-object photograph into a drawn scene.
// With --real it does the same for photographs you point at (read-only; each is rasterised to at most 1000 px). For every candidate it prints the state, the reasons, the stage timings and the memory, and (with --out)
// writes the visual acceptance sheet: SOURCE, MASK, COMPOSITE, EDGE CLOSE-UP, CONTACT SHADOW CLOSE-UP, PRODUCT FIDELITY DIFF, FINAL SCENE (+ the shadow layer). It calls no provider and needs no network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pngDimensions, rasterizeToPixels } from '../src/creative-intelligence/production-render.js';
import {
  createSegmentationCache, integrateProduct, integrateScene, renderAcceptance, segmentProduct,
} from '../src/creative-integration/index.js';
import * as W from '../test/creative-integration-world.js';
import { standardScene } from '../test/creative-integration-shared.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const out = flag('--out'); const realIdx = args.indexOf('--real'); const real = realIdx >= 0 ? args.slice(realIdx + 1).filter((a) => !a.startsWith('--')) : [];
if (out) mkdirSync(out, { recursive: true });
const scene = standardScene();
const rows = []; const mb = (n) => Math.round(n / 1048576);

const candidates = Object.entries(W.ALL).map(([name, make]) => ({ name, rgba: make().rgba }));
for (const file of real) {
  const bytes = readFileSync(file); const d = pngDimensions(bytes); const k = Math.min(1, 1000 / Math.max(d.width, d.height)); const w = Math.round(d.width * k); const h = Math.round(d.height * k);
  candidates.push({ name: path.basename(file), rgba: rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/><image width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`) });
}

for (const c of candidates) {
  const before = process.memoryUsage().heapUsed; const t0 = performance.now();
  const seg = segmentProduct({ rgba: c.rgba });
  let result = null;
  if (seg.accepted) {
    const scale = 240 / (seg.bounds.y1 - seg.bounds.y0 + 1);
    result = integrateProduct({ source: c.rgba, segmentation: seg, scene, placement: { x: 450, y: 600, scale }, shadow_kind: 'SOFT' });
  }
  const state = result ? result.state : (seg.status === 'FAILED' ? 'SEGMENTATION_FAILED' : 'SEGMENTATION_LOW_CONFIDENCE');
  const reasons = result ? result.reasons : [seg.failure_reason];
  rows.push({ name: c.name, state, reasons: reasons.join(','), ms: Math.round(performance.now() - t0), heap_mb: mb(process.memoryUsage().heapUsed - before), size: `${c.rgba.width}x${c.rgba.height}` });
  if (out && result?.state === 'READY_FOR_COMPOSITE') {
    const v = renderAcceptance({ source: c.rgba, result }); const slug = c.name.replace(/[^a-z0-9]+/gi, '_');
    writeFileSync(path.join(out, `${slug}-sheet.png`), v.sheet);
  }
}

// the photograph with several objects: explicit selections, integrated together
{
  const m = W.multiObject(); const cache = createSegmentationCache(); const t0 = performance.now();
  const r = integrateScene({
    source: m.rgba, scene, cache,
    products: [
      { id: 'red box', selection: { mode: 'IDS', ids: ['o2'] }, placement: { x: 300, y: 560, scale: 0.7 }, shadow_kind: 'SOFT' },
      { id: 'navy box', selection: { mode: 'IDS', ids: ['o1'] }, placement: { x: 560, y: 620, scale: 0.6 }, shadow_kind: 'SOFT' },
    ],
  });
  rows.push({ name: 'multi-object photograph (2 of 3 objects selected)', state: r.state, reasons: (r.reasons ?? []).join(','), ms: Math.round(performance.now() - t0), heap_mb: '-', size: `${m.rgba.width}x${m.rgba.height}`, cache_hits: cache.stats.hits });
  if (out && r.png) writeFileSync(path.join(out, 'multi-object-scene.png'), r.png);
}
console.table(rows);
console.log(`peak RSS ${mb(process.memoryUsage().rss)} MB`);
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = rows.every((r) => r.state === 'READY_FOR_COMPOSITE') ? 0 : 1;
