import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

import * as P from '../src/creative-intelligence/production.js';
import { rasterizeToPixels } from '../src/creative-intelligence/production-render.js';
import { ANNOTATIONS, SOURCE } from './runtime-world.js';

// The local product mask and the cut-out (`// PM-N` markers): the product pixels are the source pixels, the mask is deterministic, and a mask it cannot trust is flagged.

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SW = 600; const SH = 800;
const rgbaOf = (png) => rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}"><image width="${SW}" height="${SH}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`);
const rgba = rgbaOf(SOURCE);
const outline = ANNOTATIONS.outline.map(([x, y]) => [x * SW, y * SH]);
const mask = P.buildProductMask({ rgba, inner_outline: outline });

test('The mask finds the real silhouette: confident, rounded-quadrilateral fit, product inside and table outside', () => {
  // PM-1 confident, with the rounded-quad model and a small residual
  assert.equal(mask.quality.confident, true);
  assert.equal(mask.quality.shape.model, 'ROUNDED_QUAD');
  assert.ok(mask.quality.shape.median_residual_px < 2, String(mask.quality.shape.median_residual_px));
  // PM-2 the product (placed at (150, 120), 300 x 500) is inside, the table is outside, the edge is anti-aliased in between
  const at = (x, y) => mask.alpha[y * SW + x];
  assert.equal(at(300, 370), 255);
  assert.equal(at(20, 20), 0);
  assert.equal(at(580, 780), 0);
  assert.equal(at(140, 370), 0); // just left of the case
  const edge = [...mask.alpha].filter((a) => a > 0 && a < 255).length;
  assert.ok(edge > 500 && edge < 6000, String(edge));
  // PM-3 the bounds hug the case within a few pixels (the true outer silhouette is 150..450 x 120..620)
  assert.ok(Math.abs(mask.bounds.x0 - 150) <= 4 && Math.abs(mask.bounds.x1 - 450) <= 4 && Math.abs(mask.bounds.y0 - 120) <= 4 && Math.abs(mask.bounds.y1 - 620) <= 4, JSON.stringify(mask.bounds));
});

test('The cut-out holds the SOURCE pixels, exactly, wherever the mask is fully opaque', () => {
  const cutout = P.makeProductCutout({ rgba, mask });
  const img = P.decodePng(cutout.png_bytes);
  assert.deepEqual([img.width, img.height], [cutout.width, cutout.height]);
  let opaque = 0; let different = 0;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const q = (y * img.width + x) * 4; const p = ((cutout.crop.y0 + y) * SW + (cutout.crop.x0 + x)) * 4;
      if (img.pixels[q + 3] === 255) {
        opaque += 1;
        if (img.pixels[q] !== rgba.pixels[p] || img.pixels[q + 1] !== rgba.pixels[p + 1] || img.pixels[q + 2] !== rgba.pixels[p + 2]) different += 1;
      }
    }
  }
  // PM-4 every fully opaque cut-out pixel IS the source pixel (no generated, blended or retouched pixel inside the product)
  assert.ok(opaque > 100000, String(opaque));
  assert.equal(different, 0);
  // PM-5 a transparent surround: the corners are fully transparent
  assert.equal(img.pixels[3], 0);
});

test('The mask and the cut-out are deterministic, and a mask it cannot trust is flagged, never hidden', () => {
  // PM-6 the same input gives the same mask and the same cut-out bytes
  const again = P.buildProductMask({ rgba, inner_outline: outline });
  assert.equal(sha(again.alpha), sha(mask.alpha));
  assert.equal(sha(P.makeProductCutout({ rgba, mask: again }).png_bytes), sha(P.makeProductCutout({ rgba, mask }).png_bytes));
  // PM-7 a photograph with no edge at all (a flat grey) cannot be trusted: not confident
  const flat = rgbaOf(new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}"><rect width="${SW}" height="${SH}" fill="#777777"/></svg>`).render().asPng()));
  const weak = P.buildProductMask({ rgba: flat, inner_outline: outline });
  assert.equal(weak.quality.confident, false);
  // PM-8 the PNG encoder and decoder are inverses
  const px = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 37) % 256);
  const round = P.decodePng(P.encodePng({ width: 4, height: 4, pixels: px }));
  assert.deepEqual([...round.pixels], [...px]);
  assert.throws(() => P.encodePng({ width: 4, height: 4, pixels: new Uint8Array(3) }), /pixel buffer/);
});
