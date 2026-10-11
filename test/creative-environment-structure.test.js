import test from 'node:test';
import assert from 'node:assert/strict';

import { assessEnvironment, SUITABILITY, zoneObjectStructure, zoneStructure } from '../src/creative-runtime/environment-suitability.js';

// THE PRODUCT INTEGRATION ZONE GATE (`// ES-N` markers). A rich scene is welcome; the zone where the real product will be composited must hold no object and no strong structure. Texture (the grain
// of wood, the pores of stone, fabric) is not structure: it is measured at pixel scale as before (evidence) but the decision is taken at object scale. Synthetic images only: the structure of the
// failed first benchmark scene (a textured counter, hands, a sign) without any of its content.

const W = 1080; const H = 1350;
const BOX = { x: 340, y: 600, width: 400, height: 610 }; // where the product is placed
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** A flat surface of the given luma with an optional gentle large-scale shading. */
function surface(luma = 120, shading = 14) {
  const pixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const v = clamp(luma + (shading * (y / H - 0.5)) + (shading * 0.5 * Math.sin(x / 220))); const i = (y * W + x) * 4; pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255; }
  return { width: W, height: H, pixels };
}
/** Wood-like grain: fine, high-contrast, directional texture at pixel scale over a region (or everywhere). It must average out at object scale. */
function grain(env, region = { x: 0, y: 0, width: W, height: H }, amplitude = 42, seed = 7) {
  const r = lcg(seed);
  for (let y = region.y; y < Math.min(H, region.y + region.height); y += 1) {
    for (let x = region.x; x < Math.min(W, region.x + region.width); x += 1) {
      const line = Math.sin((y * 1.9) + (Math.sin(x / 40) * 3)) * amplitude * 0.6; const speck = (r() - 0.5) * amplitude;
      const i = (y * W + x) * 4; const v = clamp(env.pixels[i] + line + speck); env.pixels[i] = v; env.pixels[i + 1] = v; env.pixels[i + 2] = v;
    }
  }
  return env;
}
const paint = (env, x0, y0, w, h, luma, inside = () => true) => {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y += 1) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x += 1) if (inside(x - x0, y - y0)) { const i = (y * W + x) * 4; env.pixels[i] = luma; env.pixels[i + 1] = luma; env.pixels[i + 2] = luma; }
  return env;
};
const disc = (env, cx, cy, r, luma) => paint(env, cx - r, cy - r, 2 * r, 2 * r, luma, (x, y) => ((x - r) ** 2) + ((y - r) ** 2) <= r * r);
/** Lettering or a logo: bars of high contrast about 20 px thick, as a sign would carry. */
const lettering = (env, x0, y0, w, h) => { for (let k = 0; k * 40 < w; k += 1) paint(env, x0 + (k * 40), y0, 20, h, 15); return env; };
const verdict = (env, box = BOX) => assessEnvironment({ environment: env, productBox: box });

test('ES-1 a RICH scene with a clean integration zone is suitable: a textured counter everywhere and narrative props outside the zone', () => {
  const env = grain(surface(130));
  // narrative elements around the reserved zone: a prop at the left edge, a larger one at the right edge, structure at the top
  disc(env, 120, 760, 110, 40);
  paint(env, 880, 420, 200, 520, 30);
  paint(env, 60, 80, 700, 120, 70);
  const v = verdict(env);
  assert.equal(v.suitable, true);
  assert.ok(v.measured.structure_share <= SUITABILITY.max_structure_share);
  // the same scene measured over the props themselves is not suitable: the props are real structure
  assert.equal(verdict(env, { x: 900, y: 450, width: 160, height: 480 }).suitable, false);
});

test('ES-2 strong texture is not structure: a grained surface under the product is suitable even though the fine-scale measure alone would refuse it', () => {
  const env = grain(surface(130), undefined, 60);
  const v = verdict(env);
  assert.ok(v.measured.strong_edge_share > SUITABILITY.max_strong_edge_share * 3, 'the old fine-scale measure sees an edge-rich surface');
  assert.equal(v.suitable, true);
  assert.ok(v.measured.structure_share < 0.01);
  // the same texture over only the zone, against a smooth surroundings
  const local = grain(surface(130), { x: 300, y: 560, width: 480, height: 700 }, 60);
  assert.equal(verdict(local).suitable, true);
});

test('ES-3 an object inside the zone is refused, whatever its tone: a dark prop, a bright prop and a low-contrast block (a stone block on a stone counter)', () => {
  for (const luma of [20, 235]) {
    const env = disc(grain(surface(130)), 540, 900, 150, luma);
    assert.equal(verdict(env).suitable, false, `disc ${luma}`);
  }
  // a low-contrast block: only 36 luma levels away from its surface, half of the zone (the stone block of the second benchmark scene measured 4.9 % on the real image)
  const block = paint(grain(surface(130), undefined, 30), 330, 650, 410, 330, 166);
  const v = verdict(block);
  assert.equal(v.suitable, false);
  assert.ok(v.measured.structure_share > SUITABILITY.max_structure_share);
});

test('ES-4 a substitute product (a phone-like body with lenses) anywhere in the zone is refused, and so is a hand-like shape entering from one side', () => {
  const phone = grain(surface(130));
  paint(phone, 380, 640, 320, 520, 35, (x, y) => !(x < 30 && y < 30)); // body
  disc(phone, 460, 720, 34, 200); disc(phone, 540, 720, 34, 200); // lenses
  assert.equal(verdict(phone).suitable, false);
  const hand = grain(surface(130));
  paint(hand, 300, 553, 330, 200, 85, (x, y) => y > x * 0.2); // a mid-tone shape entering the upper part of the zone
  assert.equal(verdict(hand).suitable, false);
});

test('ES-5 lettering or a logo inside the zone is refused; the zone is where the product goes, so the same lettering outside it is the critic\'s concern, not the zone gate\'s', () => {
  assert.equal(verdict(lettering(grain(surface(130)), 360, 700, 360, 90)).suitable, false);
  assert.equal(verdict(lettering(grain(surface(130)), 60, 120, 400, 90)).suitable, true);
});

test('ES-6 the old empty-background cases remain valid, and an unmeasurable zone is still not suitable', () => {
  const calm = surface(150, 20);
  const v = verdict(calm);
  assert.equal(v.suitable, true);
  assert.ok(v.measured.structure_share === 0);
  assert.ok(v.measured.strong_edge_share <= SUITABILITY.max_strong_edge_share);
  assert.equal(verdict(calm, { x: 1070, y: 1340, width: 40, height: 40 }).suitable, false); // outside the image: nothing was measured
  assert.equal(verdict(surface(60, 10)).suitable, true);
  assert.equal(verdict(surface(220, 10)).suitable, true);
});

test('ES-7 the decision is taken on the object-scale measure, with both measures and both limits as evidence', () => {
  const v = verdict(grain(surface(130), undefined, 60));
  assert.deepEqual(Object.keys(v.measured).sort(), ['mean_gradient', 'samples', 'strong_edge_share', 'structure_blocks', 'structure_share']);
  assert.deepEqual(Object.keys(v.limit).sort(), ['block_ratio', 'max_strong_edge_share', 'max_structure_share', 'strong_edge_level', 'structure_level']);
  assert.equal(v.rule, 'THE_ENVIRONMENT_IS_A_CALM_SURFACE_WHERE_THE_PRODUCT_IS_PLACED');
  assert.equal(v.limit.max_structure_share, SUITABILITY.max_structure_share);
  // the measures are deterministic
  assert.deepEqual(verdict(grain(surface(130), undefined, 60)).measured, v.measured);
  const zone = { x: BOX.x - (BOX.width * 0.08), y: BOX.y - (BOX.height * 0.08), width: BOX.width * 1.16, height: BOX.height * 1.16 };
  assert.deepEqual(zoneObjectStructure(grain(surface(130), undefined, 60), zone), { structure_share: v.measured.structure_share, structure_blocks: v.measured.structure_blocks });
  assert.ok(zoneStructure(grain(surface(130), undefined, 60), BOX).strong_edge_share > 0.05);
});

test('ES-8 the limit is a limit: a structure just under it is suitable, just over it is not', () => {
  const blocks = zoneObjectStructure(surface(130), { x: BOX.x - (BOX.width * 0.08), y: BOX.y - (BOX.height * 0.08), width: BOX.width * 1.16, height: BOX.height * 1.16 }).structure_blocks;
  const share = (n) => n / blocks;
  const at = (blocksWide) => { const env = surface(130); paint(env, 320, 700, blocksWide * 16, 16, 20); return verdict(env); };
  let under = null; let over = null;
  for (let k = 1; k <= 40; k += 1) { const v = at(k); if (v.suitable) under = { k, v }; else { over = { k, v }; break; } }
  assert.ok(under && over, 'a bar widening block by block crosses the limit');
  assert.ok(under.v.measured.structure_share <= SUITABILITY.max_structure_share && over.v.measured.structure_share > SUITABILITY.max_structure_share);
  assert.ok(share(over.k) > 0);
});

test('ES-9 a zone touching the edge of the image is measured only on blocks that exist, and an object there is still refused', () => {
  const box = { x: 340, y: 1060, width: 400, height: 290 }; // runs to the bottom edge
  const zone = { x: box.x - (box.width * 0.08), y: box.y - (box.height * 0.08), width: box.width * 1.16, height: box.height * 1.16 };
  const B = 16;
  const rows = (Math.floor(H / B) - 1) - Math.floor(zone.y / B);
  const cols = Math.ceil((zone.x + zone.width) / B) - Math.floor(zone.x / B);
  const clean = zoneObjectStructure(surface(130), zone);
  assert.equal(clean.structure_blocks, rows * cols);
  assert.equal(verdict(disc(grain(surface(130)), 540, 1230, 70, 20), box).suitable, false);
  assert.equal(verdict(grain(surface(130)), box).suitable, true);
});
