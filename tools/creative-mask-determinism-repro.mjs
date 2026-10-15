// Reproduction of the product-mask nondeterminism (PM-6 / creative-refine RF-2..RF-4 / RF-12 intermittent failures). Diagnostic only: no assertion, no fix.
// One run: the foreground refine scenario of test/creative-refine.test.js; every call of the segmenter recomputes raster / mask / cut-out 6 times and prints the
// DISTINCT hashes seen. Deterministic code prints one hash per column. Run many at once to load the CPU, e.g. 14 in parallel:
//   for i in $(seq 1 14); do node tools/creative-mask-determinism-repro.mjs & done; wait
// Observed 2026-10-15 (Node 24.22, 4 vCPU): default flags 2/28 runs show two masks (96d2f81b... and fe46f8d3..., the very pair seen in CI run 38659540142);
// with --max-opt=0 (no optimizing JIT) 0/28; with --max-opt=2 (Maglev at most, no TurboFan) 0/28: the divergence appears only once TurboFan compiles it. The raster (resvg) and the cut-out of a given mask are stable; buildProductMask is not. Replacing `** 2` by
// multiplications in fitLine did NOT remove it (1/28). See docs/integration/integration-audit-2026-10-15.md §4.
import { createHash } from 'node:crypto';
import { rasterizeToPixels } from '../src/creative-intelligence/production-render.js';
import { buildProductMask } from '../src/creative-intelligence/product-mask.js';
import { makeProductCutout } from '../src/creative-intelligence/product-cutout.js';
import { createDefectRegion, DEFECT_KIND, refineCreative } from '../src/creative-refine/index.js';
import { firstRun, FOREGROUND_SCENE } from '../test/creative-refine-world.js';
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 10);
const steps = ({ asset, annotations }) => {
  const uri = `data:${asset.media_type};base64,${Buffer.from(asset.bytes).toString('base64')}`;
  const rgba = rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width_px}" height="${asset.height_px}" viewBox="0 0 ${asset.width_px} ${asset.height_px}"><image width="${asset.width_px}" height="${asset.height_px}" preserveAspectRatio="none" href="${uri}"/></svg>`);
  const mask = buildProductMask({ rgba, inner_outline: annotations.outline.map(([x, y]) => [x * asset.width_px, y * asset.height_px]), options: {} });
  const cut = makeProductCutout({ rgba, mask });
  return { r: sha(rgba.pixels), m: sha(mask.alpha), c: sha(cut.png_bytes) };
};
const B = await firstRun({ index: FOREGROUND_SCENE, foreground: true });
const real = B.run.ports.segmenter; const out = [];
const ports = { ...B.run.ports, segmenter: { ...real, segment: async (a) => { for (let i = 0; i < 6; i++) out.push(steps(a)); return real.segment(a); } } };
const p = B.candidate.artifact.nodes.props.find((x) => x.kind === 'PROP_FOREGROUND');
await refineCreative({ candidate: B.candidate, defects: [createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: p.layer_id })], run: { ...B.run, ports }, store: B.store });
const u = (k) => [...new Set(out.map((o) => o[k]))];
console.log(JSON.stringify({ r: u('r'), m: u('m'), c: u('c') }));
