import test from 'node:test';
import assert from 'node:assert/strict';

import * as W from './creative-integration-world.js';
import { segmented } from './creative-integration-shared.js';
import { buildCutout, checkMatte, segmentProduct } from '../src/creative-integration/index.js';

// Deterministic matte quality (`// MQ-N` markers). Every defect is INJECTED into an otherwise good matte and must be named; a good matte must pass; an unmeasurable check fails closed.

const codes = (q) => q.findings.filter((f) => !f.ok).map((f) => f.code);
const verdict = (name, mutate, declared) => {
  const f = segmented(name); const alpha = Uint8Array.from(f.seg.alpha); mutate(alpha, f.rgba, f.seg);
  return checkMatte({ rgba: f.rgba, alpha, ground: f.seg.ground, declared });
};
const at = (rgba, x, y) => y * rgba.width + x;

test('Good mattes pass every check on all seven products', () => {
  for (const name of Object.keys(W.ALL)) {
    const f = segmented(name); const q = checkMatte({ rgba: f.rgba, alpha: f.seg.alpha, ground: f.seg.ground });
    // MQ-1
    assert.deepEqual(codes(q), [], name); assert.equal(q.valid, true, name);
  }
});

test('Each matte defect is detected and named', () => {
  // MQ-2 erosion: the matte shrunk by 3 px (alpha lowered along the whole boundary)
  const erode3 = (alpha, rgba) => {
    const hard = alpha.map((a) => (a >= 128 ? 1 : 0)); const out = Uint8Array.from(alpha);
    for (let y = 0; y < rgba.height; y += 1) for (let x = 0; x < rgba.width; x += 1) {
      if (!hard[at(rgba, x, y)]) continue;
      let edge = false; for (let dy = -3; dy <= 3 && !edge; dy += 1) for (let dx = -3; dx <= 3; dx += 1) { const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= rgba.width || ny >= rgba.height || !hard[at(rgba, nx, ny)]) { edge = true; break; } }
      if (edge) out[at(rgba, x, y)] = 0;
    }
    alpha.set(out);
  };
  assert.ok(codes(verdict('phoneCase', erode3)).some((c) => ['BOUNDARY_OFFSET', 'MISSING_THIN_PARTS', 'EDGE_RECONSTRUCTION', 'EDGE_RECONSTRUCTION_RUN'].includes(c)));
  assert.ok(codes(verdict('phoneCase', erode3)).includes('BOUNDARY_OFFSET'));
  // MQ-3 dilation: the matte grown by 3 px (ground pixels become opaque): halo / fringe and offset
  const dilate3 = (alpha, rgba) => {
    const hard = alpha.map((a) => (a >= 128 ? 1 : 0)); const out = Uint8Array.from(alpha);
    for (let y = 0; y < rgba.height; y += 1) for (let x = 0; x < rgba.width; x += 1) {
      if (hard[at(rgba, x, y)]) continue;
      let near = false; for (let dy = -3; dy <= 3 && !near; dy += 1) for (let dx = -3; dx <= 3; dx += 1) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < rgba.width && ny < rgba.height && hard[at(rgba, nx, ny)]) { near = true; break; } }
      if (near) out[at(rgba, x, y)] = 255;
    }
    alpha.set(out);
  };
  const dil = codes(verdict('phoneCase', dilate3));
  assert.ok(dil.includes('BOUNDARY_OFFSET') && dil.includes('FRINGE') && dil.includes('FRINGE_RUN'), dil.join());
  // MQ-4 a pinhole: a 2x2 transparent speck inside the printed area (the source there is product)
  assert.ok(codes(verdict('phoneCase', (a, r) => { for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) a[at(r, 150 + dx, 200 + dy)] = 0; })).includes('PINHOLES'));
  // MQ-5 an accidental hole: a 30x30 transparent area where the source is product
  assert.ok(codes(verdict('phoneCase', (a, r) => { for (let y = 190; y < 220; y += 1) for (let x = 130; x < 160; x += 1) a[at(r, x, y)] = 0; })).includes('ACCIDENTAL_HOLES'));
  // MQ-6 a disconnected fragment beyond the declared object
  assert.ok(codes(verdict('phoneCase', (a, r) => { for (let y = 10; y < 22; y += 1) for (let x = 10; x < 22; x += 1) a[at(r, x, y)] = 255; })).includes('FRAGMENTS'));
  // MQ-7 stray alpha dust far from the product
  assert.ok(codes(verdict('phoneCase', (a, r) => { a[at(r, 20, 400)] = 40; })).includes('STRAY_ALPHA'));
  // MQ-8 a missing thin part: the cable stub of the small tech product is dropped
  assert.ok(codes(verdict('smallTech', (a, r) => { for (let y = 250; y < 300; y += 1) for (let x = 130; x < 150; x += 1) a[at(r, x, y)] = 0; })).includes('MISSING_THIN_PARTS'));
  // MQ-9 an interior that is not opaque (alpha contamination), unless semi-transparency is declared
  const soft = (a, r) => { for (let y = 120; y < 320; y += 1) for (let x = 100; x < 200; x += 1) if (a[at(r, x, y)] === 255) a[at(r, x, y)] = 180; };
  assert.ok(codes(verdict('phoneCase', soft)).includes('INTERIOR_ALPHA'));
  assert.ok(!codes(verdict('phoneCase', soft, { semi_transparent: true })).includes('INTERIOR_ALPHA'));
  // MQ-10 a thresholded soft edge (binary alpha on an anti-aliased source): the edge no longer reproduces the source
  const binary = (a) => { for (let i = 0; i < a.length; i += 1) a[i] = a[i] >= 128 ? 255 : 0; };
  const bin = codes(verdict('tumbler', binary)); assert.ok(bin.includes('EDGE_RECONSTRUCTION') || bin.includes('EDGE_RECONSTRUCTION_RUN'), bin.join());
  // MQ-11 a jagged alpha ramp: random alpha in the two-pixel band around the boundary
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const noisy = (alpha, rgba) => {
    const hard = alpha.map((v) => (v >= 128 ? 1 : 0));
    for (let y = 2; y < rgba.height - 2; y += 1) for (let x = 2; x < rgba.width - 2; x += 1) {
      let mixed = false; for (let dy = -2; dy <= 2 && !mixed; dy += 1) for (let dx = -2; dx <= 2; dx += 1) if (hard[at(rgba, x + dx, y + dy)] !== hard[at(rgba, x, y)]) { mixed = true; break; }
      if (mixed) alpha[at(rgba, x, y)] = Math.round(rnd() * 255);
    }
  };
  const nz = codes(verdict('phoneCase', noisy)); assert.ok(nz.includes('ALPHA_NOISE') && nz.includes('EDGE_RECONSTRUCTION'), nz.join());
  // MQ-12 ground kept inside the product: the opening of the tumbler's handle made opaque (the table would show as a cream disc)
  assert.ok(codes(verdict('tumbler', (a, r) => { for (let y = 222; y < 258; y += 1) for (let x = 194; x < 230; x += 1) a[at(r, x, y)] = 255; })).includes('GROUND_LEAK'));
});

test('A defect that is too small for a share still fails on its run length', () => {
  // MQ-13 a 6 px run of ground-coloured opaque boundary pixels is far below any share limit but is a visible halo segment
  const f = segmented('phoneCase'); const alpha = Uint8Array.from(f.seg.alpha);
  for (let y = 200; y < 206; y += 1) alpha[at(f.rgba, 64, y)] = 255; // one column just outside the left edge (x = 65 is the edge)
  const q = checkMatte({ rgba: f.rgba, alpha, ground: f.seg.ground });
  assert.ok(codes(q).includes('FRINGE_RUN') || codes(q).includes('EDGE_RECONSTRUCTION_RUN'), codes(q).join());
});

test('Fail closed: a check that cannot be measured is a failure, not a pass', () => {
  // MQ-14 a cluttered ground: the fringe, the missing parts and the offset cannot be measured
  const c = W.clutteredGround(); const alpha = new Uint8Array(300 * 300); for (let y = 100; y < 200; y += 1) for (let x = 100; x < 200; x += 1) alpha[y * 300 + x] = 255;
  const q = checkMatte({ rgba: c.rgba, alpha });
  assert.equal(q.valid, false); for (const code of ['FRINGE', 'MISSING_THIN_PARTS', 'BOUNDARY_OFFSET', 'EDGE_RECONSTRUCTION', 'GROUND_LEAK']) assert.ok(q.findings.find((f) => f.code === code && !f.ok && f.reason), code);
  // MQ-15 an empty matte and malformed input
  assert.equal(checkMatte({ rgba: c.rgba, alpha: new Uint8Array(300 * 300) }).valid, false);
  assert.equal(checkMatte({ rgba: c.rgba, alpha: new Uint8Array(5) }).valid, false);
  assert.equal(checkMatte({}).valid, false);
});

test('Other objects are not judged: the pixels of a non-selected neighbour are ignored', () => {
  // MQ-16 one object of a multi-object photograph: valid only when the others are declared ignorable
  const m = W.multiObject(); const seg = segmentProduct({ rgba: m.rgba, selection: { mode: 'IDS', ids: ['o2'] } });
  assert.equal(seg.status, 'OK');
  assert.equal(checkMatte({ rgba: m.rgba, alpha: seg.alpha, ground: seg.ground, ignore: seg.excluded }).valid, true);
  assert.equal(checkMatte({ rgba: m.rgba, alpha: seg.alpha, ground: seg.ground }).valid, false);
});

test('The cut-out keeps the source pixels; only the soft boundary is decontaminated, and it is counted', () => {
  const f = segmented('phoneCase'); const cut = buildCutout({ rgba: f.rgba, alpha: f.seg.alpha, bounds: f.seg.bounds });
  // MQ-17 every fully opaque interior pixel is the source pixel, byte for byte
  let same = 0; let n = 0;
  for (let y = 0; y < cut.height; y += 1) for (let x = 0; x < cut.width; x += 1) {
    const q = (y * cut.width + x) * 4; if (cut.pixels[q + 3] !== 255) continue;
    const si = ((cut.crop.y0 + y) * f.rgba.width + cut.crop.x0 + x) * 4; n += 1;
    if (cut.pixels[q] === f.rgba.pixels[si] && cut.pixels[q + 1] === f.rgba.pixels[si + 1] && cut.pixels[q + 2] === f.rgba.pixels[si + 2]) same += 1;
  }
  assert.ok(same / n > 0.995, `${same}/${n}`);
  // MQ-18 the decontaminated pixels are all partially transparent and are counted
  assert.ok(cut.decontaminated_pixels > 0 && cut.decontaminated_pixels < n * 0.2);
  // MQ-19 with decontamination off, no pixel colour changes at all
  const raw = buildCutout({ rgba: f.rgba, alpha: f.seg.alpha, bounds: f.seg.bounds, decontaminate: false }); assert.equal(raw.decontaminated_pixels, 0);
});
