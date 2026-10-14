import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as IW from './creative-integration-world.js';
import { e2eBrief, e2eWorld } from './creative-e2e-world.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { runLayeredCreative } from '../src/creative-runtime/index.js';
import { prepareAsset } from '../src/creative-e2e/asset.js';
import { E2E_STATE, computeProductSegmentation, runCreativeEndToEnd } from '../src/creative-e2e/index.js';
import { dilate } from '../src/creative-integration/pixels.js';
import { segmentProduct } from '../src/creative-integration/index.js';

// Native alpha is NOT assumed clean (`// ND-N` markers): a baked semi-transparent glow, a baked halo in the delivered image and a ragged edge are rejected by the validation or by the downstream gates;
// the one defect the alpha cannot show (a glow painted into OPAQUE pixels and marked opaque by the supplier) is stated as a limit with its observed behaviour, not claimed as caught.

const sha = (b) => createHash('sha256').update(b).digest('hex');
const AT = '2026-10-14T10:00:00.000Z';
const base = () => {
  const prep = prepareAsset(e2eBrief().asset); const seg = segmentProduct({ rgba: prep.rgba });
  const pre = { width: prep.rgba.width, height: prep.rgba.height, pixels: Uint8Array.from(prep.rgba.pixels) };
  for (let i = 0; i < pre.width * pre.height; i += 1) { const a = seg.alpha[i]; pre.pixels[i * 4 + 3] = a === 255 ? 253 : a; if (a === 0) { pre.pixels[i * 4] = 0; pre.pixels[i * 4 + 1] = 0; pre.pixels[i * 4 + 2] = 0; } }
  return pre;
};
const worldOf = async (img) => { const bytes = encodePng({ width: img.width, height: img.height, pixels: img.pixels }); return e2eWorld({ brief: e2eBrief({ asset: { ...e2eBrief().asset, bytes, sha256: sha(bytes) } }) }); };
const run = (w, over = {}) => runCreativeEndToEnd({ run_id: 'run-nd-1', at: AT, ceiling_eur: 2, request: w.request, brief: w.brief, fonts: w.fonts, font: w.font, ports: w.ports, guardian: w.guardian, ...over });
const ring = (img, radius, alpha) => {
  const out = { width: img.width, height: img.height, pixels: Uint8Array.from(img.pixels) }; const n = img.width * img.height; const core = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) core[i] = img.pixels[i * 4 + 3] >= 250 ? 1 : 0;
  const wide = dilate(core, img.width, img.height, radius);
  for (let i = 0; i < n; i += 1) if (wide[i] && !core[i] && img.pixels[i * 4 + 3] === 0) { out.pixels[i * 4] = 255; out.pixels[i * 4 + 1] = 240; out.pixels[i * 4 + 2] = 200; out.pixels[i * 4 + 3] = alpha; }
  return out;
};

test('A glow baked into the alpha as a semi-transparent ring stops the run before any paid call', async () => {
  // ND-1
  const w = await worldOf(ring(base(), 14, 120)); const r = await run(w);
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.stage, 'SEGMENTATION'); assert.equal(r.final, null);
  assert.equal(w.brainPort.calls.length, 0); assert.equal(r.provider_calls.length, 0); assert.equal(r.budget.spent_eur, 0); assert.equal(r.fallback_to_generated_product, false);
  assert.match(JSON.stringify(r.block), /ALPHA/);
});

test('A clean native alpha does not exempt the delivered image: a halo that appears in the composition is stopped by the artifact gate', async () => {
  // ND-2 first a real run to capture the layered result of a native-alpha asset
  const w0 = await worldOf(base()); let layered = null; let seg = null;
  const deps = { segment: async (a) => { seg = await computeProductSegmentation(a); return seg; }, runLayered: async (a) => { layered = await runLayeredCreative(a); return layered; } };
  const ok = await run(w0, { deps }); assert.equal(ok.integration.source_kind, 'NATIVE_ALPHA'); assert.notEqual(ok.state, E2E_STATE.BLOCKED);
  // a one-pixel light ring around the product in the delivered image
  const img = decodePng(layered.png_bytes); const rect = layered.product_rect; const px = Uint8Array.from(img.pixels);
  for (let y = Math.max(0, rect.y - 3); y < rect.y + rect.height + 3; y += 1) for (const x of [rect.x - 2, rect.x - 1, rect.x + rect.width + 1, rect.x + rect.width]) { const i = (y * img.width + x) * 4; px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
  const forged = { ...layered, png_bytes: encodePng({ width: img.width, height: img.height, pixels: px }) };
  const w1 = await worldOf(base()); const r = await run(w1, { deps: { segment: async () => seg, runLayered: async () => forged }, resume: { layer_store: ok.resume_state.layer_store } });
  assert.equal(r.integration.source_kind, 'NATIVE_ALPHA'); assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.code, 'INTEGRATION_ARTIFACT'); assert.equal(r.gates.find((g) => g.id === 'INTEGRATION_ARTIFACTS').outcome, 'FAIL');
});

test('A pinhole in the supplier alpha is rejected by the validation, not passed to the compositor', async () => {
  // ND-3 a 2x2 pinhole inside the product fails closed with the alpha reasons (a larger enclosed opening is a legitimate product aperture, see native-alpha.js)
  const img = base(); const pin = { width: img.width, height: img.height, pixels: Uint8Array.from(img.pixels) };
  let cx = 0; let cy = 0; let best = -1; // the opaque pixel deepest inside the product (largest all-opaque 9x9 neighbourhood nearest the centre)
  for (let y = 6; y < pin.height - 6; y += 1) for (let x = 6; x < pin.width - 6; x += 1) { let all = true; for (let dy = -6; dy <= 6 && all; dy += 2) for (let dx = -6; dx <= 6; dx += 2) if (pin.pixels[((y + dy) * pin.width + x + dx) * 4 + 3] < 250) { all = false; break; } const d = -Math.hypot(x - pin.width / 2, y - pin.height / 2); if (all && d > best) { best = d; cx = x; cy = y; } }
  assert.ok(best > -1e9 && cx > 0, 'a point deep inside the product exists');
  for (let dy = 0; dy <= 1; dy += 1) for (let dx = 0; dx <= 1; dx += 1) pin.pixels[((cy + dy) * pin.width + cx + dx) * 4 + 3] = 0;
  const r = await run(await worldOf(pin));
  assert.equal(r.state, E2E_STATE.BLOCKED); assert.equal(r.block.stage, 'SEGMENTATION'); assert.equal(r.provider_calls.length, 0); assert.match(JSON.stringify(r.block), /ALPHA/);
});

test('LIMIT (stated, not claimed as caught): a glow painted into OPAQUE pixels and marked opaque is product as far as the alpha can tell', async () => {
  // ND-4 observed behaviour is recorded: the run is never READY without the owner, and the result says the asset is pending review
  const w = await worldOf(ring(base(), 14, 255)); const r = await run(w);
  assert.notEqual(r.state, E2E_STATE.READY); assert.equal(r.owner_approval, 'PENDING'); assert.equal(r.fallback_to_generated_product, false);
});
