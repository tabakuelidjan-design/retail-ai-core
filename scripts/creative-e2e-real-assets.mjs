// The end-to-end run on REAL product files, provider-free: node scripts/creative-e2e-real-assets.mjs [--out <dir>] [--mode AUTO|PHOTO|NATIVE_ALPHA] <product.png> ...
// The Brain, the asset director and the layer generator are the scripted fakes of the test world (plates and props are drawn locally): this measures what the REAL PRODUCT does to the chain (the segmentation, the
// integration, the layered production, the gates), nothing about any provider. It reads the files, never modifies them, calls no provider and needs no network. Each run reports the exact stage where it stopped.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { e2eBrief, e2eWorld } from '../test/creative-e2e-world.js';
import { runCreativeEndToEnd } from '../src/creative-e2e/index.js';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const out = flag('--out'); const mode = flag('--mode', 'AUTO');
const files = args.filter((a, i) => !a.startsWith('--') && !['--out', '--mode'].includes(args[i - 1]));
if (out) mkdirSync(out, { recursive: true });
const rows = [];
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file)); const base = e2eBrief();
  const brief = e2eBrief({ asset: { ...base.asset, ref: `asset://real/${path.basename(file)}`, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), media_type: bytes[0] === 0xff ? 'image/jpeg' : 'image/png' }, identity_annotations: undefined });
  const w = await e2eWorld({ brief });
  const t0 = performance.now();
  const r = await runCreativeEndToEnd({ run_id: `real-${path.basename(file).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}`, at: new Date(0).toISOString(), ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, options: { source_mode: mode } });
  rows.push({
    asset: path.basename(file), mode, source_kind: r.integration?.source_kind ?? '-', state: r.state, stopped_at: r.block ? `${r.block.stage}/${r.block.code}` : (r.failure ? `FAILURE/${r.failure.code}` : '-'), reasons: r.block?.reason ?? '',
    gates_failed: r.gates.filter((g) => g.outcome === 'FAIL').map((g) => g.id).join(','), warnings: r.warnings.join(','), provider_calls: r.provider_calls.length, spent_eur: r.budget?.spent_eur, ms: Math.round(performance.now() - t0),
  });
  if (out && r.final) writeFileSync(path.join(out, `${path.basename(file, path.extname(file))}-${mode}-final.png`), r.final.png_bytes);
}
console.table(rows);
